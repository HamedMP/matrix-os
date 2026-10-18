import { describe, expect, it, vi } from 'vitest';
vi.mock('../../packages/workspace-worker/src/runtime/durable-object.js', () => ({WorkspaceRuntime:class {}}));
vi.mock('@cloudflare/sandbox', () => ({DirectoryBackupGateway:class {}}));
import worker from '../../packages/workspace-worker/src/index.js';
describe('Worker deployment boundary', () => {
  it('returns a generic service error when the database binding is missing', async () => {
    const response = await worker.fetch(new Request('https://preview.test/api/shell/bootstrap'), {} as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'Workspace unavailable'});
  });
});
