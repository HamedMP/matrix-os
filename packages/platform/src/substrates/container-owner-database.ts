import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import { sql, type ColumnType, type Generated, type Selectable } from 'kysely';
import type { PlatformDB } from '../db.js';

/**
 * Per-owner database and role on the shared owner cluster for container
 * runtimes (spike S5). The platform enforces size; Postgres enforces the
 * connection limit. Passwords are derived from a platform secret and the
 * generation that last rotated them, so nothing secret is stored.
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
  executeInDatabase(database: string, statements: readonly string[], signal: AbortSignal): Promise<void>;
}

export interface OwnerDatabaseCredentials {
  databaseName: string;
  roleName: string;
  password: string;
  passwordEpoch: number;
}

export interface ContainerOwnerDatabasesDeps {
  db: PlatformDB;
  admin: OwnerClusterAdmin;
  passwordSecret: string;
  sizeLimitBytes: number;
  connectionLimit?: number;
  randomBytes?: (size: number) => Buffer;
}

const IDENTIFIER = /^(mxo|mxr)_[a-z2-7]{26}$/;
const PASSWORD = /^[A-Za-z0-9_-]{43}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ROLE_ATTRIBUTES = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
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

export function assertOwnerIdentifier(value: string, prefix: 'mxo_' | 'mxr_'): string {
  if (!IDENTIFIER.test(value) || !value.startsWith(prefix)) throw new ContainerOwnerDatabaseError('invalid_identifier');
  return value;
}

function quoteIdentifier(value: string, prefix: 'mxo_' | 'mxr_'): string {
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
      `ALTER ROLE ${roleSql} WITH LOGIN ${ROLE_ATTRIBUTES} CONNECTION LIMIT ${connectionLimit} `
        + `PASSWORD ${quotePassword(passwordFor(row.role_name, row.password_epoch))}`,
      [], signal);
    for (const setting of ROLE_DEFAULTS) await admin.query(`ALTER ROLE ${roleSql} SET ${setting}`, [], signal);
    if (!await exists('pg_database', row.database_name, signal)) {
      await createIfAbsent(`CREATE DATABASE ${dbSql}`, signal);
    }
    await admin.query(`ALTER DATABASE ${dbSql} CONNECTION LIMIT ${connectionLimit}`, [], signal);
    await admin.query(`REVOKE ALL ON DATABASE ${dbSql} FROM PUBLIC`, [], signal);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${dbSql} TO ${roleSql}`, [], signal);
    await admin.executeInDatabase(row.database_name, [
      'REVOKE ALL ON SCHEMA public FROM PUBLIC',
      `GRANT USAGE, CREATE ON SCHEMA public TO ${roleSql}`,
    ], signal);
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



    async measureSize(clerkUserId: string, signal: AbortSignal): Promise<{ sizeBytes: number; overLimit: boolean }> {
      const row = await load(clerkUserId);
      const result = await admin.query('SELECT pg_database_size($1)::bigint AS size_bytes',
        [assertOwnerIdentifier(row.database_name, 'mxo_')], signal);
      const sizeBytes = Number(result[0]?.size_bytes);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('Owner database size measurement was invalid');
      await db.executor.updateTable('container_owner_databases')
        .set({ size_bytes: sizeBytes, size_measured_at: sql<Date>`now()` })
        .where('clerk_user_id', '=', clerkUserId).execute();
      return { sizeBytes, overLimit: sizeBytes > Number(row.size_limit_bytes) };
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
    await db.executor.updateTable('container_owner_databases').set({ deleted_at: sql<Date>`now()` })
      .where('clerk_user_id', '=', clerkUserId).where('deleted_at', 'is', null)
      .where('database_name', '=', row.database_name).where('role_name', '=', row.role_name)
      .execute();
  }
}

export type ContainerOwnerDatabases = ReturnType<typeof createContainerOwnerDatabases>;
