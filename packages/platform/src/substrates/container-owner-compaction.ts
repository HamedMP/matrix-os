import { assertOwnerIdentifier, type CompactionTarget, type ContainerOwnerDatabases, type OwnerClusterAdmin } from './container-owner-database.js';
import type { DatabaseSessionQuery, OwnerDatabaseSessions } from './container-owner-cluster-admin.js';

/**
 * Compaction for size-blocked owner databases (spec 2691 T055a follow-up).
 * Deleting rows frees space inside a table's files but does not shrink
 * pg_database_size, so a blocked owner who deletes would otherwise stay
 * blocked until it truncates. While an owner is blocked every table it made
 * is owned by its holder role, and VACUUM needs the table owner, so the admin
 * takes a SET-only, non-inheriting membership in the holder, works under
 * SET ROLE, and gives the membership up afterwards.
 *
 * VACUUM cannot run inside a transaction block, so the membership cannot be
 * scoped to a transaction the way the block itself is. Three things keep it
 * from outliving the work: it is revoked from the pool after every session,
 * whether the session succeeded, failed or died; every compaction first
 * revokes any holder membership an earlier crash left behind; and it carries
 * neither INHERIT nor ADMIN, so a leftover grants no implicit privilege.
 * (The admin's ADMIN-only membership from creating the role is not a grant
 * of privileges and is left alone.)
 *
 * Live size comes from table statistics after a plain VACUUM (ANALYZE): rows
 * times their average width per heap, chunk count per TOAST table, and indexes
 * scaled with their heap. pg_total_relation_size after a plain VACUUM was not
 * used: plain VACUUM only returns trailing empty pages, so scattered deletes
 * would never show up in it. The estimate only gates the rewrite; the block is
 * lifted solely by the real re-measurement that follows it.
 *
 * ANALYZE and VACUUM FULL evaluate index expressions and predicates (and
 * ANALYZE extended-statistics expressions) as the table owner, which is the
 * holder while blocked. If any of them on a holder-owned table references a
 * function, operator or domain outside pg_catalog, the owner wrote code that
 * would run as the holder, so compaction returns unsafe_to_compact and runs
 * no VACUUM at all; only a TRUNCATE lifts that owner's block. Remaining risk:
 * Postgres maintenance the platform does not control (autovacuum and
 * autoanalyze) still runs such code as the holder between sweeps. Each block
 * re-application revokes whatever it granted, which bounds that to one sweep
 * interval; data it writes as the holder counts against the size limit.
 */

export type CompactionOutcome = 'would_not_fit' | 'compacted' | 'still_blocked' | 'unsafe_to_compact';

export interface OwnerDatabaseCompactorDeps {
  admin: OwnerDatabaseSessions & Pick<OwnerClusterAdmin, 'query'>;
  ownerDatabases: Pick<ContainerOwnerDatabases, 'compactionTarget' | 'enforceSizeLimit'>;
  /** How long an owner is left alone after an attempt that did not lift its block. */
  cooldownMs?: number;
  now?: () => number;
  logError?: (message: string, detail: Record<string, string>) => void;
}

const SESSION_LIMITS = ["SET lock_timeout = '5s'", "SET statement_timeout = '120s'"];
const MAX_TABLES = 500;
const COOLDOWN_MS = 30 * 60_000;
const COOLDOWN_CAP = 1_000;
const REVOKE_TIMEOUT_MS = 10_000;
const HOLDER_ROLE = /^mxh_[a-z2-7]{26}$/;

const OTHER_SESSION_LOCKS = `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
  WHERE d.datname = current_database() AND l.pid <> pg_backend_pid() LIMIT 1`;

const HOLDER_TABLES = `SELECT format('%I.%I', n.nspname, c.relname) AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relowner = $1::text::regrole AND c.relkind IN ('r', 'm')
  ORDER BY pg_total_relation_size(c.oid) DESC LIMIT ${MAX_TABLES}`;

