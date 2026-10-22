import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { BrowserApprovalIdentitySchema, BrowserDecisionProofSchema, BrowserDecisionTupleSchema, BrowserGrantRevokeTupleSchema,
  BrowserGrantViewSchema, BrowserRevokeProofSchema, type BrowserApprovalIdentity, type BrowserDecisionProof, type BrowserDecisionTuple,
  type BrowserGrantRevokeTuple, type BrowserGrantView, type BrowserRevokeProof } from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";

interface Challenge { id: string; owner_id: string; chat_id: string; run_id: string; lease_epoch: string; action_digest: string; revision: number;
  scope_version: number; status: string; decision: string | null; request_id: string | null; proof_nonce: string | null;
  grant_id: string | null; grant_revision: number | null; expires_at: Date | string }
interface Grant { id: string; owner_id: string; chat_id: string; capability: "shared_chrome"; scope_version: 1; revision: number;
  state: "active" | "revoked"; created_at: Date | string; revoked_at: Date | string | null }
const unavailable = () => new Error("Browser approval unavailable");
const view = (row: Grant): BrowserGrantView => BrowserGrantViewSchema.parse({ id: row.id, chatId: row.chat_id, capability: row.capability,
  scopeVersion: row.scope_version, revision: row.revision, state: row.state, createdAt: new Date(row.created_at).toISOString(),
  revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null });

/** Borrowed owner Kysely only: close drains this repository, never destroys the pool.
 * The injected owner pool must have bounded connection acquisition. Runtime
 * registration must verify that dependency before enabling the feature.
 */
