import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

// The platform Next build emits this ID on its Server Action requests.
const AUTH_SHELL = 'http://127.0.0.1:3200';
const RUNTIME = 'https://203.0.113.50:443';
const CLERK = { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' };
const AUTH_DEPLOYMENT = '__platform-shell-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUTH_ACTION = { ...CLERK, 'next-action': 'abc123', 'x-deployment-id': AUTH_DEPLOYMENT, 'content-type': 'text/plain' };

describe('server actions from platform auth-shell pages', () => {
  let db: PlatformDB;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  function platform() {
    return createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
    });
  }

  async function runningMachine() {
    await insertUserMachine(db, {
      machineId: 'machine-alice', clerkUserId: 'user_alice', handle: 'alice', status: 'running',
      hetznerServerId: 4242, publicIPv4: '203.0.113.50', imageVersion: 'matrix-os-host-dev', provisionedAt: '2026-11-01T00:00:00.000Z',
    });
  }

  function upstreamOf(call: unknown[]): string {
    return String(call[0]);
  }

  it.each(['/', '/vm/alice/'])('finishes an auth-shell action after another tab opens %s', async (path) => {
    const app = platform();
    const authPage = await app.request('/', { headers: CLERK });
    expect(authPage.status).toBe(200);
    expect(upstreamOf(fetchMock.mock.calls[0]!)).toBe(`${AUTH_SHELL}/`);

    await runningMachine();
    const oldMarker = authPage.headers.getSetCookie()
      .find((cookie) => cookie.startsWith('matrix_platform_shell='))?.split(';')[0];
    const computerPage = await app.request(path, { headers: oldMarker ? { ...CLERK, cookie: oldMarker } : CLERK });
    expect(computerPage.status).toBe(200);
    expect(upstreamOf(fetchMock.mock.calls[1]!)).toBe(`${RUNTIME}/`);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (input: unknown) => String(input).startsWith(AUTH_SHELL)
      ? new Response('auth-shell-ok', { headers: { 'content-type': 'text/x-component' } })
      : new Response('Internal Server Error', { status: 500 }));

    const action = await app.request('/', { method: 'POST', headers: AUTH_ACTION, body: '[]' });
    expect({ status: action.status, destinations: fetchMock.mock.calls.map(upstreamOf) })
      .toEqual({ status: 200, destinations: [`${AUTH_SHELL}/`] });
    expect(await action.text()).toBe('auth-shell-ok');
    const forwarded = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(forwarded.headers).get('x-deployment-id')).toBe(AUTH_DEPLOYMENT);
    expect(await new Response(forwarded.body).text()).toBe('[]');
  });

  it('leaves ordinary POSTs on the runtime even with the auth-shell deployment ID', async () => {
    await runningMachine();
    await platform().request('/api/projects', {
      method: 'POST', headers: { ...CLERK, 'x-deployment-id': AUTH_DEPLOYMENT }, body: '{}',
    });
    expect(fetchMock.mock.calls.map(upstreamOf)).toEqual([`${RUNTIME}/api/projects`]);
  });

  it.each(['/vm/alice/', '/api', '/api/projects', '/gateway/api/projects'])(
    'keeps %s on the runtime even if an action claims the auth-shell deployment ID',
    async (path) => {
      await runningMachine();
      const res = await platform().request(path, { method: 'POST', headers: AUTH_ACTION, body: '[]' });
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls.map(upstreamOf))
        .toEqual([`${RUNTIME}${path === '/vm/alice/' ? '/' : path}`]);
    },
  );

  it('keeps a runtime action on the runtime even after an auth-shell page opens', async () => {
    const app = platform();
    await app.request('/runtime', { headers: CLERK });
    expect(upstreamOf(fetchMock.mock.calls[0]!)).toBe(`${AUTH_SHELL}/runtime`);
    await runningMachine();
    fetchMock.mockClear();

    const res = await app.request('/', {
      method: 'POST', headers: { ...AUTH_ACTION, 'x-deployment-id': 'customer-build', cookie: 'matrix_platform_shell=1' }, body: '[]',
    });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map(upstreamOf)).toEqual([`${RUNTIME}/`]);
  });

  it.each([
    { deploymentId: AUTH_DEPLOYMENT, upstream: AUTH_SHELL },
    { deploymentId: 'customer-build', upstream: RUNTIME },
  ])('keeps a missing action on its own shell ($deploymentId)', async ({ deploymentId, upstream }) => {
    await runningMachine();
    fetchMock.mockImplementation(async () =>
      new Response('Action unavailable', { status: 409, headers: { 'x-nextjs-action-not-found': '1' } }));

    const res = await platform().request('/', {
      method: 'POST', headers: { ...AUTH_ACTION, 'x-deployment-id': deploymentId }, body: '[]',
    });
    expect(res.status).toBe(409);
    expect(fetchMock.mock.calls.map(upstreamOf)).toEqual([`${upstream}/`]);
  });
});
