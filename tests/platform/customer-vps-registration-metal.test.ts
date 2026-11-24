import { describe, expect, it } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { RegisterRequestSchema } from '../../packages/platform/src/customer-vps-schema.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

/**
 * Registration for metal runtimes (spec 2691, ENG-520). A metal guest has no
 * Hetzner server id or public IPv4; it proves itself with the same one-time
 * registration token and names its platform machine as serverRef. Faults
 * detected: a metal guest unable to register, a guest registering a machine
 * it does not own, cross-provider confusion, and a regression in the
 * already-shipped Hetzner contract.
 */

const METAL_MACHINE_ID = '6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f';
const IMAGE_VERSION = 'matrix-os-host-2026.11.20-1';
const BUNDLE_SHA = 'c'.repeat(64);
const PINNED = { imageVersion: IMAGE_VERSION, bundleSha256: BUNDLE_SHA, healthy: true };

async function insertMetalRow(db: PlatformDB, overrides: { status?: string; metalVmId?: string | null; privateAddress?: string | null } = {}) {
  await createMetalHostsRepository(db.kysely).upsert({
    id: 'host-a',
    name: 'host-a',
    apiUrl: 'https://host-a.metal.example.test:8443',
    ingressHost: 'host-a.metal.example.test',
    status: 'active',
    memoryCapacityMib: 131072,
    admissionCeilingMib: 114688,
  });
  await insertUserMachine(db, {
    machineId: METAL_MACHINE_ID,
    clerkUserId: 'user_metal',
    handle: 'metal-owner',
    runtimeSlot: 'primary',
    substrate: 'metal',
    metalHostId: 'host-a',
    metalVmId: overrides.metalVmId === undefined ? 'vm_0123456789abcdef01234567' : overrides.metalVmId,
    privateAddress: overrides.privateAddress === undefined ? '10.77.0.9' : overrides.privateAddress,
    status: overrides.status ?? 'provisioning',
    imageVersion: IMAGE_VERSION,
    targetBundleVersion: IMAGE_VERSION,
    targetBundleSha256: BUNDLE_SHA,
    registrationTokenHash: hashRegistrationToken('registration-token'),
    registrationTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    provisionedAt: '2026-04-26T11:59:00.000Z',
  });
}

