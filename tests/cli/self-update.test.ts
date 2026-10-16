import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestCliRelease, updateStandaloneCli } from '../../packages/sync-client/src/cli/self-update.js';
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const version = '0.3.22', asset = `matrix-${version}-linux-x64`, base = `https://github.com/HamedMP/matrix-os/releases/download/cli-v${version}/`;
const script = Buffer.from(`#!/bin/sh\nprintf '${version}\\n'\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const release = { version, assets: [{ name: asset, browser_download_url: base + asset }, { name: asset + '.sha256', browser_download_url: base + asset + '.sha256' }] };
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'matrix-update-test-')); dirs.push(dir); const executable = join(dir, 'matrix'); await writeFile(executable, 'original binary', { mode: 0o755 }); return { dir, executable }; }
function serve(bytes = script, checksum = sha(bytes)) {
  return vi.fn(async (input: string | URL | Request) => new Response(String(input).endsWith('.sha256') ? `${checksum}  ${asset}\n` : bytes));
}
function install(executable: string, fetch = serve()) { return updateStandaloneCli({ executable, release, platform: 'linux', arch: 'x64', fetch: fetch as typeof globalThis.fetch }); }
describe('trusted CLI release selection', () => {
  it('selects the newest stable CLI tag, ignoring OS tags and prereleases', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(input).includes('/git/matching-refs/')
        ? [{ ref: 'refs/tags/v999.0.0' }, { ref: 'refs/tags/cli-v0.3.23-beta.1' }, { ref: 'refs/tags/cli-v0.3.9' }, { ref: 'refs/tags/cli-v0.3.22' }]
        : { tag_name: 'cli-v0.3.22', draft: false, prerelease: false, assets: release.assets }
    )));
    await expect(latestCliRelease(fetch as typeof globalThis.fetch)).resolves.toMatchObject({ version: '0.3.22' });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('finds a CLI even when recent OS releases fill the release feed', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).includes('/git/matching-refs/')
        ? [{ ref: 'refs/tags/cli-v0.3.21' }, { ref: 'refs/tags/cli-v0.3.22' }, { ref: 'refs/tags/cli-v0.3.23-beta.1' }]
        : String(input).endsWith('/releases/tags/cli-v0.3.22')
          ? { tag_name: 'cli-v0.3.22', draft: false, prerelease: false, assets: release.assets }
          : Array.from({ length: 50 }, (_, i) => ({ tag_name: 'v999.0.' + i, draft: false, prerelease: false, assets: [] }))
    )));
    await expect(latestCliRelease(fetch as typeof globalThis.fetch)).resolves.toMatchObject({ version: '0.3.22' });
  });
  it('skips unpublished, draft and prerelease tags to the newest published stable release', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/git/matching-refs/')) return new Response(JSON.stringify(['0.3.26','0.3.25','0.3.24','0.3.23','0.3.22'].map(v => ({ref:'refs/tags/cli-v'+v}))));
      if (url.endsWith('0.3.26')) return new Response('', {status:404});
      return new Response(JSON.stringify({tag_name:'cli-v'+url.split('cli-v')[1],draft:url.endsWith('0.3.25'),prerelease:url.endsWith('0.3.24'),assets:url.endsWith('0.3.23')?[]:release.assets}));
    });
    await expect(latestCliRelease(fetch as typeof globalThis.fetch)).resolves.toMatchObject({version:'0.3.22'});
  });
  it('rejects failed or oversized release metadata', async () => {
    await expect(latestCliRelease((async () => new Response('', { status: 503 })) as typeof globalThis.fetch)).rejects.toThrow();
    await expect(latestCliRelease((async () => new Response('[]', { headers: { 'content-length': '99999999' } })) as typeof globalThis.fetch)).rejects.toThrow();
  });
});
describe('standalone update integrity and atomicity', () => {
  it('verifies checksum/version, replaces the binary and cleans all temporary files', async () => {
    const f = await fixture();
    const fetch = serve();
    await install(f.executable, fetch);
    expect(await readFile(f.executable)).toEqual(script);
    expect(await readdir(f.dir)).toEqual(['matrix']);
    for (const [, init] of fetch.mock.calls as unknown as [
      unknown,
      RequestInit
    ][]) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('leaves the existing binary intact when checksum verification fails', async () => {
    const f = await fixture();
    await expect(install(f.executable, serve(script, '0'.repeat(64)))).rejects.toThrow();
    expect(await readFile(f.executable, 'utf8')).toBe('original binary');
    expect(await readdir(f.dir)).toEqual(['matrix']);
  });
  it('rejects an asset URL outside the exact official release', async () => {
    const f = await fixture();
    const fetch = serve();
    await expect(updateStandaloneCli({ executable: f.executable, release: { ...release, assets: [{ name: asset, browser_download_url: 'https://evil.test/binary' }, release.assets[1]!] }, platform: 'linux', arch: 'x64', fetch: fetch as typeof globalThis.fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects wrong downloaded version before replacing the binary', async () => {
    const f = await fixture();
    await expect(install(f.executable, serve(Buffer.from('#!/bin/sh\nprintf "0.3.1\\n"\n')))).rejects.toThrow();
    expect(await readFile(f.executable, 'utf8')).toBe('original binary');
    expect(await readdir(f.dir)).toEqual(['matrix']);
  });
  it('rolls back when the installed executable fails its final check', async () => {
    const f = await fixture();
    const b = Buffer.from(`#!/bin/sh\n[ "$(basename "$0")" != matrix ] || exit 1\nprintf '${version}\\n'\n`);
    await expect(install(f.executable, serve(b))).rejects.toThrow();
    expect(await readFile(f.executable, 'utf8')).toBe('original binary');
    expect(await readdir(f.dir)).toEqual(['matrix']);
  });
  it('does not overwrite a concurrent update or remove another updater’s lock', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, '.matrix-update.lock'), 'other updater');
    const fetch = serve();
    await expect(install(f.executable, fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(f.dir, '.matrix-update.lock'), 'utf8')).toBe('other updater');
  });
  it('rejects executable symlinks rather than replacing an unrelated target', async () => {
    const f = await fixture();
    const link = join(f.dir, 'other');
    await symlink(f.executable, link);
    const fetch = serve();
    await expect(install(link, fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(f.executable, 'utf8')).toBe('original binary');
  });
  it('detects a target changed while downloading', async () => {
    const f = await fixture();
    const fetch = serve();
    const changing = vi.fn(async (...args: Parameters<typeof fetch>) => { const r = await fetch(...args); await writeFile(f.executable, 'changed by another process'); return r; });
    await expect(install(f.executable, changing)).rejects.toThrow();
    expect(await readFile(f.executable, 'utf8')).toBe('changed by another process');
    expect(await readdir(f.dir)).toEqual(['matrix']);
  });
  it('rejects oversized downloads without replacing the binary', async () => {
    const f = await fixture();
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith('.sha256') ? new Response(`${sha(script)}  ${asset}\n`) : new Response(script, { headers: { 'content-length': '9999999999' } }));
    await expect(install(f.executable, fetch)).rejects.toThrow();
    expect(await readFile(f.executable, 'utf8')).toBe('original binary');
    expect(await readdir(f.dir)).toEqual(['matrix']);
  });
  it('fails closed on unsupported systems', async () => {
    const f = await fixture();
    const fetch = serve();
    await expect(updateStandaloneCli({ executable: f.executable, release, platform: 'win32', arch: 'x64', fetch: fetch as typeof globalThis.fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
