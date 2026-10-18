import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const clerk = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: clerk.auth }));
import { GET } from '../../shell/src/app/workspace/api/[...path]/route';
const entries = [
  { ownerId: 'user_hamed', handle: 'hamed', origin: 'https://hamed-pilot.workers.dev', token: 'h'.repeat(48) },
  { ownerId: 'user_nima', handle: 'nima', origin: 'https://nima-pilot.workers.dev', token: 'n'.repeat(48) },
];
const context = { params: Promise.resolve({ path: ['api', 'shell', 'bootstrap'] }) };
beforeEach(() => {
  vi.stubEnv('MATRIX_SHARED_WORKSPACE_SPIKE', '1');
  vi.stubEnv('MATRIX_STARTER_COMPUTERS', JSON.stringify(entries));
  vi.stubEnv('MATRIX_SHARED_WORKSPACE_ORIGIN', 'https://legacy-pilot.workers.dev');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('owner-bound Starter forwarding', () => {
  it.each(entries)('routes $handle only to its own Worker and private token', async (entry) => {
    clerk.auth.mockResolvedValue({ userId: entry.ownerId, getToken: async () => 'clerk-session' });
    const fetcher = vi.fn().mockResolvedValue(Response.json({ revision: 1 })); vi.stubGlobal('fetch', fetcher);
    const response = await GET(new Request('https://app.test/workspace/api/api/shell/bootstrap', { headers: { 'x-owner-id': 'user_other', authorization: 'Bearer forged' } }), context);
    expect(response.status).toBe(200);
    const [target, init] = fetcher.mock.calls[0]!;
    expect(target.origin).toBe(entry.origin);
    expect(init.headers.get('authorization')).toBe(`Bearer ${entry.token}`);
    expect(await response.text()).not.toContain(entry.token);
  });
  it('rejects unconfigured users without falling back to the old preview', async () => {
    clerk.auth.mockResolvedValue({ userId: 'user_other', getToken: async () => 'clerk-session' });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await GET(new Request('https://app.test/workspace/api/api/shell/bootstrap', { headers: { 'x-owner-id': 'user_hamed' } }), context);
    expect(response.status).toBe(404); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    '{invalid',
    JSON.stringify([entries[0], { ...entries[1], origin: entries[0].origin }]),
    JSON.stringify([entries[0], { ...entries[1], token: entries[0].token }]),
    JSON.stringify([{ ...entries[0], origin: 'http://untrusted.test' }]),
  ])('fails closed for invalid or shared credentials/origins', async (registry) => {
    vi.stubEnv('MATRIX_STARTER_COMPUTERS', registry);
    clerk.auth.mockResolvedValue({ userId: 'user_hamed', getToken: async () => 'clerk-session' });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await GET(new Request('https://app.test/workspace/api/api/shell/bootstrap'), context)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
