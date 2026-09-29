import { randomUUID } from "node:crypto";
import { CanonicalChatMessageSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import type { CodexImportMessage } from "@matrix-os/contracts/codex-chat-import";
import { sql, type Kysely } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase } from "./database.js";
import type { ChatRepository } from "./repository.js";
import { jsonb, messageSearchText, type ChatOwner } from "./records.js";

const MAX_MESSAGES = 10_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_MESSAGES = 50;
const MAX_OPEN_IMPORTS_PER_OWNER = 8;
const STAGING_TTL_MS = 24 * 60 * 60_000;
const SourceIdSchema = z.uuid();
const BeginSchema = z.object({
  sourceId: SourceIdSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(160),
}).strict();
const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(20_000).refine((text) => Buffer.byteLength(text, "utf8") <= 64 * 1024),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
const AppendSchema = z.object({
  startSeq: z.number().int().min(1).max(MAX_MESSAGES),
  messages: z.array(MessageSchema).min(1).max(MAX_BATCH_MESSAGES),
}).strict();
const CompleteSchema = z.object({ messageCount: z.number().int().min(1).max(MAX_MESSAGES) }).strict();

export class CodexChatImportError extends Error {
  constructor(readonly code: "conflict" | "not_found" | "too_large" | "incomplete") {
    super(code);
  }
}

function personalOwner(input: ChatOwner): string {
  const owner = CanonicalOwnerScopeSchema.parse(input);
  if (owner.type !== "personal") throw new CodexChatImportError("not_found");
  return owner.ownerId;
}

function state(job: { status: "uploading" | "verified"; next_seq: number; chat_id: string | null }) {
  return { status: job.status, nextSeq: Number(job.next_seq),
    ...(job.chat_id ? { chatId: job.chat_id } : {}) };
}

export class CodexChatImporter {
  private readonly db: Kysely<ChatDatabase>;
  constructor(private readonly repository: ChatRepository) {
    this.db = repository.kysely;
  }

