import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PlatformDB, PlatformDatabase } from './db.js';
import { BackendConfigSchema, MachineOverrideSchema, type BackendConfig, type MachineOverride } from './backend-management-schema.js';

export async function migrateBackendManagement(db: Kysely<PlatformDatabase>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS backend_management_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL, active_version TEXT, lease_token TEXT, lease_until TEXT
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS backend_management_machines (
    machine_id TEXT PRIMARY KEY REFERENCES user_machines(machine_id) ON DELETE CASCADE,
    desired_version TEXT NOT NULL, observed_version TEXT, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_check_at TEXT NOT NULL,
    started_at TEXT, healthy_since TEXT, last_seen_at TEXT, error_code TEXT,
    override_until TEXT, override_reason TEXT, allow_version_selection BOOLEAN NOT NULL DEFAULT FALSE
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS backend_machine_due ON backend_management_machines(next_check_at)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS backend_management_audit (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, machine_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS backend_audit_age ON backend_management_audit(created_at)`.execute(db);
  await db.insertInto('backend_management_policy').values({ id: 1, revision: 0,
    config: JSON.stringify(BackendConfigSchema.parse({})), active_version: null, lease_token: null, lease_until: null,
  }).onConflict(c => c.column('id').doNothing()).execute();
}

export class BackendPolicyConflict extends Error { constructor() { super('Backend policy conflict'); } }
export class BackendMachineNotFound extends Error {}
export class BackendInvalidConfiguration extends Error {}
export async function readBackendPolicy(db: PlatformDB) {
  await db.ready;
  const row = await db.executor.selectFrom('backend_management_policy').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
  return { ...row, config: BackendConfigSchema.parse(JSON.parse(row.config)) };
}
export async function auditBackend(db: PlatformDB, action: string, detail: string, now: Date, machineId: string | null = null) {
  await db.executor.insertInto('backend_management_audit').values({ id: randomUUID(), action, machine_id: machineId, detail, created_at: now.toISOString() }).execute();
}
export async function updateBackendPolicy(db: PlatformDB, config: BackendConfig, revision: number, now = new Date()) {
  const validated = BackendConfigSchema.parse(config);
  return db.transaction(async trx => {
    if (validated.bootstrapVersion && !await trx.executor.selectFrom('host_bundle_releases').select('version').where('version', '=', validated.bootstrapVersion).executeTakeFirst()) {
      throw new BackendInvalidConfiguration();
    }
    const previous = await readBackendPolicy(trx);
    if (validated.enabled && validated.canaryMachineIds.length && (!previous.config.enabled || JSON.stringify(previous.config.canaryMachineIds) !== JSON.stringify(validated.canaryMachineIds))) {
      const canaries = await trx.executor.selectFrom('user_machines').select('machine_id').where('machine_id', 'in', validated.canaryMachineIds)
        .where('deleted_at', 'is', null).where('status', '=', 'running').where('provisioning_class', '=', 'customer').execute();
      if (canaries.length !== validated.canaryMachineIds.length) throw new BackendInvalidConfiguration();
    }
    const updated = await trx.executor.updateTable('backend_management_policy')
      .set({ config: JSON.stringify(validated), revision: revision + 1 })
      .where('id', '=', 1).where('revision', '=', revision).returningAll().executeTakeFirst();
    if (!updated) throw new BackendPolicyConflict();
    await auditBackend(trx, 'policy_updated', JSON.stringify({ revision: revision + 1, config: validated }), now);
    return { ...updated, config: validated };
  });
}

export async function readMachineOverride(db: PlatformDB, machineId: string, now = new Date()) {
  await db.ready;
  const row = await db.executor.selectFrom('backend_management_machines as b')
    .innerJoin('user_machines as m', 'm.machine_id', 'b.machine_id')
    .select(['b.desired_version', 'b.override_until', 'b.allow_version_selection']).where('b.machine_id', '=', machineId)
    .where('m.deleted_at', 'is', null).executeTakeFirst();
  const holdUntil = row?.override_until && row.override_until > now.toISOString() ? row.override_until : null;
  // Inventory assigns a durable desired version when the worker enrolls a host.
  // A global pause must not hand enrolled machines back to passive channels.
  return { managed: true as const, passiveUpdatesAllowed: !row?.desired_version && !holdUntil,
    versionSelectionAllowed: Boolean(holdUntil && row?.allow_version_selection), holdUntil };
}
export async function setMachineOverride(db: PlatformDB, machineId: string, input: MachineOverride, now = new Date()) {
  const value = MachineOverrideSchema.parse(input);
  if (Date.parse(value.until) <= now.getTime() || Date.parse(value.until) > now.getTime() + 7 * 86400_000) throw new Error('Override must expire within seven days');
  await db.transaction(async trx => {
    const machine = await trx.executor.selectFrom('user_machines').select('machine_id').where('machine_id', '=', machineId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!machine) throw new BackendMachineNotFound();
    await trx.executor.insertInto('backend_management_machines').values({ machine_id: machineId, desired_version: '', observed_version: null,
      status: 'pending', attempts: 0, next_check_at: now.toISOString(), started_at: null, healthy_since: null, last_seen_at: null, error_code: null,
      override_until: value.until, override_reason: value.reason, allow_version_selection: value.allowVersionSelection,
    }).onConflict(c => c.column('machine_id').doUpdateSet({ override_until: value.until, override_reason: value.reason, allow_version_selection: value.allowVersionSelection })).execute();
    await auditBackend(trx, 'override_updated', JSON.stringify(value), now, machineId);
  });
}
export async function retryMachine(db: PlatformDB, machineId: string, now = new Date()) {
  await db.transaction(async trx => {
    const changed = await trx.executor.updateTable('backend_management_machines').set({ status: 'pending', attempts: 0, started_at: null, healthy_since: null, error_code: null, next_check_at: now.toISOString() })
      .where('machine_id', '=', machineId).where('status', 'in', ['blocked', 'offline'])
      .where('machine_id', 'in', trx.executor.selectFrom('user_machines').select('machine_id').where('deleted_at', 'is', null))
      .returning('machine_id').executeTakeFirst();
    if (!changed) throw new BackendPolicyConflict();
    await auditBackend(trx, 'retry_requested', '{}', now, machineId);
  });
}
export async function clearMachineOverride(db: PlatformDB, machineId: string, now = new Date()) {
  await db.transaction(async trx => {
    const machine = await trx.executor.selectFrom('user_machines').select('machine_id').where('machine_id', '=', machineId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!machine) throw new BackendMachineNotFound();
    const cleared = await trx.executor.updateTable('backend_management_machines')
      .set({ override_until: null, override_reason: null, allow_version_selection: false, next_check_at: now.toISOString() })
      .where('machine_id', '=', machineId).where('override_until', 'is not', null).returning('machine_id').executeTakeFirst();
    if (cleared) await auditBackend(trx, 'override_cleared', '{}', now, machineId);
  });
}
export async function readBackendStatus(db: PlatformDB, after = '') {
  const policy = await readBackendPolicy(db);
  const rows = await db.executor.selectFrom('user_machines as m').leftJoin('backend_management_machines as b', 'b.machine_id', 'm.machine_id')
    .select(['m.machine_id', 'm.status as machine_status', 'b.desired_version', 'b.observed_version', 'b.status', 'b.attempts', 'b.next_check_at', 'b.last_seen_at', 'b.error_code', 'b.override_until'])
    .where('m.deleted_at', 'is', null).where('m.provisioning_class', '=', 'customer').where('m.machine_id', '>', after)
    .orderBy('m.machine_id').limit(201).execute();
  return { policy: { revision: policy.revision, config: policy.config, activeVersion: policy.active_version },
    machines: rows.slice(0, 200).map(row => ({ machineId: row.machine_id, machineStatus: row.machine_status,
      desiredVersion: row.desired_version, observedVersion: row.observed_version, status: row.status ?? 'pending', attempts: row.attempts ?? 0,
      nextCheckAt: row.next_check_at, lastSeenAt: row.last_seen_at, errorCode: row.error_code, overrideUntil: row.override_until })),
    nextCursor: rows.length > 200 ? rows[199].machine_id : null };
}
