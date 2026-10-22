import { constants } from 'node:fs';
import { mkdir, open, realpath, readdir, unlink, rmdir, opendir, rename, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SharedBrowserActionResult } from '@matrix-os/contracts';
import type { BrowserCdpClient, CdpEvent } from './cdp-client.js';
import { SharedBrowserError } from './broker.js';
import { validateBrowserUrl, type BrowserResolver } from './url-policy.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURED_DOWNLOADS = 8;
const unavailable = () => new SharedBrowserError('browser_unavailable');
const report = (error: unknown) => console.warn('[shared-browser] Download cleanup unavailable', error instanceof SharedBrowserError ? error.code : 'cleanup_failed');
export type Directory = { fd: FileHandle; canonical: string; access: string };
const directories = (fd: FileHandle, canonical: string): Directory => ({ fd, canonical, access: process.platform === 'linux' ? `/proc/self/fd/${fd.fd}` : canonical });
export async function assertDirectory(directory: Directory) {
  const held = await directory.fd.stat();
  const current = await open(directory.canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const currentStat = await current.stat(); if (held.ino !== currentStat.ino || held.dev !== currentStat.dev) throw unavailable(); }
  finally { await current.close(); }
}
async function childDirectory(parent: Directory, name: string, exclusive = false) {
  await assertDirectory(parent);
  try { await mkdir(join(parent.access, name), { mode: 0o700 }); }
  catch (error) { if (exclusive || !(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const fd = await open(join(parent.access, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = await fd.stat();
  if (!stat.isDirectory() || process.getuid && stat.uid !== process.getuid()) { await fd.close(); throw unavailable(); }
  return directories(fd, join(parent.canonical, name));
}
export async function openBrowserArtifactDirectory(homePath: string): Promise<Directory> {
  const canonical = await realpath(homePath);
  const rootFd = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const root = directories(rootFd, canonical); let data: Directory | undefined;
  try { data = await childDirectory(root, 'data'); return await childDirectory(data, 'browser-artifacts'); }
  finally { await data?.fd.close(); await rootFd.close(); }
}
async function capacity(directory: Directory) {
  const entries = await opendir(directory.access); let count = 0, recoveries = 0;
  try { for await (const entry of entries) { if (++count > 128 || entry.isSymbolicLink() || entry.isDirectory() && /^recovery-[a-f0-9-]{36}$/.test(entry.name) && ++recoveries >= 8) throw unavailable(); } }
  catch (error) { if (!(error instanceof SharedBrowserError)) report(error); throw unavailable(); }
}
async function removeTemporary(parent: Directory, temporary: Directory, name: string) {
  await assertDirectory(temporary); await assertDirectory(parent);
  // Only unlink entries in the held directory. Never follow a symlink or recurse
  // into a replaced directory; Chrome creates only GUID files here.
  for (const entry of await readdir(temporary.access, { withFileTypes: true })) {
    if (entry.isDirectory()) { console.warn('[shared-browser] Temporary download directory retained'); continue; }
    await unlink(join(temporary.access, entry.name));
  }
  await rmdir(join(parent.access, name));
}
export async function cleanupDownloadTemps(homePath: string, now = Date.now()) {
  const directory = await openBrowserArtifactDirectory(homePath); const entries = await opendir(directory.access);
  let scanned = 0, removed = 0;
  try {
    for await (const entry of entries) {
      if (++scanned > 128 || removed >= 16) break;
      if (!entry.isDirectory() || !/^\.download-[a-f0-9-]{36}$/.test(entry.name)) continue;
      let temporary: Directory | undefined;
      try {
        const fd = await open(join(directory.access, entry.name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        temporary = directories(fd, join(directory.canonical, entry.name));
        const stat = await fd.stat();
        if (process.getuid && stat.uid !== process.getuid() || stat.mtimeMs > now - 24 * 60 * 60_000) continue;
        await removeTemporary(directory, temporary, entry.name); removed++;
      } catch (error) { report(error); }
      finally { await temporary?.fd.close(); }
    }
  } finally { await directory.fd.close(); }
}
async function storeOriginal(directory: Directory, temporary: Directory, guid: string, documentId: string) {
  await assertDirectory(directory); await assertDirectory(temporary);
  const source = await open(join(temporary.access, guid), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size < 8 || stat.size > MAX_BYTES) throw unavailable();
    bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const read = await source.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw unavailable(); offset += read.bytesRead; }
    if ((await source.stat()).size !== bytes.length || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw unavailable();
  } finally { await source.close(); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = `${documentId}-${sha256}.pdf`; const path = join(directory.access, name);
  let output: FileHandle | undefined;
  try {
    output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await output.writeFile(bytes); await output.sync();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await existing.stat(); if (!stat.isFile() || stat.size !== bytes.length) throw unavailable();
        const current = Buffer.alloc(bytes.length); let offset = 0;
        while (offset < current.length) { const read = await existing.read(current, offset, current.length - offset, offset); if (!read.bytesRead) throw unavailable(); offset += read.bytesRead; }
        if ((await existing.stat()).size !== bytes.length || createHash('sha256').update(current).digest('hex') !== sha256) throw unavailable();
      }
      finally { await existing.close(); }
    } else { if (output) await unlink(path).catch(report); throw error; }
  } finally { await output?.close(); }
  await assertDirectory(directory);
  return { path: `data/browser-artifacts/${name}`, size: bytes.length, sha256 };
}

export async function collectChromeDownload(options: {
  homePath: string; client: Pick<BrowserCdpClient, 'request' | 'onEvent'>; frameId: string;
  sourceUrl: string; documentId: string; signal: AbortSignal; trigger(): Promise<unknown>;
  resolveHost?: BrowserResolver; timeoutMs?: number; restoreBehavior?: 'default' | 'deny';
  onCollectingChange?(collecting: boolean): void;
}): Promise<NonNullable<SharedBrowserActionResult['artifact']> | { recoveryPath: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.documentId) || options.signal.aborted) throw unavailable();
  const checked = await validateBrowserUrl(options.sourceUrl, options.resolveHost);
  let directory: Directory | undefined, temporary: Directory | undefined;
  const temporaryName = `.download-${randomUUID()}`;
  let guid: string | undefined, sourceUrl = checked.sourceUrl, validated = false, complete = false, configured = false;
  const captures = new Map<string, { receivedBytes: number; terminal: boolean; cancelRequested: boolean }>();
  const overflowCancellations = new Set<Promise<void>>();
  let overflowCleanupFailed = false;
  let recoveryReason: 'another_chrome_tab' | 'multiple_chrome_downloads' | 'original_store_failed' | 'completed_cancelled' | 'source_validation_failed' | undefined;
  let recoveryDeny: Promise<unknown> | undefined;
  let unsubscribe: (() => unknown) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Setup/click may await commands while Chrome emits download events.
  void completion.catch(error => console.warn('[shared-browser] Original download unavailable',
    error instanceof SharedBrowserError ? error.code : 'operation_failed'));
  const onAbort = () => { if (guid && complete) recoveryReason ??= 'completed_cancelled'; fail(unavailable()); };
  const recover = (reason: NonNullable<typeof recoveryReason>) => {
    recoveryReason ??= reason;
    // Deny new downloads while retaining progress events for every file already
    // captured in this directory. Defaults return only after bounded cleanup.
    recoveryDeny ??= options.client.request('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    void recoveryDeny.catch(report); fail(unavailable());
  };
  const cancelCaptured = async () => {
    let failed = false;
    const pending = [...captures].filter(([, capture]) => !capture.terminal && !capture.cancelRequested);
    await Promise.all(pending.map(async ([capturedGuid, capture]) => {
      capture.cancelRequested = true;
      try { await options.client.request('Browser.cancelDownload', { guid: capturedGuid }); capture.terminal = true; }
      catch (error) { report(error); failed = true; }
    }));
    return !failed;
  };
  const cancelOverflow = (capturedGuid: string) => {
    if (overflowCancellations.size >= MAX_CAPTURED_DOWNLOADS) { overflowCleanupFailed = true; return; }
    const cancellation = options.client.request('Browser.cancelDownload', { guid: capturedGuid }).then(() => undefined, error => {
      report(error); overflowCleanupFailed = true;
    });
    overflowCancellations.add(cancellation);
  };
  const drainOverflow = async () => { await Promise.all(overflowCancellations); return !overflowCleanupFailed; };
  const begin = async (event: CdpEvent) => {
    const params = event.params;
    if (typeof params.guid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(params.guid)) { fail(unavailable()); return; }
    if (!captures.has(params.guid)) {
      if (captures.size >= MAX_CAPTURED_DOWNLOADS) { recover('multiple_chrome_downloads'); cancelOverflow(params.guid); return; }
      captures.set(params.guid, { receivedBytes: 0, terminal: false, cancelRequested: false });
    }
    if (params.frameId !== options.frameId) {
      // Chrome's download behavior applies to the shared default context, not
      // one target. Never read or discard another tab's captured download.
      recover('another_chrome_tab'); return;
    }
    if (guid) { if (params.guid !== guid) recover('multiple_chrome_downloads'); return; }
    if (typeof params.url !== 'string') { fail(unavailable()); return; }
    guid = params.guid;
    try { sourceUrl = (await validateBrowserUrl(params.url, options.resolveHost)).sourceUrl; validated = true; if (complete) finish(); }
    catch (error) {
      if (!(error instanceof SharedBrowserError)) report(error);
      // Completion can race validation and cancellation. Keep unverified bytes
      // for owner review rather than deleting the only completed original.
      recover('source_validation_failed');
    }
  };
  try {
    directory = await openBrowserArtifactDirectory(options.homePath); await capacity(directory);
    temporary = await childDirectory(directory, temporaryName, true);
    unsubscribe = options.client.onEvent(event => {
      if (event.method === 'Browser.downloadWillBegin') void begin(event);
      if (event.method === 'Browser.downloadProgress' && typeof event.params.guid === 'string' && captures.has(event.params.guid)) {
        const { receivedBytes, totalBytes, state } = event.params;
        const capture = captures.get(event.params.guid)!;
        if (![receivedBytes, totalBytes].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BYTES)) {
          if (captures.size > 1 || recoveryReason) recover('multiple_chrome_downloads'); else fail(unavailable());
        }
        else {
          capture.receivedBytes = receivedBytes;
          if ([...captures.values()].reduce((sum, item) => sum + item.receivedBytes, 0) > MAX_BYTES) recover('multiple_chrome_downloads');
          if (state === 'canceled') { capture.terminal = true; fail(unavailable()); }
          else if (state === 'completed') {
            capture.terminal = true;
            if (event.params.guid === guid) { complete = true; if (validated) finish(); }
          }
        }
      }
    });
    options.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail(unavailable()), Math.min(20_000, Math.max(1, options.timeoutMs ?? 20_000)));
    options.signal.throwIfAborted();
    configured = true;
    options.onCollectingChange?.(true);
    // Linux pins the path to the held directory inode across process boundaries.
    const downloadPath = process.platform === 'linux' ? `/proc/${process.pid}/fd/${temporary.fd.fd}` : temporary.canonical;
    await options.client.request('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
    await options.trigger(); await completion;
    if (options.signal.aborted) recoveryReason ??= 'completed_cancelled';
    options.signal.throwIfAborted();
    if (!guid || recoveryReason) throw unavailable();
    let stored: Awaited<ReturnType<typeof storeOriginal>>;
    try { stored = await storeOriginal(directory, temporary, guid, options.documentId); }
    catch (error) {
      // Chrome has acknowledged a complete original, but Matrix could not make
      // its durable copy. Retain the GUID source for bounded owner recovery.
      recoveryReason = 'original_store_failed';
      throw error;
    }
    return { ...stored, documentId: options.documentId, sourceUrl, retrievedAt: new Date().toISOString(), original: true };
  } catch (error) {
    if (guid && !complete && !recoveryReason) await options.client.request('Browser.cancelDownload', { guid }).catch(report);
    if (!(error instanceof SharedBrowserError)) console.warn('[shared-browser] Original download unavailable', error instanceof Error ? 'download_failed' : 'operation_failed');
    throw unavailable();
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', onAbort);
    let restoreFailed = false;
    if (configured) {
      try {
        await recoveryDeny;
        if (recoveryReason) {
          const overflowDrained = await drainOverflow();
          const capturedDrained = await cancelCaptured();
          if (!overflowDrained || !capturedDrained) restoreFailed = true;
        }
        const restoreBehavior = options.restoreBehavior ?? 'default';
        await options.client.request('Browser.setDownloadBehavior', { behavior: restoreBehavior, eventsEnabled: restoreBehavior === 'deny' });
        // A second begin event can arrive while the final reset is awaiting its ACK.
        await recoveryDeny;
        if (recoveryReason) {
          const overflowDrained = await drainOverflow();
          const capturedDrained = await cancelCaptured();
          if (!overflowDrained || !capturedDrained) restoreFailed = true;
        }
      }
      catch (error) { report(error); restoreFailed = true; }
    }
    unsubscribe?.(); options.onCollectingChange?.(false);
    let recoveryPath: string | undefined;
    try {
      if (directory && temporary && recoveryReason) {
        await assertDirectory(directory); await assertDirectory(temporary);
        const name = `recovery-${randomUUID()}`;
        // Protect the only completed copy from the temporary sweep before any
        // metadata write that may fail on a full or unavailable filesystem.
        await rename(join(directory.access, temporaryName), join(directory.access, name));
        temporary = directories(temporary.fd, join(directory.canonical, name));
        recoveryPath = `data/browser-artifacts/${name}`;
        const manifest = await open(join(temporary.access, 'recovery.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await manifest.writeFile(JSON.stringify({ reason: recoveryReason, createdAt: new Date().toISOString(), ownerReviewRequired: true })); await manifest.sync(); }
        finally { await manifest.close(); }
      } else if (directory && temporary) await removeTemporary(directory, temporary, temporaryName);
    }
    catch (error) { report(error); }
    finally { await temporary?.fd.close(); await directory?.fd.close(); }
    if (restoreFailed) throw unavailable();
    if (recoveryPath) return { recoveryPath };
  }
}
