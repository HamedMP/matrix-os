import { timingSafeEqual } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PlatformDatabase } from '../db.js';
import { runPlatformMigration } from '../migration-runner.js';
import type { DevstackRunResult } from './execute.js';
import type { DevstackSourceReceipt } from '../devstack-cli-routes.js';

export type DevstackRunKind = 'exec' | 'test' | 'source';
export interface DevstackRunAdmission {
  runId: string;
  owner: string;
  keyDigest: string;
  requestDigest: string;
  runtime: string;
  worktree: string;
  containerId: string;
  cwd: string;
  revision: string;
  previewUrl: string;
  kind: DevstackRunKind;
  sourceBindingDigest?: string;
}
export interface DevstackRunRecord extends Omit<DevstackRunAdmission, 'keyDigest' | 'owner' | 'containerId' | 'cwd'> {
  status: DevstackRunResult['status'] | 'running';
  exitCode: DevstackRunResult['exitCode'];
  logs: DevstackRunResult['logs'];
  truncated: boolean;
  sourceReceipt?: DevstackSourceReceipt;
}

type AdmissionResult =
  | { outcome: 'admitted' | 'replay'; record: DevstackRunRecord }
  | { outcome: 'missing' | 'conflict' | 'busy' | 'capacity' };

export interface DevstackRunStore {
  read(runId: string, owner: string, keyDigest: string): Promise<DevstackRunRecord | undefined>;
  admit(admission: DevstackRunAdmission): Promise<AdmissionResult>;
  finish(runId: string, result: DevstackRunResult, sourceReceipt?: DevstackSourceReceipt): Promise<void>;
}

export async function migrateDevstackRuns(db: Kysely<PlatformDatabase>): Promise<void> {
  await runPlatformMigration(db, async trx => {
    await sql`
      CREATE TABLE IF NOT EXISTS devstack_runs (
        run_id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        key_digest char(64) NOT NULL,
        request_digest char(64) NOT NULL,
        runtime text NOT NULL,
        worktree text NOT NULL,
        container_id char(64) NOT NULL,
        cwd text NOT NULL,
        revision char(40) NOT NULL,
        preview_url text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('exec', 'test')),
        status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'interrupted', 'binding_rejected')),
        exit_code integer,
        logs jsonb NOT NULL DEFAULT '[]',
        truncated boolean NOT NULL DEFAULT false,
        lease_until timestamptz NOT NULL,
        retain_until timestamptz NOT NULL
      )
    `.execute(trx);
    await sql`ALTER TABLE devstack_runs ADD COLUMN IF NOT EXISTS source_binding_digest char(64),
      ADD COLUMN IF NOT EXISTS source_receipt jsonb`.execute(trx);
    await sql`ALTER TABLE devstack_runs DROP CONSTRAINT IF EXISTS devstack_runs_kind_check`.execute(trx);
    await sql`ALTER TABLE devstack_runs ADD CONSTRAINT devstack_runs_kind_check CHECK (kind IN ('exec', 'test', 'source'))`.execute(trx);
    await sql`ALTER TABLE devstack_runs ADD CONSTRAINT devstack_source_binding_check
      CHECK ((kind = 'source') = (source_binding_digest IS NOT NULL))`.execute(trx);
  }, { scope: 'devstack-runs', revision: { generation: 2, fingerprint: 'devstack-runs-source-v2' } });
}

interface Row extends DevstackRunRecord {
  keyDigest: string;
}

function load(db: Kysely<PlatformDatabase>, runId: string, owner: string) {
  return sql<Row>`
    SELECT run_id AS "runId", key_digest AS "keyDigest", request_digest AS "requestDigest",
      runtime, worktree, revision, preview_url AS "previewUrl", kind,
      CASE WHEN status = 'running' AND lease_until <= NOW() THEN 'interrupted' ELSE status END AS status,
      exit_code AS "exitCode", logs, truncated,
      source_binding_digest AS "sourceBindingDigest", source_receipt AS "sourceReceipt"
    FROM devstack_runs
    WHERE run_id = ${runId} AND owner_id = ${owner} AND retain_until > NOW()
  `.execute(db);
}

function authorizeRow(row: Row | undefined, keyDigest: string): DevstackRunRecord | undefined {
  if (!row) return undefined;
  const { keyDigest: storedKey, sourceBindingDigest, sourceReceipt, ...record } = row;
  if (!timingSafeEqual(Buffer.from(storedKey, 'hex'), Buffer.from(keyDigest, 'hex'))) return undefined;
  return { ...record, ...(sourceBindingDigest && { sourceBindingDigest }), ...(sourceReceipt && { sourceReceipt }) };
}

export function createDevstackRunStore(db: Kysely<PlatformDatabase>): DevstackRunStore {
  return {
    async read(runId, owner, keyDigest) {
      return authorizeRow((await load(db, runId, owner)).rows[0], keyDigest);
    },

    async admit(input) {
      return db.transaction().execute(async trx => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('matrix_devstack_run_admission'))`.execute(trx);
        await sql`DELETE FROM devstack_runs WHERE retain_until <= NOW()`.execute(trx);
        const prior = (await sql`SELECT 1 FROM devstack_runs WHERE run_id = ${input.runId}`.execute(trx)).rows.length;
        if (prior) {
          const record = authorizeRow((await load(trx, input.runId, input.owner)).rows[0], input.keyDigest);
          if (!record) return { outcome: 'missing' };
          return record.requestDigest === input.requestDigest ? { outcome: 'replay', record } : { outcome: 'conflict' };
        }
        // A failed transport can lose the response after the Gateway accepts
        // the command. Keep the worktree fenced until that lease expires.
        const busy = await sql`
          SELECT 1 FROM devstack_runs
          WHERE status IN ('running', 'interrupted') AND lease_until > NOW()
            AND ((runtime = ${input.runtime} AND worktree = ${input.worktree})
                 OR (container_id = ${input.containerId} AND cwd = ${input.cwd}))
          LIMIT 1
        `.execute(trx);
        if (busy.rows.length) return { outcome: 'busy' };
        const { rows: [count] } = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM devstack_runs`.execute(trx);
        if (count.count >= 256) return { outcome: 'capacity' };
        await sql`
          INSERT INTO devstack_runs (
            run_id, owner_id, key_digest, request_digest, runtime, worktree, container_id, cwd, revision,
            preview_url, kind, status, lease_until, retain_until, source_binding_digest
          ) VALUES (
            ${input.runId}, ${input.owner}, ${input.keyDigest}, ${input.requestDigest}, ${input.runtime},
            ${input.worktree}, ${input.containerId}, ${input.cwd}, ${input.revision}, ${input.previewUrl},
            ${input.kind}, 'running', NOW() + interval '180 seconds', NOW() + interval '24 hours', ${input.sourceBindingDigest ?? null}
          )
        `.execute(trx);
        const { keyDigest: _key, owner: _owner, containerId: _container, cwd: _cwd, ...record } = input;
        return { outcome: 'admitted', record: { ...record, status: 'running', exitCode: null, logs: [], truncated: false } };
      });
    },

    async finish(runId, result, sourceReceipt) {
      await sql`
        UPDATE devstack_runs SET status = ${result.status}, exit_code = ${result.exitCode},
          logs = ${JSON.stringify(result.logs)}::jsonb, truncated = ${result.truncated},
          source_receipt = ${sourceReceipt ? JSON.stringify(sourceReceipt) : null}::jsonb
        WHERE run_id = ${runId} AND status = 'running' AND lease_until > NOW()
      `.execute(db);
    },
  };
}
