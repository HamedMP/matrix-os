import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getUserMachine,
  insertUserMachine,
  updateUserMachine,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

describe('user machine substrate records', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('reads a machine inserted without substrate fields as a generation-1 vps runtime', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: 'user_a', handle: 'alice', status: 'running',
      publicIPv4: '203.0.113.10', provisionedAt: '2026-11-01T00:00:00.000Z',
    });

    const machine = await getUserMachine(db, 'vps-1');
    expect(machine).toMatchObject({
      substrate: 'vps',
      generation: 1,
      substrateRef: null,
      privateAddress: null,
      lastActivityAt: null,
      startedAt: null,
      publicIPv4: '203.0.113.10',
    });
  });

  it('round-trips container substrate fields through insert and update', async () => {
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: 'user_b', handle: 'bob', status: 'stopped',
      provisionedAt: '2026-11-01T00:00:00.000Z',
      substrate: 'container', generation: 2, substrateRef: 'instance-abc',
      privateAddress: '10.0.0.5', startedAt: '2026-11-02T09:00:00.000Z',
    });
    expect(await getUserMachine(db, 'ctr-1')).toMatchObject({
      substrate: 'container',
      generation: 2,
      substrateRef: 'instance-abc',
      privateAddress: '10.0.0.5',
      startedAt: '2026-11-02T09:00:00.000Z',
      lastActivityAt: null,
      hetznerServerId: null,
      publicIPv4: null,
    });

    await updateUserMachine(db, 'ctr-1', {
      generation: 3, substrateRef: null, privateAddress: null,
      lastActivityAt: '2026-11-02T10:30:00.000Z', startedAt: null,
    });
    expect(await getUserMachine(db, 'ctr-1')).toMatchObject({
      substrate: 'container',
      generation: 3,
      substrateRef: null,
      privateAddress: null,
      lastActivityAt: '2026-11-02T10:30:00.000Z',
      startedAt: null,
    });
  });
  it('reads metal host and VM ids so routing can find the host', async () => {
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'metal-1', name: 'metal-1', apiUrl: 'https://hostd.example.test:8443',
      ingressHost: 'metal.example.test:9443', status: 'active',
      memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    await insertUserMachine(db, {
      machineId: 'metal-m1', clerkUserId: 'user_c', handle: 'carol', status: 'suspended',
      provisionedAt: '2026-11-01T00:00:00.000Z',
      substrate: 'metal', generation: 2, metalHostId: 'metal-1', metalVmId: 'vm_0123456789abcdef01234567',
    });
    expect(await getUserMachine(db, 'metal-m1')).toMatchObject({
      substrate: 'metal', generation: 2, metalHostId: 'metal-1', metalVmId: 'vm_0123456789abcdef01234567',
    });

    await updateUserMachine(db, 'metal-m1', { metalVmId: 'vm_fedcba9876543210fedcba98' });
    expect(await getUserMachine(db, 'metal-m1')).toMatchObject({ metalVmId: 'vm_fedcba9876543210fedcba98' });
  });

  it('reads a vps machine with null metal ids', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-2', clerkUserId: 'user_d', handle: 'dave', status: 'running',
      publicIPv4: '203.0.113.11', provisionedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(await getUserMachine(db, 'vps-2')).toMatchObject({ metalHostId: null, metalVmId: null });
  });
});
