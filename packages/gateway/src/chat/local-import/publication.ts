/** Verified original -> private staging -> one owner-Postgres canonical publication transaction. */
import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction, type Selectable } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatMessageSchema, type CanonicalChatMessage } from "@matrix-os/contracts";
import type { ImportProjection } from "@matrix-os/contracts/local-chat-import";
import type { ChatRepository } from "../repository.js";
import type { ChatDatabase } from "../database.js";
import type { LocalChatImportJobsTable } from "../import-database.js";
import { jsonb, messageSearchText, parseJson, type ChatOwner } from "../records.js";
import { ChatArchiveVerificationError, verifyLocalChatArchive } from "./archive-verification.js";
import { projectImportedChatRecord } from "./canonical-projection.js";
import { LocalChatImportJobError } from "./jobs.js";
const LEASE_MS = 120_000;
const MAX_RECORDS = 100_000;
const uuid = () => randomUUID();
const id = (prefix: string) => `${prefix}_${uuid().replaceAll("-", "")}`;
export interface LocalPublicationStorage {
  putObject(key: string, bytes: Uint8Array, mimeType: string): Promise<unknown>;
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
export class LocalChatImportPublisher {
  constructor(private readonly options: { repository: ChatRepository; storage: LocalPublicationStorage;
    runtimeOwnerId: string; fetchImpl?: typeof fetch }) {}
  private get db() { return this.options.repository.kysely; }
  private owner(owner: ChatOwner) {
    if (owner.type !== "personal" || owner.ownerId !== this.options.runtimeOwnerId) throw new LocalChatImportJobError("not_found");
    return owner.ownerId;
  }
  private async ownedJob(owner: ChatOwner, jobId: string) {
    const ownerId = this.owner(owner);
    if (!z.uuid().safeParse(jobId).success) throw new LocalChatImportJobError("invalid");
    const job = await this.db.selectFrom("local_chat_import_jobs").selectAll().where("id", "=", jobId).where("owner_id", "=", ownerId).executeTakeFirst();
    if (!job) throw new LocalChatImportJobError("not_found"); return job;
  }
  private async livePublished(owner: ChatOwner, job: Selectable<LocalChatImportJobsTable>) {
    if (job.status !== "published" || !job.chat_id || !await this.options.repository.get(owner, job.chat_id)) throw new LocalChatImportJobError("not_found");
    return job.chat_id;
  }
  async archiveUrl(owner: ChatOwner, jobId: string) {
    const job = await this.ownedJob(owner, jobId); await this.livePublished(owner, job);
    return { url: await this.options.storage.getPresignedGetUrl(job.object_key, 300), sizeBytes: Number(job.raw_size), sha256: job.source_hash };
  }
  async assetUrl(owner: ChatOwner, chatId: string, assetId: string) {
    this.owner(owner);
    if (!z.uuid().safeParse(assetId).success || !await this.options.repository.get(owner, chatId)) throw new LocalChatImportJobError("not_found");
    const asset = await this.db.selectFrom("local_chat_import_assets").selectAll().where("id", "=", assetId).where("chat_id", "=", chatId)
      .where("status", "=", "ready").where("cleanup_pending", "=", false).executeTakeFirst();
    if (!asset) throw new LocalChatImportJobError("not_found");
    const occurrence = await this.db.selectFrom("chat_messages").select("id").where("chat_id", "=", chatId)
      .where(sql<boolean>`parts @> ${JSON.stringify([{ type: "import_reference", assetId }])}::jsonb`).limit(1).executeTakeFirst();
    if (!occurrence) throw new LocalChatImportJobError("not_found");
    return { url: await this.options.storage.getPresignedGetUrl(asset.object_key, 300), mimeType: asset.mime_type, sizeBytes: Number(asset.size_bytes), sha256: asset.sha256 };
  }
  /** Same-origin streaming keeps signed storage URLs out of the Electron renderer CSP. */
  async assetContent(owner: ChatOwner, chatId: string, assetId: string, requestSignal?: AbortSignal): Promise<Response> {
    const asset = await this.assetUrl(owner, chatId, assetId);
    const url = new URL(asset.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new LocalChatImportJobError("unavailable");
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(requestSignal ? [requestSignal] : [])]);
    // This URL comes only from the trusted server-side object-store broker, never a source record or client.
    const response = await (this.options.fetchImpl ?? fetch)(url, { signal, redirect: "error" });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new LocalChatImportJobError("unavailable"); }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.sizeBytes)) {
      await response.body.cancel(); throw new LocalChatImportJobError("unavailable");
    }
    const hash = createHash("sha256"); let size = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > asset.sizeBytes || size > 64 * 1024 * 1024) throw new LocalChatImportJobError("unavailable");
        hash.update(chunk); controller.enqueue(chunk);
      },
      flush() { if (size !== asset.sizeBytes || hash.digest("hex") !== asset.sha256) throw new LocalChatImportJobError("unavailable"); },
    }));
    return new Response(body, { headers: { "Content-Type": asset.mimeType, "Content-Length": String(asset.sizeBytes),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      ...(asset.mimeType.startsWith("image/") ? {} : { "Content-Disposition": "attachment; filename=imported-content" }) } });
  }
  /** Called by the owning runtime's recurring lifecycle; failures retain exact-key retry intent. */
  async sweepPrivateArtifacts(): Promise<number> {
    await this.db.transaction().execute(async trx => {
      const orphanJobs = await trx.selectFrom("local_chat_import_jobs").select("id").where("owner_id", "=", this.options.runtimeOwnerId)
        .where("status", "=", "published").where("chat_id", "is", null).limit(100).forUpdate().execute();
      for (const job of orphanJobs) {
        await trx.updateTable("local_chat_import_jobs").set({ status: "cancelled", cleanup_pending: true, updated_at: new Date() }).where("id", "=", job.id).execute();
      }
      const terminal = await trx.selectFrom("local_chat_import_jobs").select("id").where("owner_id", "=", this.options.runtimeOwnerId)
        .where("status", "in", ["failed", "cancelled", "expired"])
        .where(sql<boolean>`(EXISTS (SELECT 1 FROM local_chat_import_assets a WHERE a.job_id=local_chat_import_jobs.id AND a.cleanup_pending=FALSE AND a.chat_id IS NULL) OR EXISTS (SELECT 1 FROM local_chat_import_records r WHERE r.job_id=local_chat_import_jobs.id))`)
        .limit(100).execute();
      if (terminal.length) {
        const jobIds = terminal.map(job => job.id);
        await trx.updateTable("local_chat_import_assets").set({ cleanup_pending: true }).where("job_id", "in", jobIds).where("chat_id", "is", null).execute();
        await trx.deleteFrom("local_chat_import_records").where("job_id", "in", jobIds).execute();
      }
    });
    const pending = await this.db.selectFrom("local_chat_import_assets").innerJoin("local_chat_import_jobs", "local_chat_import_jobs.id", "local_chat_import_assets.job_id")
      .select(["local_chat_import_assets.id", "local_chat_import_assets.object_key"])
      .where("local_chat_import_jobs.owner_id", "=", this.options.runtimeOwnerId).where("local_chat_import_assets.cleanup_pending", "=", true)
      .orderBy("local_chat_import_assets.created_at").limit(100).execute();
    let removed = 0;
    for (const asset of pending) {
      try {
        await this.options.storage.deleteObject(asset.object_key);
        const deleted = await this.db.deleteFrom("local_chat_import_assets").where("id", "=", asset.id).where("cleanup_pending", "=", true).returning("id").executeTakeFirst();
        if (deleted) removed++;
      } catch (error: unknown) { console.warn("[chat/import] private asset cleanup pending", error instanceof Error ? error.name : "UnknownError"); }
    }
    return removed;
  }
  private async lock(trx: Transaction<ChatDatabase>, jobId: string, token: string) {
    const job = await trx.selectFrom("local_chat_import_jobs").selectAll().where("id", "=", jobId).forUpdate().executeTakeFirst();
    if (!job || job.status !== "verifying" || job.lease_token !== token || !job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= Date.now()) throw new LocalChatImportJobError("conflict");
    await trx.updateTable("local_chat_import_jobs").set({ lease_expires_at: new Date(Date.now() + LEASE_MS), updated_at: new Date() }).where("id", "=", jobId).where("lease_token", "=", token).execute();
    return job;
  }
  async publish(owner: ChatOwner, jobId: string, signal?: AbortSignal): Promise<{ chatId: string; messageCount: number }> {
    const original = await this.ownedJob(owner, jobId);
    if (original.status === "published") {
      const chatId = await this.livePublished(owner, original); const chat = await this.options.repository.get(owner, chatId);
      return { chatId, messageCount: chat!.chat.messageCount };
    }
    const token = uuid();
    const job = await this.db.transaction().execute(async trx => {
      const current = await trx.selectFrom("local_chat_import_jobs").selectAll().where("id", "=", jobId).where("owner_id", "=", this.owner(owner)).forUpdate().executeTakeFirstOrThrow();
      const recoverable = current.status === "verifying" && current.lease_expires_at && new Date(current.lease_expires_at).getTime() <= Date.now();
      if (current.status !== "uploaded" && !recoverable) throw new LocalChatImportJobError("conflict");
      if (new Date(current.expires_at).getTime() <= Date.now()) throw new LocalChatImportJobError("expired");
      await trx.updateTable("local_chat_import_jobs").set({ status: "verifying", lease_token: token, lease_expires_at: new Date(Date.now() + LEASE_MS), updated_at: new Date() }).where("id", "=", jobId).execute();
      await trx.deleteFrom("local_chat_import_records").where("job_id", "=", jobId).execute();
      return current;
    });
    try {
      await verifyLocalChatArchive({ harness: job.harness, sourceId: job.source_id, ...(job.source_agent_id ? { sourceAgentId: job.source_agent_id } : {}),
        expectedSize: Number(job.raw_size), expectedSha256: job.source_hash, signal, fetchImpl: this.options.fetchImpl,
        getUrl: () => this.options.storage.getPresignedGetUrl(job.object_key, 3600), stage: event => this.stage(job, token, event) });
      if (signal?.aborted) throw new ChatArchiveVerificationError("cancelled");
      return await this.commit(owner, jobId, token);
    } catch (error: unknown) {
      await this.db.transaction().execute(async trx => {
        const changed = await trx.updateTable("local_chat_import_jobs").set({ status: "failed", cleanup_pending: true,
          error_code: error instanceof ChatArchiveVerificationError ? error.code : "projection_failed", lease_token: null, lease_expires_at: null, updated_at: new Date() })
          .where("id", "=", jobId).where("status", "=", "verifying").where("lease_token", "=", token).returning("id").executeTakeFirst();
        if (changed) {
          await trx.updateTable("local_chat_import_assets").set({ cleanup_pending: true }).where("job_id", "=", jobId).where("chat_id", "is", null).execute();
          await trx.deleteFrom("local_chat_import_records").where("job_id", "=", jobId).execute();
        }
      });
      throw error;
    }
  }
  private async asset(job: Selectable<LocalChatImportJobsTable>, token: string, input: { bytes: Uint8Array; sha256: string; mimeType: string }) {
    if (input.bytes.byteLength > 64 * 1024 * 1024 || createHash("sha256").update(input.bytes).digest("hex") !== input.sha256) throw new LocalChatImportJobError("invalid");
    const asset = await this.db.transaction().execute(async trx => {
      await this.lock(trx, job.id, token);
      const assetId = uuid(); const prefix = job.object_key.slice(0, -"original.jsonl".length);
      await trx.insertInto("local_chat_import_assets").values({ id: assetId, job_id: job.id, chat_id: null, sha256: input.sha256,
        mime_type: input.mimeType, size_bytes: input.bytes.byteLength, object_key: `${prefix}assets/${assetId}`, status: "pending", cleanup_pending: false })
        .onConflict(oc => oc.columns(["job_id", "sha256", "mime_type"]).doNothing()).execute();
      const row = await trx.selectFrom("local_chat_import_assets").selectAll().where("job_id", "=", job.id).where("sha256", "=", input.sha256).where("mime_type", "=", input.mimeType).executeTakeFirstOrThrow();
      if (row.cleanup_pending || Number(row.size_bytes) !== input.bytes.byteLength) throw new LocalChatImportJobError("conflict"); return row;
    });
    if (asset.status !== "ready") {
      await this.options.storage.putObject(asset.object_key, input.bytes, input.mimeType);
      await this.db.transaction().execute(async trx => { await this.lock(trx, job.id, token);
        await trx.updateTable("local_chat_import_assets").set({ status: "ready" }).where("id", "=", asset.id).where("cleanup_pending", "=", false).execute(); });
    }
    return { assetId: asset.id };
  }
  private async stage(job: Selectable<LocalChatImportJobsTable>, token: string, event: ImportProjection) {
    // Malformed bytes and unknown records are already preserved verbatim in the private original.
    if (!event.conversation.sessionId) return;
    const rows = await projectImportedChatRecord(event, { storeAsset: input => this.asset(job, token, input) });
    await this.db.transaction().execute(async trx => {
      await this.lock(trx, job.id, token);
      if (!rows.length) return;
      const count = await trx.selectFrom("local_chat_import_records").select(trx.fn.countAll<string>().as("count")).where("job_id", "=", job.id).executeTakeFirstOrThrow();
      if (Number(count.count) + rows.length > MAX_RECORDS) throw new ChatArchiveVerificationError("projection_limit");
      let offset = event.source.offset;
      if (rows[0]!.mode === "replace_mirror") {
        const prior = await trx.selectFrom("local_chat_import_records").select("source_offset").where("job_id", "=", job.id).where("logical_key", "=", rows[0]!.logicalKey).orderBy("source_offset").executeTakeFirst();
        if (prior) offset = Number(prior.source_offset);
        await trx.deleteFrom("local_chat_import_records").where("job_id", "=", job.id).where("logical_key", "=", rows[0]!.logicalKey).execute();
      }
      await trx.insertInto("local_chat_import_records").values(rows.map((row, chunk) => ({ job_id: job.id, record_key: row.recordKey, logical_key: row.logicalKey,
        source_offset: offset, source_block: (event.source.blockIndex ?? 0) * 2 + (event.kind === "tool_result" ? 1 : 0), chunk, role: row.role, parts: jsonb(row.parts), created_at: row.createdAt ?? job.created_at })))
        .onConflict(oc => oc.columns(["job_id", "record_key"]).doNothing()).execute();
    });
  }
  private async commit(owner: ChatOwner, jobId: string, token: string) {
    return this.options.repository.withTransaction(async repo => {
      const trx = repo.kysely as Transaction<ChatDatabase>;
      const job = await this.lock(trx, jobId, token);
      if (job.owner_id !== this.owner(owner)) throw new LocalChatImportJobError("not_found");
      const stats = await trx.selectFrom("local_chat_import_records").select(trx.fn.countAll<string>().as("count")).where("job_id", "=", jobId).executeTakeFirstOrThrow();
      const count = Number(stats.count);
      if (!count || count > MAX_RECORDS) throw new ChatArchiveVerificationError("projection_limit");
      const chatId = id("chat"); const createdAt = new Date(job.created_at).toISOString();
      await trx.insertInto("chats").values({ id: chatId, owner_type: "personal", owner_id: job.owner_id, create_request_id: `req_import_${job.id.replaceAll("-", "")}`,
        project_id: null, title: job.title, title_manual: false, lifecycle: "active", attention: "none", revision: 1, message_count: count,
        collaboration: null, user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null, current_selection: null,
        bound_driver_kind: null, bound_instance_id: null, bound_at_turn_id: null, activity_at: createdAt, created_at: createdAt, updated_at: createdAt }).execute();
      await trx.insertInto("chat_members").values({ chat_id: chatId, principal_type: "user", principal_id: job.owner_id, role: "owner" }).execute();
      await trx.insertInto("chat_user_state").values({ chat_id: chatId, principal_id: job.owner_id, read_through_seq: 0, pinned: false, muted: false,
        attention_acknowledged_at: null, last_opened_at: null }).execute();
      let seq = 0;
      let cursor: { offset: number; block: number; chunk: number } | undefined;
      let turn: { id: string; inputId: string; logicalKey: string; firstAt: string; lastAt: string; baseSeq: number } | undefined;
      let lastMessage: CanonicalChatMessage | undefined;
      const saveTurn = async () => {
        if (!turn) return;
        await trx.insertInto("chat_turns").values({ id: turn.id, chat_id: chatId, client_request_id: `req_import_turn_${turn.id}`,
          base_message_seq: turn.baseSeq, input_message_id: turn.inputId, status: "completed", created_at: turn.firstAt, updated_at: turn.lastAt }).execute();
      };
      for (;;) {
        let query = trx.selectFrom("local_chat_import_records").selectAll().where("job_id", "=", jobId);
        if (cursor) query = query.where(sql<boolean>`(source_offset,source_block,chunk) > (${cursor.offset},${cursor.block},${cursor.chunk})`);
        const page = await query.orderBy("source_offset").orderBy("source_block").orderBy("chunk").limit(100).execute();
        if (!page.length) break;
        const messages = page.map(row => {
          const messageId = id("msg"); const at = new Date(row.created_at).toISOString();
          // Human messages start historical Turns. Continuation chunks retain the same input relationship.
          return { row, messageId, at };
        });
        for (const { row, messageId, at } of messages) {
          const newHuman = row.role === "user" && (!turn || row.logical_key !== turn.logicalKey || lastMessage?.role !== "user");
          if (newHuman) { await saveTurn(); turn = { id: id("cturn"), inputId: messageId, logicalKey: row.logical_key, firstAt: at, lastAt: at, baseSeq: seq }; }
          if (turn) turn.lastAt = at;
          const message = CanonicalChatMessageSchema.parse({ id: messageId, chatId, seq: ++seq, role: row.role, state: "committed", createdAt: at,
            ...(turn ? { turnId: turn.id } : {}), ...(row.role === "user" ? { actorId: job.owner_id } : {}),
            purpose: row.role === "user" ? "ai_request" : row.role === "assistant" ? "assistant" : "system", parts: parseJson(row.parts) });
          await trx.insertInto("chat_messages").values({ id: message.id, chat_id: chatId, seq: message.seq, role: message.role, state: "committed",
            turn_id: message.turnId ?? null, run_id: null, actor_id: message.actorId ?? null, purpose: message.purpose ?? "system",
            parts: jsonb(message.parts), byte_count: Buffer.byteLength(JSON.stringify(message.parts)), search_text: messageSearchText(message), created_at: message.createdAt }).execute();
          lastMessage = message;
        }
        const last = page.at(-1)!; cursor = { offset: Number(last.source_offset), block: last.source_block, chunk: last.chunk };
      }
      await saveTurn();
      await trx.updateTable("chats").set({ last_message_preview: lastMessage ? messageSearchText(lastMessage).slice(0, 280) : null,
        activity_at: lastMessage?.createdAt ?? createdAt, updated_at: lastMessage?.createdAt ?? createdAt }).where("id", "=", chatId).execute();
      await trx.updateTable("local_chat_import_assets").set({ chat_id: chatId }).where("job_id", "=", jobId).where("status", "=", "ready")
        .where(sql<boolean>`EXISTS (SELECT 1 FROM local_chat_import_records r WHERE r.job_id = ${jobId} AND r.parts @> jsonb_build_array(jsonb_build_object('type','import_reference','assetId',local_chat_import_assets.id::text)))`).execute();
      await trx.updateTable("local_chat_import_assets").set({ cleanup_pending: true }).where("job_id", "=", jobId).where("chat_id", "is", null).execute();
      await trx.updateTable("local_chat_import_jobs").set({ status: "published", chat_id: chatId, lease_token: null, lease_expires_at: null, updated_at: new Date() })
        .where("id", "=", jobId).where("lease_token", "=", token).execute();
      await trx.deleteFrom("local_chat_import_records").where("job_id", "=", jobId).execute();
      await repo.appendOutboxEvent(owner, chatId, 1, "chat.created", { importedMessages: count });
      return { chatId, messageCount: count };
    });
  }
}
