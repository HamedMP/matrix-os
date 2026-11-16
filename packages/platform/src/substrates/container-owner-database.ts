import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import { sql, type ColumnType, type Generated, type Selectable } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import {
  enabledTriggersAndRules,
  writeBlockStatements,
  writeRestoreStatements,
  type DisabledByBlock,
  type WriteBlockNames,
} from './container-owner-write-block.js';

/**
 * Per-owner database and role on the shared owner cluster for container
 * runtimes (spike S5). Postgres enforces the connection limit on the role and
 * the database. Postgres has no database size quota, so the platform measures
 * size and, over the limit, makes the role's sessions read-only by default
 * and moves ownership of the owner's objects to a holder role (see
 * container-owner-write-block.ts), which the owner cannot undo. Passwords are derived from a platform
 * secret and the generation that last rotated them, so nothing secret is stored.
 */

export interface ContainerOwnerDatabasesTable {
  clerk_user_id: string;
  database_name: string;
  role_name: string;
  connection_limit: Generated<number>;
  size_limit_bytes: ColumnType<number | string, number, number>;
  size_measured_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  size_bytes: ColumnType<number | string | null, number | null | undefined, number | null>;
  state: 'active' | 'fenced' | 'deleting';
  password_epoch: number;
  writes_blocked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Triggers and rules the block disabled, so the restore re-enables exactly those. */
  block_disabled: ColumnType<unknown, string | null | undefined, string | null>;
  /** Set when a blocked database passed the alert threshold; cleared once it falls back below it. */
  size_alerted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** When the size sweep last offered this blocked owner for compaction. */
  compaction_offered_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

type Row = Selectable<ContainerOwnerDatabasesTable>;

export type ContainerOwnerDatabaseErrorCode =
  | 'not_found' | 'fenced' | 'deleting' | 'invalid_identifier' | 'stale_generation' | 'busy';

export class ContainerOwnerDatabaseError extends Error {
  constructor(readonly code: ContainerOwnerDatabaseErrorCode) {
    super(`container owner database: ${code}`);
    this.name = 'ContainerOwnerDatabaseError';
  }
}

/** Executes admin SQL on the owner cluster. Statements come only from this module. */
export interface OwnerClusterAdmin {
  query(statement: string, params: readonly unknown[], signal: AbortSignal): Promise<Record<string, unknown>[]>;
  /** Runs the statements in one session in that database; resolves with the last statement's rows. */
  executeInDatabase(database: string, statements: readonly string[], signal: AbortSignal): Promise<Record<string, unknown>[] | void>;
}

export interface OwnerDatabaseCredentials {
  databaseName: string;
  roleName: string;
  password: string;
  passwordEpoch: number;
}

export interface CompactionTarget {
  databaseName: string;
  holderName: string;
  holderSql: string;
  /** Writes come back once the database measures below this. */
  restoreBelowBytes: number;
}

/** Structured operator alert for a blocked database far over its limit. Carries no owner data. */
export interface OwnerDatabaseSizeAlert {
  event: 'container_owner_db_size_alert';
  sizeBytes: number;
  limitBytes: number;
}

export interface ContainerOwnerDatabasesDeps {
  db: PlatformDB;
  admin: OwnerClusterAdmin;
  passwordSecret: string;
  sizeLimitBytes: number;
  /** Writes come back once the size is below the limit minus this margin. Defaults to a tenth of the limit. */
  sizeRestoreMarginBytes?: number;
  connectionLimit?: number;
  randomBytes?: (size: number) => Buffer;
  /** Defaults to one structured warning line in the platform log. */
  alertOperator?: (alert: OwnerDatabaseSizeAlert) => void;
}

const IDENTIFIER = /^(mxo|mxr|mxh)_[a-z2-7]{26}$/;
const PASSWORD = /^[A-Za-z0-9_-]{43}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ROLE_ATTRIBUTES = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
// Only a role holding SUPERUSER, REPLICATION or BYPASSRLS may restate them, so a
// non-superuser admin re-asserts the rest; it could never have granted those three.
const ALTERABLE_ROLE_ATTRIBUTES = 'NOCREATEDB NOCREATEROLE NOINHERIT';
const ROLE_DEFAULTS = [
  "statement_timeout = '30s'",
  "idle_in_transaction_session_timeout = '60s'",
  "lock_timeout = '10s'",
];
const DUPLICATE_CODES = new Set(['42710', '42P04', '23505']);
/** How long an owner database operation waits for another one on the same owner. */
const OWNER_LOCK_WAIT_MS = 30_000;
const OWNER_LOCK_POLL_MS = 50;
/** Owners with operations queued in this process; beyond it new operations answer busy. */
const MAX_LOCAL_OWNER_QUEUES = 10_000;
const ALERT_RATIO = 1.5;
const MAX_RECORDED = 10_000;
const DisabledSchema = z.array(z.object({
  kind: z.enum(['trigger', 'rule']),
  oid: z.coerce.number().int().min(1).max(4_294_967_295),
  mode: z.enum(['O', 'R', 'A']),
})).max(MAX_RECORDED);

function recordedDisabled(value: unknown): DisabledByBlock[] {
  if (value === null || value === undefined) return [];
  const parsed = DisabledSchema.safeParse(value);
  if (!parsed.success) throw new Error('Recorded block triggers were invalid');
  return parsed.data;
}

type IdentifierPrefix = 'mxo_' | 'mxr_' | 'mxh_';

export function assertOwnerIdentifier(value: string, prefix: IdentifierPrefix): string {
  if (!IDENTIFIER.test(value) || !value.startsWith(prefix)) throw new ContainerOwnerDatabaseError('invalid_identifier');
  return value;
}

function quoteIdentifier(value: string, prefix: IdentifierPrefix): string {
  return `"${assertOwnerIdentifier(value, prefix)}"`;
}

function quotePassword(value: string): string {
  if (!PASSWORD.test(value)) throw new ContainerOwnerDatabaseError('invalid_identifier');
  return `'${value}'`;
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new ContainerOwnerDatabaseError('stale_generation');
}

function queuedOperationEnded(): void {}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && DUPLICATE_CODES.has(String((error as { code: unknown }).code));
}

