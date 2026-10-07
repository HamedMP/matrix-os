import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { createApp } from '../../packages/platform/src/main.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';
describe('platform Gmail callback and consent launcher routing', () => {
  let db: PlatformDB;
  beforeEach(async () => { db = await setupProxyRoutingTest(); });
  afterEach(async () => { vi.unstubAllGlobals(); await cleanupProxyRoutingTest(db); });
  it('keeps Gmail consent state through unauthenticated fallback sign-in and session exchange', async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff138', clerkUserId: 'user_alice', handle: 'alice',
      runtimeSlot: 'primary', status: 'running', hetznerServerId: 123482, publicIPv4: '203.0.113.33',
      imageVersion: 'matrix-os-host-fixture', serverType: 'cpx22', provisionedAt: '2026-05-31T12:00:00.000Z',
    });
    const state = 'a'.repeat(41) + '_-';
    const target = `/auth/gmail?state=${state}`;
    const backend = vi.fn(async () => { throw new Error('Auth shell unavailable'); });
    vi.stubGlobal('fetch', backend);
    const launch = vi.fn();
    const launchRoutes = new Hono().get('/gmail', c => { launch(); return c.json({ owner: c.get('platformUserId') }); });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret', gmailLaunchRoutes: launchRoutes,
      env: { MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'false', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_matrix' },
      clerkAuth: createClerkAuth({ verifyToken: async token => {
        if (token !== 'clerk-fixture') throw new Error('invalid token');
        return { sub: 'user_alice' };
      } }) });
    const response = await app.request(`${target}&owner=other&scope=mail&client_id=private`, { headers: { host: 'app.matrix-os.com' } });
    expect(response.status).toBe(200);
    const html = await response.text();
    const encodedTarget = /var redirectTarget = ("[^"\n]+");/.exec(html)?.[1];
    expect(encodedTarget).toBe(JSON.stringify(target));
    expect(html).toContain("fetch('/api/auth/app-session'");
    expect(backend).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    const exchange = await app.request('/api/auth/app-session', { method: 'POST',
      headers: { host: 'app.matrix-os.com', authorization: 'Bearer clerk-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ redirectTo: JSON.parse(encodedTarget!) }) });
    expect(exchange.status).toBe(200);
    const exchanged = await exchange.json();
    expect(exchanged).toEqual({ redirectTo: target });
    const launched = await app.request(exchanged.redirectTo, { headers: { host: 'app.matrix-os.com', authorization: 'Bearer clerk-fixture' } });
    expect(launched.status).toBe(200); expect(await launched.json()).toEqual({ owner: 'user_alice' });
    expect(launch).toHaveBeenCalledOnce();
  });
  it('serves authenticated consent launch on the platform with the verified identity', async () => {
    const backend = vi.fn(async () => new Response('unexpected proxy'));
    vi.stubGlobal('fetch', backend);
    const launch = new Hono().get('/gmail', c => c.json({ owner: c.get('platformUserId') }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret', gmailLaunchRoutes: launch,
      clerkAuth: createClerkAuth({ verifyToken: async token => {
        if (token !== 'clerk-fixture') throw new Error('invalid token');
        return { sub: 'user_alice' };
      } }) });
    const response = await app.request('/auth/gmail?state=opaque', { headers: { host: 'app.matrix-os.com', authorization: 'Bearer clerk-fixture' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ owner: 'user_alice' });
    expect(backend).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('permits only the exact GET callback without a Matrix session', async () => {
    const callback = vi.fn();
    const routes = new Hono().get('/gmail/oauth/callback', c => { callback(); return c.json({ checkedStoredProof: true }); });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret', integrationRoutes: routes,
      clerkAuth: createClerkAuth({ verifyToken: async () => { throw new Error('not authenticated'); } }) });
    const headers = { host: 'app.matrix-os.com' };
    expect((await app.request('/api/integrations/gmail/oauth/callback?state=opaque&code=code', { headers })).status).toBe(200);
    expect((await app.request('/api/integrations/gmail/oauth/callback', { method: 'POST', headers })).status).toBe(401);
    expect((await app.request('/api/integrations/gmail/oauth/callback/extra', { headers })).status).toBe(401);
    expect(callback).toHaveBeenCalledOnce();
  });
  it('returns a safe unavailable response for a missing callback dependency', async () => {
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret',
      clerkAuth: createClerkAuth({ verifyToken: async () => { throw new Error('not authenticated'); } }) });
    const response = await app.request('/api/integrations/gmail/oauth/callback?state=opaque', { headers: { host: 'app.matrix-os.com' } });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'integrations_unavailable' });
  });
});