/** Allocated and estimated live bytes of the holder's tables, their TOAST and their indexes. */
const LIVE_ESTIMATE = `WITH rels AS (
    SELECT GREATEST(c.reltuples, 0) AS tuples, pg_relation_size(c.oid) AS heap_bytes,
      pg_indexes_size(c.oid) AS index_bytes,
      COALESCE(pg_relation_size(NULLIF(c.reltoastrelid, 0)), 0) AS toast_bytes,
      COALESCE((SELECT GREATEST(t.reltuples, 0) FROM pg_class t WHERE t.oid = c.reltoastrelid), 0) AS toast_tuples,
      COALESCE((SELECT sum(s.avg_width) FROM pg_stats s
        WHERE s.schemaname = n.nspname AND s.tablename = c.relname AND NOT s.inherited), 0) AS width
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner = $1::text::regrole AND c.relkind IN ('r', 'm')
  ), live AS (
    SELECT heap_bytes + toast_bytes + index_bytes AS allocated, heap_bytes, index_bytes,
      LEAST(heap_bytes, ceil(tuples * (width + 32) / 8000.0) * 8192) AS heap_live,
      LEAST(toast_bytes, ceil(toast_tuples / 4.0) * 8192) AS toast_live
    FROM rels
  )
  SELECT COALESCE(sum(allocated), 0)::bigint AS allocated_bytes,
    COALESCE(sum(heap_live + toast_live
      + CASE WHEN heap_bytes > 0 THEN ceil(index_bytes * heap_live / heap_bytes) ELSE index_bytes END), 0)::bigint AS live_bytes
  FROM live`;

/** Index and extended-statistics expressions on holder tables that reference non-catalog code. */
const OWNER_CODE_IN_EXPRESSIONS = `WITH trees AS (
    SELECT i.indexprs::text AS tree FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relowner = $1::text::regrole AND i.indexprs IS NOT NULL
    UNION ALL SELECT i.indpred::text FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relowner = $1::text::regrole AND i.indpred IS NOT NULL
    UNION ALL SELECT s.stxexprs::text FROM pg_statistic_ext s JOIN pg_class c ON c.oid = s.stxrelid
      WHERE c.relowner = $1::text::regrole AND s.stxexprs IS NOT NULL
  ), refs AS (
    SELECT m[1] AS key, m[2]::oid AS ref FROM trees,
      regexp_matches(tree, ':(funcid|opfuncid|hashfuncid|negfuncid|opno|resulttype) ([0-9]+)', 'g') m
  )
  SELECT 1 FROM refs
    LEFT JOIN pg_proc p ON refs.key IN ('funcid', 'opfuncid', 'hashfuncid', 'negfuncid') AND p.oid = refs.ref
    LEFT JOIN pg_operator o ON refs.key = 'opno' AND o.oid = refs.ref
    LEFT JOIN pg_proc op ON op.oid = o.oprcode
    LEFT JOIN pg_type t ON refs.key = 'resulttype' AND t.oid = refs.ref AND t.typtype = 'd'
  WHERE p.pronamespace <> 'pg_catalog'::regnamespace
    OR o.oprnamespace <> 'pg_catalog'::regnamespace OR op.pronamespace <> 'pg_catalog'::regnamespace
    OR t.typnamespace <> 'pg_catalog'::regnamespace
  LIMIT 1`;

const DATABASE_SIZE = 'SELECT pg_database_size(current_database())::bigint AS size_bytes';

