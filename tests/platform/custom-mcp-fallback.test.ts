import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
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
