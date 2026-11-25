import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import { createOwnerCustomMcpRouteOptions } from '../../packages/platform/src/custom-mcp-route-registration.js';
import { createCustomMcpRoutes } from '../../packages/gateway/src/integrations/custom-mcp/routes.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { createApiClient } from '../../desktop/src/renderer/src/lib/api.js';
import { cleanupProxyRoutingTest, JWT_SECRET, setupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';

const host = 'pr-3314.preview.matrix-os.com';
const secret = 'owner-preview-platform-secret';
const path = '/api/mcp-servers/core/external-approvals';

describe('public MCP owner identity on a shared preview', () => {
  let db: PlatformDB;
  let token: string;
  beforeEach(async () => {
    vi.stubEnv('MATRIX_APP_DOMAIN_HOSTS', host);
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    db = await setupProxyRoutingTest();
    process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = 'false';
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000003314',
      clerkUserId: 'chat-share-preview-fixture-pr-3314',
      handle: 'pr-3314', runtimeSlot: 'pr-3314', provisioningClass: 'preview',
      accessClerkUserIds: ['user_alice'], status: 'running',
      provisionedAt: '2026-11-12T00:00:00.000Z',
    });
    token = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: 'user_alice',
      handle: 'pr-3314', runtimeSlot: 'pr-3314', gatewayUrl: 'https://app.matrix-os.com' })).token;
  });
  afterEach(async () => { await cleanupProxyRoutingTest(db); vi.unstubAllEnvs(); });

  function fixture(existing = true) {
    const getUserByClerkId = vi.fn(async (actor: string) => existing && actor === 'user_alice'
      ? { id: 'alice-personal-account' } : null);
    const ensureUser = vi.fn().mockResolvedValue({ id: 'unexpected-created-account' });
    const listPending = vi.fn().mockResolvedValue([]);
    const decide = vi.fn().mockResolvedValue({ status: 'approved' });
    const routes = createCustomMcpRoutes({
      broker: { list: vi.fn().mockResolvedValue([]) } as never,
      ownerApprovals: { listPendingExternalCustomMcpToolApprovals: listPending,
        decideExternalCustomMcpToolApproval: decide } as never,
      ...createOwnerCustomMcpRouteOptions(db, { getUserByClerkId, ensureUser }),
    });
    return { server: createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret,
      clerkAuth: createClerkAuth({ verifyToken: async (presented) => {
        if (presented !== 'owner-clerk-session') throw new Error('Invalid session');
        return { sub: 'user_alice', sid: 'sess_alice', exp: Math.floor(Date.now() / 1000) + 300 };
      } }),
      customMcpRoutes: routes }), getUserByClerkId, ensureUser, listPending, decide };
  }

  // Fault: the selected preview machine's synthetic owner rejects the real
  // authenticated owner's account before the approval store is reached.
  it.each(['browser', 'native'])('lists the %s owner’s approvals independently of the selected preview machine', async (surface) => {
    const f = fixture();
    const response = await f.server.request(path, { headers: { host, ...(surface === 'browser'
      ? { cookie: '__session=owner-clerk-session' } : { authorization: `Bearer ${token}` }) } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ approvals: [] });
    expect(f.getUserByClerkId).toHaveBeenCalledWith('user_alice');
    expect(f.listPending).toHaveBeenCalledWith('alice-personal-account');
    expect(f.ensureUser).not.toHaveBeenCalled();
  });

  it('saves a native owner decision against the personal account rather than the shared fixture', async () => {
    const f = fixture();
    const approvalId = '00000000-0000-4000-8000-000000003315';
    const response = await f.server.request(`${path}/${approvalId}`, { method: 'POST',
      headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'approved' });
    expect(f.decide).toHaveBeenCalledWith({ userId: 'alice-personal-account', approvalId, decision: 'approve' });
    expect(f.ensureUser).not.toHaveBeenCalled();
  });

  it.each([undefined, createHmac('sha256', secret).update('pr-3314').digest('hex')])
    ('never resolves a personal owner from an anonymous or preview-machine bearer', async (bearer) => {
      const f = fixture();
      const response = await f.server.request(path, { headers: { host,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(f.getUserByClerkId).not.toHaveBeenCalled();
      expect(f.listPending).not.toHaveBeenCalled();
    });

  it('does not create a personal account from a shared preview when none exists', async () => {
    const f = fixture(false);
    expect((await f.server.request(path, { headers: { host, authorization: `Bearer ${token}` } })).status).toBe(503);
    expect(f.ensureUser).not.toHaveBeenCalled();
    expect(f.listPending).not.toHaveBeenCalled();
  });

  it('keeps the desktop session when an authenticated owner’s account state is unavailable', async () => {
    const f = fixture(false);
    const onUnauthorized = vi.fn();
    const client = createApiClient({ baseUrl: `https://${host}`, getRuntimeSlot: () => 'pr-3314', onUnauthorized,
      fetchFn: (url, init) => f.server.request(url, { ...init,
        headers: { host, authorization: `Bearer ${token}` } }) });
    await expect(client.get(path)).rejects.toMatchObject({ category: 'server', detail: 'custom_mcp_unavailable' });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(f.ensureUser).not.toHaveBeenCalled();
  });
});
