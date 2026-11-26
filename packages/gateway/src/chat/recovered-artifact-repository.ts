import {
  AgentAttachmentSchema,
  CanonicalChatIdSchema,
  CanonicalChatMessagePartSchema,
  CanonicalChatMessageSchema,
  CanonicalOwnerScopeSchema,
  type AgentAttachment,
} from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase } from "./database.js";
import { jsonb, messageSearchText, toMessage, type ChatOutboxEventType, type ChatOwner } from "./records.js";
import { lockRunCollaborationScope } from "./run-scope-lock.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
type Transact = <T>(fn: (trx: Executor) => Promise<T>) => Promise<T>;
type AppendOutbox = (
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
  revision: number,
  eventType: ChatOutboxEventType,
  payload?: Record<string, unknown>,
) => Promise<void>;

const SAFE_REF = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const MAX_MESSAGE_ATTACHMENTS = 8;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_PAGE = 500;
const encoded = new TextEncoder();

export interface RecoverableCodexRun {
  runId: string;
  chatId: string;
  owner: ChatOwner;
  conversationId: string;
  startedAt: Date;
  completedAt: Date;
}

export type RecoveredArtifactOutcome = "attached" | "already_attached" | "no_reply" | "reply_full";

/**
 * Attaches artifacts recovered after a run finished, such as images a Codex
 * run made before Matrix could capture them, to that run's final reply.
 */
export class ChatRecoveredArtifactRepository {
  constructor(
    private readonly kysely: Kysely<ChatDatabase>,
    private readonly transact: Transact,
    private readonly appendOutbox: AppendOutbox,
  ) {}

  /** Finished Codex runs in run-ID order, one bounded page after `afterRunId`. */
  async listFinishedCodexRuns(input: { afterRunId?: string; limit: number }): Promise<{
    runs: RecoverableCodexRun[];
    nextCursor: string | null;
  }> {
    const limit = z.number().int().min(1).max(MAX_PAGE).parse(input.limit);
    let query = this.kysely.selectFrom("chat_runs")
      .innerJoin("chat_run_adapter_state", "chat_run_adapter_state.run_id", "chat_runs.id")
      .innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .select([
        "chat_runs.id as run_id", "chat_runs.chat_id", "chat_runs.started_at", "chat_runs.completed_at",
        "chats.owner_type", "chats.owner_id", "chat_run_adapter_state.state",
      ])
      .where("chat_runs.driver_kind", "=", "codex")
      .where("chat_runs.status", "=", "completed")
      .where("chat_runs.started_at", "is not", null)
      .where("chat_runs.completed_at", "is not", null)
      .orderBy("chat_runs.id")
      .limit(limit);
    if (input.afterRunId) query = query.where("chat_runs.id", ">", SAFE_REF.parse(input.afterRunId));
    const rows = await query.execute();
    const runs: RecoverableCodexRun[] = [];
    for (const row of rows) {
      const state = row.state as { conversationId?: unknown } | null;
      const owner = CanonicalOwnerScopeSchema.safeParse({ type: row.owner_type, ownerId: row.owner_id });
      if (!owner.success || typeof state?.conversationId !== "string" || !row.started_at || !row.completed_at) continue;
      runs.push({
        runId: row.run_id,
        chatId: row.chat_id,
        owner: owner.data,
        conversationId: state.conversationId,
        startedAt: new Date(row.started_at),
        completedAt: new Date(row.completed_at),
      });
    }
    // The cursor is the last row read, kept or not, so a skipped row is not read again.
    return { runs, nextCursor: rows.length === limit ? rows.at(-1)!.run_id : null };
  }

  async attachToFinalReply(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    attachment: AgentAttachment;
    recoveredAt: Date;
  }): Promise<RecoveredArtifactOutcome> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const runId = SAFE_REF.parse(input.runId);
    const attachment = AgentAttachmentSchema.parse(input.attachment);
    if (!attachment.path) throw new TypeError("Recovered artifact needs an owner reference");
    const part = CanonicalChatMessagePartSchema.parse({
      type: "attachment_reference",
      attachmentId: attachment.id,
      kind: attachment.kind === "image" ? "image" : "file",
      label: attachment.label,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
      ownerReference: attachment.path,
      resource: { kind: "home", path: attachment.path },
    });
    const recoveredAt = input.recoveredAt.toISOString();
    return this.transact(async (trx) => {
      await lockRunCollaborationScope(trx, owner, chatId, runId);
      const chat = await trx.selectFrom("chats").select(["id", "revision"])
        .where("id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .forUpdate().executeTakeFirst();
      if (!chat) return "no_reply";
      const row = await trx.selectFrom("chat_messages").selectAll()
        .where("chat_id", "=", chatId).where("run_id", "=", runId)
        .where("role", "=", "assistant").where("state", "=", "committed")
        .orderBy("seq", "desc").limit(1).forUpdate().executeTakeFirst();
      if (!row) return "no_reply";
      const current = toMessage(row);
      const existing = current.parts.filter((candidate) => candidate.type === "attachment_reference");
      if (existing.some((candidate) => candidate.attachmentId === attachment.id)) return "already_attached";
      if (existing.length >= MAX_MESSAGE_ATTACHMENTS) return "reply_full";
      const next = CanonicalChatMessageSchema.parse({ ...current, parts: [...current.parts, part] });
      const byteCount = encoded.encode(JSON.stringify(next)).byteLength;
      if (byteCount > MAX_MESSAGE_BYTES) return "reply_full";
      await trx.updateTable("chat_messages").set({
        parts: jsonb(next.parts),
        byte_count: byteCount,
        search_text: messageSearchText(next),
      }).where("id", "=", next.id).execute();
      const inserted = await trx.insertInto("chat_attachments").values({
        id: attachment.id,
        chat_id: chatId,
        message_id: next.id,
        kind: attachment.kind === "image" ? "image" : "file",
        label: attachment.label,
        mime_type: attachment.mimeType ?? null,
        size_bytes: attachment.sizeBytes ?? null,
        owner_reference: attachment.path,
        created_at: recoveredAt,
      }).onConflict((conflict) => conflict.column("id").doNothing()).returning("id").executeTakeFirst();
      // The ID is content-addressed per session; one already stored elsewhere
      // means this run's artifact was captured before, so leave both alone.
      if (!inserted) throw new RecoveredArtifactConflict();
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({ revision, updated_at: recoveredAt }).where("id", "=", chatId).execute();
      await this.appendOutbox(trx, owner, chatId, revision, "chat.updated", { messageId: next.id, seq: next.seq });
      return "attached";
    }).catch((error: unknown) => {
      if (error instanceof RecoveredArtifactConflict) return "already_attached";
      throw error;
    });
  }
}

/** Rolls the transaction back when the attachment row already exists. */
class RecoveredArtifactConflict extends Error {
  constructor() {
    super("Recovered artifact is already stored");
    this.name = "RecoveredArtifactConflict";
  }
}