function bytes(rows: Record<string, unknown>[], column: string): number {
  const value = Number(rows[0]?.[column]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Owner database compaction measurement was invalid');
  return value;
}

export function createOwnerDatabaseCompactor(deps: OwnerDatabaseCompactorDeps) {
  const cooldownMs = deps.cooldownMs ?? COOLDOWN_MS;
  const now = deps.now ?? Date.now;
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  const attempted = new Map<string, number>();

  function coolingDown(owner: string): boolean {
    const at = attempted.get(owner);
    if (at === undefined) return false;
    if (now() - at < cooldownMs) return true;
    attempted.delete(owner);
    return false;
  }

  function remember(owner: string): void {
    attempted.delete(owner);
    attempted.set(owner, now());
    while (attempted.size > COOLDOWN_CAP) attempted.delete(attempted.keys().next().value!);
  }

  async function revokeHolder(holderSql: string): Promise<void> {
    await deps.admin.query(`REVOKE ${holderSql} FROM CURRENT_USER`, [], AbortSignal.timeout(REVOKE_TIMEOUT_MS));
  }

  async function revokeLeftoverMemberships(signal: AbortSignal): Promise<void> {
    const rows = await deps.admin.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND (m.set_option OR m.inherit_option)`, [], signal);
    for (const row of rows) {
      const name = String(row.rolname);
      if (HOLDER_ROLE.test(name)) await revokeHolder(`"${assertOwnerIdentifier(name, 'mxh_')}"`);
    }
  }

  async function tables(query: DatabaseSessionQuery, target: CompactionTarget): Promise<string[]> {
    return (await query(HOLDER_TABLES, [target.holderName])).map((row) => String(row.name));
  }

  /** Runs in one session as the holder; returns null when another session holds locks. */
  async function rewrite(
    query: DatabaseSessionQuery, target: CompactionTarget,
  ): Promise<'would_not_fit' | 'unsafe_to_compact' | 'rewritten' | null> {
    for (const statement of SESSION_LIMITS) await query(statement);
    if ((await query(OTHER_SESSION_LOCKS)).length > 0) return null;
    if ((await query(OWNER_CODE_IN_EXPRESSIONS, [target.holderName])).length > 0) return 'unsafe_to_compact';
    await query(`GRANT ${target.holderSql} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
    await query(`SET ROLE ${target.holderSql}`);
    const names = await tables(query, target);
    for (const name of names) await query(`VACUUM (ANALYZE) ${name}`);
    const estimate = await query(LIVE_ESTIMATE, [target.holderName]);
    await query('RESET ROLE');
    const predicted = bytes(await query(DATABASE_SIZE), 'size_bytes')
      - bytes(estimate, 'allocated_bytes') + bytes(estimate, 'live_bytes');
    if (predicted >= target.restoreBelowBytes) return 'would_not_fit';
    await query(`SET ROLE ${target.holderSql}`);
    for (const name of names) await query(`VACUUM (FULL) ${name}`);
    await query('RESET ROLE');
    return 'rewritten';
  }

  async function compact(owner: string, target: CompactionTarget, signal: AbortSignal): Promise<CompactionOutcome | null> {
    let result: Awaited<ReturnType<typeof rewrite>>;
    try {
      result = await deps.admin.withDatabaseSession(target.databaseName, signal, (query) => rewrite(query, target));
    } finally {
      await revokeHolder(target.holderSql).catch((error: unknown) => {
        logError('[container-owner-db] compaction membership revoke failed', {
          cause: error instanceof Error ? error.name : 'unknown',
        });
      });
    }
    if (result === null) return null;
    remember(owner);
    if (result === 'unsafe_to_compact') {
      logError('[container-owner-db] compaction skipped: an index or statistics expression runs owner code', {});
      return result;
    }
    if (result === 'would_not_fit') return 'would_not_fit';
    const { writesBlocked } = await deps.ownerDatabases.enforceSizeLimit(owner, signal);
    return writesBlocked ? 'still_blocked' : 'compacted';
  }

  return {
    /**
     * Tries the given blocked owners in order and works on at most one: owners
     * cooling down, no longer blocked, or with another session holding locks
     * in their database are passed over. Throws when the attempt fails.
     */
    async compactFirst(owners: readonly string[], signal: AbortSignal): Promise<{ owner: string; outcome: CompactionOutcome } | null> {
      await revokeLeftoverMemberships(signal);
      for (const owner of owners) {
        if (coolingDown(owner)) continue;
        const target = await deps.ownerDatabases.compactionTarget(owner);
        if (!target) continue;
        let outcome: CompactionOutcome | null;
        try {
          outcome = await compact(owner, target, signal);
        } catch (error: unknown) {
          remember(owner);
          throw error;
        }
        if (outcome) return { owner, outcome };
      }
      return null;
    },
  };
}

export type OwnerDatabaseCompactor = ReturnType<typeof createOwnerDatabaseCompactor>;
