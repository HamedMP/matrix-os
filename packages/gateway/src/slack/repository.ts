import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import type { SlackCompanyDatabase, SlackInboxTable } from "./database.js";
import { SlackCompanyError, SlackHomeEnvelopeSchema, type SlackHomeEnvelope, type SlackThreadBinding } from "./schemas.js";

export function slackIdentity(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function slackRequestId(value: unknown): string {
  const hex = slackIdentity(value);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function eventKey(input: SlackHomeEnvelope) { return slackRequestId([input.event.appId, input.event.teamId, input.event.eventId]); }
export function threadKey(input: SlackHomeEnvelope) { return slackIdentity([input.event.appId, input.event.teamId, input.event.channelId, input.event.threadTs ?? input.event.ts]); }
export type SlackInbox = Selectable<SlackInboxTable>;

export class SlackCompanyRepository {
  constructor(private readonly db: Kysely<SlackCompanyDatabase>, private readonly ownerId: string, private readonly now: () => Date) {}

  async receive(envelope: SlackHomeEnvelope) {
    const id = eventKey(envelope); const hash = slackIdentity(envelope);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${this.ownerId}))`.execute(trx);
      const old = await trx.selectFrom("slack_company_inbox").selectAll().where("id", "=", id).executeTakeFirst();
      if (old) {
        if (old.owner_id !== this.ownerId || old.payload_hash !== hash) throw new SlackCompanyError("conflict");
        return { accepted: true as const, duplicate: true, eventId: id };
      }
      const usage = await trx.selectFrom("slack_company_inbox").select([
        sql<string>`count(*)`.as("total"), sql<string>`count(*) FILTER (WHERE state IN ('pending','processing','accepted'))`.as("pending"),
      ]).where("owner_id", "=", this.ownerId).executeTakeFirstOrThrow();
      if (Number(usage.total) >= 10_000 || Number(usage.pending) >= 1000) throw new SlackCompanyError("capacity");
      await trx.insertInto("slack_company_inbox").values({ id, owner_id: this.ownerId, envelope: sql`${JSON.stringify(envelope)}::jsonb`, payload_hash: hash,
        state: "pending", attempts: 0, lease: null, lease_until: null, chat_id: null, scope_id: null, request_text: null, expected_revision: null,
        source_proofs:sql`'[]'::jsonb`, ingestion_status:"not_requested", queued_turn_id: null, created_at: this.now(), updated_at: this.now() }).onConflict((oc) => oc.column("id").doNothing()).execute();
      return { accepted: true as const, duplicate: false, eventId: id };
    });
  }

  async claim() {
    return this.db.transaction().execute(async (trx) => {
      const now = this.now();
      const row = await trx.selectFrom("slack_company_inbox").selectAll().where("owner_id", "=", this.ownerId).where("attempts", "<", 8)
        .where((eb) => eb.or([eb.and([eb("state", "=", "pending"),eb.or([eb("lease_until", "is", null),eb("lease_until", "<=", now)])]), eb.and([eb("state", "=", "processing"), eb("lease_until", "<", now)])]))
        .orderBy("created_at", "asc").forUpdate().skipLocked().limit(1).executeTakeFirst();
      if (!row) return null;
      const lease = randomUUID();
      return await trx.updateTable("slack_company_inbox").set({ state: "processing", lease, lease_until: new Date(now.getTime()+60_000), attempts: row.attempts+1, updated_at: now })
        .where("id", "=", row.id).returningAll().executeTakeFirstOrThrow();
    });
  }

  async bind(row: SlackInbox, envelope: SlackHomeEnvelope, thread: SlackThreadBinding, text: string, revision: string, sourceProofs: Array<{scopeId:string;sourceId:string;incarnation:string;revision:number}>, ingestion: SlackInbox["ingestion_status"]): Promise<SlackInbox> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${this.ownerId}))`.execute(trx);
      const current = await trx.selectFrom("slack_company_inbox").selectAll().where("id", "=", row.id).where("owner_id", "=", this.ownerId).forUpdate().executeTakeFirstOrThrow();
      if (current.lease !== row.lease || current.state !== "processing") throw new SlackCompanyError("conflict");
      if (current.scope_id && (current.scope_id !== thread.scopeId || current.chat_id !== thread.chatId)) throw new SlackCompanyError("conflict");
      const key = threadKey(envelope);
      const old = await trx.selectFrom("slack_company_threads").selectAll().where("thread_key", "=", key).executeTakeFirst();
      if (old && (old.owner_id !== envelope.ownerId || old.organization_id !== envelope.organizationId || old.project_scope_id !== envelope.channelScopeId
        || old.project_id !== thread.projectId || old.scope_id !== thread.scopeId || old.chat_id !== thread.chatId)) throw new SlackCompanyError("forbidden");
      if (!old) {
        const usage = await trx.selectFrom("slack_company_threads").select(sql<string>`count(*)`.as("count")).where("owner_id", "=", this.ownerId).executeTakeFirstOrThrow();
        if (Number(usage.count) >= 10_000) throw new SlackCompanyError("capacity");
      }
      await trx.insertInto("slack_company_threads").values({ thread_key: key, owner_id: envelope.ownerId, organization_id: envelope.organizationId,
        project_scope_id: thread.projectScopeId, project_id: thread.projectId, scope_id: thread.scopeId, chat_id: thread.chatId, updated_at: this.now() })
        .onConflict((oc) => oc.column("thread_key").doUpdateSet({ updated_at: this.now() })).execute();
      return trx.updateTable("slack_company_inbox").set({ scope_id: thread.scopeId, chat_id: thread.chatId,
        request_text: current.request_text ?? text, expected_revision: current.expected_revision ?? revision,
        source_proofs: current.request_text !== null ? sql`${JSON.stringify(current.source_proofs)}::jsonb` : sql`${JSON.stringify(sourceProofs)}::jsonb`,
        ingestion_status: current.request_text !== null ? current.ingestion_status : ingestion, updated_at: this.now() })
        .where("id", "=", row.id).where("lease", "=", row.lease).returningAll().executeTakeFirstOrThrow();
    });
  }

  async refreshRevision(row: SlackInbox, revision: string) {
    await this.db.updateTable("slack_company_inbox").set({ expected_revision: revision, updated_at: this.now() })
      .where("id", "=", row.id).where("owner_id", "=", this.ownerId).where("lease", "=", row.lease).where("state", "=", "processing").execute();
  }
  async accepted(row: SlackInbox, queuedTurnId: string) {
    await this.db.updateTable("slack_company_inbox").set({ state: "accepted", queued_turn_id: queuedTurnId, lease: null, lease_until: null, updated_at: this.now() })
      .where("id", "=", row.id).where("owner_id", "=", this.ownerId).where("lease", "=", row.lease).execute();
  }
  async release(row: SlackInbox, retry: boolean) {
    await this.db.updateTable("slack_company_inbox").set({ state: retry && row.attempts < 8 ? "pending" : "failed", lease: null, lease_until: retry ? new Date(this.now().getTime()+Math.min(300_000, 5000 * 2**row.attempts)) : null, updated_at: this.now() })
      .where("id", "=", row.id).where("owner_id", "=", this.ownerId).where("lease", "=", row.lease).execute();
  }
  async waiting() { return this.db.selectFrom("slack_company_inbox").selectAll().where("owner_id", "=", this.ownerId).where("state", "=", "accepted").orderBy("updated_at", "asc").limit(20).execute(); }
  async deferResult(row: SlackInbox) {
    await this.db.updateTable("slack_company_inbox").set({updated_at:this.now()}).where("id","=",row.id)
      .where("owner_id","=",this.ownerId).where("state","=","accepted").where("queued_turn_id","=",row.queued_turn_id).execute();
  }
  async finish(row: SlackInbox, result: { runId: string; text: string } | null) {
    await this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("slack_company_inbox").selectAll().where("id", "=", row.id).where("owner_id", "=", this.ownerId).forUpdate().executeTakeFirst();
      if (!current || current.state !== "accepted" || current.queued_turn_id !== row.queued_turn_id) return;
      if (result) await trx.insertInto("slack_company_outbox").values({ event_id: row.id, run_id: result.runId, text: result.text, state: "pending",
        attempts: 0, lease: null, lease_until: null, message_ts: null, updated_at: this.now() }).onConflict((oc) => oc.column("event_id").doNothing()).execute();
      await trx.updateTable("slack_company_inbox").set({ state: result ? "completed" : "failed", updated_at: this.now() }).where("id", "=", row.id).execute();
    });
  }
  async claimReply() {
    return this.db.transaction().execute(async (trx) => {
      const now = this.now();
      // A crash after beginning a send has an ambiguous outcome; do not send it again automatically.
      await trx.updateTable("slack_company_outbox").set({ state: "uncertain", lease: null, lease_until: null, updated_at: now })
        .where("state", "=", "sending").where("lease_until", "<", now).execute();
      const row = await trx.selectFrom("slack_company_outbox as outbox").innerJoin("slack_company_inbox as inbox", "inbox.id", "outbox.event_id")
        .selectAll("outbox").where("inbox.owner_id", "=", this.ownerId).where("outbox.state", "=", "pending").where("outbox.attempts", "<", 3).where((eb)=>eb.or([eb("outbox.lease_until","is",null),eb("outbox.lease_until","<=",now)]))
        .orderBy("outbox.updated_at", "asc").forUpdate("outbox").skipLocked().limit(1).executeTakeFirst();
      if (!row) return null;
      const outbox = await trx.updateTable("slack_company_outbox").set({ state: "sending", attempts: row.attempts+1, lease: randomUUID(),
        lease_until: new Date(now.getTime()+30_000), updated_at: now }).where("event_id", "=", row.event_id).returningAll().executeTakeFirstOrThrow();
      const inbox = await trx.selectFrom("slack_company_inbox").selectAll().where("id", "=", row.event_id).executeTakeFirstOrThrow();
      return { outbox, inbox };
    });
  }
  async replyStatus(eventId: string, lease: string | null, state: "sent" | "pending" | "uncertain" | "failed", messageTs?: string) {
    await this.db.updateTable("slack_company_outbox").set({ state, message_ts: messageTs ?? null, lease: null, lease_until: state === "pending" ? new Date(this.now().getTime()+30_000) : null, updated_at: this.now() })
      .where("event_id", "=", eventId).where("lease", "=", lease).execute();
  }
  async cleanup() {
    await this.db.transaction().execute(async(trx)=>{
      const now=this.now();
      await trx.updateTable("slack_company_inbox").set({state:"failed",lease:null,lease_until:null,updated_at:now})
        .where("owner_id","=",this.ownerId).where("state","in",["pending","processing","accepted"]).where("created_at","<",new Date(now.getTime()-86400_000)).execute();
      await trx.deleteFrom("slack_company_inbox").where("owner_id", "=", this.ownerId).where("state", "in", ["completed", "failed"])
        .where("updated_at", "<", new Date(now.getTime()-7*86400_000)).where("id", "not in", trx.selectFrom("slack_company_outbox").select("event_id").where("state", "in", ["pending", "sending"])) .execute();
      await trx.deleteFrom("slack_company_threads").where("owner_id", "=", this.ownerId).where("updated_at", "<", new Date(now.getTime()-30*86400_000))
        .where("scope_id", "not in", trx.selectFrom("slack_company_inbox").select("scope_id").where("scope_id", "is not", null)).execute();
    });
  }
  envelope(row: SlackInbox): SlackHomeEnvelope { return SlackHomeEnvelopeSchema.parse(typeof row.envelope === "string" ? JSON.parse(row.envelope) : row.envelope); }
}
