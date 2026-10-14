import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { collectChromeDownload, cleanupDownloadTemps } from '../../packages/gateway/src/shared-browser/cdp-downloads.js';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function rig() {
  const homePath = await mkdtemp(join(tmpdir(), 'cdp-download-')); homes.push(homePath);
  const callbacks = new Set<(event: any) => void>(); const messages: any[] = [];
  let path = '';
  const client = { request: async (method: string, params: any) => { messages.push({ method, params }); if (params.downloadPath) path = params.downloadPath; return {}; },
    onEvent: (callback: (event: any) => void) => { callbacks.add(callback); return () => callbacks.delete(callback); } };
  const emit = (method: string, params: any) => { for (const callback of callbacks) callback({ method, params }); };
  const original = Buffer.from('%PDF-1.4\nsynthetic original invoice\n%%EOF');
  const trigger = async () => { await writeFile(join(path, 'invoice-guid-123'), original); emit('Browser.downloadWillBegin', { frameId: 'agent-frame', guid: 'invoice-guid-123', url: 'http://127.0.0.1:8730/invoices/original.pdf?private=token' }); emit('Browser.downloadProgress', { guid: 'invoice-guid-123', receivedBytes: original.length, totalBytes: original.length, state: 'completed' }); };
  const options = { homePath, client, frameId: 'agent-frame', documentId: 'INV-001', sourceUrl: 'http://127.0.0.1:8730/invoices/original.pdf?private=token', signal: new AbortController().signal, trigger, timeoutMs: 100 };
  return { options, homePath, messages, emit, original, trigger, downloadPath: () => path };
}
it('preserves verified original bytes, strips source secrets, deduplicates and restores Chrome defaults', async () => {
  const { options, homePath, original, messages } = await rig();
  const artifact = await collectChromeDownload(options);
  if ('recoveryPath' in artifact) throw new Error('Unexpected recovery');
  expect(artifact).toMatchObject({ documentId: 'INV-001', size: original.length, sha256: createHash('sha256').update(original).digest('hex'), original: true, sourceUrl: 'http://127.0.0.1:8730/invoices/original.pdf' });
  expect(await readFile(join(homePath, artifact.path))).toEqual(original);
  expect(await collectChromeDownload(options)).toMatchObject({ path: artifact.path, sha256: artifact.sha256 });
  expect(await readdir(join(homePath, 'data/browser-artifacts'))).toEqual([artifact.path.split('/').at(-1)]);
  expect(messages.at(-1)).toMatchObject({ method: 'Browser.setDownloadBehavior', params: { behavior: 'default', eventsEnabled: false } });
});
it('cancels oversized and incomplete downloads, removes temporary files and restores defaults', async () => {
  for (const oversized of [true, false]) {
    const { options, homePath, emit, messages } = await rig();
    options.trigger = async () => { emit('Browser.downloadWillBegin', { frameId: 'agent-frame', guid: 'invoice-guid-123', url: options.sourceUrl }); if (oversized) emit('Browser.downloadProgress', { guid: 'invoice-guid-123', receivedBytes: 10 * 1024 * 1024 + 1, totalBytes: 0, state: 'inProgress' }); };
    await expect(collectChromeDownload(options)).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(messages.some(message => message.method === 'Browser.cancelDownload')).toBe(true);
    expect(await readdir(join(homePath, 'data/browser-artifacts'))).toEqual([]);
    expect(messages.at(-1)?.params.behavior).toBe('default');
  }
});
it('rejects symlinked owner artifact parents before changing Chrome download behavior', async () => {
  const { options, homePath, messages } = await rig();
  await symlink(tmpdir(), join(homePath, 'data'));
  await expect(collectChromeDownload(options)).rejects.toMatchObject({ code: 'browser_unavailable' });
  expect(messages).toEqual([]);
});
it('preserves an unrelated tab download as bounded owner recovery data without reading or deleting it', async () => {
  const { options, homePath, trigger, emit } = await rig();
  options.trigger = async () => {
    await trigger();
    emit('Browser.downloadWillBegin', { frameId: 'owner-private-frame', guid: 'owner-download-guid', url: 'https://private.invalid/?token=private' });
  };
  const result = await collectChromeDownload(options);
  expect(result).toHaveProperty('recoveryPath');
  const recoveryPath = (result as { recoveryPath: string }).recoveryPath;
  expect(recoveryPath).toMatch(/^data\/browser-artifacts\/recovery-[a-f0-9-]{36}$/);
  const manifest = await readFile(join(homePath, recoveryPath, 'recovery.json'), 'utf8');
  expect(manifest).toContain('another_chrome_tab'); expect(manifest).not.toContain('private');
  expect(await readdir(join(homePath, recoveryPath))).toContain('invoice-guid-123');
});
it('preserves all same-frame originals and hands off when one click starts multiple downloads', async () => {
  for (const firstComplete of [false, true]) {
    const { options, homePath, emit, original, messages, downloadPath } = await rig();
    const second = Buffer.from('%PDF-1.4\nsecond original invoice\n%%EOF');
    options.trigger = async () => {
      await writeFile(join(downloadPath(), 'invoice-guid-123'), original);
      emit('Browser.downloadWillBegin', { frameId: 'agent-frame', guid: 'invoice-guid-123', url: options.sourceUrl });
      if (firstComplete) emit('Browser.downloadProgress', { guid: 'invoice-guid-123', receivedBytes: original.length, totalBytes: original.length, state: 'completed' });
      await writeFile(join(downloadPath(), 'invoice-guid-456'), second);
      emit('Browser.downloadWillBegin', { frameId: 'agent-frame', guid: 'invoice-guid-456', url: options.sourceUrl });
      emit('Browser.downloadProgress', { guid: 'invoice-guid-456', receivedBytes: second.length, totalBytes: second.length, state: 'completed' });
      if (!firstComplete) emit('Browser.downloadProgress', { guid: 'invoice-guid-123', receivedBytes: original.length, totalBytes: original.length, state: 'completed' });
    };
    const result = await collectChromeDownload(options);
    expect(result).toHaveProperty('recoveryPath');
    if (!('recoveryPath' in result)) throw new Error('Unacknowledged originals were reported as one successful download');
    expect(await readFile(join(homePath, result.recoveryPath, 'invoice-guid-123'))).toEqual(original);
    expect(await readFile(join(homePath, result.recoveryPath, 'invoice-guid-456'))).toEqual(second);
    expect(JSON.parse(await readFile(join(homePath, result.recoveryPath, 'recovery.json'), 'utf8'))).toMatchObject({ reason: 'multiple_chrome_downloads', ownerReviewRequired: true });
    expect(messages.at(-1)?.params).toMatchObject({ behavior: 'default', eventsEnabled: false });
    expect(messages.some(message => message.method === 'Browser.cancelDownload')).toBe(false);
  }
});
it('preserves a later same-frame original arriving after the first completed during default restoration', async () => {
  const { options, homePath, emit, original, downloadPath } = await rig();
  const second = Buffer.from('%PDF-1.4\nlate original invoice\n%%EOF');
  const request = options.client.request; let captured = false;
  options.client.request = async (method, params) => {
    const result = await request(method, params);
    if (params.behavior === 'default' && !captured) {
      captured = true;
      await writeFile(join(downloadPath(), 'invoice-guid-later'), second);
      emit('Browser.downloadWillBegin', { frameId: 'agent-frame', guid: 'invoice-guid-later', url: options.sourceUrl });
      emit('Browser.downloadProgress', { guid: 'invoice-guid-later', receivedBytes: second.length, totalBytes: second.length, state: 'completed' });
    }
    return result;
  };
  const result = await collectChromeDownload(options);
  expect(result).toHaveProperty('recoveryPath');
  if (!('recoveryPath' in result)) throw new Error('Late original was reported as successful single download');
  expect(await readFile(join(homePath, result.recoveryPath, 'invoice-guid-123'))).toEqual(original);
  expect(await readFile(join(homePath, result.recoveryPath, 'invoice-guid-later'))).toEqual(second);
});
it('does not turn a repeated first download notification into multiple-download recovery', async () => {
  const { options, emit, trigger } = await rig();
  options.trigger = async () => {
    await trigger();
    emit('Browser.downloadWillBegin', { frameId: 'agent-frame', guid: 'invoice-guid-123', url: options.sourceUrl });
  };
  expect(await collectChromeDownload(options)).toHaveProperty('original', true);
});
it('removes only expired real download directories and preserves fresh files, artifacts and symlink targets', async () => {
  const { homePath } = await rig(); const parent = join(homePath, 'data/browser-artifacts'); await mkdir(parent, { recursive: true });
  const old = join(parent, '.download-00000000-0000-4000-8000-000000000001');
  const fresh = join(parent, '.download-00000000-0000-4000-8000-000000000002');
  const link = join(parent, '.download-00000000-0000-4000-8000-000000000003');
  await mkdir(old); await writeFile(join(old, 'invoice-guid'), '%PDF-original'); await mkdir(fresh);
  await symlink(tmpdir(), link); await writeFile(join(parent, 'verified.pdf'), '%PDF-existing');
  await utimes(old, new Date(0), new Date(0)); await cleanupDownloadTemps(homePath);
  expect(await readdir(parent)).toEqual(expect.arrayContaining([fresh.split('/').at(-1), link.split('/').at(-1), 'verified.pdf']));
  expect(await readdir(parent)).not.toContain(old.split('/').at(-1));
});