export class BrowserApprovalRepository {
  private closed = false;
  private readonly controller = new AbortController();
  private readonly operations = new Set<Promise<unknown>>(); // <=32; finally eviction + shutdown drain
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly db: Kysely<ChatDatabase>, private readonly options: {
    boundedConnectionAcquisition: true;
    now?: () => number;
    verifyDecision(tuple: BrowserDecisionTuple, proof: string, signal?: AbortSignal): Promise<BrowserDecisionProof>;
    verifyRevoke(tuple: BrowserGrantRevokeTuple, proof: string, signal?: AbortSignal): Promise<BrowserRevokeProof>;
  }) { if (options.boundedConnectionAcquisition !== true) throw unavailable(); }
  private now() { return (this.options.now ?? Date.now)(); }
  private perform<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.operations.size >= 32) return Promise.reject(unavailable());
    const result = Promise.resolve().then(() => { if (this.closed) throw unavailable(); return work(); }).finally(() => { this.operations.delete(result); });
    this.operations.add(result); return result;
  }
  private async transaction<T>(ownerId: string, work: (trx: Transaction<ChatDatabase>) => Promise<T>): Promise<T> {
    if (this.closed) throw unavailable();
    return this.db.transaction().execute(async trx => {
      await sql`SET LOCAL lock_timeout = '3s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext('browser_owner_v1'),hashtext(${ownerId}))`.execute(trx);
      if (this.closed) throw unavailable();
      return work(trx);
    });
  }
  private async assertChat(trx: Transaction<ChatDatabase>, ownerId: string, chatId: string, runId?: string) {
    const chat = await sql`SELECT id FROM chats WHERE id=${chatId} AND owner_type='personal' AND owner_id=${ownerId}
      AND lifecycle='active' AND collaboration IS NULL FOR UPDATE`.execute(trx);
    if (!chat.rows.length) throw unavailable();
    if (runId) {
      const run = await sql`SELECT id FROM chat_runs WHERE id=${runId} AND chat_id=${chatId}
        AND status IN ('accepted','running','waiting_for_approval','waiting_for_input') FOR UPDATE`.execute(trx);
      if (!run.rows.length) throw unavailable();
    }
  }
  private async challenge(trx: Transaction<ChatDatabase>, input: BrowserApprovalIdentity): Promise<Challenge> {
    await this.assertChat(trx, input.ownerId, input.chatId, input.runId);
    const lease = await sql`SELECT epoch FROM browser_chat_leases WHERE owner_id=${input.ownerId} AND epoch=${input.leaseEpoch}::uuid
      AND chat_id=${input.chatId} AND run_id=${input.runId} AND state='active' AND expires_at>${new Date(this.now())} FOR UPDATE`.execute(trx);
    if (!lease.rows.length) throw unavailable();
    const result = await sql<Challenge>`SELECT * FROM browser_chat_challenges WHERE id=${input.approvalId} AND owner_id=${input.ownerId}
      AND chat_id=${input.chatId} AND run_id=${input.runId} AND lease_epoch=${input.leaseEpoch}::uuid
      AND action_digest=${input.actionDigest} AND revision=${input.challengeRevision} AND scope_version=${input.scopeVersion} FOR UPDATE`.execute(trx);
    const row = result.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= this.now()) throw unavailable();
    return row;
  }
  reserve(inputValue: BrowserApprovalIdentity, expiresAt: number) {
    const input = BrowserApprovalIdentitySchema.parse(inputValue);
    return this.perform(() => this.transaction(input.ownerId, async trx => {
      const now = this.now();
      if (input.challengeRevision !== 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 5 * 60_000) throw unavailable();
      await this.assertChat(trx, input.ownerId, input.chatId, input.runId);
      const leases = await sql<{ count: string }>`SELECT count(*)::text AS count FROM browser_chat_leases WHERE owner_id=${input.ownerId} AND state='active' AND expires_at>${new Date(now)}`.execute(trx);
      const lease = await sql`SELECT epoch FROM browser_chat_leases WHERE owner_id=${input.ownerId} AND epoch=${input.leaseEpoch}::uuid`.execute(trx);
      const leaseHistory = await sql<{ count: string }>`SELECT count(*)::text AS count FROM browser_chat_leases WHERE owner_id=${input.ownerId}`.execute(trx);
      if (!lease.rows.length && (Number(leases.rows[0]?.count) >= 64 || Number(leaseHistory.rows[0]?.count) >= 256)) throw unavailable();
      await sql`INSERT INTO browser_chat_leases(owner_id,epoch,chat_id,run_id,state,expires_at)
        VALUES(${input.ownerId},${input.leaseEpoch}::uuid,${input.chatId},${input.runId},'active',${new Date(now + 30 * 60_000)}) ON CONFLICT(owner_id,epoch) DO NOTHING`.execute(trx);
      const live = await sql<{ expires_at: Date | string }>`SELECT expires_at FROM browser_chat_leases WHERE owner_id=${input.ownerId} AND epoch=${input.leaseEpoch}::uuid
        AND chat_id=${input.chatId} AND run_id=${input.runId} AND state='active' AND expires_at>${new Date(now)} FOR UPDATE`.execute(trx);
      if (!live.rows.length || new Date(live.rows[0]!.expires_at).getTime() < expiresAt) throw unavailable();
      const existing = (await sql<Challenge>`SELECT * FROM browser_chat_challenges WHERE id=${input.approvalId} FOR UPDATE`.execute(trx)).rows[0];
      if (existing) {
        const current = await this.challenge(trx, input);
        if (current.status !== "pending" || new Date(current.expires_at).getTime() !== expiresAt) throw unavailable();
        return;
      }
      await sql`UPDATE browser_chat_challenges SET status='expired',resolved_at=${new Date(now)} WHERE owner_id=${input.ownerId} AND status IN ('pending','approved') AND expires_at<=${new Date(now)}`.execute(trx);
      const count = await sql<{ total: string; live: string; per_run: string }>`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE status IN ('pending','approved'))::text AS live,
        count(*) FILTER (WHERE run_id=${input.runId} AND status IN ('pending','approved'))::text AS per_run FROM browser_chat_challenges WHERE owner_id=${input.ownerId}`.execute(trx);
      if (Number(count.rows[0]?.total) >= 4096 || Number(count.rows[0]?.live) >= 128 || Number(count.rows[0]?.per_run) >= 16) throw unavailable();
      const inserted = await sql`INSERT INTO browser_chat_challenges(id,owner_id,chat_id,run_id,lease_epoch,action_digest,revision,scope_version,status,expires_at)
        VALUES(${input.approvalId},${input.ownerId},${input.chatId},${input.runId},${input.leaseEpoch}::uuid,${input.actionDigest},0,1,'pending',${new Date(expiresAt)})
        ON CONFLICT(id) DO NOTHING RETURNING id`.execute(trx);
      if (!inserted.rows.length) {
        const current = await this.challenge(trx, input);
        if (current.status !== "pending" || new Date(current.expires_at).getTime() !== expiresAt) throw unavailable();
      }
    }));
  }
  decide(tupleValue: BrowserDecisionTuple, proof: string) {
    const tuple = BrowserDecisionTupleSchema.parse(tupleValue);
    return this.perform(async () => {
      const verified = BrowserDecisionProofSchema.parse(await this.options.verifyDecision(tuple, proof, this.controller.signal));
      if (!Object.entries(tuple).every(([key, value]) => verified[key as keyof typeof verified] === value)) throw unavailable();
      return this.transaction(tuple.actorId, async trx => {
        if (verified.expiresAt <= this.now() || verified.expiresAt > this.now() + 60_000) throw unavailable();
        const identity = { ownerId: tuple.actorId, ...tuple };
        const current = await this.challenge(trx, identity);
        if (current.request_id === tuple.clientRequestId && current.decision === tuple.browserDecision) {
          const prior = await sql<{ intent_digest: string }>`SELECT intent_digest FROM browser_chat_decisions WHERE owner_id=${tuple.actorId} AND request_id=${tuple.clientRequestId}`.execute(trx);
          if (prior.rows[0]?.intent_digest !== verified.bodyDigest) throw unavailable();
          const grant = current.grant_id ? (await sql<Grant>`SELECT * FROM browser_chat_grants WHERE id=${current.grant_id}::uuid AND owner_id=${tuple.actorId}`.execute(trx)).rows[0] : undefined;
          return { alreadySubmitted: true, grant: grant ? view(grant) : undefined };
        }
        if (current.status !== "pending") throw unavailable();
        await this.claimNonce(trx, tuple.actorId, verified.nonce, verified.expiresAt, tuple.clientRequestId, tuple.browserDecision, verified.bodyDigest, tuple.approvalId);
        let grant: Grant | undefined;
        if (tuple.browserDecision === "allow_in_chat") {
          const count = await sql<{ total: string; active: string }>`SELECT count(*)::text AS total,
            count(*) FILTER(WHERE state='active')::text AS active FROM browser_chat_grants WHERE owner_id=${tuple.actorId}`.execute(trx);
          const existing = await sql<Grant>`SELECT * FROM browser_chat_grants WHERE owner_id=${tuple.actorId} AND chat_id=${tuple.chatId} FOR UPDATE`.execute(trx);
          if ((!existing.rows.length && Number(count.rows[0]?.total) >= 256)
            || (existing.rows[0]?.state !== "active" && Number(count.rows[0]?.active) >= 128)) throw unavailable();
          grant = (await sql<Grant>`INSERT INTO browser_chat_grants(id,owner_id,chat_id,capability,scope_version,revision,state,origin_approval_id)
            VALUES(${randomUUID()}::uuid,${tuple.actorId},${tuple.chatId},'shared_chrome',1,1,'active',${tuple.approvalId})
            ON CONFLICT(chat_id) DO UPDATE SET revision=CASE WHEN browser_chat_grants.state='active'
              THEN browser_chat_grants.revision ELSE browser_chat_grants.revision+1 END,state='active',revoked_at=NULL,
              origin_approval_id=CASE WHEN browser_chat_grants.state='active' THEN browser_chat_grants.origin_approval_id ELSE EXCLUDED.origin_approval_id END
            WHERE browser_chat_grants.owner_id=EXCLUDED.owner_id
              AND (browser_chat_grants.state='active' OR browser_chat_grants.revision<2147483647) RETURNING *`.execute(trx)).rows[0];
          if (!grant) throw unavailable();
        }
        const status = tuple.browserDecision === "not_now" ? "denied" : tuple.browserDecision === "cancel" ? "cancelled" : "approved";
        const updated = await sql`UPDATE browser_chat_challenges SET status=${status},decision=${tuple.browserDecision},request_id=${tuple.clientRequestId},
          proof_nonce=${verified.nonce},grant_id=${grant?.id ?? null}::uuid,grant_revision=${grant?.revision ?? null},resolved_at=${new Date(this.now())}
          WHERE id=${tuple.approvalId} AND owner_id=${tuple.actorId} AND status='pending' AND revision=${tuple.challengeRevision}
          AND expires_at>GREATEST(${new Date(this.now())},clock_timestamp()) AND ${new Date(verified.expiresAt)}>clock_timestamp() RETURNING id`.execute(trx);
        if (!updated.rows.length) throw unavailable();
        return { alreadySubmitted: false, grant: grant ? view(grant) : undefined };
      });
    });
  }
  private async claimNonce(trx: Transaction<ChatDatabase>, owner: string, nonce: string, expiry: number, request: string, decision: string, intentDigest: string, challenge?: string, grant?: string) {
    if (this.closed) throw unavailable();
    const count = await sql<{ count: string }>`SELECT count(*)::text AS count FROM browser_chat_decisions WHERE owner_id=${owner}`.execute(trx);
    if (Number(count.rows[0]?.count) >= 4096) throw unavailable();
    const result = await sql`INSERT INTO browser_chat_decisions(owner_id,nonce,challenge_id,grant_id,request_id,decision,intent_digest,expires_at)
      VALUES(${owner},${nonce},${challenge ?? null},${grant ?? null}::uuid,${request},${decision},${intentDigest},${new Date(expiry)}) ON CONFLICT DO NOTHING RETURNING nonce`.execute(trx);
    if (!result.rows.length) throw unavailable();
  }
  consume(inputValue: BrowserApprovalIdentity) {
    const input = BrowserApprovalIdentitySchema.parse(inputValue);
    return this.perform(() => this.transaction(input.ownerId, async trx => {
      const current = await this.challenge(trx, input);
      if (current.status !== "approved") throw unavailable();
      if (current.grant_id) {
        const grant = await sql`SELECT id FROM browser_chat_grants WHERE id=${current.grant_id}::uuid AND owner_id=${input.ownerId}
          AND chat_id=${input.chatId} AND revision=${current.grant_revision} AND state='active' FOR UPDATE`.execute(trx);
        if (!grant.rows.length) throw unavailable();
      }
      if (this.closed) throw unavailable();
      const result = await sql`UPDATE browser_chat_challenges SET status='consumed' WHERE id=${input.approvalId} AND owner_id=${input.ownerId}
        AND status='approved' AND revision=${input.challengeRevision} AND expires_at>GREATEST(${new Date(this.now())},clock_timestamp()) RETURNING id`.execute(trx);
      if (!result.rows.length) throw unavailable();
    }));
  }
  activeGrant(ownerId: string, chatId: string) {
    BrowserApprovalIdentitySchema.shape.ownerId.parse(ownerId); BrowserApprovalIdentitySchema.shape.chatId.parse(chatId);
    return this.perform(() => this.transaction(ownerId, async trx => {
      const result = await sql<Grant>`SELECT g.* FROM browser_chat_grants g JOIN chats c ON c.id=g.chat_id
        WHERE g.owner_id=${ownerId} AND g.chat_id=${chatId} AND g.state='active' AND c.owner_id=${ownerId}
        AND c.owner_type='personal' AND c.lifecycle='active' AND c.collaboration IS NULL FOR UPDATE OF g`.execute(trx);
      return result.rows[0] ? view(result.rows[0]) : null;
    }));
  }
  consumeGrant(inputValue: BrowserApprovalIdentity, grantId: string, expectedRevision: number) {
    const input = BrowserApprovalIdentitySchema.parse(inputValue);
    BrowserGrantViewSchema.shape.id.parse(grantId); BrowserGrantViewSchema.shape.revision.parse(expectedRevision);
    return this.perform(() => this.transaction(input.ownerId, async trx => {
      const current = await this.challenge(trx, input);
      if (current.status !== "pending" || this.closed) throw unavailable();
      const grant = await sql`SELECT id FROM browser_chat_grants WHERE id=${grantId}::uuid AND owner_id=${input.ownerId} AND chat_id=${input.chatId}
        AND revision=${expectedRevision} AND state='active' AND scope_version=1 FOR UPDATE`.execute(trx);
      if (!grant.rows.length) throw unavailable();
      const changed = await sql`UPDATE browser_chat_challenges SET status='consumed',decision='allow_in_chat',grant_id=${grantId}::uuid,
        grant_revision=${expectedRevision},resolved_at=${new Date(this.now())} WHERE id=${input.approvalId} AND owner_id=${input.ownerId}
        AND status='pending' AND revision=${input.challengeRevision} AND expires_at>GREATEST(${new Date(this.now())},clock_timestamp()) RETURNING id`.execute(trx);
      if (!changed.rows.length) throw unavailable();
    }));
  }
  revoke(tupleValue: BrowserGrantRevokeTuple, proof: string) {
    const tuple = BrowserGrantRevokeTupleSchema.parse(tupleValue);
    return this.perform(async () => {
      const verified = BrowserRevokeProofSchema.parse(await this.options.verifyRevoke(tuple, proof, this.controller.signal));
      if (!Object.entries(tuple).every(([key, value]) => verified[key as keyof typeof verified] === value)) throw unavailable();
      return this.transaction(tuple.actorId, async trx => {
        if (verified.expiresAt <= this.now() || verified.expiresAt > this.now() + 60_000) throw unavailable();
        await this.assertChat(trx, tuple.actorId, tuple.chatId);
        const prior = (await sql<{ intent_digest: string; decision: string; result: unknown }>`SELECT intent_digest,decision,result FROM browser_chat_decisions
          WHERE owner_id=${tuple.actorId} AND request_id=${tuple.clientRequestId}`.execute(trx)).rows[0];
        if (prior) {
          if (prior.decision !== "revoke_grant" || prior.intent_digest !== verified.bodyDigest) throw unavailable();
          return BrowserGrantViewSchema.parse(prior.result);
        }
        await this.claimNonce(trx, tuple.actorId, verified.nonce, verified.expiresAt, tuple.clientRequestId, "revoke_grant", verified.bodyDigest, undefined, tuple.grantId);
        const result = await sql<Grant>`UPDATE browser_chat_grants SET state='revoked',revision=revision+1,revoked_at=${new Date(this.now())}
          WHERE id=${tuple.grantId}::uuid AND owner_id=${tuple.actorId} AND chat_id=${tuple.chatId} AND revision=${tuple.baseRevision}
          AND state='active' AND revision<2147483647 AND ${new Date(verified.expiresAt)}>clock_timestamp() RETURNING *`.execute(trx);
        if (!result.rows[0]) throw unavailable();
        await sql`UPDATE browser_chat_challenges SET status='cancelled',resolved_at=${new Date(this.now())}
          WHERE owner_id=${tuple.actorId} AND grant_id=${tuple.grantId}::uuid AND status='approved'`.execute(trx);
        const resultView = view(result.rows[0]);
        await sql`UPDATE browser_chat_decisions SET result=${JSON.stringify(resultView)}::jsonb WHERE owner_id=${tuple.actorId} AND request_id=${tuple.clientRequestId}`.execute(trx);
        return resultView;
      });
    });
  }
  cancelChallenge(inputValue: BrowserApprovalIdentity) {
    const input = BrowserApprovalIdentitySchema.parse(inputValue);
    return this.perform(() => this.transaction(input.ownerId, async trx => {
      await sql`UPDATE browser_chat_challenges SET status='cancelled',resolved_at=${new Date(this.now())}
        WHERE id=${input.approvalId} AND owner_id=${input.ownerId} AND chat_id=${input.chatId} AND run_id=${input.runId}
        AND lease_epoch=${input.leaseEpoch}::uuid AND action_digest=${input.actionDigest}
        AND revision=${input.challengeRevision} AND scope_version=${input.scopeVersion} AND status IN ('pending','approved')`.execute(trx);
    }));
  }
  invalidateLease(ownerId: string, epoch: string) {
    BrowserApprovalIdentitySchema.shape.ownerId.parse(ownerId); BrowserApprovalIdentitySchema.shape.leaseEpoch.parse(epoch);
    return this.perform(() => this.transaction(ownerId, async trx => {
      const existing = await sql`SELECT epoch FROM browser_chat_leases WHERE owner_id=${ownerId} AND epoch=${epoch}::uuid`.execute(trx);
      const history = await sql<{ count: string }>`SELECT count(*)::text AS count FROM browser_chat_leases WHERE owner_id=${ownerId}`.execute(trx);
      if (!existing.rows.length && Number(history.rows[0]?.count) >= 256) throw unavailable();
      await sql`INSERT INTO browser_chat_leases(owner_id,epoch,chat_id,run_id,state,expires_at)
        VALUES(${ownerId},${epoch}::uuid,NULL,NULL,'revoked',${new Date(this.now() + 30 * 60_000)})
        ON CONFLICT(owner_id,epoch) DO UPDATE SET state='revoked'`.execute(trx);
      await sql`UPDATE browser_chat_challenges SET status='cancelled',resolved_at=${new Date(this.now())}
        WHERE owner_id=${ownerId} AND lease_epoch=${epoch}::uuid AND status IN ('pending','approved')`.execute(trx);
    }));
  }
  sweep() {
    return this.perform(() => this.db.transaction().execute(async trx => {
      await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
      const now = new Date(this.now()), cutoff = new Date(this.now() - 24 * 60 * 60_000);
      await sql`UPDATE browser_chat_challenges SET status='expired',resolved_at=${now} WHERE id IN
        (SELECT id FROM browser_chat_challenges WHERE status IN ('pending','approved') AND expires_at<=${now} ORDER BY expires_at LIMIT 256 FOR UPDATE SKIP LOCKED)`.execute(trx);
      await sql`DELETE FROM browser_chat_decisions WHERE (owner_id,nonce) IN (SELECT owner_id,nonce FROM browser_chat_decisions WHERE expires_at<${cutoff} ORDER BY expires_at LIMIT 256)`.execute(trx);
      await sql`DELETE FROM browser_chat_challenges WHERE id IN (SELECT id FROM browser_chat_challenges WHERE status NOT IN ('pending','approved') AND expires_at<${cutoff} ORDER BY expires_at LIMIT 256)`.execute(trx);
      await sql`DELETE FROM browser_chat_grants WHERE state='revoked' AND revoked_at<${cutoff} AND id IN (SELECT id FROM browser_chat_grants WHERE state='revoked' AND revoked_at<${cutoff} ORDER BY revoked_at LIMIT 256 FOR UPDATE SKIP LOCKED)`.execute(trx);
      await sql`DELETE FROM browser_chat_leases WHERE (owner_id,epoch) IN (SELECT owner_id,epoch FROM browser_chat_leases WHERE expires_at<${cutoff} ORDER BY expires_at LIMIT 256)`.execute(trx);
    }));
  }
  startMaintenance() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(error => console.warn("[browser-approval] Maintenance unavailable", error instanceof Error ? error.name : "UnknownError")); }, 60_000);
    this.timer.unref?.();
  }
  async close() { this.closed = true; this.controller.abort(); clearInterval(this.timer); await Promise.allSettled([...this.operations]); }
}
