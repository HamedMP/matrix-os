import { sql } from 'kysely';
import {
  OWNED_MACHINE_HEARTBEAT_FRESH_MS,
  OWNED_MACHINE_LIMIT_PER_ACCOUNT,
  type OwnedComputerStatus,
  type OwnedComputerSummary,
  type OwnedMachineReport,
} from '@matrix-os/contracts';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import { mapUserMachine, toUserMachineRow } from '../database/user-machine-records.js';
import type { OwnedTunnelState } from './types.js';

export const OWNED_ENROLLMENTS_PER_SOURCE_PER_HOUR = 5;
export const OWNED_ENROLLMENTS_PER_OWNER_PER_DAY = 5;
export const OWNED_PENDING_ENROLLMENTS_MAX = 1_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

async function advisoryLock(db: PlatformDB, key: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(('x' || substr(md5(${key}), 1, 16))::bit(64)::bigint)`.execute(db.executor);
}

export type CreateEnrollmentResult = 'created' | 'rate_limited' | 'capacity' | 'code_conflict';

export async function createOwnedEnrollment(db: PlatformDB, input: {
  enrollmentId: string;
  deviceCodeHash: string;
  userCode: string;
  report: OwnedMachineReport;
  sourceKey: string;
  now: Date;
  expiresAt: Date;
}): Promise<CreateEnrollmentResult> {
  return db.transaction(async (trx) => {
    await advisoryLock(trx, `owned-enroll-source:${input.sourceKey}`);
    const recent = await trx.executor.selectFrom('owned_machine_enrollments')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('source_key', '=', input.sourceKey)
      .where('created_at', '>', new Date(input.now.getTime() - HOUR_MS))
      .executeTakeFirstOrThrow();
    if (Number(recent.count) >= OWNED_ENROLLMENTS_PER_SOURCE_PER_HOUR) return 'rate_limited';
    const pending = await trx.executor.selectFrom('owned_machine_enrollments')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', '=', 'pending')
      .where('expires_at', '>', input.now)
      .executeTakeFirstOrThrow();
    if (Number(pending.count) >= OWNED_PENDING_ENROLLMENTS_MAX) return 'capacity';
    const inserted = await trx.executor.insertInto('owned_machine_enrollments').values({
      enrollment_id: input.enrollmentId,
      device_code_hash: input.deviceCodeHash,
      user_code: input.userCode,
      reported_hostname: input.report.hostname,
      reported_os: input.report.os,
      reported_arch: input.report.arch,
      agent_version: input.report.agentVersion,
      source_key: input.sourceKey,
      created_at: input.now,
      expires_at: input.expiresAt,
    }).onConflict((oc) => oc.doNothing()).returning('enrollment_id').executeTakeFirst();
    return inserted ? 'created' : 'code_conflict';
  });
}

export interface PendingEnrollment {
  enrollmentId: string;
  userCode: string;
  report: OwnedMachineReport;
  expiresAt: Date;
}

export async function getPendingEnrollmentByUserCode(
  db: PlatformDB, userCode: string, now: Date,
): Promise<PendingEnrollment | null> {
  await db.ready;
  const row = await db.executor.selectFrom('owned_machine_enrollments').selectAll()
    .where('user_code', '=', userCode).where('status', '=', 'pending').where('expires_at', '>', now)
    .executeTakeFirst();
  if (!row) return null;
  return {
    enrollmentId: row.enrollment_id,
    userCode: row.user_code,
    report: { hostname: row.reported_hostname, os: row.reported_os, arch: row.reported_arch, agentVersion: row.agent_version },
    expiresAt: new Date(row.expires_at),
  };
}

export type ApproveEnrollmentResult =
  | { ok: true; machine: UserMachineRecord }
  | { ok: false; reason: 'not_found' | 'machine_limit' | 'daily_limit' | 'handle_unavailable' };

/**
 * Approval is one transaction: owner cap, daily cap, machine row, link row and
 * the enrollment transition. Tunnel creation happens later from the link row.
 */
export async function approveOwnedEnrollment(db: PlatformDB, input: {
  userCode: string;
  clerkUserId: string;
  handle: string;
  name: string;
  machineId: string;
  runtimeSlot: string;
  now: Date;
  isHandleAvailable: (trx: PlatformDB, handle: string, clerkUserId: string) => Promise<boolean>;
}): Promise<ApproveEnrollmentResult> {
  return db.transaction(async (trx) => {
    await advisoryLock(trx, `owned-owner:${input.clerkUserId}`);
    await advisoryLock(trx, `handle:${input.handle}`);
    const enrollment = await trx.executor.selectFrom('owned_machine_enrollments').selectAll()
      .where('user_code', '=', input.userCode).where('status', '=', 'pending').where('expires_at', '>', input.now)
      .forUpdate().executeTakeFirst();
    if (!enrollment) return { ok: false, reason: 'not_found' };
    const active = await trx.executor.selectFrom('owned_machine_links')
      .innerJoin('user_machines', 'user_machines.machine_id', 'owned_machine_links.machine_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('owned_machine_links.clerk_user_id', '=', input.clerkUserId)
      .where('owned_machine_links.revoked_at', 'is', null)
      .where('user_machines.deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(active.count) >= OWNED_MACHINE_LIMIT_PER_ACCOUNT) return { ok: false, reason: 'machine_limit' };
    const today = await trx.executor.selectFrom('owned_machine_enrollments')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('clerk_user_id', '=', input.clerkUserId)
      .where('approved_at', '>', new Date(input.now.getTime() - DAY_MS))
      .executeTakeFirstOrThrow();
    if (Number(today.count) >= OWNED_ENROLLMENTS_PER_OWNER_PER_DAY) return { ok: false, reason: 'daily_limit' };
    if (!(await input.isHandleAvailable(trx, input.handle, input.clerkUserId))) {
      return { ok: false, reason: 'handle_unavailable' };
    }
    const machineRow = await trx.executor.insertInto('user_machines').values(toUserMachineRow({
      machineId: input.machineId,
      clerkUserId: input.clerkUserId,
      handle: input.handle,
      runtimeSlot: input.runtimeSlot,
      provisioningClass: 'owned',
      substrate: 'owned',
      developerTools: [],
      status: 'enrolling',
      provisionedAt: input.now.toISOString(),
    })).returningAll().executeTakeFirstOrThrow();
    await trx.executor.insertInto('owned_machine_links').values({
      machine_id: input.machineId,
      clerk_user_id: input.clerkUserId,
      display_name: input.name,
      tunnel_id: null,
      tunnel_hostname: null,
      tunnel_next_attempt_at: input.now,
      reported_hostname: enrollment.reported_hostname,
      reported_os: enrollment.reported_os,
      reported_arch: enrollment.reported_arch,
      agent_version: enrollment.agent_version,
      last_heartbeat_at: null,
      paired_at: input.now,
      revoked_at: null,
    }).execute();
    await trx.executor.updateTable('owned_machine_enrollments')
      .set({ status: 'approved', clerk_user_id: input.clerkUserId, machine_id: input.machineId, approved_at: input.now })
      .where('enrollment_id', '=', enrollment.enrollment_id).execute();
    return { ok: true, machine: mapUserMachine(machineRow) };
  });
}

export type PollEnrollmentResult =
  | { status: 'pending' | 'slow_down' | 'expired' | 'denied' }
  | { status: 'approved'; enrollmentId: string; machineId: string; tunnelState: OwnedTunnelState };

export async function pollOwnedEnrollment(
  db: PlatformDB, deviceCodeHash: string, now: Date, minIntervalMs: number,
): Promise<PollEnrollmentResult> {
  return db.transaction(async (trx) => {
    const row = await trx.executor.selectFrom('owned_machine_enrollments').selectAll()
      .where('device_code_hash', '=', deviceCodeHash).forUpdate().executeTakeFirst();
    if (!row || row.status === 'delivered' || row.status === 'expired') return { status: 'expired' };
    if (row.status === 'denied') return { status: 'denied' };
    if (row.status === 'pending' && new Date(row.expires_at).getTime() <= now.getTime()) {
      await trx.executor.updateTable('owned_machine_enrollments').set({ status: 'expired' })
        .where('enrollment_id', '=', row.enrollment_id).execute();
      return { status: 'expired' };
    }
    const tooFast = row.last_polled_at && now.getTime() - new Date(row.last_polled_at).getTime() < minIntervalMs;
    await trx.executor.updateTable('owned_machine_enrollments').set({ last_polled_at: now })
      .where('enrollment_id', '=', row.enrollment_id).execute();
    if (tooFast) return { status: 'slow_down' };
    if (row.status === 'pending' || !row.machine_id) return { status: 'pending' };
    const link = await trx.executor.selectFrom('owned_machine_links').select(['tunnel_state', 'revoked_at'])
      .where('machine_id', '=', row.machine_id).executeTakeFirst();
    if (!link || link.revoked_at) return { status: 'denied' };
    return { status: 'approved', enrollmentId: row.enrollment_id, machineId: row.machine_id, tunnelState: link.tunnel_state };
  });
}

/** Single delivery: only the caller whose compare-and-set wins may hand out credentials. */
export async function markOwnedEnrollmentDelivered(db: PlatformDB, enrollmentId: string, now: Date): Promise<boolean> {
  await db.ready;
  const result = await db.executor.updateTable('owned_machine_enrollments')
    .set({ status: 'delivered', delivered_at: now })
    .where('enrollment_id', '=', enrollmentId).where('status', '=', 'approved')
    .returning('machine_id').executeTakeFirst();
  return Boolean(result);
}

export interface OwnedMachineLink {
  machine: UserMachineRecord;
  displayName: string;
  tunnelState: OwnedTunnelState;
  tunnelId: string | null;
  tunnelHostname: string | null;
  reportedOs: string | null;
  reportedArch: 'x86_64' | 'arm64' | null;
  agentVersion: string | null;
  lastHeartbeatAt: Date | null;
  autoSecurityUpdates: boolean;
  backupsEnabled: boolean;
  revokedAt: Date | null;
}

function linkQuery(db: PlatformDB) {
  return db.executor.selectFrom('owned_machine_links')
    .innerJoin('user_machines', 'user_machines.machine_id', 'owned_machine_links.machine_id')
    .selectAll('user_machines')
    .select([
      'owned_machine_links.display_name', 'owned_machine_links.tunnel_state', 'owned_machine_links.tunnel_id',
      'owned_machine_links.tunnel_hostname', 'owned_machine_links.reported_os', 'owned_machine_links.reported_arch',
      'owned_machine_links.agent_version', 'owned_machine_links.last_heartbeat_at',
      'owned_machine_links.auto_security_updates', 'owned_machine_links.backups_enabled',
      'owned_machine_links.revoked_at',
    ]);
}

type LinkRow = Awaited<ReturnType<ReturnType<typeof linkQuery>['executeTakeFirstOrThrow']>>;

function mapLink(row: LinkRow): OwnedMachineLink {
  return {
    machine: mapUserMachine(row),
    displayName: row.display_name,
    tunnelState: row.tunnel_state,
    tunnelId: row.tunnel_id,
    tunnelHostname: row.tunnel_hostname,
    reportedOs: row.reported_os,
    reportedArch: row.reported_arch,
    agentVersion: row.agent_version,
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null,
    autoSecurityUpdates: row.auto_security_updates,
    backupsEnabled: row.backups_enabled,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

export async function getOwnedMachineLink(db: PlatformDB, machineId: string): Promise<OwnedMachineLink | null> {
  await db.ready;
  const row = await linkQuery(db).where('owned_machine_links.machine_id', '=', machineId).executeTakeFirst();
  return row ? mapLink(row) : null;
}

export function isOwnedHeartbeatFresh(lastHeartbeatAt: Date | null, now: Date): boolean {
  return Boolean(lastHeartbeatAt && now.getTime() - lastHeartbeatAt.getTime() <= OWNED_MACHINE_HEARTBEAT_FRESH_MS);
}

export function ownedComputerStatus(link: OwnedMachineLink, now: Date): OwnedComputerStatus {
  if (link.machine.status === 'enrolling' || !link.lastHeartbeatAt) return 'enrolling';
  return isOwnedHeartbeatFresh(link.lastHeartbeatAt, now) && link.tunnelState === 'ready' ? 'online' : 'offline';
}

export function toOwnedComputerSummary(link: OwnedMachineLink, now: Date): OwnedComputerSummary {
  return {
    machineId: link.machine.machineId,
    handle: link.machine.handle,
    runtimeSlot: link.machine.runtimeSlot,
    name: link.displayName,
    status: ownedComputerStatus(link, now),
    lastSeenAt: link.lastHeartbeatAt?.toISOString() ?? null,
    os: link.reportedOs,
    arch: link.reportedArch,
    agentVersion: link.agentVersion,
    autoSecurityUpdates: link.autoSecurityUpdates,
    backupsEnabled: link.backupsEnabled,
  };
}

export async function listOwnedMachineLinks(db: PlatformDB, clerkUserId: string): Promise<OwnedMachineLink[]> {
  await db.ready;
  const rows = await linkQuery(db)
    .where('owned_machine_links.clerk_user_id', '=', clerkUserId)
    .where('owned_machine_links.revoked_at', 'is', null)
    .where('user_machines.deleted_at', 'is', null)
    .orderBy('owned_machine_links.paired_at')
    .limit(OWNED_MACHINE_LIMIT_PER_ACCOUNT)
    .execute();
  return rows.map(mapLink);
}

/**
 * Records a heartbeat for a live machine. The epoch must match so a rotated or
 * revoked credential cannot keep a machine online. Writes are debounced.
 */
export async function recordOwnedHeartbeat(db: PlatformDB, input: {
  machineId: string;
  epoch: number;
  agentVersion: string;
  now: Date;
  debounceMs: number;
}): Promise<OwnedMachineLink | null> {
  return db.transaction(async (trx) => {
    const row = await linkQuery(trx).where('owned_machine_links.machine_id', '=', input.machineId)
      .forUpdate().executeTakeFirst();
    if (!row) return null;
    const link = mapLink(row);
    if (link.revokedAt || link.machine.deletedAt || link.machine.runtimeTokenEpoch !== input.epoch) return null;
    const stale = !link.lastHeartbeatAt || input.now.getTime() - link.lastHeartbeatAt.getTime() >= input.debounceMs;
    if (stale || link.agentVersion !== input.agentVersion || link.machine.status === 'enrolling') {
      await trx.executor.updateTable('owned_machine_links')
        .set({ last_heartbeat_at: input.now, agent_version: input.agentVersion })
        .where('machine_id', '=', input.machineId).execute();
      if (link.machine.status === 'enrolling') {
        await trx.executor.updateTable('user_machines').set({ status: 'running', last_seen_at: input.now.toISOString() })
          .where('machine_id', '=', input.machineId).where('status', '=', 'enrolling').execute();
      }
    }
    return (await getOwnedMachineLink(trx, input.machineId));
  });
}

export async function updateOwnedComputer(db: PlatformDB, input: {
  clerkUserId: string;
  machineId: string;
  name?: string;
  autoSecurityUpdates?: boolean;
  backupsEnabled?: boolean;
}): Promise<boolean> {
  await db.ready;
  const result = await db.executor.updateTable('owned_machine_links')
    .set({
      ...(input.name !== undefined ? { display_name: input.name } : {}),
      ...(input.autoSecurityUpdates !== undefined ? { auto_security_updates: input.autoSecurityUpdates } : {}),
      ...(input.backupsEnabled !== undefined ? { backups_enabled: input.backupsEnabled } : {}),
    })
    .where('machine_id', '=', input.machineId)
    .where('clerk_user_id', '=', input.clerkUserId)
    .where('revoked_at', 'is', null)
    .returning('machine_id').executeTakeFirst();
  return Boolean(result);
}

export type OwnedRevocationHook = (trx: PlatformDB, machine: UserMachineRecord, now: Date) => Promise<void>;

/**
 * Revocation commits before any Cloudflare call: the machine row is deleted,
 * its epoch is bumped (every derived token stops verifying) and the tunnel is
 * queued for deletion. Hooks run in the same transaction to disable shares,
 * sites and collaboration sessions.
 */
export async function revokeOwnedMachine(db: PlatformDB, input: {
  machineId: string;
  clerkUserId?: string;
  now: Date;
  hooks?: readonly OwnedRevocationHook[];
}): Promise<boolean> {
  return db.transaction(async (trx) => {
    let query = trx.executor.selectFrom('owned_machine_links').select(['machine_id', 'tunnel_id', 'revoked_at'])
      .where('machine_id', '=', input.machineId);
    if (input.clerkUserId) query = query.where('clerk_user_id', '=', input.clerkUserId);
    const link = await query.forUpdate().executeTakeFirst();
    if (!link || link.revoked_at) return false;
    await trx.executor.updateTable('owned_machine_links').set({
      revoked_at: input.now,
      tunnel_state: link.tunnel_id ? 'deleting' : 'deleted',
      tunnel_attempts: 0,
      tunnel_next_attempt_at: input.now,
    }).where('machine_id', '=', input.machineId).execute();
    const machine = await trx.executor.updateTable('user_machines').set({
      status: 'deleted',
      deleted_at: input.now.toISOString(),
      runtime_token_epoch: sql`runtime_token_epoch + 1`,
    }).where('machine_id', '=', input.machineId).where('substrate', '=', 'owned')
      .returningAll().executeTakeFirstOrThrow();
    await trx.executor.updateTable('owned_machine_enrollments').set({ status: 'denied' })
      .where('machine_id', '=', input.machineId).where('status', '=', 'approved').execute();
    for (const hook of input.hooks ?? []) await hook(trx, mapUserMachine(machine), input.now);
    return true;
  });
}

export interface OwnedTunnelWorkItem {
  machineId: string;
  clerkUserId: string;
  tunnelState: 'pending' | 'deleting';
  tunnelId: string | null;
  tunnelHostname: string | null;
  revoked: boolean;
  attempts: number;
}

/** Leases due tunnel work. A crashed worker's lease expires and the item is picked up again. */
export async function claimOwnedTunnelWork(db: PlatformDB, input: {
  now: Date; limit: number; leaseMs: number;
}): Promise<OwnedTunnelWorkItem[]> {
  return db.transaction(async (trx) => {
    const rows = await trx.executor.selectFrom('owned_machine_links')
      .select(['machine_id', 'clerk_user_id', 'tunnel_state', 'tunnel_id', 'tunnel_hostname', 'revoked_at', 'tunnel_attempts'])
      .where('tunnel_state', 'in', ['pending', 'deleting'])
      .where('tunnel_next_attempt_at', '<=', input.now)
      .orderBy('tunnel_next_attempt_at').limit(input.limit)
      .forUpdate().skipLocked().execute();
    if (rows.length === 0) return [];
    await trx.executor.updateTable('owned_machine_links')
      .set({ tunnel_next_attempt_at: new Date(input.now.getTime() + input.leaseMs), tunnel_attempts: sql`tunnel_attempts + 1` })
      .where('machine_id', 'in', rows.map((row) => row.machine_id)).execute();
    return rows.map((row) => ({
      machineId: row.machine_id,
      clerkUserId: row.clerk_user_id,
      tunnelState: row.tunnel_state as 'pending' | 'deleting',
      tunnelId: row.tunnel_id,
      tunnelHostname: row.tunnel_hostname,
      revoked: Boolean(row.revoked_at),
      attempts: row.tunnel_attempts + 1,
    }));
  });
}

/** Records the provider tunnel before configuration, so a crash can be adopted or cleaned up. */
export async function recordOwnedTunnelCreated(db: PlatformDB, input: {
  machineId: string; tunnelId: string; tunnelHostname: string;
}): Promise<boolean> {
  await db.ready;
  const result = await db.executor.updateTable('owned_machine_links')
    .set({ tunnel_id: input.tunnelId, tunnel_hostname: input.tunnelHostname })
    .where('machine_id', '=', input.machineId).where('tunnel_state', '=', 'pending').where('revoked_at', 'is', null)
    .returning('machine_id').executeTakeFirst();
  return Boolean(result);
}

export async function markOwnedTunnelReady(db: PlatformDB, machineId: string): Promise<boolean> {
  await db.ready;
  const result = await db.executor.updateTable('owned_machine_links')
    .set({ tunnel_state: 'ready', tunnel_attempts: 0 })
    .where('machine_id', '=', machineId).where('tunnel_state', '=', 'pending').where('revoked_at', 'is', null)
    .where('tunnel_id', 'is not', null)
    .returning('machine_id').executeTakeFirst();
  return Boolean(result);
}

export async function markOwnedTunnelDeleted(db: PlatformDB, machineId: string): Promise<void> {
  await db.ready;
  await db.executor.updateTable('owned_machine_links')
    .set({
      tunnel_state: sql`CASE WHEN revoked_at IS NULL THEN 'reclaimed' ELSE 'deleted' END`,
      tunnel_id: null, tunnel_hostname: null, tunnel_attempts: 0,
    })
    .where('machine_id', '=', machineId).where('tunnel_state', '=', 'deleting').execute();
}

export async function deferOwnedTunnelWork(db: PlatformDB, input: {
  machineId: string; nextAttemptAt: Date; failed: boolean;
}): Promise<void> {
  await db.ready;
  await db.executor.updateTable('owned_machine_links')
    .set({
      tunnel_next_attempt_at: input.nextAttemptAt,
      ...(input.failed ? { tunnel_state: sql`CASE WHEN tunnel_state = 'pending' THEN 'failed' ELSE tunnel_state END` } : {}),
    })
    .where('machine_id', '=', input.machineId).execute();
}

/** Machines offline past the reclaim window give their tunnel back; reconnect reissues it. */
export async function queueStaleOwnedTunnelReclaim(db: PlatformDB, input: {
  offlineBefore: Date; now: Date; limit: number;
}): Promise<number> {
  await db.ready;
  const result = await sql<{ machine_id: string }>`
    UPDATE owned_machine_links SET tunnel_state = 'deleting', tunnel_attempts = 0, tunnel_next_attempt_at = ${input.now}
    WHERE machine_id IN (
      SELECT machine_id FROM owned_machine_links
      WHERE tunnel_state = 'ready' AND revoked_at IS NULL
        AND COALESCE(last_heartbeat_at, paired_at) < ${input.offlineBefore}
      ORDER BY machine_id LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING machine_id
  `.execute(db.executor);
  return result.rows.length;
}

export async function requestOwnedTunnelReissue(db: PlatformDB, machineId: string, now: Date): Promise<boolean> {
  await db.ready;
  const result = await db.executor.updateTable('owned_machine_links')
    .set({ tunnel_state: 'pending', tunnel_attempts: 0, tunnel_next_attempt_at: now })
    .where('machine_id', '=', machineId).where('tunnel_state', 'in', ['reclaimed', 'failed'])
    .where('revoked_at', 'is', null)
    .returning('machine_id').executeTakeFirst();
  return Boolean(result);
}

export async function purgeExpiredOwnedEnrollments(db: PlatformDB, before: Date, limit: number): Promise<number> {
  await db.ready;
  const result = await sql<{ enrollment_id: string }>`
    DELETE FROM owned_machine_enrollments WHERE enrollment_id IN (
      SELECT enrollment_id FROM owned_machine_enrollments
      WHERE expires_at < ${before} AND status IN ('pending', 'expired', 'delivered', 'denied')
      ORDER BY expires_at LIMIT ${limit}
    ) RETURNING enrollment_id
  `.execute(db.executor);
  return result.rows.length;
}
