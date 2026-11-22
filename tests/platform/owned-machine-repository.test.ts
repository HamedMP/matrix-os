import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import {
  listRunningUserMachines,
  listStaleUserMachines,
} from '../../packages/platform/src/database/user-machines.js';
import {
  approveOwnedEnrollment,
  claimOwnedTunnelWork,
  createOwnedEnrollment,
  getOwnedMachineLink,
  lapseUndeliveredOwnedEnrollments,
  listOwnedMachineLinks,
  markOwnedEnrollmentDelivered,
  markOwnedTunnelDeleted,
  markOwnedTunnelReady,
  pollOwnedEnrollment,
  queueStaleOwnedTunnelReclaim,
  recordOwnedHeartbeat,
  recordOwnedTunnelCreated,
  requestOwnedTunnelReissue,
  revokeOwnedMachine,
  toOwnedComputerSummary,
} from '../../packages/platform/src/owned-machines/repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const REPORT = { hostname: 'lab', os: 'Ubuntu 24.04', arch: 'x86_64' as const, agentVersion: '1.0.0' };
let counter = 0;

function code(): string {
  counter += 1;
  const letters = 'BCDFGHJKLMNPQRSTVWXZ';
  let n = counter;
  let out = '';
  for (let i = 0; i < 8; i += 1) { out += letters[n % 20]; n = Math.floor(n / 20); }
  return out;
}

async function enroll(db: PlatformDB, sourceKey = 'src-1'): Promise<{ userCode: string; deviceCodeHash: string }> {
  const userCode = code();
  const deviceCodeHash = `hash-${userCode}`;
  const result = await createOwnedEnrollment(db, {
    enrollmentId: randomUUID(), deviceCodeHash, userCode, report: REPORT, sourceKey,
    now: NOW, expiresAt: new Date(NOW.getTime() + 900_000),
  });
  expect(result).toBe('created');
  return { userCode, deviceCodeHash };
}

async function approve(db: PlatformDB, userCode: string, owner = 'user_1', now = NOW) {
  return approveOwnedEnrollment(db, {
    userCode, clerkUserId: owner, handle: 'alice', name: 'Lab', machineId: randomUUID(),
    runtimeSlot: `owned-${randomUUID().slice(0, 8)}`, now, isHandleAvailable: async () => true,
  });
}

async function provisionTunnel(db: PlatformDB, machineId: string, tunnelId: string, host: string, now = NOW) {
  const [item] = await claimOwnedTunnelWork(db, { now, limit: 1, leaseMs: 60_000 });
  expect(item?.machineId).toBe(machineId);
  const claim = { claimId: item!.claimId, now };
  expect(await recordOwnedTunnelCreated(db, { machineId, tunnelId, tunnelHostname: host, claim })).toBe(true);
  expect(await markOwnedTunnelReady(db, machineId, claim)).toBe(true);
}

async function finishDelete(db: PlatformDB, machineId: string, now = NOW) {
  const [item] = await claimOwnedTunnelWork(db, { now, limit: 1, leaseMs: 60_000 });
  expect(item).toMatchObject({ machineId, tunnelState: 'deleting' });
  await markOwnedTunnelDeleted(db, machineId, { claimId: item!.claimId, now });
}

