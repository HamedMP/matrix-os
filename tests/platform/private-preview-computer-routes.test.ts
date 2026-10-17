import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixComputerListSchema, RuntimeSelectionResponseSchema } from '@matrix-os/contracts';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { listUserRuntimeComputersByClerkId } from '../../packages/platform/src/computer-repository.js';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { issueSyncJwt, verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { JWT_SECRET, cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';

const owner = 'user_alice';
const privateHandle = 'pv-2514-1234abcd';

function privateRow(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId: `machine-${privateHandle}`,
    clerkUserId: owner,
    handle: privateHandle,
    runtimeSlot: privateHandle,
    provisioningClass: 'private-preview',
    sourcePr: 2514,
    confirmedBundleVersion: 'v2026.10.12-pr2514-1-a792ac3',
    imageVersion: 'v2026.10.12-pr2514-1-a792ac3',
    status: 'running',
    provisionedAt: '2026-10-12T00:00:00.000Z',
    publicIPv4: '203.0.113.10',
    ...overrides,
  };
}

function appFor(db: PlatformDB) {
  return createApp({
    db,
    orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: owner }) }),
    platformSecret: 'platform-secret-123',
  });
}

function inventoryRequest(app: ReturnType<typeof appFor>, token = 'clerk-session') {
  return app.request('/api/auth/computers', {
    headers: { host: 'app.matrix-os.com', authorization: `Bearer ${token}` },
  });
}

function selectionRequest(app: ReturnType<typeof appFor>, token: string, slot: string) {
  return app.request('/api/auth/runtime-selection', {
    method: 'POST',
    headers: {
      host: 'api.matrix-os.com',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ slot }),
  });
}

async function sourceToken(db: PlatformDB) {
  await insertUserMachine(db, {
    machineId: 'machine-alice-main', clerkUserId: owner, handle: 'alice-main', runtimeSlot: 'primary',
    status: 'running', publicIPv4: '203.0.113.11', provisionedAt: '2026-10-12T00:00:00.000Z',
  });
  return (await issueSyncJwt({
    secret: JWT_SECRET, clerkUserId: owner, handle: 'alice-main', runtimeSlot: 'primary',
    gatewayUrl: 'https://app.matrix-os.com/vm/alice-main', sessionProvenance: 'clerk-device',
  })).token;
}

