import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scanner = resolve('scripts/review/check-patterns.sh');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function scan(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'matrix-pattern-proof-')); directories.push(root);
  await mkdir(join(root, 'packages/workspace-worker/src'), { recursive: true });
  await mkdir(join(root, 'shell'));
  await writeFile(join(root, 'packages/workspace-worker/src/index.ts'), source);
  const result = spawnSync('bash', [scanner], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  return result;
}
describe('Worker fetch pattern classification', () => {
  it('accepts an inbound Worker handler and local Hono dispatch', async () => {
    const result = await scan(`export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const app = createWorkspaceRoutes({});
    return await app.fetch(request);
  },
};`);
    expect(result.status, result.stdout).toBe(0);
  });
  it('still rejects an unbounded outbound fetch inside that Worker handler', async () => {
    const result = await scan(`export default {
  async fetch(request: Request): Promise<Response> {
    const result = await fetch('https://external.example/api');
    return result;
  },
};`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fetch() without signal');
  });
  it('accepts a real outbound fetch with its explicit timeout', async () => {
    expect((await scan("const result = await fetch('https://external.example/api', { signal: AbortSignal.timeout(10000) });")).status).toBe(0);
  });
  it('does not exempt arbitrary app.fetch calls outside the known Hono dispatch', async () => {
    const result = await scan("const result = await app.fetch(new Request('https://external.example/api')); ");
    expect(result.status).toBe(1);
  });
});