describe('owned machine repository', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('rate limits enrollment starts per source', async () => {
    for (let i = 0; i < 5; i += 1) await enroll(db, 'busy');
    const result = await createOwnedEnrollment(db, {
      enrollmentId: randomUUID(), deviceCodeHash: 'x', userCode: code(), report: REPORT, sourceKey: 'busy',
      now: NOW, expiresAt: new Date(NOW.getTime() + 900_000),
    });
    expect(result).toBe('rate_limited');
  });

  it('approves into an owned enrolling machine and delivers exactly once', async () => {
    const { userCode, deviceCodeHash } = await enroll(db);
    expect(await pollOwnedEnrollment(db, deviceCodeHash, NOW, 0)).toEqual({ status: 'pending' });
    const approved = await approve(db, userCode);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.machine).toMatchObject({ substrate: 'owned', provisioningClass: 'owned', status: 'enrolling' });
    const poll = await pollOwnedEnrollment(db, deviceCodeHash, new Date(NOW.getTime() + 10_000), 0);
    expect(poll).toMatchObject({ status: 'approved', tunnelState: 'pending' });
    if (poll.status !== 'approved') return;
    expect(await markOwnedEnrollmentDelivered(db, poll.enrollmentId, NOW)).toBe(true);
    expect(await markOwnedEnrollmentDelivered(db, poll.enrollmentId, NOW)).toBe(false);
    expect(await pollOwnedEnrollment(db, deviceCodeHash, new Date(NOW.getTime() + 20_000), 0)).toEqual({ status: 'expired' });
    expect((await approve(db, userCode)).ok).toBe(false);
  });

  it('answers slow_down for fast polls and expired after the code lifetime', async () => {
    const { deviceCodeHash } = await enroll(db);
    await pollOwnedEnrollment(db, deviceCodeHash, NOW, 5_000);
    expect(await pollOwnedEnrollment(db, deviceCodeHash, new Date(NOW.getTime() + 1_000), 5_000)).toEqual({ status: 'slow_down' });
    expect(await pollOwnedEnrollment(db, deviceCodeHash, new Date(NOW.getTime() + 901_000), 5_000)).toEqual({ status: 'expired' });
  });

  it('caps an account at three owned machines', async () => {
    for (let i = 0; i < 3; i += 1) expect((await approve(db, (await enroll(db, `s${i}`)).userCode)).ok).toBe(true);
    expect(await approve(db, (await enroll(db, 's9')).userCode)).toEqual({ ok: false, reason: 'machine_limit' });
  });

  it('frees a slot after revocation and keeps owned rows out of fleet listings', async () => {
    const approved = await approve(db, (await enroll(db)).userCode);
    if (!approved.ok) throw new Error('approve failed');
    const machineId = approved.machine.machineId;
    await provisionTunnel(db, machineId, 't-1', 'abc.m.example.net');
    const beat = await recordOwnedHeartbeat(db, { machineId, epoch: 1, agentVersion: '1.0.1', now: NOW, debounceMs: 30_000 });
    expect(beat?.machine.status).toBe('running');
    expect(toOwnedComputerSummary(beat!, NOW).status).toBe('online');
    expect(await listRunningUserMachines(db, 50)).toEqual([]);
    expect((await listRunningUserMachines(db, 50, { provisioningClass: 'owned' })).map((m) => m.machineId)).toEqual([machineId]);
    expect(await listStaleUserMachines(db, ['enrolling', 'running'], '2030-01-01T00:00:00.000Z', 50)).toEqual([]);

    const seen: string[] = [];
    expect(await revokeOwnedMachine(db, {
      machineId, clerkUserId: 'user_1', now: NOW,
      hooks: [async (_trx, machine) => { seen.push(machine.machineId); }],
    })).toBe(true);
    expect(seen).toEqual([machineId]);
    const link = await getOwnedMachineLink(db, machineId);
    expect(link).toMatchObject({ tunnelState: 'deleting' });
    expect(link?.machine.runtimeTokenEpoch).toBe(2);
    expect(link?.machine.deletedAt).not.toBeNull();
    expect(await recordOwnedHeartbeat(db, { machineId, epoch: 1, agentVersion: '1', now: NOW, debounceMs: 0 })).toBeNull();
    expect(await recordOwnedHeartbeat(db, { machineId, epoch: 2, agentVersion: '1', now: NOW, debounceMs: 0 })).toBeNull();
    expect(await listOwnedMachineLinks(db, 'user_1')).toEqual([]);
    expect(await revokeOwnedMachine(db, { machineId, now: NOW })).toBe(false);
    const work = await claimOwnedTunnelWork(db, { now: NOW, limit: 10, leaseMs: 60_000 });
    expect(work).toMatchObject([{ machineId, tunnelState: 'deleting', revoked: true, tunnelId: 't-1' }]);
    await markOwnedTunnelDeleted(db, machineId, { claimId: work[0]!.claimId, now: NOW });
    expect((await getOwnedMachineLink(db, machineId))?.tunnelState).toBe('deleted');
  });

  it('rejects revocation by another owner', async () => {
    const approved = await approve(db, (await enroll(db)).userCode);
    if (!approved.ok) throw new Error('approve failed');
    expect(await revokeOwnedMachine(db, { machineId: approved.machine.machineId, clerkUserId: 'user_2', now: NOW })).toBe(false);
  });

  it('reclaims tunnels of long-offline machines and reissues on reconnect', async () => {
    const approved = await approve(db, (await enroll(db)).userCode);
    if (!approved.ok) throw new Error('approve failed');
    const machineId = approved.machine.machineId;
    await provisionTunnel(db, machineId, 't-2', 'def.m.example.net');
    expect(await queueStaleOwnedTunnelReclaim(db, { offlineBefore: new Date(NOW.getTime() + 1), now: NOW, limit: 10 })).toBe(1);
    await finishDelete(db, machineId);
    expect((await getOwnedMachineLink(db, machineId))?.tunnelState).toBe('reclaimed');
    expect(await requestOwnedTunnelReissue(db, machineId, NOW)).toBe(true);
    expect((await getOwnedMachineLink(db, machineId))?.tunnelState).toBe('pending');
  });

  it('leases tunnel work so a second worker skips it', async () => {
    await approve(db, (await enroll(db)).userCode);
    expect(await claimOwnedTunnelWork(db, { now: NOW, limit: 10, leaseMs: 60_000 })).toHaveLength(1);
    expect(await claimOwnedTunnelWork(db, { now: NOW, limit: 10, leaseMs: 60_000 })).toHaveLength(0);
    expect(await claimOwnedTunnelWork(db, { now: new Date(NOW.getTime() + 61_000), limit: 10, leaseMs: 60_000 })).toHaveLength(1);
  });

  it('rejects writes from a worker whose lease expired and was re-claimed', async () => {
    const approved = await approve(db, (await enroll(db)).userCode);
    if (!approved.ok) throw new Error('approve failed');
    const machineId = approved.machine.machineId;
    const [first] = await claimOwnedTunnelWork(db, { now: NOW, limit: 1, leaseMs: 60_000 });
    const later = new Date(NOW.getTime() + 61_000);
    const [second] = await claimOwnedTunnelWork(db, { now: later, limit: 1, leaseMs: 60_000 });
    expect(second?.claimId).not.toBe(first?.claimId);
    expect(await recordOwnedTunnelCreated(db, { machineId, tunnelId: 'old', tunnelHostname: 'old.m.example.net',
      claim: { claimId: first!.claimId, now: later } })).toBe(false);
    expect(await recordOwnedTunnelCreated(db, { machineId, tunnelId: 'new', tunnelHostname: 'new.m.example.net',
      claim: { claimId: second!.claimId, now: later } })).toBe(true);
    expect(await markOwnedTunnelReady(db, machineId, { claimId: first!.claimId, now: later })).toBe(false);
    expect((await getOwnedMachineLink(db, machineId))?.tunnelHostname).toBe('new.m.example.net');
  });

  it('lapses an approval the machine never collects and frees the slot', async () => {
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push(await enroll(db, `s${i}`));
    for (const { userCode } of codes) expect((await approve(db, userCode)).ok).toBe(true);
    const late = new Date(NOW.getTime() + 16 * 60_000);
    const poll = await pollOwnedEnrollment(db, codes[0]!.deviceCodeHash, late, 0);
    expect(poll).toEqual({ status: 'expired' });
    expect(await lapseUndeliveredOwnedEnrollments(db, late, 10)).toBe(3);
    expect(await lapseUndeliveredOwnedEnrollments(db, late, 10)).toBe(0);
    expect(await listOwnedMachineLinks(db, 'user_1')).toEqual([]);
    const fresh = await createOwnedEnrollment(db, {
      enrollmentId: randomUUID(), deviceCodeHash: 'late', userCode: code(), report: REPORT, sourceKey: 'late',
      now: late, expiresAt: new Date(late.getTime() + 900_000),
    });
    expect(fresh).toBe('created');
  });

  it('frees slots held by uncollected approvals when the owner approves again', async () => {
    for (let i = 0; i < 3; i += 1) expect((await approve(db, (await enroll(db, `t${i}`)).userCode)).ok).toBe(true);
    const late = new Date(NOW.getTime() + 16 * 60_000);
    const fresh = await enroll(db, 'later');
    await db.executor.updateTable('owned_machine_enrollments').set({ expires_at: new Date(late.getTime() + 900_000) })
      .where('user_code', '=', fresh.userCode).execute();
    expect((await approve(db, fresh.userCode, 'user_1', late)).ok).toBe(true);
    expect(await listOwnedMachineLinks(db, 'user_1')).toHaveLength(1);
  });

  it('refuses delivery after the delivery window even if the poll raced it', async () => {
    const { userCode, deviceCodeHash } = await enroll(db);
    await approve(db, userCode);
    const poll = await pollOwnedEnrollment(db, deviceCodeHash, NOW, 0);
    if (poll.status !== 'approved') throw new Error('not approved');
    expect(await markOwnedEnrollmentDelivered(db, poll.enrollmentId, new Date(NOW.getTime() + 16 * 60_000))).toBe(false);
  });

  it('enforces the global pending cap across sources', async () => {
    const base = { report: REPORT, now: NOW, expiresAt: new Date(NOW.getTime() + 900_000), pendingCap: 2 };
    expect(await createOwnedEnrollment(db, { ...base, enrollmentId: randomUUID(), deviceCodeHash: 'a', userCode: code(), sourceKey: 'one' })).toBe('created');
    expect(await createOwnedEnrollment(db, { ...base, enrollmentId: randomUUID(), deviceCodeHash: 'b', userCode: code(), sourceKey: 'two' })).toBe('created');
    expect(await createOwnedEnrollment(db, { ...base, enrollmentId: randomUUID(), deviceCodeHash: 'c', userCode: code(), sourceKey: 'three' })).toBe('capacity');
  });

  it('enforces the owned row shape in the database', async () => {
    await expect(sql`
      INSERT INTO user_machines (machine_id, clerk_user_id, handle, runtime_slot, provisioned_at, status, substrate, provisioning_class)
      VALUES ('m-x', 'u', 'h', 'primary', '2026-11-01', 'enrolling', 'owned', 'owned')
    `.execute(db.kysely)).rejects.toThrow();
  });
});