describe('Private Preview normal computer inventory and selection', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    process.env.MATRIX_API_ORIGIN = 'https://api.matrix-os.com';
    db = await setupProxyRoutingTest();
  });

  afterEach(async () => {
    await cleanupProxyRoutingTest(db);
    delete process.env.MATRIX_API_ORIGIN;
  });

  it('preserves the internal private provisioning class without reclassifying its authorization', async () => {
    await insertUserMachine(db, privateRow());
    await expect(listUserRuntimeComputersByClerkId(db, owner, 21)).resolves.toEqual([{
      handle: privateHandle, runtimeSlot: privateHandle, provisioningClass: 'private-preview',
      status: 'running', imageVersion: 'v2026.10.12-pr2514-1-a792ac3',
    }]);
  });

  it.each([
    ['running', 'available'], ['provisioning', 'starting'], ['failed', 'unavailable'],
  ] as const)('lists an owned %s Private Preview with the existing strict wire contract', async (status, availability) => {
    await insertUserMachine(db, privateRow({ status }));
    const response = await inventoryRequest(appFor(db));
    expect(response.status).toBe(200);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.items).toEqual([{
      handle: privateHandle, runtimeSlot: privateHandle, label: 'Preview Computer', kind: 'preview',
      availability, versionLabel: 'v2026.10.12',
      gatewayPath: `/vm/${privateHandle}?runtime=${privateHandle}`,
      capabilities: ['matrixComputerInventoryV1'],
    }]);
    expect(body.selectedSlot).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps Main and shared preview presentation while hiding foreign private rows and collaborators', async () => {
    await sourceToken(db);
    await insertUserMachine(db, privateRow());
    await insertUserMachine(db, {
      machineId: 'shared-preview', clerkUserId: 'user_bob', handle: 'pr-2515', runtimeSlot: 'pr-2515',
      provisioningClass: 'preview', accessClerkUserIds: [owner], status: 'running',
      provisionedAt: '2026-10-11T00:00:00.000Z',
    });
    // Legacy malformed access lists cannot turn a private runtime into a shared preview.
    await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_private_preview_check`.execute(db.executor);
    await insertUserMachine(db, privateRow({
      machineId: 'foreign-preview', clerkUserId: 'user_bob', handle: 'pv-2516-abcdef12',
      runtimeSlot: 'pv-2516-abcdef12', sourcePr: 2516, accessClerkUserIds: [owner],
    }));
    const response = await inventoryRequest(appFor(db));
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.items.map(item => item.handle)).toEqual(['alice-main', privateHandle, 'pr-2515']);
    expect(body.items[0]).toMatchObject({ label: 'Main Computer', kind: 'customer' });
    expect(body.items[2]).toMatchObject({ label: 'Preview Computer', kind: 'preview' });
    expect(body.selectedSlot).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/user_bob|foreign-preview|abcdef12|accessClerkUserIds/);
  });

  it('never lists a deleted private runtime', async () => {
    await insertUserMachine(db, privateRow({ deletedAt: '2026-10-12T01:00:00.000Z' }));
    const response = await inventoryRequest(appFor(db));
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('keeps a signed private selection within the bounded first page without changing Main', async () => {
    await insertUserMachine(db, privateRow());
    const mainToken = await sourceToken(db);
    for (let index = 0; index < 20; index += 1) {
      await insertUserMachine(db, {
        machineId: `additional-${index}`, clerkUserId: owner, handle: `alice-${index}`, runtimeSlot: `slot-${index}`,
        status: 'running', provisionedAt: '2026-10-13T00:00:00.000Z',
      });
    }
    const token = (await issueSyncJwt({
      secret: JWT_SECRET, clerkUserId: owner, handle: privateHandle, runtimeSlot: privateHandle,
      gatewayUrl: `https://app.matrix-os.com/vm/${privateHandle}`,
    })).token;
    const response = await inventoryRequest(appFor(db), token);
    const body = MatrixComputerListSchema.parse(await response.json());
    expect(body.selectedSlot).toBe(privateHandle);
    expect(body.items[0]).toMatchObject({ handle: privateHandle, label: 'Preview Computer', kind: 'preview' });
    expect(body.items[1]).toMatchObject({ handle: 'alice-main', label: 'Main Computer' });
    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    const mainResponse = await inventoryRequest(appFor(db), mainToken);
    expect(MatrixComputerListSchema.parse(await mainResponse.json()).selectedSlot).toBe('primary');
  });

  it('selects only an owned running private runtime and preserves verified native provenance and expiry', async () => {
    const token = await sourceToken(db);
    await insertUserMachine(db, privateRow());
    const response = await selectionRequest(appFor(db), token, privateHandle);
    expect(response.status).toBe(200);
    const body = RuntimeSelectionResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ handle: privateHandle, slot: privateHandle });
    const source = await verifySyncJwt(token, { secret: JWT_SECRET });
    const selected = await verifySyncJwt(body.accessToken, { secret: JWT_SECRET });
    expect(selected).toMatchObject({ sub: owner, runtime_slot: privateHandle, session_provenance: 'clerk-device' });
    expect(selected.exp).toBeLessThanOrEqual(source.exp);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each(['missing', 'foreign', 'collaborator', 'deleted', 'failed', 'provisioning', 'stopped', 'unauthorized'])
    ('denies selection of a %s private runtime without returning credentials', async (condition) => {
      const token = await sourceToken(db);
      if (condition === 'collaborator') {
        await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_private_preview_check`.execute(db.executor);
      }
      if (condition !== 'missing') {
        await insertUserMachine(db, privateRow({
          ...(condition === 'foreign' || condition === 'collaborator' ? { clerkUserId: 'user_bob' } : {}),
          ...(condition === 'collaborator' ? { accessClerkUserIds: [owner] } : {}),
          ...(condition === 'deleted' ? { deletedAt: '2026-10-12T01:00:00.000Z' } : {}),
          ...(['failed', 'provisioning', 'stopped'].includes(condition) ? { status: condition } : {}),
          ...(condition === 'unauthorized' ? { activationState: 'awaiting_billing' as const } : {}),
        }));
      }
      const response = await selectionRequest(appFor(db), token, privateHandle);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Computer unavailable' });
    });
});
