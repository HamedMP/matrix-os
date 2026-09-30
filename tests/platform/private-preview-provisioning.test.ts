import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { getProvisioningJobByMachineId } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import { PRIVATE_PREVIEW_HANDLE_PATTERN } from '../../packages/platform/src/customer-vps-schema.js';
import { assertMachineProviderMutationAllowed } from '../../packages/platform/src/customer-vps-support.js';
import { insertPrivatePreviewIfAbsent } from '../../packages/platform/src/database/private-previews.js';
import {
  getUserMachine,
  insertUserMachine,
  type PlatformDB,
  upsertHostBundleRelease,
} from '../../packages/platform/src/db.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const owner = 'user_owner';
const v1 = 'v2026.09.28-pr1907-1-1-abcdef0';
const v2 = 'v2026.09.29-pr1907-2-1-1234567';
const otherPr = 'v2026.09.29-pr1908-1-1-7654321';

describe('Private Preview provisioning', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    for (const [version, sourcePr] of [[v1, 1907], [v2, 1907], [otherPr, 1908]] as const) {
      await upsertHostBundleRelease(db, {
        version,
        gitCommit: 'c1598218',
        gitRef: 'feature/private-preview',
        buildTime: '2026-09-28T00:00:00.000Z',
        bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`,
        sha256: 'a'.repeat(64),
        size: 1234,
        sourcePr,
        sourceAuthor: 'octo-dev',
      });
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await destroyTestPlatformDb(db);
  });

  function service(env: Record<string, string> = {}) {
    return createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
        PLATFORM_SECRET: 'platform-secret',
        HETZNER_API_TOKEN: 'token',
        S3_ACCESS_KEY_ID: 'r2-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-secret-key',
        S3_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'matrixos-sync',
        ...env,
      }),
      hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(),
      // Provider creation is out of scope here; the durable job is asserted instead.
      scheduleProvisioningDispatch: () => {},
      resolveBillingEntitlement: async () => {
        throw new Error('Private Previews must not read billing entitlement');
      },
    });
  }

  const start = (svc: ReturnType<typeof service>, sourcePr: number, bundleVersion: string) =>
    svc.startPrivatePreview({ clerkUserId: owner, sourcePr, bundleVersion }, { dispatch: 'detached' });

  it('provisions an owner-only machine pinned to the confirmed bundle', async () => {
    const started = await start(service(), 1907, v1);

    expect(started.status).toBe('provisioning');
    expect(started.handle).toMatch(PRIVATE_PREVIEW_HANDLE_PATTERN);
    expect(started.handle.startsWith('pv-1907-')).toBe(true);
    await expect(getUserMachine(db, started.machineId)).resolves.toMatchObject({
      clerkUserId: owner,
      handle: started.handle,
      runtimeSlot: started.handle,
      provisioningClass: 'private-preview',
      accessClerkUserIds: [],
      sourcePr: 1907,
      confirmedBundleVersion: v1,
      imageVersion: v1,
      status: 'provisioning',
    });
    await expect(getProvisioningJobByMachineId(db, started.machineId)).resolves.toMatchObject({ status: 'queued' });
  });

  it('accepts only a registered bundle from the same PR', async () => {
    await expect(start(service(), 1907, otherPr)).rejects.toMatchObject({ status: 409, code: 'invalid_state' });
    await expect(start(service(), 1907, 'v2026.09.30-pr1907-9-1-deadbee')).rejects.toBeInstanceOf(CustomerVpsError);
  });

  it('returns the existing machine for a repeated or concurrent start of the same PR', async () => {
    const svc = service();
    const [first, second] = await Promise.all([start(svc, 1907, v1), start(svc, 1907, v1)]);
    expect(second.machineId).toBe(first.machineId);
    await expect(start(svc, 1907, v2)).resolves.toMatchObject({ machineId: first.machineId, handle: first.handle });
  });

  it('resolves a racing insert for the same owner and PR inside Postgres', async () => {
    const row = (n: number) => ({
      machineId: `00000000-0000-4000-8000-00000000190${n}`,
      clerkUserId: owner,
      handle: `pv-1907-0000000${n}`,
      runtimeSlot: `pv-1907-0000000${n}`,
      provisioningClass: 'private-preview' as const,
      sourcePr: 1907,
      confirmedBundleVersion: v1,
      status: 'provisioning',
      provisionedAt: '2026-09-28T00:00:00.000Z',
    });
    await expect(insertPrivatePreviewIfAbsent(db, row(1))).resolves.toBe(true);
    await expect(insertPrivatePreviewIfAbsent(db, row(2))).resolves.toBe(false);
    await expect(getUserMachine(db, row(2).machineId)).resolves.toBeUndefined();
  });

  it('asks the owner to destroy a failed Private Preview before starting again', async () => {
    const started = await start(service(), 1907, v1);
    await sql`UPDATE user_machines SET status = 'failed' WHERE machine_id = ${started.machineId}`.execute(db.kysely);
    await expect(start(service(), 1907, v1)).rejects.toMatchObject({ status: 409, code: 'invalid_state' });
  });

  it('limits active Private Previews per owner without counting other machines', async () => {
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000000001',
      clerkUserId: owner,
      handle: 'owner-handle',
      status: 'running',
      provisionedAt: '2026-09-28T00:00:00.000Z',
    });
    const svc = service({ MATRIX_PRIVATE_PREVIEW_LIMIT: '1' });
    await start(svc, 1907, v1);
    await expect(start(svc, 1908, otherPr)).rejects.toMatchObject({ status: 429, code: 'quota_exceeded' });
  });

  it('authorizes provider creation without the owner billing entitlement', async () => {
    const resolveBillingEntitlement = vi.fn();
    await expect(assertMachineProviderMutationAllowed(
      { resolveBillingEntitlement } as never,
      {
        clerkUserId: owner,
        runtimeSlot: 'pv-1907-3fa91c2e',
        provisioningClass: 'private-preview',
        activationState: 'authorized',
        prebillingIntentId: null,
      },
      'cpx22',
      new Date(),
    )).resolves.toBeUndefined();
    expect(resolveBillingEntitlement).not.toHaveBeenCalled();
  });

  describe('explicit update', () => {
    async function runningPreview(svc: ReturnType<typeof service>) {
      const started = await start(svc, 1907, v1);
      await sql`UPDATE user_machines SET status = 'running', public_ipv4 = '203.0.113.19' WHERE machine_id = ${started.machineId}`.execute(db.kysely);
      return started;
    }

    it('confirms the new version before asking the machine to install it', async () => {
      const svc = service();
      const started = await runningPreview(svc);
      const fetchMock = vi.fn(async () => {
        // The confirmation is visible to the update base before the machine is triggered.
        await expect(getUserMachine(db, started.machineId)).resolves.toMatchObject({ confirmedBundleVersion: v2 });
        return new Response('{}', { status: 202 });
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(svc.updatePrivatePreview({ clerkUserId: owner, machineId: started.machineId, bundleVersion: v2 }))
        .resolves.toEqual({ machineId: started.machineId, status: 'updating' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://203.0.113.19:443/api/system/update');
      expect(JSON.parse(String(init.body))).toEqual({ version: v2 });
    });

    it('rejects another PR, another owner, or a machine that is not running', async () => {
      const svc = service();
      const started = await runningPreview(svc);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })));

      await expect(svc.updatePrivatePreview({ clerkUserId: owner, machineId: started.machineId, bundleVersion: otherPr }))
        .rejects.toMatchObject({ status: 409 });
      await expect(svc.updatePrivatePreview({ clerkUserId: 'user_other', machineId: started.machineId, bundleVersion: v2 }))
        .rejects.toMatchObject({ status: 404 });
      await sql`UPDATE user_machines SET status = 'provisioning' WHERE machine_id = ${started.machineId}`.execute(db.kysely);
      await expect(svc.updatePrivatePreview({ clerkUserId: owner, machineId: started.machineId, bundleVersion: v2 }))
        .rejects.toMatchObject({ status: 409 });
      await expect(getUserMachine(db, started.machineId)).resolves.toMatchObject({ confirmedBundleVersion: v1 });
    });
  });
});
