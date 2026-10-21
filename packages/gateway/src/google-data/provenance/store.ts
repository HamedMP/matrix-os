import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  copySchema, entityKind, GoogleProvenanceUnavailable, limits, originKey, originSchema, validateOpaque,
  type GoogleCopy, type GoogleOrigin, type ProvenanceLimits, type PurgeClaim, type PurgeHandlers, type RecordGoogleCopy,
} from "./contracts.js";
import { migrateGoogleProvenance } from "./schema.js";
import { executePurgeClaim, claimPurgeJob } from "./worker.js";

interface CopyRow {
  id: string; owner_id: string; kind: GoogleCopy["kind"]; entity_ref: string; content_hash: string;
  origins: GoogleOrigin[]; revision: number; retention_deadline: Date; retention_decision_id: string; state: GoogleCopy["state"];
}
const safeCopy = (row: CopyRow): GoogleCopy => ({ id: row.id, ownerId: row.owner_id, kind: row.kind,
  entityRef: row.entity_ref, contentHash: row.content_hash, origins: row.origins, revision: row.revision,
  retentionDeadline: row.retention_deadline.toISOString(), retentionDecisionId: row.retention_decision_id, state: row.state });
const unavailable = () => { throw new GoogleProvenanceUnavailable(); };
const lock = async <DB>(tx: Transaction<DB>) => { await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(tx); };

