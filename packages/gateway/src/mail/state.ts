import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { mailTransaction, bounded, iso, json } from "./reading.js";
import { MailArchiveError, type CleanupStatus, type MailSourceKey, type MailSyncJob, type StoredCleanupEntry, type StoredCleanupOperation, type StoredCleanupPlan } from "./types.js";
interface JobRow { id: string; owner_id: string; account_id: string; range_from: Date | string; range_until: Date | string; status: MailSyncJob["status"]; token: string | null; worker_id: string | null; lease_until: Date | string | null; checkpoint: unknown }
function job(row: JobRow): MailSyncJob { return { id: row.id, ownerId: row.owner_id, accountId: row.account_id, rangeFrom: iso(row.range_from), rangeUntil: iso(row.range_until), status: row.status, token: row.token, workerId: row.worker_id, leaseUntil: row.lease_until ? iso(row.lease_until) : null, checkpoint: row.checkpoint ? json(row.checkpoint) : null }; }
function scope(key: MailSourceKey): void { bounded(key.ownerId); bounded(key.accountId); }
const cleanupAllowed: Record<CleanupStatus, CleanupStatus[]> = { intent: ["unknown","confirmed","failed"], unknown: ["confirmed","unknown"], confirmed: ["undone","undo_pending"], undone: [], failed: [], planned: ["dispatching","skipped"], dispatching: ["unknown","confirmed"], skipped: [], undo_pending: ["undone"] };
export class MailStateRepository {
  constructor(readonly kysely: Kysely<unknown>, protected readonly now: () => Date) {}
  async enqueueSync(input: MailSourceKey & { rangeFrom: string; rangeUntil: string }): Promise<MailSyncJob> {
    scope(input); const from = new Date(input.rangeFrom); const until = new Date(input.rangeUntil);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || from > until) throw new MailArchiveError("invalid");
    return mailTransaction(this.kysely, async (trx) => {
      await sql`INSERT INTO mail_sync_jobs(id,owner_id,account_id,range_from,range_until,status)
        VALUES(${randomUUID()},${input.ownerId},${input.accountId},${from},${until},'pending') ON CONFLICT(owner_id,account_id) DO NOTHING`.execute(trx);
      const current = (await sql<JobRow>`SELECT * FROM mail_sync_jobs WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} FOR UPDATE`.execute(trx)).rows[0]!;
      // Active requests coalesce only within existing coverage. Widening while
      // a worker advances a page would hide required historical discovery.
      if (current.status !== "completed") {
        if (from < new Date(current.range_from) || until > new Date(current.range_until)) throw new MailArchiveError("conflict");
        return job(current);
      }
      const checkpoint = from >= new Date(current.range_from) && current.checkpoint ? JSON.stringify(json(current.checkpoint)) : null;
      return job((await sql<JobRow>`UPDATE mail_sync_jobs SET id=${randomUUID()},range_from=${from},range_until=${until},status='pending',token=NULL,worker_id=NULL,lease_until=NULL,checkpoint=${checkpoint}::jsonb WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} RETURNING *`.execute(trx)).rows[0]!);
    });
  }
  async getSyncJob(input: MailSourceKey): Promise<MailSyncJob | null> {
    scope(input); const row = (await sql<JobRow>`SELECT * FROM mail_sync_jobs WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(this.kysely)).rows[0]; return row ? job(row) : null;
  }
  async claimSync(input: MailSourceKey & { workerId: string; leaseMs?: number }): Promise<(MailSyncJob & { token: string }) | null> {
    scope(input); bounded(input.workerId); const token = randomUUID(); const leaseUntil = new Date(this.now().getTime() + Math.min(5 * 60_000, Math.max(1000, input.leaseMs ?? 60_000)));
    const row = (await sql<JobRow>`UPDATE mail_sync_jobs SET status='running',token=${token},worker_id=${input.workerId},lease_until=${leaseUntil}
      WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND (status='pending' OR (status='running' AND lease_until<=${this.now()})) RETURNING *`.execute(this.kysely)).rows[0]; return row ? { ...job(row), token } : null;
  }
  async checkpointSync(input: MailSourceKey & { token: string; baseRevision: number; checkpoint: Record<string, unknown> }): Promise<boolean> {
    scope(input); bounded(input.token); const payload = JSON.stringify(input.checkpoint);
    if (Buffer.byteLength(payload) > 16_384 || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || input.checkpoint.revision !== input.baseRevision + 1) throw new MailArchiveError("invalid");
    const row = (await sql`UPDATE mail_sync_jobs SET checkpoint=${payload}::jsonb WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND token=${input.token} AND status='running' AND lease_until>${this.now()}
      AND COALESCE((checkpoint->>'revision')::integer,0)=${input.baseRevision} RETURNING id`.execute(this.kysely)).rows;
    return row.length === 1;
  }
  async renewSync(input: MailSourceKey & { token: string; leaseMs?: number }): Promise<boolean> {
    scope(input); bounded(input.token); const expiry = new Date(this.now().getTime() + Math.min(5 * 60_000, Math.max(1000, input.leaseMs ?? 60_000)));
    return (await sql`UPDATE mail_sync_jobs SET lease_until=${expiry} WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND token=${input.token} AND status='running' AND lease_until>${this.now()} RETURNING id`.execute(this.kysely)).rows.length === 1;
  }
  async completeSync(input: MailSourceKey & { token: string }): Promise<boolean> {
    scope(input); bounded(input.token);
    return (await sql`UPDATE mail_sync_jobs SET status='completed',token=NULL,worker_id=NULL,lease_until=NULL WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND token=${input.token} AND status='running' AND lease_until>${this.now()} RETURNING id`.execute(this.kysely)).rows.length === 1;
  }
  async releaseSync(input: MailSourceKey & { token: string }): Promise<boolean> {
    scope(input); bounded(input.token);
    return (await sql`UPDATE mail_sync_jobs SET status='pending',token=NULL,worker_id=NULL,lease_until=NULL WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND token=${input.token} AND status='running' AND lease_until>${this.now()} RETURNING id`.execute(this.kysely)).rows.length === 1;
  }
  async savePlan(plan: StoredCleanupPlan): Promise<void> {
    scope(plan); bounded(plan.id); bounded(plan.binding); bounded(plan.policyVersion); if (!/^[a-f0-9]{64}$/.test(plan.hash) || !Number.isFinite(plan.expiresAt) || plan.expiresAt <= this.now().getTime() || plan.expiresAt > this.now().getTime() + 30 * 60_000 || !plan.messages.length || plan.messages.length > 100 || new Set(plan.messages.map(m => m.messageId)).size !== plan.messages.length) throw new MailArchiveError("invalid");
    const payload = JSON.stringify(plan); if (Buffer.byteLength(payload) > 128_000) throw new MailArchiveError("invalid");
    await mailTransaction(this.kysely, async (trx) => {
      for (const message of plan.messages) {
        bounded(message.messageId, 512);
        const row = (await sql<{ object: unknown; revision: number }>`SELECT object,revision FROM mail_messages WHERE owner_id=${plan.ownerId} AND account_id=${plan.accountId} AND message_id=${message.messageId} AND deleted_at IS NULL FOR SHARE`.execute(trx)).rows[0];
        if (!row?.object || json<{ digest: string }>(row.object).digest !== message.contentDigest || row.revision !== message.revision || !message.ready) throw new MailArchiveError("conflict");
      }
      const inserted = (await sql`INSERT INTO mail_cleanup_plans(id,owner_id,account_id,payload,expires_at) VALUES(${plan.id},${plan.ownerId},${plan.accountId},${payload}::jsonb,${new Date(plan.expiresAt)}) ON CONFLICT DO NOTHING RETURNING id`.execute(trx)).rows;
      if (!inserted.length) {
        const existing = (await sql<{ payload: unknown }>`SELECT payload FROM mail_cleanup_plans WHERE id=${plan.id} AND owner_id=${plan.ownerId} AND account_id=${plan.accountId}`.execute(trx)).rows[0];
        const matches = existing && (await sql<{ same: boolean }>`SELECT payload=${payload}::jsonb AS same FROM mail_cleanup_plans WHERE id=${plan.id} AND owner_id=${plan.ownerId} AND account_id=${plan.accountId}`.execute(trx)).rows[0]?.same;
        if (!matches) throw new MailArchiveError("conflict");
      }
    });
  }
  async getPlan(input: MailSourceKey & { planId: string }): Promise<StoredCleanupPlan | null> {
    scope(input); bounded(input.planId);
    const row = (await sql<{ payload: unknown }>`SELECT payload FROM mail_cleanup_plans WHERE id=${input.planId} AND owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(this.kysely)).rows[0]; return row ? json(row.payload) : null;
  }
  async claimOperation(plan: StoredCleanupPlan, existingOnly = false): Promise<{ id: string; entries: StoredCleanupEntry[] }> {
    scope(plan); bounded(plan.id);
    return mailTransaction(this.kysely, async (trx) => {
      const stored = (await sql<{ payload: unknown; expires_at: Date | string }>`SELECT payload,expires_at FROM mail_cleanup_plans WHERE id=${plan.id} AND owner_id=${plan.ownerId} AND account_id=${plan.accountId} FOR SHARE`.execute(trx)).rows[0];
      if (!stored || json<StoredCleanupPlan>(stored.payload).hash !== plan.hash) throw new MailArchiveError("conflict");
      const existing = (await sql<{ id:string }>`SELECT id FROM mail_cleanup_operations WHERE plan_id=${plan.id} AND owner_id=${plan.ownerId} AND account_id=${plan.accountId}`.execute(trx)).rows[0];
      if (!existing && (existingOnly || new Date(stored.expires_at) <= this.now())) throw new MailArchiveError("conflict");
      // Use the retained immutable snapshot, never a caller-supplied selection.
      const canonical = json<StoredCleanupPlan>(stored.payload);
      const inserted = existing ? undefined : (await sql<{ id: string }>`INSERT INTO mail_cleanup_operations(id,plan_id,owner_id,account_id)
        VALUES(${randomUUID()},${plan.id},${plan.ownerId},${plan.accountId}) ON CONFLICT(plan_id) DO NOTHING RETURNING id`.execute(trx)).rows[0];
      const id = existing?.id ?? inserted?.id ?? (await sql<{ id: string }>`SELECT id FROM mail_cleanup_operations WHERE plan_id=${plan.id} AND owner_id=${plan.ownerId} AND account_id=${plan.accountId}`.execute(trx)).rows[0]!.id;
      if (inserted) for (const message of canonical.messages) {
        const entry: StoredCleanupEntry = { messageId: message.messageId, state: "planned" };
        await sql`INSERT INTO mail_cleanup_operation_entries(operation_id,message_id,state,payload) VALUES(${id},${message.messageId},'planned',${JSON.stringify(entry)}::jsonb)`.execute(trx);
      }
      const entries = (await sql<{ payload: unknown }>`SELECT payload FROM mail_cleanup_operation_entries WHERE operation_id=${id} ORDER BY message_id`.execute(trx)).rows.map(r => json<StoredCleanupEntry>(r.payload));
      return { id, entries };
    });
  }
  async transition(input: MailSourceKey & { operationId: string; messageId: string; from: StoredCleanupEntry["state"]; next: StoredCleanupEntry }): Promise<boolean> {
    scope(input); bounded(input.operationId); bounded(input.messageId, 512);
    if (input.next.messageId !== input.messageId || !(cleanupAllowed[input.from] ?? []).includes(input.next.state) || (input.next.labels?.length ?? 0) > 100) throw new MailArchiveError("invalid");
    return (await sql`UPDATE mail_cleanup_operation_entries e SET state=${input.next.state},payload=${JSON.stringify(input.next)}::jsonb
      FROM mail_cleanup_operations o WHERE e.operation_id=o.id AND o.id=${input.operationId} AND o.owner_id=${input.ownerId} AND o.account_id=${input.accountId} AND e.message_id=${input.messageId} AND e.state=${input.from} RETURNING e.message_id`.execute(this.kysely)).rows.length === 1;
  }
  async getOperation(input: MailSourceKey & { operationId: string }): Promise<StoredCleanupOperation | null> {
    scope(input); bounded(input.operationId);
    return mailTransaction(this.kysely, async (trx) => {
      const op = (await sql<{ id: string; payload: unknown }>`SELECT o.id,p.payload FROM mail_cleanup_operations o JOIN mail_cleanup_plans p ON p.id=o.plan_id WHERE o.id=${input.operationId} AND o.owner_id=${input.ownerId} AND o.account_id=${input.accountId}`.execute(trx)).rows[0];
      if (!op) return null;
      const rows = (await sql<{ payload: unknown }>`SELECT payload FROM mail_cleanup_operation_entries WHERE operation_id=${op.id} ORDER BY message_id`.execute(trx)).rows;
      return { id: op.id, plan: json(op.payload), entries: rows.map(row => json(row.payload)) };
    });
  }
}
