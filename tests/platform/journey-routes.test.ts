import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createJourneyRoutes,
  createJourneyUserResolver,
} from '../../packages/platform/src/journey-routes.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import {
  getOnboardingFirstRun,
  insertUserMachine,
  upsertBillingOverride,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const SECRET = 'test-platform-jwt-secret-at-least-32-chars-long';
const APP_ORIGIN = 'https://app.matrix-os.com';

describe('platform/journey-routes', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function routes(overrides: Partial<Parameters<typeof createJourneyRoutes>[0]> = {}) {
    return createJourneyRoutes({
      db,
      resolveUserId: async () => 'user_123',
      provisionRuntime: vi.fn(async () => {}),
      // Per-handle verifier: accept the fixed token only for handle "alice".
      verifyInternalToken: (handle: string, token: string | undefined) =>
        handle === 'alice' && token === 'token-for-alice',
      // Handle "alice" is owned by user_123.
      resolveHandleOwner: async (handle: string) => (handle === 'alice' ? 'user_123' : null),
      appOrigin: APP_ORIGIN,
      maxProvisionAttempts: 3,
      now: () => new Date('2026-06-11T12:00:00.000Z'),
      ...overrides,
    });
  }

  describe('GET /api/journey', () => {
    it('401 when unauthenticated', async () => {
      const app = routes({ resolveUserId: async () => null });
      const res = await app.request('/api/journey');
      expect(res.status).toBe(401);
    });

    it('200 with phase + no-store for an authenticated user', async () => {
      const app = routes();
      const res = await app.request('/api/journey');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.phase).toBe('plan_required');
      expect(body.nextAction.kind).toBe('open_plans');
    });

    it('validates runtimeSlot and derives progress for that slot', async () => {
      await upsertBillingOverride(db, {
        id: 'override-active', clerkUserId: 'user_123', planSlug: 'internal', status: 'active',
        maxRuntimeSlots: 2, includedRuntimeSlots: 2, addonRuntimeSlots: 0,
        defaultServerType: 'cpx32', allowedServerTypes: ['cpx32'], reason: 'test', createdBy: 'test',
        expiresAt: null, revokedAt: null, createdAt: '2026-06-11T00:00:00.000Z',
      });
      await insertUserMachine(db, {
        machineId: 'm-secondary', clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'studio',
        status: 'provisioning', provisionedAt: '2026-06-11T11:59:00.000Z',
      });
      const app = routes();

      const response = await app.request('/api/journey?runtimeSlot=studio');
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        phase: 'provisioning',
        progress: { stage: 'creating_server' },
      });

      const invalid = await app.request('/api/journey?runtimeSlot=Bad%20Slot!');
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: 'Invalid request' });
    });

    it('503 when a journey dependency fails (no phase guessing)', async () => {
      const app = routes({ resolveReadiness: async () => { throw new Error('readiness down'); } });
      const res = await app.request('/api/journey');
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('journey_unavailable');
    });

    it('returns the identical contract for a sync-JWT bearer caller (CLI / native macOS path)', async () => {
      // The native macOS app and CLI present a platform sync JWT, not a Clerk
      // session. The resolver must resolve it to the same clerkUserId, yielding
      // an identical journey contract.
      const { token } = await issueSyncJwt({
        secret: SECRET, clerkUserId: 'user_123', handle: 'alice', gatewayUrl: 'https://app.matrix-os.com',
      });
      const resolver = createJourneyUserResolver({ syncJwtSecret: SECRET });
      const app = routes({ resolveUserId: resolver });
      const res = await app.request('/api/journey', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect((await res.json()).phase).toBe('plan_required');
    });

    it('rejects a sync JWT signed with the wrong secret', async () => {
      const { token } = await issueSyncJwt({
        secret: 'a-different-secret-also-at-least-32-characters', clerkUserId: 'user_123', handle: 'alice', gatewayUrl: 'x',
      });
      const resolver = createJourneyUserResolver({ syncJwtSecret: SECRET });
      const app = routes({ resolveUserId: resolver });
      const res = await app.request('/api/journey', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/journey/retry-provision', () => {
    it('401 when unauthenticated', async () => {
      const app = routes({ resolveUserId: async () => null });
      const res = await app.request('/api/journey/retry-provision', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('503 when provisioning is unavailable', async () => {
      const app = routes({ provisionRuntime: undefined });
      const res = await app.request('/api/journey/retry-provision', { method: 'POST' });
      expect(res.status).toBe(503);
    });

    it('converges on an in-flight machine without calling provision again', async () => {
      const provisionRuntime = vi.fn(async () => {});
      await insertUserMachine(db, {
        machineId: 'm-live', clerkUserId: 'user_123', handle: 'alice', status: 'provisioning',
        provisionedAt: '2026-06-11T11:59:00.000Z',
      });
      const app = routes({ provisionRuntime });
      const res = await app.request('/api/journey/retry-provision', { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('in_progress');
      expect(provisionRuntime).not.toHaveBeenCalled();
    });

    it('starts provisioning when there is no live machine', async () => {
      const provisionRuntime = vi.fn(async () => {});
      const app = routes({ provisionRuntime });
      const res = await app.request('/api/journey/retry-provision', { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('started');
      expect(provisionRuntime).toHaveBeenCalledWith('user_123', 'primary');
    });

    it('maps billing_required to 402', async () => {
      const app = routes({
        provisionRuntime: async () => { throw new CustomerVpsError(402, 'billing_required', 'x'); },
      });
      const res = await app.request('/api/journey/retry-provision', { method: 'POST' });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe('billing_required');
    });

    it('maps retry_exhausted to 409', async () => {
      const app = routes({
        provisionRuntime: async () => { throw new CustomerVpsError(409, 'retry_exhausted', 'x'); },
      });
      const res = await app.request('/api/journey/retry-provision', { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('retry_exhausted');
    });

    it('400 on an invalid runtimeSlot', async () => {
      const app = routes();
      const res = await app.request('/api/journey/retry-provision', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtimeSlot: 'Bad Slot!' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /internal/first-run', () => {
    const validBody = {
      clerkUserId: 'user_123', handle: 'alice', completedAt: '2026-06-11T11:00:00.000Z',
      goal: 'coding', steps: { api_key: 'skipped' }, source: 'gateway_ws',
    };

    it('401 without a valid internal token', async () => {
      const app = routes();
      const res = await app.request('/internal/first-run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(401);
    });

    it('204 and upserts with a valid per-handle token', async () => {
      const app = routes();
      const res = await app.request('/internal/first-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token-for-alice', 'x-matrix-handle': 'alice' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(204);
      const row = await getOnboardingFirstRun(db, 'user_123');
      expect(row?.goal).toBe('coding');
      expect(row?.steps).toEqual({ api_key: 'skipped' });
    });

    it('401 when the token does not match the claimed handle', async () => {
      const app = routes();
      const res = await app.request('/internal/first-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token-for-alice', 'x-matrix-handle': 'mallory' },
        body: JSON.stringify({ ...validBody, handle: 'mallory' }),
      });
      expect(res.status).toBe(401);
    });

    it('422 on an invalid body', async () => {
      const app = routes();
      const res = await app.request('/internal/first-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token-for-alice', 'x-matrix-handle': 'alice' },
        body: JSON.stringify({ clerkUserId: 'user_123' }),
      });
      expect(res.status).toBe(422);
    });

    it('422 when the authenticated handle does not own the reported completion', async () => {
      const app = routes();
      const res = await app.request('/internal/first-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token-for-alice', 'x-matrix-handle': 'alice' },
        body: JSON.stringify({ ...validBody, handle: 'someone-else' }),
      });
      expect(res.status).toBe(422);
    });

    it('403 when the submitted clerkUserId is not the handle owner (no journey hijack)', async () => {
      const app = routes();
      const res = await app.request('/internal/first-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token-for-alice', 'x-matrix-handle': 'alice' },
        body: JSON.stringify({ ...validBody, clerkUserId: 'user_victim' }),
      });
      expect(res.status).toBe(403);
      expect(await getOnboardingFirstRun(db, 'user_victim')).toBeUndefined();
    });
  });
});
