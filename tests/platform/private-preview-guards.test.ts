import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isReservedMatrixOsHandle, normalizeMatrixOsHandleCandidate } from '../../packages/clerk-sync/src/index.js';
import {
  collaborationRelayHandle,
  collaborationRuntimeOrigin,
} from '../../packages/platform/src/collaboration/runtime-machine.js';
import { canClerkUserAccessMachine, isPrivatePreviewMachine } from '../../packages/platform/src/customer-vps-preview.js';
import { CustomerHandleSchema, ProvisionRequestSchema } from '../../packages/platform/src/customer-vps-schema.js';
import {
  getAccessibleRunningUserMachineByClerkId,
  getActiveUserMachineByHandle,
  insertUserMachine,
  type NewUserMachine,
  type PlatformDB,
  type UserMachineRecord,
} from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { buildPreviewTerminalAccess } from '../../packages/platform/src/preview-terminal-access.js';
import { getRuntimeEntitlementDecisionForUser } from '../../packages/platform/src/runtime-entitlement.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const secret = 'platform-secret-123';
const handle = 'pv-1907-3fa91c2e';
const owner = 'user_owner';

const privatePreview = {
  handle,
  runtimeSlot: handle,
  provisioningClass: 'private-preview' as const,
  clerkUserId: owner,
  accessClerkUserIds: [] as string[],
};

