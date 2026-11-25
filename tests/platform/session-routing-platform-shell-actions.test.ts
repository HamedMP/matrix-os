import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * A page rendered by the platform's auth shell can post a Next server action
 * (Clerk's post-sign-in cache invalidation) to "/" after the owner's computer
 * became routable. Routed to the runtime, whose build does not know that
 * action, it answered 500 (live, khorma38 19:26:14Z). Pages the auth shell
 * serves now set a short-lived cookie, and server actions carrying it go back
 * to the auth shell. Faults detected: the 500, and the cookie misrouting
 * ordinary POSTs or runtime-page actions.
 */

const AUTH_SHELL = 'http://127.0.0.1:3200';
const CLERK = { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' };
const COOKIE = 'matrix_platform_shell=1';

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

  it('marks a document the auth shell serves with a short-lived, HttpOnly, Lax cookie', async () => {
    const res = await platform().request('/', { headers: CLERK });

    expect(upstreamOf(fetchMock.mock.calls[0]!)).toBe(`${AUTH_SHELL}/`);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('matrix_platform_shell=1');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('routes a server action carrying the cookie to the auth shell, even when the computer is running', async () => {
    await runningMachine();

    await platform().request('/', {
      method: 'POST', headers: { ...CLERK, cookie: COOKIE, 'next-action': 'abc123', 'content-type': 'text/plain' }, body: '[]',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upstreamOf(fetchMock.mock.calls[0]!)).toBe(`${AUTH_SHELL}/`);
  });

  it('routes a server action without the cookie to the runtime', async () => {
    await runningMachine();

    await platform().request('/', {
      method: 'POST', headers: { ...CLERK, 'next-action': 'abc123', 'content-type': 'text/plain' }, body: '[]',
    });

    expect(upstreamOf(fetchMock.mock.calls[0]!)).toContain('203.0.113.50');
  });

  it('leaves an ordinary POST with the cookie on the runtime', async () => {
    await runningMachine();

    await platform().request('/api/projects', {
      method: 'POST', headers: { ...CLERK, cookie: COOKIE, 'content-type': 'application/json' }, body: '{}',
    });

    expect(upstreamOf(fetchMock.mock.calls[0]!)).toContain('203.0.113.50');
  });

  it('clears the cookie when the runtime serves a document', async () => {
    await runningMachine();

    const res = await platform().request('/', { headers: { ...CLERK, cookie: COOKIE } });

    expect(upstreamOf(fetchMock.mock.calls[0]!)).toContain('203.0.113.50');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/matrix_platform_shell=; [^,]*Max-Age=0/);
  });
});
