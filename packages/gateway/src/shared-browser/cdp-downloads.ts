import { constants } from 'node:fs';
import { mkdir, open, realpath, readdir, unlink, rmdir, opendir, rename, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SharedBrowserActionResult } from '@matrix-os/contracts';
import type { BrowserCdpClient, CdpEvent } from './cdp-client.js';
import { SharedBrowserError } from './broker.js';
import { validateBrowserUrl, type BrowserResolver } from './url-policy.js';

const MAX_BYTES = 10 * 1024 * 1024;
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
  resolveHost?: BrowserResolver; timeoutMs?: number;
}): Promise<NonNullable<SharedBrowserActionResult['artifact']> | { recoveryPath: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.documentId) || options.signal.aborted) throw unavailable();
  const checked = await validateBrowserUrl(options.sourceUrl, options.resolveHost);
  let directory: Directory | undefined, temporary: Directory | undefined;
  const temporaryName = `.download-${randomUUID()}`;
  let guid: string | undefined, sourceUrl = checked.sourceUrl, validated = false, complete = false, configured = false;
  let recoveryReason: 'another_chrome_tab' | 'multiple_chrome_downloads' | undefined;
  let recoveryRestore: Promise<unknown> | undefined;
  let unsubscribe: (() => unknown) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Setup/click may await commands while Chrome emits download events.
  void completion.catch(error => console.warn('[shared-browser] Original download unavailable',
    error instanceof SharedBrowserError ? error.code : 'operation_failed'));
  const onAbort = () => fail(unavailable());
  const recover = (reason: NonNullable<typeof recoveryReason>) => {
    recoveryReason ??= reason;
    // Stop redirecting subsequent downloads, retaining every file already
    // captured in this directory for owner review rather than picking one.
    recoveryRestore ??= options.client.request('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false });
    void recoveryRestore.catch(report); fail(unavailable());
  };
  const begin = async (event: CdpEvent) => {
    const params = event.params;
    if (params.frameId !== options.frameId) {
      // Chrome's download behavior applies to the shared default context, not
      // one target. Never read or discard another tab's captured download.
      recover('another_chrome_tab'); return;
    }
    if (guid) { if (params.guid !== guid) recover('multiple_chrome_downloads'); return; }
    if (typeof params.guid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(params.guid) || typeof params.url !== 'string') { fail(unavailable()); return; }
    guid = params.guid;
    try { sourceUrl = (await validateBrowserUrl(params.url, options.resolveHost)).sourceUrl; validated = true; if (complete) finish(); }
    catch (error) { if (!(error instanceof SharedBrowserError)) report(error); fail(unavailable()); }
  };
  try {
    directory = await openBrowserArtifactDirectory(options.homePath); await capacity(directory);
    temporary = await childDirectory(directory, temporaryName, true);
    unsubscribe = options.client.onEvent(event => {
      if (event.method === 'Browser.downloadWillBegin') void begin(event);
      if (event.method === 'Browser.downloadProgress' && event.params.guid === guid) {
        const { receivedBytes, totalBytes, state } = event.params;
        if (![receivedBytes, totalBytes].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BYTES) || state === 'canceled') fail(unavailable());
        else if (state === 'completed') { complete = true; if (validated) finish(); }
      }
    });
    options.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail(unavailable()), Math.min(20_000, Math.max(1, options.timeoutMs ?? 20_000)));
    options.signal.throwIfAborted();
    configured = true;
    // Linux pins the path to the held directory inode across process boundaries.
    const downloadPath = process.platform === 'linux' ? `/proc/${process.pid}/fd/${temporary.fd.fd}` : temporary.canonical;
    await options.client.request('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
    await options.trigger(); await completion; options.signal.throwIfAborted();
    if (!guid || recoveryReason) throw unavailable();
    const stored = await storeOriginal(directory, temporary, guid, options.documentId);
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
        await recoveryRestore;
        await options.client.request('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false });
        // A second begin event can arrive while the final reset is awaiting its ACK.
        await recoveryRestore;
      }
      catch (error) { report(error); restoreFailed = true; }
    }
    unsubscribe?.();
    let recoveryPath: string | undefined;
    try {
      if (directory && temporary && recoveryReason) {
        await assertDirectory(directory); await assertDirectory(temporary);
        const name = `recovery-${randomUUID()}`;
        const manifest = await open(join(temporary.access, 'recovery.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await manifest.writeFile(JSON.stringify({ reason: recoveryReason, createdAt: new Date().toISOString(), ownerReviewRequired: true })); await manifest.sync(); }
        finally { await manifest.close(); }
        await rename(join(directory.access, temporaryName), join(directory.access, name));
        recoveryPath = `data/browser-artifacts/${name}`;
      } else if (directory && temporary) await removeTemporary(directory, temporary, temporaryName);
    }
    catch (error) { report(error); }
    finally { await temporary?.fd.close(); await directory?.fd.close(); }
    if (restoreFailed) throw unavailable();
    if (recoveryPath) return { recoveryPath };
  }
}