function bearer(value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function row(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId: '00000000-0000-4000-8000-000000001907',
    clerkUserId: owner,
    handle,
    runtimeSlot: handle,
    provisioningClass: 'private-preview',
    sourcePr: 1907,
    confirmedBundleVersion: 'v2026.09.28-pr1907-1-1-abcdef0',
    status: 'running',
    publicIPv4: '203.0.113.19',
    provisionedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function machineRecord(overrides: Partial<UserMachineRecord> = {}): UserMachineRecord {
  return { ...privatePreview, machineId: row().machineId, status: 'running', publicIPv4: '203.0.113.19', ...overrides } as UserMachineRecord;
}

describe('Private Preview handle reservation', () => {
  it('reserves the Private Preview handle grammar for platform-owned machines', () => {
    expect(isReservedMatrixOsHandle(handle)).toBe(true);
    expect(isReservedMatrixOsHandle('pv-art')).toBe(false);
    expect(isReservedMatrixOsHandle('alice')).toBe(false);
  });

  it('never derives a reserved handle from a Clerk profile', () => {
    expect(normalizeMatrixOsHandleCandidate(handle)).toBeNull();
    expect(normalizeMatrixOsHandleCandidate('PV-1907-3FA91C2E')).toBeNull();
    expect(normalizeMatrixOsHandleCandidate('pv-art')).toBe('pv-art');
  });

  it('rejects reserved handles on customer handle assignment', () => {
    expect(CustomerHandleSchema.safeParse(handle).success).toBe(false);
    expect(CustomerHandleSchema.safeParse('alice').success).toBe(true);
    expect(ProvisionRequestSchema.safeParse({ clerkUserId: 'user_alice', handle }).success).toBe(false);
    expect(ProvisionRequestSchema.safeParse({ clerkUserId: 'user_alice', handle: 'alice' }).success).toBe(true);
  });
});

describe('Private Preview machine classification', () => {
  it('recognizes only owner-only machines in the reserved namespace', () => {
    expect(isPrivatePreviewMachine(privatePreview)).toBe(true);
    expect(isPrivatePreviewMachine({ ...privatePreview, accessClerkUserIds: ['user_other'] })).toBe(false);
    expect(isPrivatePreviewMachine({ ...privatePreview, runtimeSlot: 'primary' })).toBe(false);
    expect(isPrivatePreviewMachine({ ...privatePreview, handle: 'pr-1907', runtimeSlot: 'pr-1907' })).toBe(false);
    expect(isPrivatePreviewMachine({ ...privatePreview, provisioningClass: 'preview' })).toBe(false);
    expect(isPrivatePreviewMachine({ ...privatePreview, provisioningClass: 'customer' })).toBe(false);
  });

  it('admits only the owner, even when a collaborator is listed', () => {
    expect(canClerkUserAccessMachine(privatePreview, owner)).toBe(true);
    expect(canClerkUserAccessMachine({ ...privatePreview, accessClerkUserIds: ['user_other'] }, 'user_other')).toBe(false);
  });

  it('issues no collaborator Terminal grant', () => {
    expect(buildPreviewTerminalAccess({
      machine: { ...privatePreview, accessClerkUserIds: ['user_other'] },
      actorId: 'user_other',
      path: '/api/terminal/sessions',
      platformSecret: secret,
    })).toBeUndefined();
  });

  it('is platform-funded without reading billing state', async () => {
    const db = new Proxy({}, { get() { throw new Error('billing state read'); } }) as PlatformDB;
    await expect(getRuntimeEntitlementDecisionForUser(
      db, owner, { MATRIX_STRIPE_BILLING_ENABLED: 'true' }, handle, 'private-preview',
    )).resolves.toMatchObject({ status: 'active', runtimeProxyAllowed: true });
  });
});

describe('Private Preview collaboration', () => {
  it('never registers a collaboration relay for a Private Preview', () => {
    expect(collaborationRelayHandle(machineRecord({ provisioningClass: 'customer', handle: 'alice', runtimeSlot: 'primary' }), owner)).toBe('alice');
    expect(collaborationRelayHandle(machineRecord(), owner)).toBeNull();
    expect(collaborationRelayHandle(machineRecord({ provisioningClass: 'customer', handle: 'alice' }), 'user_other')).toBeNull();
    expect(collaborationRelayHandle(machineRecord({ provisioningClass: 'customer', status: 'stopped' }), owner)).toBeNull();
    expect(collaborationRelayHandle(undefined, owner)).toBeNull();
  });

  it('never exposes a collaboration origin for a Private Preview', () => {
    expect(collaborationRuntimeOrigin(machineRecord({ provisioningClass: 'customer', handle: 'alice' }), owner))
      .toBe('https://203.0.113.19:443');
    expect(collaborationRuntimeOrigin(machineRecord(), owner)).toBeNull();
    expect(collaborationRuntimeOrigin(machineRecord({ provisioningClass: 'customer', publicIPv4: null }), owner)).toBeNull();
  });
});

describe('Private Preview persistence and routes', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('persists the source PR for an owner-only machine', async () => {
    await insertUserMachine(db, row());
    await expect(getActiveUserMachineByHandle(db, handle, handle)).resolves.toMatchObject({
      provisioningClass: 'private-preview',
      sourcePr: 1907,
      accessClerkUserIds: [],
    });
  });

  it.each([
    ['a collaborator', { accessClerkUserIds: ['user_other'] }],
    ['a runtime slot that differs from its handle', { runtimeSlot: 'primary' }],
    ['a handle outside the reserved namespace', { handle: 'pr-1907', runtimeSlot: 'pr-1907' }],
    ['no source PR', { sourcePr: null }],
  ])('rejects a Private Preview with %s', async (_label, overrides) => {
    await expect(insertUserMachine(db, row(overrides))).rejects.toThrow();
  });

  it('rejects a source PR on any other machine class', async () => {
    await expect(insertUserMachine(db, row({ provisioningClass: 'customer', handle: 'alice', runtimeSlot: 'primary' })))
      .rejects.toThrow();
  });

  it('keeps a legacy machine with a reserved-shaped handle updatable', async () => {
    await insertUserMachine(db, row({ provisioningClass: 'customer', runtimeSlot: 'primary', sourcePr: null }));
    await expect(sql`UPDATE user_machines SET status = 'stopped' WHERE handle = ${handle}`.execute(db.kysely))
      .resolves.toBeDefined();
  });

  it('rejects unknown machine classes', async () => {
    await insertUserMachine(db, row({ provisioningClass: 'customer', handle: 'alice', runtimeSlot: 'primary', sourcePr: null }));
    await expect(sql`UPDATE user_machines SET provisioning_class = 'mystery' WHERE handle = 'alice'`.execute(db.kysely))
      .rejects.toThrow();
  });

  it('keeps one active Private Preview per owner and PR', async () => {
    await insertUserMachine(db, row());
    const second = row({ machineId: '00000000-0000-4000-8000-000000001908', handle: 'pv-1907-0badf00d', runtimeSlot: 'pv-1907-0badf00d' });
    await expect(insertUserMachine(db, second)).rejects.toThrow();
    await sql`UPDATE user_machines SET deleted_at = '2026-09-28T01:00:00.000Z' WHERE handle = ${handle}`.execute(db.kysely);
    await expect(insertUserMachine(db, second)).resolves.toBeUndefined();
  });

  it('routes only the owner to a Private Preview', async () => {
    await insertUserMachine(db, row());
    await expect(getAccessibleRunningUserMachineByClerkId(db, owner, handle)).resolves.toMatchObject({ handle });
    await expect(getAccessibleRunningUserMachineByClerkId(db, 'user_other', handle)).resolves.toBeUndefined();
  });

  function app() {
    const probe = new Hono();
    probe.get('/probe', (c) => c.json({ ok: true }));
    probe.get('/', (c) => c.json([]));
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: secret,
      internalIntegrationRoutes: probe,
      internalCustomMcpRoutes: probe,
    });
  }

  it('denies personal Integrations until Private Preview eligibility exists', async () => {
    await insertUserMachine(db, row());
    const response = await app().request(`/internal/containers/${handle}/integrations/probe`, {
      headers: { authorization: `Bearer ${bearer(handle)}` },
    });
    expect(response.status).toBe(403);
  });

  it('denies personal Custom MCP until Private Preview eligibility exists', async () => {
    await insertUserMachine(db, row());
    const response = await app().request(`/internal/containers/${handle}/mcp-servers`, {
      headers: { authorization: `Bearer ${bearer(handle)}` },
    });
    expect(response.status).toBe(403);
  });
});
