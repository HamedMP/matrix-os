import { ManagedRuntimeBusy } from './backend-management-transport.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from './db.js';
import { auditBackend, readBackendPolicy } from './backend-management-repository.js';
import type { BackendMachineTable } from './backend-management-schema.js';
import { isBackendDowngrade } from './backend-release-order.js';

export interface ManagedMachine { machineId: string; handle: string; publicIPv4: string | null; }
export interface ManagedProbe { version: string | null; healthy: boolean; }
export interface ManagedBackendDeps {
  db: PlatformDB;
  probe(machine: ManagedMachine): Promise<ManagedProbe>;
  deploy(machine: ManagedMachine, version: string): Promise<void>;
  now?: () => Date;
  shouldStop?: () => boolean;
}
const LEASE_MS = 120_000;
const INSTALL_DEADLINE_MS = 30 * 60_000;

/** Single durable lease across platform replicas; no transaction spans network IO. */
export async function reconcileManagedBackend(deps: ManagedBackendDeps): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  await db.ready;
  const token = randomUUID();
  const at = now();
  const claimed = await db.executor.updateTable('backend_management_policy').set({ lease_token: token, lease_until: new Date(at.getTime() + LEASE_MS).toISOString() })
    .where('id', '=', 1).where(eb => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at.toISOString())]))
    .returning('id').executeTakeFirst();
  if (!claimed) return;
  async function ownsLease(): Promise<boolean> {
    if (deps.shouldStop?.()) return false;
    const date = now();
    const renewed = await db.executor.updateTable('backend_management_policy').set({ lease_until: new Date(date.getTime() + LEASE_MS).toISOString() })
      .where('id', '=', 1).where('lease_token', '=', token).where('lease_until', '>', date.toISOString()).returning('id').executeTakeFirst();
    return Boolean(renewed);
  }
  try {
    const policy = await readBackendPolicy(db);
    if (!policy.config.enabled) return;
    const stable = await db.executor.selectFrom('host_bundle_channels').select('version').where('channel', '=', 'stable').executeTakeFirst();
    let candidate = policy.config.bootstrapVersion ?? stable?.version;
    if (!candidate) return;
    if (!policy.config.bootstrapVersion && policy.active_version && await isBackendDowngrade(db, candidate, policy.active_version)) candidate = policy.active_version;
    const unfinished = await db.executor.selectFrom('backend_management_machines as b').innerJoin('user_machines as m', 'm.machine_id', 'b.machine_id')
      .select('b.machine_id').where('m.deleted_at', 'is', null).where('m.provisioning_class', '=', 'customer')
      .where('b.status', 'in', ['updating', 'soaking', 'blocked']).executeTakeFirst();
    const version = unfinished && policy.active_version ? policy.active_version : candidate;
    const inventoried = await db.transaction(async trx => {
      const owned = await trx.executor.updateTable('backend_management_policy').set({ active_version: version }).where('id', '=', 1)
        .where('lease_token', '=', token).where('lease_until', '>', now().toISOString()).where('revision', '=', policy.revision).returning('id').executeTakeFirst();
      if (!owned) return false;
      // Set based inventory includes old machines whose provisioning metadata is stale.
      await sql`INSERT INTO backend_management_machines (machine_id, desired_version, status, next_check_at)
        SELECT machine_id, ${version}, 'pending', ${at.toISOString()} FROM user_machines
        WHERE deleted_at IS NULL AND provisioning_class = 'customer' AND status = 'running'
        ON CONFLICT (machine_id) DO NOTHING`.execute(trx.executor);
      await trx.executor.updateTable('backend_management_machines').set({ desired_version: version, status: 'pending', attempts: 0, started_at: null, healthy_since: null, error_code: null, next_check_at: at.toISOString() })
        .where('desired_version', '!=', version).where('status', 'not in', ['updating', 'soaking', 'blocked']).execute();
      await trx.executor.deleteFrom('backend_management_audit').where('created_at', '<', new Date(at.getTime() - 90 * 86400_000).toISOString()).execute();
      return true;
    });
    if (!inventoried) return;
    const inflight = await db.executor.selectFrom('backend_management_machines as b').innerJoin('user_machines as m', 'm.machine_id', 'b.machine_id')
      .select(['b.machine_id', 'b.status']).where('m.deleted_at', 'is', null).where('m.provisioning_class', '=', 'customer')
      .where('b.desired_version', '=', version).where('b.status', 'in', ['updating', 'soaking', 'blocked']).execute();
    const verified = await db.executor.selectFrom('backend_management_machines as b').innerJoin('user_machines as m', 'm.machine_id', 'b.machine_id')
      .select('b.machine_id').where('b.desired_version', '=', version).where('b.status', '=', 'current')
      .where('m.deleted_at', 'is', null).where('m.status', '=', 'running').where('m.provisioning_class', '=', 'customer')
      .where(eb => eb.or([eb('b.override_until', 'is', null), eb('b.override_until', '<=', at.toISOString())]))
      .$if(policy.config.canaryMachineIds.length > 0, q => q.where('b.machine_id', 'in', policy.config.canaryMachineIds)).orderBy('b.machine_id').limit(10).execute();
    const hasVerified = policy.config.canaryMachineIds.length ? policy.config.canaryMachineIds.every(id => verified.some(row => row.machine_id === id)) : verified.length > 0;
    const gateIds = policy.config.canaryMachineIds.length ? policy.config.canaryMachineIds : verified.slice(0, 1).map(row => row.machine_id);
    const gateFilter = gateIds.length ? gateIds : ['']; // Avoid empty SQL IN; machine IDs cannot be empty.
    let budget = inflight.length ? 0 : hasVerified ? policy.config.batchSize : 1;
    const rows = await db.executor.selectFrom('backend_management_machines as b').innerJoin('user_machines as m', 'm.machine_id', 'b.machine_id')
      .selectAll('b').select(['m.handle', 'm.public_ipv4'])
      .where('m.deleted_at', 'is', null).where('m.provisioning_class', '=', 'customer').where('m.status', '=', 'running')
      .where(eb => eb.or([eb('b.next_check_at', '<=', at.toISOString()), eb.and([eb('b.status', '=', 'current'), eb('b.machine_id', 'in', gateFilter)])])).where('b.status', '!=', 'blocked')
      .where(eb => eb.or([eb('b.override_until', 'is', null), eb('b.override_until', '<=', at.toISOString())]))
      .orderBy(eb => eb.case().when('b.status', 'in', ['updating', 'soaking']).then(0).when('b.machine_id', 'in', gateFilter).then(1).else(2).end())
      .orderBy('b.next_check_at').orderBy('b.machine_id').limit(20).execute();
    for (const row of rows) {
      if (!await ownsLease()) return;
      const currentPolicy = await readBackendPolicy(db);
      if (!currentPolicy.config.enabled || currentPolicy.revision !== policy.revision) return;
      // Recheck the hold after selection: an operator can pause a queued machine.
      const fresh = await db.executor.selectFrom('backend_management_machines').select('override_until').where('machine_id', '=', row.machine_id).executeTakeFirstOrThrow();
      if (fresh.override_until && fresh.override_until > now().toISOString()) continue;
      const machine = { machineId: row.machine_id, handle: row.handle, publicIPv4: row.public_ipv4 };
      const date = now();
      const after = (ms: number) => new Date(date.getTime() + ms).toISOString();
      async function save(patch: Partial<BackendMachineTable>, audit?: string): Promise<boolean> {
        return db.transaction(async trx => {
          const changed = await trx.executor.updateTable('backend_management_machines').set(patch).where('machine_id', '=', row.machine_id)
            .where(eb => eb.exists(eb.selectFrom('backend_management_policy').select('id').where('id', '=', 1).where('lease_token', '=', token).where('lease_until', '>', now().toISOString()).where('revision', '=', policy.revision)))
            .where('machine_id', 'in', trx.executor.selectFrom('user_machines').select('machine_id').where('deleted_at', 'is', null).where('status', '=', 'running'))
            .where(eb => eb.or([eb('override_until', 'is', null), eb('override_until', '<=', now().toISOString())]))
            .returning('machine_id').executeTakeFirst();
          if (changed && audit) await auditBackend(trx, audit, JSON.stringify({ version }), date, row.machine_id);
          return Boolean(changed);
        });
      }
      let observed: ManagedProbe;
      try { observed = await deps.probe(machine); }
      catch (err: unknown) {
        console.warn('[managed-backend] Runtime probe unavailable', err instanceof Error ? err.name : typeof err);
        observed = { healthy: false, version: null };
      }
      if (!await ownsLease()) return;
      if (observed.healthy && observed.version === version) {
        const started = row.healthy_since ?? date.toISOString();
        const soaked = date.getTime() - Date.parse(started) >= policy.config.soakSeconds * 1000;
        if (!await save({ observed_version: version, last_seen_at: date.toISOString(), healthy_since: started,
          status: soaked ? 'current' : 'soaking', error_code: null, next_check_at: after(soaked ? 300_000 : 60_000) })) return;
        // An already-current canary must soak before allowing the next cohort.
        if (!soaked) budget = 0;
        continue;
      }
      if (row.status === 'updating' || row.status === 'soaking') {
        const timedOut = row.status === 'soaking' || date.getTime() - Date.parse(row.started_at ?? date.toISOString()) >= INSTALL_DEADLINE_MS;
        await save({ status: timedOut ? 'blocked' : 'updating', observed_version: observed.version,
          healthy_since: null, error_code: timedOut ? 'verification_failed' : null, next_check_at: after(60_000),
          ...(observed.healthy ? { last_seen_at: date.toISOString() } : {}) }, timedOut ? 'rollout_blocked' : undefined);
        budget = 0;
        continue;
      }
      if (!observed.healthy) {
        await save({ status: 'offline', error_code: 'unreachable', next_check_at: after(300_000), healthy_since: null });
        if (gateIds.includes(row.machine_id)) budget = 0;
        continue;
      }
      if (!policy.config.bootstrapVersion && await isBackendDowngrade(db, version, observed.version)) {
        await save({ status: 'blocked', observed_version: observed.version, error_code: 'newer_release_requires_review', healthy_since: null, last_seen_at: date.toISOString() }, 'rollout_blocked');
        budget = 0;
        continue;
      }
      await save({ observed_version: observed.version, last_seen_at: date.toISOString(), healthy_since: null, status: 'pending', next_check_at: after(60_000) });
      // A canary that drifted after verification must be reinstalled and soaked
      // alone before any additional cohort can proceed.
      if (gateIds.includes(row.machine_id) && row.status === 'current') budget = Math.min(budget, 1);
      if (budget <= 0) continue;
      if (!hasVerified && policy.config.canaryMachineIds.length && !policy.config.canaryMachineIds.includes(row.machine_id)) continue;
      const latestPolicy = await readBackendPolicy(db);
      if (!latestPolicy.config.enabled || latestPolicy.revision !== policy.revision) return;
      // Persist dispatch intent before external IO. A crash resumes by observing,
      // never by blindly sending a second restart while the first is in progress.
      if (!await save({ status: 'updating', attempts: row.attempts + 1, started_at: date.toISOString(), error_code: null }, 'update_intent')) continue;
      budget--;
      try {
        await deps.deploy(machine, version);
      } catch (err: unknown) {
        if (err instanceof ManagedRuntimeBusy) {
          await save({ status: 'pending', attempts: row.attempts, started_at: null, error_code: 'runtime_busy', next_check_at: after(300_000) });
          continue;
        }
        console.warn('[managed-backend] Update dispatch uncertain', err instanceof Error ? err.name : typeof err);
        // The host may have accepted the request before the connection broke.
        // Continue observation; timeout quarantines rather than risking a restart loop.
        await save({ error_code: 'dispatch_unconfirmed' });
        budget = 0;
      }
    }
  } finally {
    await db.executor.updateTable('backend_management_policy').set({ lease_token: null, lease_until: null }).where('id', '=', 1).where('lease_token', '=', token).execute();
  }
}
