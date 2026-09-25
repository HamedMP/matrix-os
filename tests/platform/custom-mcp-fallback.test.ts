import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import { resolveCustomMcpUserIdForMachine } from '../../packages/platform/src/custom-mcp-route-registration.js';
import { createCustomMcpRoutes } from '../../packages/gateway/src/integrations/custom-mcp/routes.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createIntegrationProxyResponse } from '../../packages/gateway/src/integrations/proxy-response.js';
import { registerCustomMcpGatewayRoutes } from '../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js';
import { createApiClient } from '../../desktop/src/renderer/src/lib/api.js';
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';

const secret = 'platform-secret-123';
const publicPath = '/api/mcp-servers';
const internalPath = '/internal/containers/alice/mcp-servers';

describe('Custom MCP route boundary', () => {
  let db: PlatformDB;
  let userToken: string;
  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    db = await setupProxyRoutingTest();
    userToken = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice', handle: 'alice', gatewayUrl: 'https://app.matrix-os.com' })).token;
  });
  afterEach(async () => { await cleanupProxyRoutingTest(db); });

  function app(enabled = false) {
    const routes = new Hono();
    routes.get('/', (c) => c.json([]));
    routes.get('/oauth/callback', (c) => c.json({
      ok: true,
      code: c.req.query('code'),
      state: c.req.query('state'),
    }));
    return createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret,
      ...(enabled ? { customMcpRoutes: routes, internalCustomMcpRoutes: routes } : {}),
    });
  }
  function headers(internal: boolean) {
    const token = internal ? createHmac('sha256', secret).update('alice').digest('hex') : userToken;
    return { host: 'app.matrix-os.com', authorization: `Bearer ${token}` };
  }

  it('rejects owner-scoped custom MCP access from preview machines', async () => {
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001304',
      clerkUserId: 'user_alice',
      handle: 'pr-1304',
      runtimeSlot: 'pr-1304',
      provisioningClass: 'preview',
      accessClerkUserIds: ['user_collaborator'],
      status: 'running',
      provisionedAt: '2026-09-25T00:00:00.000Z',
    });
    const token = createHmac('sha256', secret).update('pr-1304').digest('hex');
    const response = await app(true).request('/internal/containers/pr-1304/mcp-servers', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it.each(['running', 'provisioning'] as const)('does not select a customer MCP owner when a %s preview shares its handle', async (previewStatus) => {
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001308',
      clerkUserId: 'user_alice',
      handle: 'pr-1308',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      status: 'running',
      provisionedAt: '2026-09-25T00:00:00.000Z',
    });
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001309',
      clerkUserId: 'user_preview_owner',
      handle: 'pr-1308',
      runtimeSlot: 'pr-1308',
      provisioningClass: 'preview',
      status: previewStatus,
      provisionedAt: '2026-09-25T00:00:00.000Z',
    });
    const token = createHmac('sha256', secret).update('pr-1308').digest('hex');
    const response = await app(true).request('/internal/containers/pr-1308/mcp-servers', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it('keeps the isolated platform preview Custom MCP fixture available', async () => {
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001305',
      clerkUserId: 'chat-share-preview-fixture-pr-1305',
      handle: 'pr-1305',
      runtimeSlot: 'pr-1305',
      provisioningClass: 'preview',
      status: 'running',
      provisionedAt: '2026-09-25T00:00:00.000Z',
    });
    const token = createHmac('sha256', secret).update('pr-1305').digest('hex');
    const response = await app(true).request('/internal/containers/pr-1305/mcp-servers', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('resolves the synthetic fixture through the real Custom MCP route when a primary row shares its handle', async () => {
    const handle = 'pr-1307';
    const fixtureId = `chat-share-preview-fixture-${handle}`;
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001310',
      clerkUserId: 'user_customer_owner',
      handle,
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      status: 'running',
      provisionedAt: '2026-09-25T00:00:00.000Z',
    });
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001311',
      clerkUserId: fixtureId,
      handle,
      runtimeSlot: handle,
      provisioningClass: 'preview',
      status: 'running',
      provisionedAt: '2026-09-25T00:00:00.000Z',
    });
    const ensureUser = vi.fn().mockResolvedValue({ id: 'fixture-user' });
    const routes = createCustomMcpRoutes({
      broker: { list: vi.fn().mockResolvedValue([]) } as unknown as Parameters<typeof createCustomMcpRoutes>[0]['broker'],
      resolveUserId: (c) => resolveCustomMcpUserIdForMachine(db, {
        getUserByClerkId: vi.fn().mockResolvedValue(null),
        ensureUser,
      }, c.get('internalContainerClerkUserId'), c.get('internalContainerHandle')),
    });
    const server = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: secret,
      internalCustomMcpRoutes: routes,
    });
    const token = createHmac('sha256', secret).update(handle).digest('hex');
    const response = await server.request(`/internal/containers/${handle}/mcp-servers`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(ensureUser).toHaveBeenCalledWith(expect.objectContaining({ clerkId: fixtureId }));
  });

  it.each([false, true])('returns unavailable for disabled routes (internal=%s)', async (internal) => {
    const server = app();
    const base = internal ? internalPath : publicPath;
    for (const [method, suffix] of [['GET', ''], ['GET', '/'], ['POST', ''], ['PATCH', '/server'], ['DELETE', '/server'], ['POST', '/server/discover']]) {
      const response = await server.request(base + suffix, { method, headers: headers(internal) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'custom_mcp_unavailable' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it.each([false, true])('keeps enabled routes working and contains unknown paths (internal=%s)', async (internal) => {
    const server = app(true);
    const base = internal ? internalPath : publicPath;
    expect((await server.request(base, { headers: headers(internal) })).status).toBe(200);
    expect((await server.request(base + '/unknown/action', { headers: headers(internal) })).status).toBe(404);
  });

  it.each(['api.matrix-os.com', 'app.matrix-os.com'])(
    'lets the OAuth provider callback reach the enabled backend without a Matrix session on %s',
    async (host) => {
    const response = await app(true).request(
      `${publicPath}/oauth/callback?code=provider-code&state=${'s'.repeat(32)}`,
      { headers: { host } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      code: 'provider-code',
      state: 's'.repeat(32),
    });
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect((await app(true).request(publicPath, {
      headers: { host },
    })).status).toBe(401);
    },
  );

  it.each([false, true])('preserves authentication when disabled (internal=%s)', async (internal) => {
    const response = await app().request(internal ? internalPath : publicPath, {
      headers: { host: 'app.matrix-os.com', authorization: 'Bearer invalid' },
    });
    expect(response.status).toBe(401);
  });

  it.each([false, true])('rejects declared oversized disabled mutation bodies (internal=%s)', async (internal) => {
    const response = await app().request(internal ? internalPath : publicPath, {
      method: 'DELETE', headers: { ...headers(internal), 'content-length': String(64 * 1024 + 1) }, body: 'x'.repeat(64 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });

  it('keeps MCP unavailable through the customer gateway proxy', async () => {
    const platform = app();
    const gateway = new Hono();
    registerCustomMcpGatewayRoutes(gateway, {
      homePath: '/unused',
      platformProxy: {
        internalPlatformUrl: 'https://app.matrix-os.com', handle: 'alice', token: 'test-token',
        request: async () => createIntegrationProxyResponse(await platform.request(internalPath, { headers: headers(true) })),
      },
    });
    const response = await gateway.request(publicPath);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'custom_mcp_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not expire the desktop session when the MCP backend is disabled', async () => {
    const server = app();
    const onUnauthorized = vi.fn();
    const client = createApiClient({ baseUrl: 'https://app.matrix-os.com', getRuntimeSlot: () => 'primary', onUnauthorized,
      fetchFn: (url, init) => server.request(url, { ...init, headers: headers(false) }),
    });
    await expect(client.get(publicPath)).rejects.toMatchObject({ category: 'server', detail: 'custom_mcp_unavailable' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
