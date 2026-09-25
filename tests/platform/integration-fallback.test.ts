import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import { insertContainer, type PlatformDB } from '../../packages/platform/src/db.js';
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

  it('binds Preview personal integration requests to each authenticated actor', async () => {
    await insertContainer(db, {
      handle: 'engineer', clerkUserId: 'user_engineer',
      port: 5002, shellPort: 6002, status: 'running',
    });
    const routes = new Hono().get('/', c => c.json({ actorId: c.get('platformUserId') }));
    const server = app(routes);
    const engineerToken = (await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: 'user_engineer',
      handle: 'engineer',
      gatewayUrl: 'https://app.matrix-os.com',
    })).token;
    const path = '/api/integrations?runtime=pr-1304';

    const owner = await server.request(path, { headers: headers() });
    const engineer = await server.request(path, {
      headers: { host: 'app.matrix-os.com', authorization: `Bearer ${engineerToken}` },
    });

    expect(owner.status).toBe(200);
    expect(engineer.status).toBe(200);
    expect(await owner.json()).toEqual({ actorId: 'user_alice' });
    expect(await engineer.json()).toEqual({ actorId: 'user_engineer' });
  });

  it('preserves configured routes', async () => {
    const routes = new Hono().get('/', c => c.json([{ id: 'existing' }]));
    const response = await app(routes).request('/api/integrations', { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'existing' }]);
  });
});