  async sweepExpired(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STAGING_TTL_MS);
    return this.db.transaction().execute(async (trx) => {
      const expired = await trx.selectFrom("chat_import_jobs")
        .select(["owner_id", "source_id"])
        .where("status", "=", "uploading").where("updated_at", "<", cutoff)
        .orderBy("updated_at").limit(100).forUpdate().execute();
      for (const job of expired) {
        await trx.deleteFrom("chat_import_jobs").where("owner_id", "=", job.owner_id)
          .where("source_id", "=", job.source_id).execute();
      }
      return expired.length;
    });
  }

  async begin(ownerInput: ChatOwner, input: { sourceId: string; sourceHash: string; title: string }) {
    const ownerId = personalOwner(ownerInput);
    const request = BeginSchema.parse(input);
    await this.sweepExpired();
    return this.db.transaction().execute(async (trx) => {
      const existingImport = await trx.selectFrom("chat_legacy_imports").selectAll()
        .where("owner_type", "=", "personal").where("owner_id", "=", ownerId)
        .where("source_kind", "=", "codex_jsonl").where("source_id", "=", request.sourceId)
        .executeTakeFirst();
      if (existingImport) {
        if (existingImport.source_hash !== request.sourceHash) throw new CodexChatImportError("conflict");
        const liveChat = await trx.selectFrom("chats").select(["id", "message_count"])
          .where("id", "=", existingImport.chat_id).where("owner_type", "=", "personal")
          .where("owner_id", "=", ownerId).executeTakeFirst();
        if (!liveChat) throw new CodexChatImportError("conflict");
        return { status: "verified" as const,
          nextSeq: Number(liveChat.message_count) + 1, chatId: existingImport.chat_id };
      }
      // Serialize per-owner admission so concurrent starts cannot exceed the
      // eight-job staging budget under PostgreSQL READ COMMITTED.
      await sql`SELECT pg_advisory_xact_lock(53901, hashtext(${ownerId}))`.execute(trx);
      const openJobs = await trx.selectFrom("chat_import_jobs").select("source_id")
        .where("owner_id", "=", ownerId).where("status", "=", "uploading")
        .limit(MAX_OPEN_IMPORTS_PER_OWNER + 1).execute();
      if (openJobs.length >= MAX_OPEN_IMPORTS_PER_OWNER
        && !openJobs.some((job) => job.source_id === request.sourceId)) {
        throw new CodexChatImportError("too_large");
      }
      await trx.insertInto("chat_import_jobs").values({
        owner_type: "personal", owner_id: ownerId, source_id: request.sourceId,
        source_hash: request.sourceHash, title: request.title, status: "uploading",
        chat_id: null, next_seq: 1, total_bytes: 0,
      }).onConflict((oc) => oc.columns(["owner_id", "source_id"]).doNothing()).execute();
      const job = await trx.selectFrom("chat_import_jobs").selectAll()
        .where("owner_id", "=", ownerId).where("source_id", "=", request.sourceId)
        .forUpdate().executeTakeFirstOrThrow();
      if (job.source_hash !== request.sourceHash) {
        throw new CodexChatImportError("conflict");
      }
      if (job.title !== request.title && job.status === "uploading") {
        await trx.updateTable("chat_import_jobs").set({ title: request.title,
          updated_at: sql`now()` }).where("owner_id", "=", ownerId)
          .where("source_id", "=", request.sourceId).execute();
      }
      return state(job);
    });
  }

  async append(ownerInput: ChatOwner, sourceIdInput: string,
    input: { startSeq: number; messages: CodexImportMessage[] }) {
    const ownerId = personalOwner(ownerInput);
    const sourceId = SourceIdSchema.parse(sourceIdInput);
    const batch = AppendSchema.parse(input);
    return this.db.transaction().execute(async (trx) => {
      const job = await trx.selectFrom("chat_import_jobs").selectAll()
        .where("owner_id", "=", ownerId).where("source_id", "=", sourceId)
        .forUpdate().executeTakeFirst();
      if (!job) throw new CodexChatImportError("not_found");
      if (job.status !== "uploading") throw new CodexChatImportError("conflict");
      const nextSeq = Number(job.next_seq);
      if (batch.startSeq < nextSeq) {
        const prior = await trx.selectFrom("chat_import_messages").selectAll()
          .where("owner_id", "=", ownerId).where("source_id", "=", sourceId)
          .where("seq", ">=", batch.startSeq)
          .where("seq", "<", batch.startSeq + batch.messages.length)
          .orderBy("seq").execute();
        if (prior.length !== batch.messages.length || prior.some((row, index) =>
          Number(row.seq) !== batch.startSeq + index || row.role !== batch.messages[index]?.role
          || row.text !== batch.messages[index]?.text
          || new Date(row.created_at).toISOString() !== new Date(batch.messages[index]!.createdAt).toISOString())) {
          throw new CodexChatImportError("conflict");
        }
        return { nextSeq };
      }
      if (batch.startSeq !== nextSeq) throw new CodexChatImportError("incomplete");
      const bytes = batch.messages.reduce((total, message) => total + Buffer.byteLength(message.text, "utf8"), 0);
      if (nextSeq + batch.messages.length - 1 > MAX_MESSAGES || Number(job.total_bytes) + bytes > MAX_TOTAL_BYTES) {
        throw new CodexChatImportError("too_large");
      }
      await trx.insertInto("chat_import_messages").values(batch.messages.map((message, index) => ({
        owner_id: ownerId, source_id: sourceId, seq: nextSeq + index, role: message.role,
        text: message.text, created_at: message.createdAt,
      }))).execute();
      await trx.updateTable("chat_import_jobs").set({ next_seq: nextSeq + batch.messages.length,
        total_bytes: Number(job.total_bytes) + bytes, updated_at: sql`now()` })
        .where("owner_id", "=", ownerId).where("source_id", "=", sourceId).execute();
      return { nextSeq: nextSeq + batch.messages.length };
    });
  }

  async complete(ownerInput: ChatOwner, sourceIdInput: string, input: { messageCount: number }) {
    const ownerId = personalOwner(ownerInput);
    const sourceId = SourceIdSchema.parse(sourceIdInput);
    const request = CompleteSchema.parse(input);
    return this.repository.withTransaction(async (transactionRepository) => {
      const trx = transactionRepository.kysely;
      const job = await trx.selectFrom("chat_import_jobs").selectAll()
        .where("owner_id", "=", ownerId).where("source_id", "=", sourceId)
        .forUpdate().executeTakeFirst();
      if (!job) {
        const imported = await trx.selectFrom("chat_legacy_imports").select("chat_id")
          .where("owner_type", "=", "personal").where("owner_id", "=", ownerId)
          .where("source_kind", "=", "codex_jsonl").where("source_id", "=", sourceId)
          .executeTakeFirst();
        if (!imported) throw new CodexChatImportError("not_found");
        const chat = await trx.selectFrom("chats").select("message_count")
          .where("id", "=", imported.chat_id).where("owner_type", "=", "personal")
          .where("owner_id", "=", ownerId).executeTakeFirst();
        if (!chat || Number(chat.message_count) !== request.messageCount) {
          throw new CodexChatImportError("conflict");
        }
        return { chatId: imported.chat_id, messageCount: request.messageCount };
      }
      if (job.status === "verified") {
        if (!job.chat_id || Number(job.next_seq) !== request.messageCount + 1) {
          throw new CodexChatImportError("conflict");
        }
        const liveChat = await trx.selectFrom("chats").select("id")
          .where("id", "=", job.chat_id).where("owner_type", "=", "personal")
          .where("owner_id", "=", ownerId).executeTakeFirst();
        if (!liveChat) throw new CodexChatImportError("conflict");
        return { chatId: job.chat_id, messageCount: request.messageCount };
      }
      if (Number(job.next_seq) !== request.messageCount + 1) throw new CodexChatImportError("incomplete");
      const staged = await trx.selectFrom("chat_import_messages").selectAll()
        .where("owner_id", "=", ownerId).where("source_id", "=", sourceId)
        .orderBy("seq").execute();
      if (staged.length !== request.messageCount || staged.some((row, index) => Number(row.seq) !== index + 1)) {
        throw new CodexChatImportError("incomplete");
      }
      if (staged[0]?.role !== "user") throw new CodexChatImportError("incomplete");
      const chatId = `chat_${randomUUID().replaceAll("-", "")}`;
      const firstAt = new Date(staged[0]!.created_at).toISOString();
      const lastAt = new Date(staged.at(-1)!.created_at).toISOString();
      await trx.insertInto("chats").values({
        id: chatId, owner_type: "personal", owner_id: ownerId,
        create_request_id: `req_codex_${sourceId.replaceAll("-", "")}`,
        project_id: null, title: job.title, title_manual: false,
        lifecycle: "active", attention: "none", revision: 1,
        message_count: staged.length, collaboration: null, user_state: null,
        shell_state: null, fork_provenance: null,
        last_message_preview: staged.at(-1)!.text.slice(0, 280), current_selection: null,
        bound_driver_kind: null, bound_instance_id: null, bound_at_turn_id: null,
        activity_at: lastAt, created_at: firstAt, updated_at: lastAt,
      }).execute();
      await trx.insertInto("chat_members").values({ chat_id: chatId,
        principal_type: "user", principal_id: ownerId, role: "owner" }).execute();
      await trx.insertInto("chat_user_state").values({ chat_id: chatId,
        principal_id: ownerId, read_through_seq: 0, pinned: false,
        muted: false, attention_acknowledged_at: null, last_opened_at: null }).execute();
      const turns: Array<{ id: string; inputMessageId: string; baseMessageSeq: number;
        createdAt: string; updatedAt: string }> = [];
      let activeTurn: (typeof turns)[number] | undefined;
      const messages = staged.map((row, index) => {
        const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
        const createdAt = new Date(row.created_at).toISOString();
        if (row.role === "user") {
          activeTurn = { id: `cturn_${randomUUID().replaceAll("-", "")}`,
            inputMessageId: messageId, baseMessageSeq: index,
            createdAt, updatedAt: createdAt };
          turns.push(activeTurn);
        } else if (activeTurn) {
          activeTurn.updatedAt = createdAt;
        }
        return CanonicalChatMessageSchema.parse({
          id: messageId, chatId, seq: index + 1, turnId: activeTurn!.id,
          role: row.role, state: "committed", actorId: row.role === "user" ? ownerId : undefined,
          purpose: row.role === "user" ? "ai_request" : "assistant",
          parts: [{ type: "text", text: row.text }], createdAt,
        });
      });
      for (let offset = 0; offset < messages.length; offset += 100) {
        await trx.insertInto("chat_messages").values(messages.slice(offset, offset + 100).map((message) => ({
          id: message.id, chat_id: chatId, seq: message.seq, role: message.role,
          state: message.state, purpose: message.purpose ?? "system",
          turn_id: message.turnId!, run_id: null, actor_id: message.actorId ?? null,
          parts: jsonb(message.parts), byte_count: Buffer.byteLength(JSON.stringify(message.parts), "utf8"),
          search_text: messageSearchText(message), created_at: message.createdAt,
        }))).execute();
      }
      for (let offset = 0; offset < turns.length; offset += 100) {
        await trx.insertInto("chat_turns").values(turns.slice(offset, offset + 100).map((turn) => ({
          id: turn.id, chat_id: chatId,
          client_request_id: `req_codex_${sourceId.replaceAll("-", "")}_${turn.baseMessageSeq + 1}`,
          base_message_seq: turn.baseMessageSeq, input_message_id: turn.inputMessageId,
          status: "completed" as const, created_at: turn.createdAt, updated_at: turn.updatedAt,
        }))).execute();
      }
      await trx.insertInto("chat_legacy_imports").values({
        owner_type: "personal", owner_id: ownerId, source_kind: "codex_jsonl", source_id: sourceId,
        chat_id: chatId, source_hash: job.source_hash, import_version: 1,
        verification_status: "verified",
      }).execute();
      await transactionRepository.appendOutboxEvent({ type: "personal", ownerId }, chatId, 1,
        "chat.created", { importedMessages: messages.length });
      await trx.deleteFrom("chat_import_messages")
        .where("owner_id", "=", ownerId).where("source_id", "=", sourceId).execute();
      await trx.deleteFrom("chat_import_jobs")
        .where("owner_id", "=", ownerId).where("source_id", "=", sourceId).execute();
      return { chatId, messageCount: messages.length };
    });
  }
}