export function createContainerOwnerDatabases(deps: ContainerOwnerDatabasesDeps) {
  const { admin } = deps;
  const platformDb = deps.db;
  /**
   * Inside a serialized operation, record queries run on the connection that
   * holds the owner lock. Borrowing more from the pool there could exhaust it:
   * every holder would wait on its own next query.
   */
  const lockConnection = new AsyncLocalStorage<PlatformDB['executor']>();
  const db = {
    get executor(): PlatformDB['executor'] { return lockConnection.getStore() ?? platformDb.executor; },
  };
  if (deps.passwordSecret.length < 32) throw new Error('Owner database password secret must be at least 32 characters');
  if (!Number.isSafeInteger(deps.sizeLimitBytes) || deps.sizeLimitBytes < 1) throw new Error('Owner database size limit is invalid');
  const connectionLimit = deps.connectionLimit ?? 5;
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 20) {
    throw new Error('Owner database connection limit is invalid');
  }
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  const alertOperator = deps.alertOperator ?? ((alert: OwnerDatabaseSizeAlert) => console.warn(JSON.stringify(alert)));
  const restoreMargin = deps.sizeRestoreMarginBytes;
  if (restoreMargin !== undefined && (!Number.isSafeInteger(restoreMargin) || restoreMargin < 0)) {
    throw new Error('Owner database size restore margin is invalid');
  }

  function opaqueName(prefix: 'mxo_' | 'mxr_'): string {
    const bytes = randomBytes(26);
    let name = prefix;
    for (let i = 0; i < 26; i += 1) name += BASE32[bytes[i]! % 32];
    return name;
  }

  function passwordFor(roleName: string, epoch: number): string {
    return createHmac('sha256', deps.passwordSecret)
      .update(`matrix-container-owner-db:v1:${roleName}:${epoch}`)
      .digest('base64url');
  }

  function credentials(row: Row): OwnerDatabaseCredentials {
    return {
      databaseName: row.database_name,
      roleName: row.role_name,
      password: passwordFor(row.role_name, row.password_epoch),
      passwordEpoch: row.password_epoch,
    };
  }

  async function load(clerkUserId: string): Promise<Row> {
    const row = await db.executor.selectFrom('container_owner_databases').selectAll()
      .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
    if (!row) throw new ContainerOwnerDatabaseError('not_found');
    if (row.state === 'deleting') throw new ContainerOwnerDatabaseError('deleting');
    return row;
  }

  async function exists(catalog: 'pg_roles' | 'pg_database', name: string, signal: AbortSignal): Promise<boolean> {
    const column = catalog === 'pg_roles' ? 'rolname' : 'datname';
    return (await admin.query(`SELECT 1 FROM ${catalog} WHERE ${column} = $1`, [name], signal)).length > 0;
  }

  async function createIfAbsent(statement: string, signal: AbortSignal): Promise<void> {
    try {
      await admin.query(statement, [], signal);
    } catch (error: unknown) {
      if (!isDuplicate(error)) throw error;
    }
  }

  async function terminateSessions(roleName: string, signal: AbortSignal): Promise<void> {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [roleName], signal);
  }

  async function provision(row: Row, signal: AbortSignal): Promise<void> {
    const roleSql = quoteIdentifier(row.role_name, 'mxr_');
    const dbSql = quoteIdentifier(row.database_name, 'mxo_');
    if (!await exists('pg_roles', row.role_name, signal)) {
      await createIfAbsent(`CREATE ROLE ${roleSql} NOLOGIN ${ROLE_ATTRIBUTES}`, signal);
    }
    await admin.query(
      `ALTER ROLE ${roleSql} WITH LOGIN ${ALTERABLE_ROLE_ATTRIBUTES} CONNECTION LIMIT ${connectionLimit} `
        + `PASSWORD ${quotePassword(passwordFor(row.role_name, row.password_epoch))}`,
      [], signal);
    for (const setting of ROLE_DEFAULTS) await admin.query(`ALTER ROLE ${roleSql} SET ${setting}`, [], signal);
    if (!await exists('pg_database', row.database_name, signal)) {
      await createIfAbsent(`CREATE DATABASE ${dbSql}`, signal);
    }
    await admin.query(`ALTER DATABASE ${dbSql} CONNECTION LIMIT ${connectionLimit}`, [], signal);
    await admin.query(`REVOKE ALL ON DATABASE ${dbSql} FROM PUBLIC`, [], signal);
    // A size-blocked owner gets CONNECT and USAGE only; the size sweep alone grants CREATE back.
    const blocked = row.writes_blocked_at !== null;
    await admin.query(`GRANT ${blocked ? 'CONNECT' : 'CONNECT, CREATE'} ON DATABASE ${dbSql} TO ${roleSql}`, [], signal);
    await admin.executeInDatabase(row.database_name, [
      'REVOKE ALL ON SCHEMA public FROM PUBLIC',
      `GRANT ${blocked ? 'USAGE' : 'USAGE, CREATE'} ON SCHEMA public TO ${roleSql}`,
    ], signal);
  }

  function restoreBelow(row: Row): number {
    const limit = Number(row.size_limit_bytes);
    return limit - (restoreMargin ?? Math.floor(limit / 10));
  }

  function writeBlockNames(row: Row): WriteBlockNames {
    const holderName = `mxh_${row.role_name.slice(4)}`;
    return {
      databaseSql: quoteIdentifier(row.database_name, 'mxo_'),
      ownerSql: quoteIdentifier(row.role_name, 'mxr_'),
      holderSql: quoteIdentifier(holderName, 'mxh_'),
      ownerName: assertOwnerIdentifier(row.role_name, 'mxr_'),
      holderName,
    };
  }

  async function ensureHolder(names: WriteBlockNames, signal: AbortSignal): Promise<void> {
    if (!await exists('pg_roles', names.holderName, signal)) {
      await createIfAbsent(`CREATE ROLE ${names.holderSql} NOLOGIN ${ROLE_ATTRIBUTES}`, signal);
    }
  }

  /**
   * Adds the enabled triggers and rules to the row's record in one statement
   * and returns the whole record. Written before the block disables anything,
   * so whatever the block disabled is always recorded.
   */
  async function recordEnabled(row: Row, names: WriteBlockNames, signal: AbortSignal): Promise<DisabledByBlock[]> {
    const enabled = recordedDisabled(await admin.executeInDatabase(row.database_name, [enabledTriggersAndRules(names)], signal) ?? []);
    return mergeRecorded(row, enabled);
  }

  /** Adds entries to the row's record of what the block disabled, in one statement. */
  async function mergeRecorded(row: Row, enabled: DisabledByBlock[]): Promise<DisabledByBlock[]> {
    const merged = await sql<{ block_disabled: unknown }>`UPDATE container_owner_databases SET block_disabled = (
        SELECT jsonb_agg(e ORDER BY e->>'kind', (e->>'oid')::bigint) FROM (
          SELECT DISTINCT ON (e->>'kind', e->>'oid') e FROM (
            SELECT e, 0 AS source FROM jsonb_array_elements(COALESCE(block_disabled, '[]'::jsonb)) e
            UNION ALL SELECT e, 1 FROM jsonb_array_elements(${JSON.stringify(enabled)}::jsonb) e
          ) candidates ORDER BY e->>'kind', e->>'oid', source
        ) deduplicated)
      WHERE clerk_user_id = ${row.clerk_user_id} RETURNING block_disabled`.execute(db.executor);
    return recordedDisabled(merged.rows[0]?.block_disabled);
  }

  /** Recorded first, so a crash mid-block leaves a row the next sweep re-blocks or lifts. */
  async function blockWrites(row: Row, signal: AbortSignal): Promise<void> {
    const names = writeBlockNames(row);
    const changed = row.writes_blocked_at === null;
    if (changed) {
      await db.executor.updateTable('container_owner_databases').set({ writes_blocked_at: sql<Date>`now()` })
        .where('clerk_user_id', '=', row.clerk_user_id).where('writes_blocked_at', 'is', null).execute();
    }
    await admin.query(`ALTER ROLE ${names.ownerSql} SET default_transaction_read_only = on`, [], signal);
    if (changed) await terminateSessions(row.role_name, signal);
    await ensureHolder(names, signal);
    const recorded = await recordEnabled(row, names, signal);
    // A trigger the owner added after the read above is disabled inside the block transaction and
    // returned here, so the restore re-enables it too.
    const late = recordedDisabled(await admin.executeInDatabase(row.database_name, writeBlockStatements(names, recorded), signal) ?? []);
    if (late.length > 0) await mergeRecorded(row, late);
  }

  /** The record is cleared with the block flag, after the triggers are back on. */
  async function restoreWrites(row: Row, signal: AbortSignal): Promise<void> {
    const names = writeBlockNames(row);
    await ensureHolder(names, signal);
    await admin.executeInDatabase(row.database_name,
      writeRestoreStatements(names, recordedDisabled(row.block_disabled)), signal);
    await admin.query(`ALTER ROLE ${names.ownerSql} RESET default_transaction_read_only`, [], signal);
    await db.executor.updateTable('container_owner_databases').set({ writes_blocked_at: null, block_disabled: null })
      .where('clerk_user_id', '=', row.clerk_user_id).execute();
    await terminateSessions(row.role_name, signal);
  }

  /** Alerts once per crossing: the conditional update is the gate, so concurrent measurements alert once. */
  async function alertIfFarOver(row: Row, sizeBytes: number, writesBlocked: boolean): Promise<void> {
    const limitBytes = Number(row.size_limit_bytes);
    const threshold = limitBytes * ALERT_RATIO;
    if (writesBlocked && sizeBytes > threshold) {
      const crossed = await db.executor.updateTable('container_owner_databases').set({ size_alerted_at: sql<Date>`now()` })
        .where('clerk_user_id', '=', row.clerk_user_id).where('size_alerted_at', 'is', null)
        .returning('clerk_user_id').executeTakeFirst();
      if (!crossed) return;
      try {
        alertOperator({ event: 'container_owner_db_size_alert', sizeBytes, limitBytes });
      } catch (error: unknown) {
        console.error('[container-owner-db] size alert failed', { cause: error instanceof Error ? error.name : 'unknown' });
      }
    } else if (sizeBytes < threshold && row.size_alerted_at !== null) {
      await db.executor.updateTable('container_owner_databases').set({ size_alerted_at: null })
        .where('clerk_user_id', '=', row.clerk_user_id).execute();
    }
  }

  async function applyPassword(row: Row, epoch: number, signal: AbortSignal): Promise<void> {
    const roleSql = quoteIdentifier(row.role_name, 'mxr_');
    await admin.query(`ALTER ROLE ${roleSql} PASSWORD ${quotePassword(passwordFor(row.role_name, epoch))}`, [], signal);
    await terminateSessions(row.role_name, signal);
  }

  const MAX_SETTLE_PASSES = 5;

  /**
   * Provisioning writes the cluster from a row it read earlier. Fence and
   * rotate record their intent in the table before touching the cluster, so
   * re-reading the row after provisioning sees any that landed in between and
   * re-applies it: a fence wins over provisioning, and the newest password
   * epoch is the one left in force.
   */
  async function settleProvisioned(provisioned: Row, signal: AbortSignal): Promise<Row> {
    let applied = provisioned.password_epoch;
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
      const current = await load(provisioned.clerk_user_id);
      if (current.role_name !== provisioned.role_name || current.database_name !== provisioned.database_name) {
        throw new ContainerOwnerDatabaseError('deleting');
      }
      if (current.state === 'fenced') {
        await admin.query(`ALTER ROLE ${quoteIdentifier(current.role_name, 'mxr_')} NOLOGIN`, [], signal);
        await terminateSessions(current.role_name, signal);
        throw new ContainerOwnerDatabaseError('fenced');
      }
      if (current.password_epoch === applied) return current;
      applied = current.password_epoch;
      await applyPassword(current, applied, signal);
    }
    throw new Error('Owner database provisioning did not settle');
  }

  /**
   * Serializes every operation on one owner's database across platform
   * instances, with a session advisory lock on one pinned platform
   * connection. Operations read the record and then write the cluster, so
   * without it a fence or unfence could interleave with provisioning and
   * leave the role out of step with the record.
   */
  const localQueues = new Map<string, Promise<unknown>>();

  /**
   * Queues operations on one owner inside this process first. A session
   * advisory lock is re-entrant, so two operations sharing one connection (a
   * single-connection database) would otherwise both pass it.
   */
  async function serialized<T>(clerkUserId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = localQueues.get(clerkUserId);
    if (!previous && localQueues.size >= MAX_LOCAL_OWNER_QUEUES) throw new ContainerOwnerDatabaseError('busy');
    // The earlier operation's caller already received its outcome; this one only waits for it to end.
    const run = (previous ?? Promise.resolve()).then(queuedOperationEnded, queuedOperationEnded)
      .then(() => advisoryLocked(clerkUserId, signal, work));
    localQueues.set(clerkUserId, run);
    try {
      return await run;
    } finally {
      if (localQueues.get(clerkUserId) === run) localQueues.delete(clerkUserId);
    }
  }

  async function advisoryLocked<T>(clerkUserId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const key = `matrix:container-owner-db:${clerkUserId}`;
    return platformDb.kysely.connection().execute(async (connection) => {
      const deadline = Date.now() + OWNER_LOCK_WAIT_MS;
      for (;;) {
        signal.throwIfAborted();
        const lock = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`
          .execute(connection);
        if (lock.rows[0]?.locked) break;
        if (Date.now() >= deadline) throw new ContainerOwnerDatabaseError('busy');
        await new Promise(resolve => setTimeout(resolve, OWNER_LOCK_POLL_MS));
      }
      try {
        return await lockConnection.run(connection as unknown as PlatformDB['executor'], work);
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection);
      }
    });
  }

  /**
   * Runs under the owner lock. The password is applied and the role's
   * sessions ended before the epoch is recorded, so a recorded epoch always
   * means its rotation finished, and a failed one is redone by the retry.
   */
  async function rotate(clerkUserId: string, generation: number, signal: AbortSignal) {
    assertGeneration(generation);
    const row = await load(clerkUserId);
    if (row.password_epoch >= generation) return { rotated: false, passwordEpoch: row.password_epoch };
    await applyPassword(row, generation, signal);
    const recorded = await db.executor.updateTable('container_owner_databases')
      .set({ password_epoch: generation })
      .where('clerk_user_id', '=', clerkUserId)
      .where('password_epoch', '<', generation)
      .where('state', '!=', 'deleting')
      .returning('password_epoch')
      .executeTakeFirst();
    if (!recorded) throw new ContainerOwnerDatabaseError('deleting');
    return { rotated: true, passwordEpoch: generation };
  }

  async function ensureLocked(clerkUserId: string, generation: number, signal: AbortSignal): Promise<OwnerDatabaseCredentials> {
    const fresh = {
      clerk_user_id: clerkUserId,
      database_name: opaqueName('mxo_'),
      role_name: opaqueName('mxr_'),
      connection_limit: connectionLimit,
      size_limit_bytes: deps.sizeLimitBytes,
      state: 'active' as const,
      password_epoch: generation,
    };
    await db.executor.insertInto('container_owner_databases').values(fresh)
      .onConflict(oc => oc.column('clerk_user_id').doUpdateSet({
        database_name: fresh.database_name,
        role_name: fresh.role_name,
        connection_limit: connectionLimit,
        size_limit_bytes: deps.sizeLimitBytes,
        state: 'active',
        password_epoch: generation,
        size_bytes: null,
        size_measured_at: null,
        // A replacement is a new, empty database: none of the old one's block state carries over.
        size_alerted_at: null,
        writes_blocked_at: null,
        block_disabled: null,
        compaction_offered_at: null,
        created_at: sql<Date>`now()`,
        deleted_at: null,
      }).where('container_owner_databases.deleted_at', 'is not', null))
      .execute();
    let row = await load(clerkUserId);
    if (row.state === 'fenced') throw new ContainerOwnerDatabaseError('fenced');
    if (row.password_epoch > generation) throw new ContainerOwnerDatabaseError('stale_generation');
    await provision(row, signal);
    row = await settleProvisioned(row, signal);
    if (row.password_epoch > generation) throw new ContainerOwnerDatabaseError('stale_generation');
    if (row.password_epoch < generation) {
      await rotate(clerkUserId, generation, signal);
      row = await load(clerkUserId);
    }
    return credentials(row);
  }

  async function fence(clerkUserId: string, signal: AbortSignal): Promise<void> {
    const row = await load(clerkUserId);
    await db.executor.updateTable('container_owner_databases').set({ state: 'fenced' })
      .where('clerk_user_id', '=', clerkUserId).where('state', 'in', ['active', 'fenced']).execute();
    await admin.query(`ALTER ROLE ${quoteIdentifier(row.role_name, 'mxr_')} NOLOGIN`, [], signal);
    await terminateSessions(row.role_name, signal);
  }

  async function unfence(clerkUserId: string, signal: AbortSignal): Promise<void> {
    const row = await load(clerkUserId);
    const updated = await db.executor.updateTable('container_owner_databases').set({ state: 'active' })
      .where('clerk_user_id', '=', clerkUserId).where('state', 'in', ['active', 'fenced'])
      .returning('state').executeTakeFirst();
    if (!updated) throw new ContainerOwnerDatabaseError('deleting');
    await admin.query(`ALTER ROLE ${quoteIdentifier(row.role_name, 'mxr_')} LOGIN`, [], signal);
  }

  async function measureSizeOf(clerkUserId: string, signal: AbortSignal): Promise<{ sizeBytes: number; overLimit: boolean }> {
    const row = await load(clerkUserId);
    const result = await admin.query('SELECT pg_database_size($1)::bigint AS size_bytes',
      [assertOwnerIdentifier(row.database_name, 'mxo_')], signal);
    const sizeBytes = Number(result[0]?.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('Owner database size measurement was invalid');
    await db.executor.updateTable('container_owner_databases')
      .set({ size_bytes: sizeBytes, size_measured_at: sql<Date>`now()` })
      .where('clerk_user_id', '=', clerkUserId).execute();
    return { sizeBytes, overLimit: sizeBytes > Number(row.size_limit_bytes) };
  }

  return {
    passwordFor,

    async ensure(clerkUserId: string, generation: number, signal: AbortSignal): Promise<OwnerDatabaseCredentials> {
      if (!OWNER_ID.test(clerkUserId)) throw new ContainerOwnerDatabaseError('invalid_identifier');
      assertGeneration(generation);
      return serialized(clerkUserId, signal, () => ensureLocked(clerkUserId, generation, signal));
    },

    rotate(clerkUserId: string, generation: number, signal: AbortSignal) {
      return serialized(clerkUserId, signal, () => rotate(clerkUserId, generation, signal));
    },

    fence(clerkUserId: string, signal: AbortSignal): Promise<void> {
      return serialized(clerkUserId, signal, () => fence(clerkUserId, signal));
    },

    unfence(clerkUserId: string, signal: AbortSignal): Promise<void> {
      return serialized(clerkUserId, signal, () => unfence(clerkUserId, signal));
    },



    measureSize: measureSizeOf,

    /**
     * Measures, then blocks writes over the limit or lifts the block once the
     * size is below the limit minus the restore margin; in between, the
     * recorded state holds. A block is re-applied on every sweep.
     */
    /** Serialized with provisioning, which grants CREATE according to the recorded block. */
    enforceSizeLimit(clerkUserId: string, signal: AbortSignal) {
      return serialized(clerkUserId, signal, async () => {
        const row = await load(clerkUserId);
        if (row.state !== 'active') throw new ContainerOwnerDatabaseError('fenced');
        const { sizeBytes, overLimit } = await measureSizeOf(clerkUserId, signal);
        const wasBlocked = row.writes_blocked_at !== null;
        const writesBlocked = overLimit || (wasBlocked && sizeBytes >= restoreBelow(row));
        if (writesBlocked) await blockWrites(row, signal);
        else if (wasBlocked) await restoreWrites(row, signal);
        await alertIfFarOver(row, sizeBytes, writesBlocked);
        return { sizeBytes, overLimit, writesBlocked };
      });
    },

    /** What compaction needs for an active size-blocked owner; null when there is nothing to compact. */
    async compactionTarget(clerkUserId: string): Promise<CompactionTarget | null> {
      const row = await load(clerkUserId);
      if (row.state !== 'active' || row.writes_blocked_at === null) return null;
      const names = writeBlockNames(row);
      return {
        databaseName: assertOwnerIdentifier(row.database_name, 'mxo_'),
        holderName: names.holderName,
        holderSql: names.holderSql,
        restoreBelowBytes: restoreBelow(row),
      };
    },

    /**
     * Drops the role and database. Safe to repeat; the record stays as a
     * tombstone. Both record updates match the names this call read, so a
     * delayed removal never marks a record that replaced them.
     */
    async remove(clerkUserId: string, signal: AbortSignal): Promise<void> {
      return serialized(clerkUserId, signal, () => removeLocked(clerkUserId, signal));
    },
  };

  async function removeLocked(clerkUserId: string, signal: AbortSignal): Promise<void> {
    const row = await db.executor.selectFrom('container_owner_databases').selectAll()
      .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
    if (!row || row.deleted_at) return;
    const marked = await db.executor.updateTable('container_owner_databases').set({ state: 'deleting' })
      .where('clerk_user_id', '=', clerkUserId).where('deleted_at', 'is', null)
      .where('database_name', '=', row.database_name).where('role_name', '=', row.role_name)
      .returning('clerk_user_id').executeTakeFirst();
    if (!marked) return;
    const roleSql = quoteIdentifier(row.role_name, 'mxr_');
    const dbSql = quoteIdentifier(row.database_name, 'mxo_');
    const roleExists = await exists('pg_roles', row.role_name, signal);
    if (roleExists) await admin.query(`ALTER ROLE ${roleSql} NOLOGIN`, [], signal);
    if (roleExists && await exists('pg_database', row.database_name, signal)) {
      await admin.query(`REVOKE CONNECT ON DATABASE ${dbSql} FROM ${roleSql}`, [], signal);
    }
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 OR datname = $2',
      [row.role_name, row.database_name], signal);
    await admin.query(`DROP DATABASE IF EXISTS ${dbSql} WITH (FORCE)`, [], signal);
    await admin.query(`DROP ROLE IF EXISTS ${roleSql}`, [], signal);
    await admin.query(`DROP ROLE IF EXISTS ${writeBlockNames(row).holderSql}`, [], signal);
    await db.executor.updateTable('container_owner_databases').set({ deleted_at: sql<Date>`now()` })
      .where('clerk_user_id', '=', clerkUserId).where('deleted_at', 'is', null)
      .where('database_name', '=', row.database_name).where('role_name', '=', row.role_name)
      .execute();
  }
}

export type ContainerOwnerDatabases = ReturnType<typeof createContainerOwnerDatabases>;
