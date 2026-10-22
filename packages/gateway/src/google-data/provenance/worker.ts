import { boundedProvenanceTransaction } from "./transaction.js";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { GoogleProvenanceUnavailable, validateOpaque, type GoogleEntityKind, type ProvenanceLimits, type PurgeClaim, type PurgeHandlers, type PurgeOutcome } from "./contracts.js";

export async function claimPurgeJob<DB>(db: Kysely<DB>, cap: ProvenanceLimits, workerId: string, input: { leaseMs?: number } = {}): Promise<PurgeClaim | null> {
  validateOpaque(workerId);
  const leaseMs = input.leaseMs ?? 60_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new GoogleProvenanceUnavailable();
  return boundedProvenanceTransaction(db, async tx => {
    // Crashed workers consume an attempt too; lease churn cannot create infinite retries.
    await sql`UPDATE google_copy_purge_jobs SET state='unresolved',reason='retry_exhausted',revision=revision+1,updated_at=now()
      WHERE (state='pending' OR (state='leased' AND lease_until <= now())) AND attempts >= ${cap.maxAttempts}`.execute(tx);
    const row = (await sql<{ id: string; owner_id: string }>`SELECT id,owner_id FROM google_copy_purge_jobs
      WHERE attempts < ${cap.maxAttempts} AND ((state='pending' AND next_attempt <= now()) OR (state='leased' AND lease_until <= now()))
      ORDER BY next_attempt,id LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(tx)).rows[0];
    if (!row) return null;
    const token = randomUUID();
    const result = (await sql<{ revision: number }>`UPDATE google_copy_purge_jobs SET state='leased',attempts=attempts+1,revision=revision+1,
      lease_token=${token},worker_id=${workerId},lease_until=now()+${leaseMs} * interval '1 millisecond',updated_at=now()
      WHERE id=${row.id} RETURNING revision`.execute(tx)).rows[0]!;
    return { jobId: row.id, ownerId: row.owner_id, leaseToken: token, revision: result.revision };
  });
}

export async function executePurgeClaim<DB>(db: Kysely<DB>, cap: ProvenanceLimits, claim: PurgeClaim, handlers: PurgeHandlers): Promise<"deleted" | "unresolved" | "retry" | "stale"> {
  validateOpaque(claim.ownerId);
  if (![claim.jobId, claim.leaseToken].every(value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)) || !Number.isSafeInteger(claim.revision) || claim.revision < 1) throw new GoogleProvenanceUnavailable();
  return boundedProvenanceTransaction(db, async tx => {
    // Discovery cannot authorize deletion. All paths lock copy before job, including mixed-account purge admission.
    const source = (await sql<{ copy_id: string }>`SELECT copy_id FROM google_copy_purge_jobs
      WHERE id=${claim.jobId} AND owner_id=${claim.ownerId}`.execute(tx)).rows[0];
    if (!source) return "stale";
    const entity = (await sql<{ kind: GoogleEntityKind; entity_ref: string; content_hash: string }>`SELECT kind,entity_ref,content_hash FROM google_copy_registry
      WHERE id=${source.copy_id} AND owner_id=${claim.ownerId} AND state='purging' FOR UPDATE`.execute(tx)).rows[0];
    if (!entity) return "stale";
    const locked = (await sql`SELECT id FROM google_copy_purge_jobs
      WHERE id=${claim.jobId} AND owner_id=${claim.ownerId} AND lease_token=${claim.leaseToken}
      AND copy_id=${source.copy_id} AND revision=${claim.revision} AND state='leased' FOR UPDATE`.execute(tx)).rows[0];
    if (!locked) return "stale";
    // A row-lock wait can outlive its lease without changing the row. Read the live DB clock after both locks.
    const job = (await sql<{ copy_id: string; attempts: number; remaining_ms: number }>`SELECT copy_id,attempts,
      (extract(epoch FROM lease_until-clock_timestamp())*1000)::int AS remaining_ms FROM google_copy_purge_jobs
      WHERE id=${claim.jobId} AND owner_id=${claim.ownerId} AND copy_id=${source.copy_id} AND lease_token=${claim.leaseToken}
      AND revision=${claim.revision} AND state='leased' AND lease_until > clock_timestamp()`.execute(tx)).rows[0];
    if (!job) return "stale";
    const handler = handlers[entity.kind];
    let result: PurgeOutcome | undefined;
    let reason: "missing_handler" | "modified" | "unavailable" | "retry_exhausted" | "timeout" | null = handler ? null : "missing_handler";
    let retry = false;
    if (handler) {
      const timeout = Math.max(1, Math.min(cap.handlerTimeoutMs, job.remaining_ms));
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Purge timed out")); }, timeout); });
        result = await Promise.race([handler({ ownerId: claim.ownerId, entityRef: entity.entity_ref, expectedHash: entity.content_hash, signal: controller.signal }), aborted]);
        if (!result || !["deleted", "missing", "modified", "unavailable"].includes(result.status)) reason = "unavailable";
        else if (result.status === "modified" || result.status === "unavailable") reason = result.status;
      } catch {
        // Handler payloads/errors can contain content. Persist only this fixed code; never log them.
        retry = job.attempts < cap.maxAttempts && !controller.signal.aborted;
        reason = controller.signal.aborted ? "timeout" : retry ? null : "retry_exhausted";
      } finally { if (timer) clearTimeout(timer); controller.abort(); }
    }
    const deleted = result?.status === "deleted" || result?.status === "missing";
    const state = deleted ? "deleted" : retry ? "pending" : "unresolved";
    const settled = await sql`UPDATE google_copy_purge_jobs SET state=${state},reason=${reason},revision=revision+1,
      lease_token=NULL,worker_id=NULL,lease_until=NULL,next_attempt=now()+${cap.retryDelayMs} * interval '1 millisecond',updated_at=now()
      WHERE id=${claim.jobId} AND revision=${claim.revision} AND lease_token=${claim.leaseToken}
      AND lease_until > clock_timestamp() RETURNING id`.execute(tx);
    // A handler may have performed an idempotent deletion before its lease expired. Do not attest
    // a stale completion; the next worker verifies missing and settles under its own live lease.
    if (!settled.rows.length) return "stale";
    if (deleted) await sql`UPDATE google_copy_registry SET state='deleted',revision=revision+1,updated_at=now() WHERE id=${job.copy_id} AND owner_id=${claim.ownerId} AND state='purging'`.execute(tx);
    return deleted ? "deleted" : retry ? "retry" : "unresolved";
  });
}
