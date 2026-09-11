import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function download({
  existing = false,
  broken = false,
  empty = false,
  chunks,
}: {
  existing?: boolean;
  broken?: boolean;
  empty?: boolean;
  chunks?: string[];
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-broker-download-'));
  directories.push(directory);
  const destination = join(directory, 'latest');
  if (existing) writeFileSync(destination, 'old snapshot');
  // Exercise the shipped CLI in a real subprocess with real file handles. No network/credentials.
  const downloadBody = broken
    ? "new ReadableStream({start(c){c.error(new Error('private storage failure'));}})"
    : chunks
      ? `new ReadableStream({start(c){for(const chunk of ${JSON.stringify(chunks)}) c.enqueue(new TextEncoder().encode(chunk));c.close();}})`
      : JSON.stringify(empty ? '' : 'system/runtime-slots/pr-1502/db/snapshots/2026-09-09T1200Z.dump\n');
  const stub = `globalThis.fetch = async (url) => {
    if (String(url).endsWith('/presign/get')) return Response.json({url:'https://download.test/snapshot'});
    return new Response(${downloadBody});
  };`;
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(stub)}`,
    resolve('distro/customer-vps/host-bin/matrix-r2-broker.mjs'),
    'get', 'system/runtime-slots/pr-1502/db/latest', destination,
  ], {
    encoding: 'utf8', timeout: 5_000,
    env: {
      MATRIX_HANDLE: 'pr-1502', PLATFORM_INTERNAL_URL: 'https://platform.test',
      UPGRADE_TOKEN: 'test-only-token-not-a-real-credential',
    },
  });
  return { directory, destination, result };
}

describe('host R2 download completion', () => {
  it.each([false, true])('commits the destination before successful exit (existing=%s)', (existing) => {
    const { directory, destination, result } = download({ existing });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe('system/runtime-slots/pr-1502/db/snapshots/2026-09-09T1200Z.dump\n');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['latest']);
  });

  it('completes empty downloads without leaving a temporary file', () => {
    const { directory, destination, result } = download({ empty: true });
    expect(result.status).toBe(0);
    expect(readFileSync(destination).length).toBe(0);
    expect(readdirSync(directory)).toEqual(['latest']);
  });

  it('preserves ordering across multiple successful response chunks', () => {
    const chunks = [
      'system/runtime-slots/pr-1502/',
      'db/snapshots/',
      '2026-09-09T1200Z.dump\n',
    ];
    const { directory, destination, result } = download({ chunks });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe(chunks.join(''));
    expect(readdirSync(directory)).toEqual(['latest']);
  });

  it('preserves the previous file and cleans up when streaming fails', () => {
    const { directory, destination, result } = download({ existing: true, broken: true });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matrix-r2-broker: operation failed');
    expect(result.stderr).not.toContain('private storage failure');
    expect(readFileSync(destination, 'utf8')).toBe('old snapshot');
    expect(readdirSync(directory)).toEqual(['latest']);
  });
});
