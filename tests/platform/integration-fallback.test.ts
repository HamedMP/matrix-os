import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createApiClient } from '../../desktop/src/renderer/src/lib/api.js';
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';

describe('unconfigured managed integrations', () => {
  let db: PlatformDB;
  let token: string;
  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    db = await setupProxyRoutingTest();
    token = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice', handle: 'alice', gatewayUrl: 'https://app.matrix-os.com' })).token;
  });
  afterEach(async () => { await cleanupProxyRoutingTest(db); });
  const headers = () => ({ host: 'app.matrix-os.com', authorization: `Bearer ${token}` });
  const app = (integrationRoutes?: Hono) => createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret', integrationRoutes });

  it('reports unavailable instead of expiring a valid desktop session during startup', async () => {
    const server = app();
    const response = await server.request('/api/integrations', { headers: headers() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'integrations_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const onUnauthorized = vi.fn();
    const client = createApiClient({ baseUrl: 'https://app.matrix-os.com', getRuntimeSlot: () => 'primary', onUnauthorized,
      fetchFn: (url, init) => server.request(url, { ...init, headers: headers() }),
    });
    await expect(client.get('/api/integrations')).rejects.toMatchObject({ category: 'server' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('still rejects unauthenticated requests', async () => {
    expect((await app().request('/api/integrations', { headers: { host: 'app.matrix-os.com' } })).status).toBe(401);
  });

  it('contains nested routes and rejects oversized mutation bodies', async () => {
    const server = app();
    expect((await server.request('/api/integrations/missing', { method: 'DELETE', headers: headers() })).status).toBe(503);
    expect((await server.request('/api/integrations/missing', { method: 'DELETE', headers: { ...headers(), 'content-length': String(65537) }, body: 'x'.repeat(65537) })).status).toBe(413);
  });

  it('returns unavailable for public discovery without requiring a login', async () => {
    expect((await app().request('/api/integrations/available', { headers: { host: 'app.matrix-os.com' } })).status).toBe(503);
  });

  it('preserves configured routes', async () => {
    const routes = new Hono().get('/', c => c.json([{ id: 'existing' }]));
    const response = await app(routes).request('/api/integrations', { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'existing' }]);
  });
});
