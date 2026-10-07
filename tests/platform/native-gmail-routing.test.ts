import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { createApp } from '../../packages/platform/src/main.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';
describe('platform Gmail callback and consent launcher routing', () => {
  let db: PlatformDB;
  beforeEach(async () => { db = await setupProxyRoutingTest(); });
  afterEach(async () => { vi.unstubAllGlobals(); await cleanupProxyRoutingTest(db); });
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