describe('owned machine migration', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('widens a database that still has the two-substrate check and stays idempotent', async () => {
    const { migrateOwnedMachines } = await import('../../packages/platform/src/owned-machines/migration.js');
    await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_substrate_check`.execute(db.kysely);
    await sql`ALTER TABLE user_machines ADD CONSTRAINT user_machines_substrate_check CHECK (substrate IN ('vps', 'container'))`.execute(db.kysely);
    await migrateOwnedMachines(db.kysely);
    await migrateOwnedMachines(db.kysely);
    const approved = await approve(db, (await enroll(db)).userCode);
    expect(approved.ok).toBe(true);
    await expect(sql`UPDATE user_machines SET substrate = 'hetzner'`.execute(db.kysely)).rejects.toThrow();
  });

  it('keeps values another branch added to the substrate check when widening it', async () => {
    const { migrateOwnedMachines } = await import('../../packages/platform/src/owned-machines/migration.js');
    await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_substrate_check`.execute(db.kysely);
    await sql`ALTER TABLE user_machines DROP CONSTRAINT user_machines_owned_shape_check`.execute(db.kysely);
    await sql`ALTER TABLE user_machines ADD CONSTRAINT user_machines_substrate_check CHECK (substrate IN ('vps', 'container', 'metal'))`.execute(db.kysely);
    await sql`INSERT INTO user_machines (machine_id, clerk_user_id, handle, runtime_slot, provisioned_at, status, substrate)
      VALUES ('m-metal', 'u', 'h', 'primary', '2026-11-01', 'running', 'metal')`.execute(db.kysely);
    await migrateOwnedMachines(db.kysely);
    await migrateOwnedMachines(db.kysely);
    const def = await sql<{ d: string }>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'user_machines_substrate_check'`.execute(db.kysely);
    expect(def.rows[0]?.d).toContain('metal');
    expect(def.rows[0]?.d).toContain('owned');
  });

  it('records its own schema scope instead of the shared core generation', async () => {
    const rows = await sql<{ generation: number; fingerprint: string }>`
      SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'owned-machines'`.execute(db.kysely);
    expect(rows.rows).toEqual([{ generation: 2, fingerprint: 'owned-machines-v2' }]);
  });
});