describe('customer VPS registration for metal runtimes', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture((value) => { db = value!; });

  it('deleting a metal machine queues its VM teardown with the soft delete, and never calls Hetzner', async () => {
    const { service, hetzner } = createService();
    await insertMetalRow(db, { status: 'running' });

    await expect(service.delete(METAL_MACHINE_ID)).resolves.toMatchObject({ deleted: true, machineId: METAL_MACHINE_ID });

    expect((await getUserMachine(db, METAL_MACHINE_ID))?.status).toBe('deleted');
    expect(await db.executor.selectFrom('metal_vm_deletions')
      .select(['machine_id', 'metal_host_id', 'metal_vm_id', 'reason', 'completed_at']).execute())
      .toEqual([{ machine_id: METAL_MACHINE_ID, metal_host_id: 'host-a', metal_vm_id: 'vm_0123456789abcdef01234567', reason: 'delete', completed_at: null }]);
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
  });

  it('refuses to recover a metal machine before changing its row or calling Hetzner', async () => {
    const { service, hetzner } = createService();
    await insertMetalRow(db, { status: 'running' });
    await expect(service.recover({ clerkUserId: 'user_metal', runtimeSlot: 'primary', allowEmpty: true }))
      .rejects.toMatchObject({ status: 409, code: 'invalid_state' });
    expect(await getUserMachine(db, METAL_MACHINE_ID)).toMatchObject({ status: 'running', substrate: 'metal' });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('account deletion of a metal-only owner needs no Hetzner client and stays pending until the VM teardown completes', async () => {
    const { service } = createService();
    await insertMetalRow(db, { status: 'running' });
    const adapters = createAccountDeletionAdapters({ db, clerkSecretKey: 'key', r2PrefixRoot: 'sync', customerVpsService: service,
      fetch: async () => Response.json({ data: [], total_count: 0 }) });
    const ctx = { clerkUserId: 'user_metal', appleTokens: [] };
    await expect(adapters.vps(ctx)).rejects.toThrow('Runtime cleanup pending');
    expect((await getUserMachine(db, METAL_MACHINE_ID))?.status).toBe('deleted');
    await expect(eraseOwnerPlatformData(db, 'user_metal')).rejects.toThrow('runtime_cleanup_pending');

    await db.executor.updateTable('metal_vm_deletions').set({ completed_at: '2026-04-26T12:00:00.000Z' }).execute();
    await expect(adapters.vps(ctx)).resolves.toBeUndefined();
  });

  it('registration accepts metal with serverRef and rejects a wrong serverRef', async () => {
    const { service, systemStore } = createService();
    await insertMetalRow(db);

    await expect(service.register('registration-token', {
      provider: 'metal',
      machineId: METAL_MACHINE_ID,
      serverRef: 'f0e1d2c3-b4a5-4968-8776-655443322110',
      ...PINNED,
    })).rejects.toMatchObject({ status: 401, code: 'registration_rejected' });
    expect((await getUserMachine(db, METAL_MACHINE_ID))?.status).toBe('provisioning');

    await expect(service.register('wrong-token', {
      provider: 'metal',
      machineId: METAL_MACHINE_ID,
      serverRef: METAL_MACHINE_ID,
      ...PINNED,
    })).rejects.toMatchObject({ status: 401 });

    await expect(service.register('registration-token', {
      provider: 'metal',
      machineId: METAL_MACHINE_ID,
      serverRef: METAL_MACHINE_ID,
      ...PINNED,
    })).resolves.toEqual({ registered: true, status: 'running' });

    const row = await getUserMachine(db, METAL_MACHINE_ID);
    expect(row).toMatchObject({
      status: 'running',
      substrate: 'metal',
      registrationTokenHash: null,
      registrationTokenExpiresAt: null,
      publicIPv4: null,
      hetznerServerId: null,
      metalVmId: 'vm_0123456789abcdef01234567',
      privateAddress: '10.77.0.9',
    });
    // vps-meta is the Hetzner recovery record; metal runtimes do not write it.
    expect(systemStore.writtenMeta).toHaveLength(0);

    await expect(service.register('registration-token', {
      provider: 'metal',
      machineId: METAL_MACHINE_ID,
      serverRef: METAL_MACHINE_ID,
      ...PINNED,
    })).rejects.toMatchObject({ status: 409, code: 'already_registered' });
  });

  it('verifies the pinned bundle for metal: a mismatched digest is rejected, a matching one is accepted', async () => {
    const { service } = createService();
    await insertMetalRow(db);
    const body = { provider: 'metal' as const, machineId: METAL_MACHINE_ID, serverRef: METAL_MACHINE_ID };

    await expect(service.register('registration-token', { ...body, ...PINNED, bundleSha256: 'd'.repeat(64) }))
      .rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(service.register('registration-token', { ...body, imageVersion: IMAGE_VERSION }))
      .rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    await expect(service.register('registration-token', { ...body, ...PINNED, healthy: false }))
      .rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
    expect((await getUserMachine(db, METAL_MACHINE_ID))?.status).toBe('provisioning');

    await expect(service.register('registration-token', { ...body, ...PINNED }))
      .resolves.toEqual({ registered: true, status: 'running' });
    expect(await getUserMachine(db, METAL_MACHINE_ID)).toMatchObject({ targetBundleSha256: BUNDLE_SHA });
  });

  it('refuses a metal registration with a retryable error until the VM id is recorded', async () => {
    const { service } = createService();
    await insertMetalRow(db, { metalVmId: null, privateAddress: null });

    await expect(service.register('registration-token', {
      provider: 'metal', machineId: METAL_MACHINE_ID, serverRef: METAL_MACHINE_ID, ...PINNED,
    })).rejects.toMatchObject({ status: 503 });
    expect((await getUserMachine(db, METAL_MACHINE_ID))?.status).toBe('provisioning');
  });

  it('refuses a metal row that carries no bundle pin', async () => {
    const { service } = createService();
    await insertMetalRow(db);
    await db.executor.updateTable('user_machines')
      .set({ target_bundle_version: null, target_bundle_sha256: null })
      .where('machine_id', '=', METAL_MACHINE_ID).execute();

    await expect(service.register('registration-token', {
      provider: 'metal', machineId: METAL_MACHINE_ID, serverRef: METAL_MACHINE_ID, ...PINNED,
    })).rejects.toMatchObject({ status: 409, code: 'registration_rejected' });
  });

  it('rejects a Hetzner registration for a metal machine and a metal registration for a Hetzner machine', async () => {
    const { service } = createService();
    await insertMetalRow(db);
    const hetzner = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(service.register('registration-token', {
      machineId: METAL_MACHINE_ID,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: IMAGE_VERSION,
    })).rejects.toMatchObject({ status: 401 });
    await expect(service.register('registration-token', {
      provider: 'metal',
      machineId: hetzner.machineId,
      serverRef: hetzner.machineId,
      imageVersion: IMAGE_VERSION,
    })).rejects.toMatchObject({ status: 401 });

    expect((await getUserMachine(db, METAL_MACHINE_ID))?.status).toBe('provisioning');
    expect((await getUserMachine(db, hetzner.machineId))?.status).toBe('provisioning');
  });

  it('hetzner registration is unchanged', async () => {
    const { service, systemStore } = createService();
    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(service.register('registration-token', {
      machineId: provisioned.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    })).resolves.toEqual({ registered: true, status: 'running' });

    expect(await getUserMachine(db, provisioned.machineId)).toMatchObject({
      status: 'running',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
    });
    expect(systemStore.writtenMeta).toHaveLength(1);
  });

  it('parses the register body as hetzner by default and metal only by its exact shape', () => {
    const hetznerBody = {
      machineId: METAL_MACHINE_ID,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: IMAGE_VERSION,
    };
    expect(RegisterRequestSchema.safeParse(hetznerBody).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...hetznerBody, provider: 'hetzner' }).success).toBe(true);

    const metalBody = { provider: 'metal', machineId: METAL_MACHINE_ID, serverRef: METAL_MACHINE_ID, imageVersion: IMAGE_VERSION };
    expect(RegisterRequestSchema.safeParse(metalBody).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...metalBody, bundleSha256: 'a'.repeat(64), healthy: true }).success).toBe(true);

    expect(RegisterRequestSchema.safeParse({ ...metalBody, publicIPv4: '203.0.113.10' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...metalBody, hetznerServerId: 1 }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...metalBody, serverRef: '' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...metalBody, serverRef: 'a"b' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...metalBody, serverRef: 'a'.repeat(129) }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...hetznerBody, provider: 'metal' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ ...hetznerBody, provider: 'other' }).success).toBe(false);
  });
});
