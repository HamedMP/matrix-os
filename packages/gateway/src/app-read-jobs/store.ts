import { sql, type Kysely } from "kysely";
import type { AppRecord } from "../app-db-registry.js";
import { parseAppSlug } from "../app-db-types.js";
import { READ_JOB_TABLES, ReadJobSchema, jobHash, rowKey, type ReadJob, type ReadJobClaim, type ReadJobCompletion, type ReadJobSnapshot, type ReadJobStatus } from "./types.js";

export function createAppReadJobStore(options: {
  db: Kysely<any>; ownerId: string;
  registeredApp(app: string): Promise<Pick<AppRecord, "slug" | "tables"> | null>;
}) {
  const { db, ownerId } = options;
  const table = (app: string, name: string) => sql.id(parseAppSlug(app), name);
  const key = (job: ReadJob) => rowKey(ownerId, job.id);
  async function prepare(job: ReadJob) {
    ReadJobSchema.parse(job);
    const registered = await options.registeredApp(job.app);
    if (!registered || registered.slug !== job.app || Object.entries(READ_JOB_TABLES).some(([name, def]) =>
      Object.entries(def.columns).some(([column, type]) => registered.tables[name]?.columns[column] !== type) || !registered.tables[name]?.uniqueIndexes?.includes("key"))) {
      throw new Error("App read job storage is unavailable");
    }
    await db.transaction().execute(async trx => {
      const prepared=await sql<{generation:number}>`INSERT INTO ${table(job.app, "read_job_state")}
        (key,owner_id,job_id,config_hash,generation,paused,status,next_due_at)
        VALUES (${key(job)},${ownerId},${job.id},${jobHash(job)},0,false,'idle',now())
        ON CONFLICT (key) DO UPDATE SET config_hash=excluded.config_hash,
          generation=CASE WHEN ${table(job.app, "read_job_state")}.config_hash<>excluded.config_hash THEN ${table(job.app, "read_job_state")}.generation+1 ELSE ${table(job.app, "read_job_state")}.generation END,
          status=CASE WHEN ${table(job.app,"read_job_state")}.config_hash<>excluded.config_hash THEN CASE WHEN ${table(job.app,"read_job_state")}.paused THEN 'paused' ELSE 'idle' END ELSE ${table(job.app,"read_job_state")}.status END,
          lease_until=CASE WHEN ${table(job.app, "read_job_state")}.config_hash<>excluded.config_hash THEN NULL ELSE ${table(job.app, "read_job_state")}.lease_until END
        RETURNING generation`.execute(trx);
      await sql`UPDATE ${table(job.app,"read_job_runs")} SET status='aborted',finished_at=now()
        WHERE owner_id=${ownerId} AND job_id=${job.id} AND status='running' AND generation<${prepared.rows[0]!.generation}`.execute(trx);
    });
  }
  async function claim(job: ReadJob, manual = false): Promise<ReadJobClaim | null> {
    if (!job.enabled) return null;
    return db.transaction().execute(async trx => {
      const result = await sql<{ generation: number; started_at: string }>`UPDATE ${table(job.app, "read_job_state")}
        SET generation=generation+1, status='running',last_attempt_at=now(),lease_until=now()+interval '120 seconds'
        WHERE key=${key(job)} AND owner_id=${ownerId} AND config_hash=${jobHash(job)} AND paused=false
          AND (lease_until IS NULL OR lease_until<=now()) AND (${manual} OR next_due_at<=now())
        RETURNING generation,last_attempt_at::text AS started_at`.execute(trx);
      const winner = result.rows[0];
      if (!winner) return null;
      // A recovered lease leaves a truthful interrupted receipt, rather than a permanent running badge.
      await sql`UPDATE ${table(job.app, "read_job_runs")} SET status='aborted',finished_at=now()
        WHERE owner_id=${ownerId} AND job_id=${job.id} AND status='running'`.execute(trx);
      await sql`INSERT INTO ${table(job.app, "read_job_runs")} (key,owner_id,job_id,generation,status,started_at,data)
        VALUES (${rowKey(ownerId,job.id,String(winner.generation))},${ownerId},${job.id},${winner.generation},'running',now(),'{}'::jsonb)`.execute(trx);
      return { generation: winner.generation, startedAt: winner.started_at };
    });
  }
  async function markSummaryAttempt(job: ReadJob, claim: ReadJobClaim): Promise<boolean> {
    // Intent is durable before inference so timeout/crash cannot bypass cost throttles.
    const result = await sql`UPDATE ${table(job.app,"read_job_state")} SET summary_attempt_at=now()
      WHERE key=${key(job)} AND owner_id=${ownerId} AND generation=${claim.generation}
        AND config_hash=${jobHash(job)} AND paused=false AND status='running' AND lease_until>now()
      RETURNING id`.execute(db);
    return result.rows.length > 0;
  }
  async function finish(job: ReadJob, claim: ReadJobClaim, result: ReadJobCompletion): Promise<boolean> {
    if (Buffer.byteLength(JSON.stringify(result)) > 262144) throw new Error("Read job result exceeds limit");
    return db.transaction().execute(async trx => {
      const won = await sql`UPDATE ${table(job.app, "read_job_state")} SET status=${result.status},lease_until=NULL,
        next_due_at=now()+(${job.intervalMs}::double precision*interval '1 millisecond'),
        last_success_at=CASE WHEN ${result.status === "completed"} THEN now() ELSE last_success_at END,
        summary_attempt_at=CASE WHEN ${result.summary?.status === "completed" || result.summary?.status === "unavailable"} THEN now() ELSE summary_attempt_at END,
        summary_at=CASE WHEN ${result.summary?.status === "completed"} THEN now() ELSE summary_at END,
        summary_hash=CASE WHEN ${result.summary?.status === "completed"} THEN ${result.summary?.hash ?? null} ELSE summary_hash END
        WHERE key=${key(job)} AND owner_id=${ownerId} AND generation=${claim.generation} AND config_hash=${jobHash(job)}
          AND paused=false AND status='running' AND lease_until>now() RETURNING id`.execute(trx);
      if (!won.rows.length) return false;
      for (const snapshot of result.snapshots) {
        await sql`INSERT INTO ${table(job.app,"read_job_snapshots")}
          (key,owner_id,job_id,source_key,data,observed_at,success_at)
          VALUES (${rowKey(ownerId,job.id,snapshot.sourceKey)},${ownerId},${job.id},${snapshot.sourceKey},${JSON.stringify(snapshot)}::jsonb,${snapshot.observedAt}::timestamptz,${snapshot.lastSuccessAt}::timestamptz)
          ON CONFLICT(key) DO UPDATE SET data=excluded.data,observed_at=excluded.observed_at,success_at=excluded.success_at,updated_at=now()`.execute(trx);
      }
      await sql`UPDATE ${table(job.app,"read_job_runs")} SET status=${result.status},data=${JSON.stringify({ sourceCoverage: result.snapshots.map(s => ({sourceKey:s.sourceKey,coverage:s.coverage,error:s.error})), summary:result.summary ?? null })}::jsonb,finished_at=now()
        WHERE key=${rowKey(ownerId,job.id,String(claim.generation))} AND owner_id=${ownerId} AND generation=${claim.generation}`.execute(trx);
      await sql`DELETE FROM ${table(job.app,"read_job_runs")} WHERE owner_id=${ownerId} AND job_id=${job.id} AND finished_at<now()-(CASE WHEN data->'summary'->>'status'='completed' THEN interval '90 days' ELSE interval '30 days' END)`.execute(trx);
      return true;
    });
  }
  async function status(job: ReadJob): Promise<ReadJobStatus | null> {
    const result = await sql<ReadJobStatus>`SELECT generation,paused,status,next_due_at::text AS "nextDueAt",lease_until::text AS "leaseUntil",last_attempt_at::text AS "lastAttemptAt",last_success_at::text AS "lastSuccessAt",summary_at::text AS "summaryAt",summary_attempt_at::text AS "summaryAttemptAt",summary_hash AS "summaryHash"
      FROM ${table(job.app,"read_job_state")} WHERE key=${key(job)} AND owner_id=${ownerId}`.execute(db);
    return result.rows[0] ?? null;
  }
  async function snapshots(job: ReadJob): Promise<ReadJobSnapshot[]> {
    const result = await sql<{data: ReadJobSnapshot}>`SELECT data FROM ${table(job.app,"read_job_snapshots")} WHERE owner_id=${ownerId} AND job_id=${job.id} ORDER BY source_key LIMIT 8`.execute(db);
    return result.rows.map(row => row.data);
  }
  async function setPaused(job: ReadJob, paused: boolean) {
    await db.transaction().execute(async trx => {
      await sql`UPDATE ${table(job.app,"read_job_state")} SET paused=${paused},generation=generation+1,lease_until=NULL,status=${paused ? "paused" : "idle"}
        WHERE key=${key(job)} AND owner_id=${ownerId}`.execute(trx);
      await sql`UPDATE ${table(job.app,"read_job_runs")} SET status='aborted',finished_at=now() WHERE owner_id=${ownerId} AND job_id=${job.id} AND status='running'`.execute(trx);
    });
  }
  return { prepare, claim, markSummaryAttempt, finish, status, snapshots, setPaused };
}
export type AppReadJobStore = ReturnType<typeof createAppReadJobStore>;
