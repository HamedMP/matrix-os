import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixComputerListSchema, RuntimeSelectionResponseSchema } from '@matrix-os/contracts';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { issueSyncJwt, verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { JWT_SECRET, stubOrchestrator } from './proxy-routing-test-utils.js';

const owner = 'user_private_owner';
const handle = 'pv-2545-1234abcd';
const env = {
  PLATFORM_JWT_SECRET: JWT_SECRET,
  MATRIX_API_ORIGIN: 'https://api.matrix-os.com',
  MATRIX_INTERNAL_CLERK_ORG_ID: 'org_internal',
  MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'false',
};

function privateRow(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return { machineId: randomUUID(), clerkUserId: owner, handle, runtimeSlot: handle,
    provisioningClass: 'private-preview', sourcePr: 2545,
    confirmedBundleVersion: 'v2026.10.16-pr2545-1-1-abcdef0', imageVersion: 'dev',
    status: 'running', provisionedAt: new Date().toISOString(), ...overrides };
}

describe('eligible owner Private Previews in canonical Computers', () => {
  let db: PlatformDB;
  let sourceToken: string;
  let isMember: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: randomUUID(), clerkUserId: owner,
      handle: 'owner-main', runtimeSlot: 'primary', status: 'running',
      provisionedAt: new Date(0).toISOString() });
    sourceToken = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: owner,
      handle: 'owner-main', runtimeSlot: 'primary', gatewayUrl: 'https://app.matrix-os.com/vm/owner-main',
      sessionProvenance: 'clerk-device' })).token;
    isMember = vi.fn().mockResolvedValue(true);
  });

  afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function app(config = env, membership = isMember) {
    return createApp({ db, orchestrator: stubOrchestrator(), env: config,
      platformSecret: 'platform-secret-123', privatePreviewMembership: membership,
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue(null) }) });
  }
  async function inventory(application = app(), token = sourceToken) {
    const response = await application.request('/api/auth/computers', { headers: {
      host: 'app.matrix-os.com', authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return MatrixComputerListSchema.parse(await response.json());
  }
  async function select(application = app(), slot = handle) {
    return application.request('/api/auth/runtime-selection', { method: 'POST', headers: {
      host: 'api.matrix-os.com', authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slot }) });
  }

  it('lists the eligible owner target with the existing preview contract and selects it normally', async () => {
    await insertUserMachine(db, privateRow());
    const application = app();
    const body = await inventory(application);
    expect(body.items.find(item => item.handle === handle)).toMatchObject({ kind: 'preview',
      label: 'Preview Computer', availability: 'available', gatewayPath: `/vm/${handle}?runtime=${handle}` });
    expect(JSON.stringify(body)).not.toMatch(/machineId|clerkUserId|sourcePr|confirmedBundleVersion|org_internal/);
    const response = await select(application);
    expect(response.status).toBe(200);
    const selection = RuntimeSelectionResponseSchema.parse(await response.json());
    const claims = await verifySyncJwt(selection.accessToken, { secret: JWT_SECRET });
    expect(claims).toMatchObject({ sub: owner, handle, runtime_slot: handle, session_provenance: 'clerk-device' });
    expect(isMember).toHaveBeenCalledWith('org_internal', owner);
  });

  it.each(['expired', 'deleted', 'inactive', 'stopped', 'non-member', 'membership-error', 'missing-org'] as const)(
    'excludes and refuses selection for %s even with a cached inventory', async condition => {
      await insertUserMachine(db, privateRow());
      const application = app();
      // List while eligible, then change authority before selection: no stale-list grant.
      expect((await inventory(application)).items.some(item => item.handle === handle)).toBe(true);
      let updatedApp = application;
      if (condition === 'expired') await sql`UPDATE user_machines SET provisioned_at = ${new Date(Date.now() - 72 * 3600_000).toISOString()} WHERE handle = ${handle}`.execute(db.executor);
      if (condition === 'deleted') await sql`UPDATE user_machines SET deleted_at = ${new Date().toISOString()} WHERE handle = ${handle}`.execute(db.executor);
      if (condition === 'inactive') await sql`UPDATE user_machines SET activation_state = 'awaiting_billing' WHERE handle = ${handle}`.execute(db.executor);
      if (condition === 'stopped') await sql`UPDATE user_machines SET status = 'stopped' WHERE handle = ${handle}`.execute(db.executor);
      if (condition === 'non-member') isMember.mockResolvedValue(false);
      if (condition === 'membership-error') isMember.mockRejectedValue(new Error('private membership service details'));
      if (condition === 'missing-org') updatedApp = app({ ...env, MATRIX_INTERNAL_CLERK_ORG_ID: '' });
      expect((await inventory(updatedApp)).items.some(item => item.handle === handle)).toBe(false);
      const response = await select(updatedApp);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Computer unavailable' });
    });

  it('rechecks private membership before issuing a runtime credential without relying on listing', async () => {
    await insertUserMachine(db, privateRow());
    isMember.mockResolvedValue(false);
    const response = await select();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Computer unavailable' });
  });

  it('never lists or selects another owner private even with a legacy shared ACL', async () => {
    await insertUserMachine(db, privateRow({ clerkUserId: 'user_other_owner' }));
    await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_private_preview_check`.execute(db.executor);
    await sql`UPDATE user_machines SET access_clerk_user_ids = ARRAY[${owner}]::TEXT[] WHERE handle = ${handle}`.execute(db.executor);
    expect((await inventory()).items.map(item => item.handle)).not.toContain(handle);
    expect((await select()).status).toBe(404);
  });

  it('rejects malformed owner private rows rather than turning shared ACLs into eligibility', async () => {
    await insertUserMachine(db, privateRow());
    await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_private_preview_check`.execute(db.executor);
    await sql`UPDATE user_machines SET access_clerk_user_ids = ARRAY['user_someone']::TEXT[] WHERE handle = ${handle}`.execute(db.executor);
    expect((await inventory()).items.map(item => item.handle)).not.toContain(handle);
    expect((await select()).status).toBe(404);
  });

  it('fails unavailable at the hard scan cap instead of returning a misleading partial list', async () => {
    await sql`INSERT INTO user_machines (machine_id, clerk_user_id, handle, runtime_slot,
      provisioning_class, source_pr, confirmed_bundle_version, status, provisioned_at)
      SELECT 'cap-' || n, ${owner}, 'pv-' || n || '-1234abcd', 'pv-' || n || '-1234abcd',
        'private-preview', n, 'v2026.10.16-pr2545-1-1-abcdef0', 'stopped', ${new Date().toISOString()}
      FROM generate_series(10000, 10420) AS n`.execute(db.executor);
    const response = await app().request('/api/auth/computers', { headers: {
      host: 'app.matrix-os.com', authorization: `Bearer ${sourceToken}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Computers unavailable' });
    // Lifecycle rejection precedes membership; no repeated remote membership work.
    expect(isMember).not.toHaveBeenCalled();
  });

  it('retains existing public Preview collaborator listing and selection without internal membership', async () => {
    isMember.mockResolvedValue(false);
    await insertUserMachine(db, { machineId: randomUUID(), clerkUserId: 'user_public_owner',
      handle: 'pr-2550', runtimeSlot: 'pr-2550', provisioningClass: 'preview', accessClerkUserIds: [owner],
      status: 'running', provisionedAt: new Date().toISOString() });
    expect((await inventory()).items.find(item => item.handle === 'pr-2550')).toMatchObject({ kind: 'preview' });
    expect((await select(app(), 'pr-2550')).status).toBe(200);
  });

  it('scans past a filtered candidate page and preserves the eligible selected private in a full page', async () => {
    await insertUserMachine(db, privateRow({ provisionedAt: new Date(Date.now() - 3600_000).toISOString() }));
    const tiedTime = new Date().toISOString();
    for (let index = 0; index < 24; index += 1) {
      const other = `pv-${3000 + index}-1234abcd`;
      await insertUserMachine(db, privateRow({ handle: other, runtimeSlot: other, sourcePr: 3000 + index,
        status: 'stopped', provisionedAt: tiedTime }));
      await insertUserMachine(db, { machineId: randomUUID(), clerkUserId: owner, handle: `other-${index}`,
        runtimeSlot: `slot-${index}`, status: 'running', provisionedAt: tiedTime });
    }
    // Without a selected token, filtered private rows still cannot consume the page budget.
    const body = await inventory();
    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    const selectedToken = (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: owner,
      handle, runtimeSlot: handle, gatewayUrl: `https://app.matrix-os.com/vm/${handle}` })).token;
    const selected = await inventory(app(), selectedToken);
    expect(selected.selectedSlot).toBe(handle);
    expect(selected.items[0]).toMatchObject({ handle, kind: 'preview' });
    expect(selected.items).toHaveLength(20);
    expect(selected.hasMore).toBe(true);
  });

  it('does not let excluded rows hide an eligible target after a bounded query page', async () => {
    const tiedTime = new Date().toISOString();
    for (let index = 0; index < 24; index += 1) {
      const other = `pv-${3000 + index}-1234abcd`;
      await insertUserMachine(db, privateRow({ handle: other, runtimeSlot: other, sourcePr: 3000 + index,
        status: 'stopped', provisionedAt: tiedTime }));
    }
    await insertUserMachine(db, privateRow({ provisionedAt: new Date(Date.now() - 3600_000).toISOString() }));
    const result = await inventory();
    expect(result.items.map(item => item.handle)).toEqual(['owner-main', handle]);
    expect(result.hasMore).toBe(false);
  });
});