export function createGoogleProvenanceStore<DB>(db: Kysely<DB>, options: Partial<ProvenanceLimits> = {}) {
  const cap = limits(options);
  async function inspect(ownerId: string, kind: GoogleCopy["kind"], entityRef: string) {
    validateOpaque(ownerId); entityKind.parse(kind); validateOpaque(entityRef);
    const row = (await sql<CopyRow>`SELECT * FROM google_copy_registry WHERE owner_id=${ownerId} AND kind=${kind} AND entity_ref=${entityRef}`.execute(db)).rows[0];
    return row ? safeCopy(row) : null;
  }
  async function enqueue<DBT>(tx: Transaction<DBT>, rows: CopyRow[]) {
    const count = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM google_copy_purge_jobs`.execute(tx)).rows[0]!.count;
    const existing = rows.length ? (await sql<{ copy_id: string }>`SELECT copy_id FROM google_copy_purge_jobs WHERE copy_id IN (${sql.join(rows.map(r => r.id))})`.execute(tx)).rows : [];
    if (count + rows.length - existing.length > cap.maxJobs) unavailable();
    for (const row of rows) {
      await sql`INSERT INTO google_copy_purge_jobs(id,copy_id,owner_id,state)
        VALUES(${randomUUID()},${row.id},${row.owner_id},${row.state === "deleted" ? "deleted" : "pending"}) ON CONFLICT(copy_id) DO NOTHING`.execute(tx);
      await sql`UPDATE google_copy_registry SET state='purging',revision=revision+1,updated_at=now() WHERE id=${row.id} AND state='active'`.execute(tx);
    }
  }
  return {
    migrate: () => migrateGoogleProvenance(db),
    inspect,
    /** Trusted server composition only. Origin bindings must come from current P1 authority, never client attestations.
     * Recheck authority after this read and before dispatch. This is a provenance check, not authorization. */
    async assertReadable(ownerId: string, kind: GoogleCopy["kind"], entityRef: string, authorized: GoogleOrigin[]) {
      const approved = originSchema.array().max(32).parse(authorized);
      const row = await inspect(ownerId, kind, entityRef);
      if (!row || row.state !== "active" || new Date(row.retentionDeadline) <= new Date()) unavailable();
      if (row!.origins.some(origin => !approved.some(allow => originKey(origin) === originKey(allow)))) unavailable();
      return row!;
    },
    /** Caller registers lineage before exposing a managed copy and uses the returned revision for subsequent changes.
     * Recording metadata alone does not intercept writes or retroactively label unregistered historical data. */
    async record(value: RecordGoogleCopy): Promise<GoogleCopy> {
      const input = copySchema.parse(value);
      const deadline = new Date(input.retention.deadline);
      if (deadline <= new Date() || deadline.getTime() > Date.now() + 30 * 86_400_000) unavailable();
      return db.transaction().execute(async tx => {
        await lock(tx);
        const blocked = await sql`SELECT id FROM google_copy_purge_requests WHERE owner_id=${input.ownerId}
          AND connection_id IN (${sql.join(input.origins.map(o => o.connectionId))}) LIMIT 1`.execute(tx);
        if (blocked.rows.length) unavailable();
        const current = (await sql<CopyRow>`SELECT * FROM google_copy_registry WHERE owner_id=${input.ownerId} AND kind=${input.kind} AND entity_ref=${input.entityRef} FOR UPDATE`.execute(tx)).rows[0];
        if (current) {
          if (current.state !== "active" || current.retention_deadline <= new Date()
            || (input.baseRevision !== undefined && input.baseRevision !== current.revision)
            || (input.contentHash !== current.content_hash && input.baseRevision !== current.revision)) unavailable();
          const origins = [...new Map([...current.origins, ...input.origins].map(o => [originKey(o), o])).values()];
          if (origins.length > 32) unavailable();
          const keepOldDeadline = current.retention_deadline <= deadline;
          const updated = await sql<CopyRow>`UPDATE google_copy_registry SET content_hash=${input.contentHash},origins=${JSON.stringify(origins)}::jsonb,
            revision=revision+1,retention_deadline=LEAST(retention_deadline,${deadline}),
            retention_decision_id=${keepOldDeadline ? current.retention_decision_id : input.retention.decisionId},updated_at=now()
            WHERE id=${current.id} AND revision=${current.revision} RETURNING *`.execute(tx);
          if (!updated.rows[0]) unavailable();
          return safeCopy(updated.rows[0]!);
        }
        if (input.baseRevision !== undefined) unavailable();
        const count = (await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE owner_id=${input.ownerId})::int AS owned FROM google_copy_registry`.execute(tx)).rows[0]!;
        if (count.total >= cap.maxEntities || count.owned >= cap.maxEntitiesPerOwner) unavailable();
        const origins = [...new Map(input.origins.map(o => [originKey(o), o])).values()];
        const result = await sql<CopyRow>`INSERT INTO google_copy_registry(id,owner_id,kind,entity_ref,content_hash,origins,revision,retention_deadline,retention_decision_id,state)
          VALUES(${randomUUID()},${input.ownerId},${input.kind},${input.entityRef},${input.contentHash},${JSON.stringify(origins)}::jsonb,1,${deadline},${input.retention.decisionId},'active') RETURNING *`.execute(tx);
        return safeCopy(result.rows[0]!);
      });
    },
    /** Exact account tombstone never expires automatically. Reuse requires a newly authorized connection generation.
     * All managed mixed-origin copies are purged conservatively; unrelated accounts and owners are untouched. */
    async requestPurge(ownerId: string, connectionId: string, requestKey: string) {
      validateOpaque(ownerId); validateOpaque(connectionId); validateOpaque(requestKey);
      return db.transaction().execute(async tx => {
        await lock(tx);
        const previous = (await sql<{ id: string; connection_id: string }>`SELECT r.id,r.connection_id FROM google_copy_purge_keys k
          JOIN google_copy_purge_requests r ON r.id=k.request_id AND r.owner_id=k.owner_id WHERE k.owner_id=${ownerId} AND k.request_key=${requestKey}`.execute(tx)).rows[0];
        if (previous) {
          if (previous.connection_id !== connectionId) unavailable();
          return { id: previous.id, coverage: "registered-copies-only" as const };
        }
        const accountRequest = (await sql<{ id: string }>`SELECT id FROM google_copy_purge_requests WHERE owner_id=${ownerId} AND connection_id=${connectionId}`.execute(tx)).rows[0];
        const count = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM google_copy_purge_keys`.execute(tx)).rows[0]!.count;
        if (count >= cap.maxRequests) unavailable();
        if (accountRequest) {
          await sql`INSERT INTO google_copy_purge_keys(owner_id,request_key,request_id) VALUES(${ownerId},${requestKey},${accountRequest.id})`.execute(tx);
          return { id: accountRequest.id, coverage: "registered-copies-only" as const };
        }
        const rows = (await sql<CopyRow>`SELECT * FROM google_copy_registry WHERE owner_id=${ownerId} AND origins @> ${JSON.stringify([{ connectionId }])}::jsonb FOR UPDATE`.execute(tx)).rows;
        await enqueue(tx, rows);
        const id = randomUUID();
        await sql`INSERT INTO google_copy_purge_requests(id,owner_id,connection_id,request_key) VALUES(${id},${ownerId},${connectionId},${requestKey})`.execute(tx);
        await sql`INSERT INTO google_copy_purge_keys(owner_id,request_key,request_id) VALUES(${ownerId},${requestKey},${id})`.execute(tx);
        await sql`INSERT INTO google_copy_purge_links(request_id,job_id) SELECT ${id},j.id FROM google_copy_purge_jobs j
          JOIN google_copy_registry c ON c.id=j.copy_id WHERE c.owner_id=${ownerId} AND c.origins @> ${JSON.stringify([{ connectionId }])}::jsonb ON CONFLICT DO NOTHING`.execute(tx);
        return { id, coverage: "registered-copies-only" as const };
      });
    },
    async status(ownerId: string, requestId: string) {
      validateOpaque(ownerId);
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId)) unavailable();
      // One database snapshot prevents cleanup from splitting archived and live counts between reads.
      const result = (await sql<{ pending: number; unresolved: number; deleted: number }>`SELECT
        count(j.id) FILTER(WHERE j.state IN ('pending','leased'))::int AS pending,
        count(j.id) FILTER(WHERE j.state='unresolved')::int AS unresolved,
        count(j.id) FILTER(WHERE j.state='deleted')::int + r.archived_deleted AS deleted
        FROM google_copy_purge_requests r LEFT JOIN google_copy_purge_links l ON l.request_id=r.id
        LEFT JOIN google_copy_purge_jobs j ON j.id=l.job_id AND j.owner_id=r.owner_id
        WHERE r.id=${requestId} AND r.owner_id=${ownerId} GROUP BY r.id`.execute(db)).rows[0];
      if (!result) return null;
      return { id: requestId, ...result, complete: result.pending === 0 && result.unresolved === 0,
        coverage: "registered-copies-only" as const };
    },
    /** Host must call on a recurring bounded schedule. Expired data is unreadable even before scheduling. */
    async queueExpired(batchSize = 100) {
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) unavailable();
      return db.transaction().execute(async tx => {
        await lock(tx);
        const rows = (await sql<CopyRow>`SELECT * FROM google_copy_registry WHERE state='active' AND retention_deadline <= now()
          ORDER BY retention_deadline LIMIT ${batchSize} FOR UPDATE`.execute(tx)).rows;
        await enqueue(tx, rows);
        return rows.length;
      });
    },
    /** Host schedules this alongside queueExpired. Preserve count-only owner receipts and non-expiring account tombstones.
     * Never evict active/unresolved entities to satisfy a cap; exhausted storage fails closed. */
    async cleanupDeleted(batchSize = 100) {
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) unavailable();
      return db.transaction().execute(async tx => {
        await lock(tx);
        const rows = (await sql<{ id: string; job_id: string }>`SELECT c.id,j.id AS job_id FROM google_copy_registry c
          JOIN google_copy_purge_jobs j ON j.copy_id=c.id WHERE c.state='deleted' AND j.state='deleted'
          AND c.updated_at < now()-interval '30 days' ORDER BY c.updated_at LIMIT ${batchSize} FOR UPDATE OF c,j`.execute(tx)).rows;
        for (const row of rows) {
          await sql`UPDATE google_copy_purge_requests SET archived_deleted=archived_deleted+1 WHERE id IN
            (SELECT request_id FROM google_copy_purge_links WHERE job_id=${row.job_id})`.execute(tx);
          await sql`DELETE FROM google_copy_purge_links WHERE job_id=${row.job_id}`.execute(tx);
          await sql`DELETE FROM google_copy_purge_jobs WHERE id=${row.job_id} AND state='deleted'`.execute(tx);
          await sql`DELETE FROM google_copy_registry WHERE id=${row.id} AND state='deleted'`.execute(tx);
        }
        return rows.length;
      });
    },
    claimPurge: (workerId: string, input?: { leaseMs?: number }) => claimPurgeJob(db, cap, workerId, input),
    executeClaim: (claim: PurgeClaim, handlers: PurgeHandlers) => executePurgeClaim(db, cap, claim, handlers),
  };
}
