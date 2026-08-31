import {
  CanonicalChatIdSchema,
  CanonicalChatMessageSchema,
  CanonicalChatQueuedTurnIdSchema,
  CanonicalChatQueuedTurnSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatTurnIdSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessage,
  type CanonicalChatQueuedTurn,
  type CanonicalSteerChatRunRequest,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import {
  ChatConflictError,
  ChatNotFoundError,
  ChatRunNotActiveError,
} from "./errors.js";
import {
  asIso,
  jsonb,
  messageSearchText,
  toMessage,
  type ChatOutboxEventType,
  type ChatOwner,
} from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;

export interface BeginSteerInput {
  chatId: string;
  runId: string;
  expectedTurnId: string;
  steerId: string;
  messageId: string;
  clientRequestId: string;
  parts: CanonicalSteerChatRunRequest["parts"];
  createdAt: string;
}

export interface BeginQueuedTurnSteerInput extends Omit<BeginSteerInput, "parts"> {
  queuedTurnId: string;
  baseRevision: number;
}

export type BegunSteer =
  | { status: "accepted"; message: CanonicalChatMessage; alreadyRequested: true }
  | { status: "pending" | "failed"; alreadyRequested: boolean };

export type BegunQueuedTurnSteer =
  | { status: "accepted"; message: CanonicalChatMessage; alreadyRequested: true }
  | { status: "pending"; parts: CanonicalChatQueuedTurn["parts"]; alreadyRequested: boolean }
  | { status: "failed"; alreadyRequested: boolean };

function preview(message: CanonicalChatMessage): string | null {
  const text = message.parts.find((part) => part.type === "text");
  return text?.type === "text" ? text.text.slice(0, 280) : null;
}

export class ChatSteeringRepository {
  constructor(
    private readonly transact: <T>(fn: (executor: Executor) => Promise<T>) => Promise<T>,
    private readonly appendOutbox: (
      executor: Executor,
      owner: ChatOwner,
      chatId: string,
      revision: number,
      eventType: ChatOutboxEventType,
      payload: Record<string, unknown>,
    ) => Promise<void>,
  ) {}

  async begin(ownerInput: ChatOwner, input: BeginSteerInput): Promise<BegunSteer> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const runId = CanonicalChatRunIdSchema.parse(input.runId);
    const turnId = CanonicalChatTurnIdSchema.parse(input.expectedTurnId);
    const clientRequestId = CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const createdAt = new Date(input.createdAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await trx.selectFrom("chats").selectAll()
        .where("id", "=", chatId)
        .where("owner_type", "=", owner.type)
        .where("owner_id", "=", owner.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!chat) throw new ChatNotFoundError(chatId);
      const duplicate = await trx.selectFrom("chat_run_steers").selectAll()
        .where("chat_id", "=", chatId)
        .where("client_request_id", "=", clientRequestId)
        .executeTakeFirst();
      if (duplicate) {
        if (duplicate.status !== "accepted") {
          return { status: duplicate.status, alreadyRequested: true };
        }
        const message = await trx.selectFrom("chat_messages").selectAll()
          .where("id", "=", duplicate.message_id)
          .executeTakeFirstOrThrow();
        return { message: toMessage(message), status: "accepted", alreadyRequested: true };
      }
      const run = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", runId)
        .where("chat_id", "=", chatId)
        .where("turn_id", "=", turnId)
        .where("status", "in", [...ACTIVE_RUNS])
        .executeTakeFirst();
      if (!run || run.capability_snapshot === null) {
        throw new ChatRunNotActiveError(chatId, runId);
      }
      const capability = typeof run.capability_snapshot === "string"
        ? JSON.parse(run.capability_snapshot) as { steering?: unknown }
        : run.capability_snapshot as { steering?: unknown };
      if (capability.steering !== "same_run") {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      await trx.insertInto("chat_run_steers").values({
        id: input.steerId,
        chat_id: chatId,
        run_id: runId,
        turn_id: turnId,
        client_request_id: clientRequestId,
        message_id: input.messageId,
        queued_turn_id: null,
        parts: jsonb(input.parts),
        status: "pending",
        created_at: createdAt,
        updated_at: createdAt,
      }).execute();
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({
        revision,
        updated_at: createdAt,
      }).where("id", "=", chatId).where("revision", "=", Number(chat.revision)).executeTakeFirstOrThrow();
      await this.appendOutbox(trx, owner, chatId, revision, "run.steer_requested", {
        runId,
        turnId,
        messageId: input.messageId,
      });
      return { status: "pending", alreadyRequested: false };
    });
  }

  async beginQueuedTurn(
    ownerInput: ChatOwner,
    input: BeginQueuedTurnSteerInput,
  ): Promise<BegunQueuedTurnSteer> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const runId = CanonicalChatRunIdSchema.parse(input.runId);
    const turnId = CanonicalChatTurnIdSchema.parse(input.expectedTurnId);
    const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(input.queuedTurnId);
    const clientRequestId = CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const createdAt = new Date(input.createdAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await trx.selectFrom("chats").selectAll()
        .where("id", "=", chatId)
        .where("owner_type", "=", owner.type)
        .where("owner_id", "=", owner.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!chat) throw new ChatNotFoundError(chatId);
      const duplicate = await trx.selectFrom("chat_run_steers").selectAll()
        .where("chat_id", "=", chatId)
        .where("client_request_id", "=", clientRequestId)
        .executeTakeFirst();
      if (duplicate) {
        if (duplicate.queued_turn_id !== queuedTurnId) {
          throw new ChatConflictError(chatId, Number(chat.revision));
        }
        if (duplicate.status === "accepted") {
          const message = await trx.selectFrom("chat_messages").selectAll()
            .where("id", "=", duplicate.message_id)
            .executeTakeFirstOrThrow();
          return { message: toMessage(message), status: "accepted", alreadyRequested: true };
        }
        if (duplicate.status === "failed") {
          return { status: "failed", alreadyRequested: true };
        }
        return {
          status: "pending",
          parts: CanonicalChatQueuedTurnSchema.shape.parts.parse(
            typeof duplicate.parts === "string" ? JSON.parse(duplicate.parts) : duplicate.parts,
          ),
          alreadyRequested: true,
        };
      }
      if (chat.lifecycle !== "active" || Number(chat.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      const queued = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("id", "=", queuedTurnId)
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .forUpdate()
        .executeTakeFirst();
      if (!queued) throw new ChatConflictError(chatId, Number(chat.revision));
      const pending = await trx.selectFrom("chat_run_steers").select("id")
        .where("queued_turn_id", "=", queuedTurnId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (pending) throw new ChatConflictError(chatId, Number(chat.revision));
      const run = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", runId)
        .where("chat_id", "=", chatId)
        .where("turn_id", "=", turnId)
        .where("status", "in", [...ACTIVE_RUNS])
        .executeTakeFirst();
      if (!run || run.capability_snapshot === null) {
        throw new ChatRunNotActiveError(chatId, runId);
      }
      const capability = typeof run.capability_snapshot === "string"
        ? JSON.parse(run.capability_snapshot) as { steering?: unknown }
        : run.capability_snapshot as { steering?: unknown };
      if (capability.steering !== "same_run") {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      const parts = CanonicalChatQueuedTurnSchema.shape.parts.parse(
        typeof queued.parts === "string" ? JSON.parse(queued.parts) : queued.parts,
      );
      await trx.insertInto("chat_run_steers").values({
        id: input.steerId,
        chat_id: chatId,
        run_id: runId,
        turn_id: turnId,
        client_request_id: clientRequestId,
        message_id: input.messageId,
        queued_turn_id: queuedTurnId,
        parts: jsonb(parts),
        status: "pending",
        created_at: createdAt,
        updated_at: createdAt,
      }).execute();
      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({ revision, updated_at: createdAt })
        .where("id", "=", chatId)
        .where("revision", "=", input.baseRevision)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(chat.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "run.steer_requested", {
        runId,
        turnId,
        messageId: input.messageId,
        queuedTurnId,
      });
      return { status: "pending", parts, alreadyRequested: false };
    });
  }

  async accept(
    ownerInput: ChatOwner,
    input: { chatId: string; runId: string; clientRequestId: string; acceptedAt: string },
  ): Promise<CanonicalChatMessage> {
    const message = await this.finish(ownerInput, { ...input, outcome: "accepted" });
    if (!message) throw new ChatRunNotActiveError(input.chatId, input.runId);
    return message;
  }

  async fail(
    ownerInput: ChatOwner,
    input: { chatId: string; runId: string; clientRequestId: string; acceptedAt: string },
  ): Promise<void> {
    await this.finish(ownerInput, { ...input, outcome: "failed" });
  }

  async acceptQueuedTurn(
    ownerInput: ChatOwner,
    input: {
      chatId: string;
      runId: string;
      queuedTurnId: string;
      clientRequestId: string;
      acceptedAt: string;
    },
  ): Promise<CanonicalChatMessage> {
    const message = await this.finish(ownerInput, { ...input, outcome: "accepted" });
    if (!message) throw new ChatRunNotActiveError(input.chatId, input.runId);
    return message;
  }

  async failQueuedTurn(
    ownerInput: ChatOwner,
    input: {
      chatId: string;
      runId: string;
      queuedTurnId: string;
      clientRequestId: string;
      acceptedAt: string;
    },
  ): Promise<void> {
    await this.finish(ownerInput, { ...input, outcome: "failed" });
  }

  private async finish(
    ownerInput: ChatOwner,
    input: {
      chatId: string;
      runId: string;
      clientRequestId: string;
      acceptedAt: string;
      queuedTurnId?: string;
      outcome: "accepted" | "failed";
    },
  ): Promise<CanonicalChatMessage | null> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const runId = CanonicalChatRunIdSchema.parse(input.runId);
    const clientRequestId = CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const acceptedAt = new Date(input.acceptedAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await trx.selectFrom("chats").selectAll()
        .where("id", "=", chatId)
        .where("owner_type", "=", owner.type)
        .where("owner_id", "=", owner.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!chat) throw new ChatNotFoundError(chatId);
      const steer = await trx.selectFrom("chat_run_steers").selectAll()
        .where("chat_id", "=", chatId)
        .where("run_id", "=", runId)
        .where("client_request_id", "=", clientRequestId)
        .forUpdate()
        .executeTakeFirst();
      if (!steer) throw new ChatConflictError(chatId, Number(chat.revision));
      if ((input.queuedTurnId ?? null) !== steer.queued_turn_id) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      if (steer.status !== "pending") {
        if (input.outcome === "failed" && steer.status !== "failed") {
          throw new ChatConflictError(chatId, Number(chat.revision));
        }
        if (steer.status === "failed") return null;
        const existing = await trx.selectFrom("chat_messages").selectAll()
          .where("id", "=", steer.message_id).executeTakeFirstOrThrow();
        return toMessage(existing);
      }
      let outcome = input.outcome;
      if (outcome === "accepted") {
        const run = await trx.selectFrom("chat_runs").select("status")
          .where("id", "=", runId)
          .where("chat_id", "=", chatId)
          .executeTakeFirst();
        if (!run || !ACTIVE_RUNS.includes(run.status as (typeof ACTIVE_RUNS)[number])) {
          outcome = "failed";
        }
      }
      let message: CanonicalChatMessage | null = null;
      let queuedPosition: number | undefined;
      if (outcome === "accepted") {
        if (input.queuedTurnId) {
          const queued = await trx.selectFrom("chat_queued_turns").select(["id", "position", "status"])
            .where("id", "=", CanonicalChatQueuedTurnIdSchema.parse(input.queuedTurnId))
            .where("chat_id", "=", chatId)
            .forUpdate()
            .executeTakeFirst();
          if (!queued || queued.status !== "queued") {
            outcome = "failed";
          } else {
            queuedPosition = Number(queued.position);
          }
        }
      }
      if (outcome === "accepted") {
        const latest = await trx.selectFrom("chat_messages")
          .select(({ fn }) => fn.max("seq").as("seq"))
          .where("chat_id", "=", chatId)
          .executeTakeFirst();
        const parts = typeof steer.parts === "string" ? JSON.parse(steer.parts) : steer.parts;
        message = CanonicalChatMessageSchema.parse({
          id: steer.message_id,
          chatId,
          seq: Number(latest?.seq ?? 0) + 1,
          role: "user",
          state: "committed",
          turnId: steer.turn_id,
          runId,
          parts,
          createdAt: asIso(steer.created_at),
        });
        await trx.insertInto("chat_messages").values({
          id: message.id,
          chat_id: chatId,
          seq: message.seq,
          role: message.role,
          state: message.state,
          turn_id: message.turnId ?? null,
          run_id: message.runId ?? null,
          parts: jsonb(message.parts),
          byte_count: new TextEncoder().encode(JSON.stringify(message)).byteLength,
          search_text: messageSearchText(message),
          created_at: message.createdAt,
        }).execute();
        for (const part of message.parts) {
          if (part.type !== "attachment_reference") continue;
          await trx.insertInto("chat_attachments").values({
            id: part.attachmentId,
            chat_id: chatId,
            message_id: message.id,
            kind: part.kind,
            label: part.label,
            mime_type: part.mimeType ?? null,
            size_bytes: part.sizeBytes ?? null,
            owner_reference: part.ownerReference ?? null,
          }).execute();
        }
        if (input.queuedTurnId && queuedPosition !== undefined) {
          await trx.updateTable("chat_queued_turns").set({
            status: "claimed",
            claimed_turn_id: steer.turn_id,
            claimed_run_id: runId,
            updated_at: acceptedAt,
          }).where("id", "=", input.queuedTurnId)
            .where("chat_id", "=", chatId)
            .where("status", "=", "queued")
            .executeTakeFirstOrThrow();
          await trx.updateTable("chat_queued_turns").set({
            position: sql<number>`position - 1`,
            updated_at: acceptedAt,
          }).where("chat_id", "=", chatId)
            .where("status", "=", "queued")
            .where("position", ">", queuedPosition)
            .execute();
        }
      }
      await trx.updateTable("chat_run_steers").set({
        status: outcome,
        updated_at: acceptedAt,
      }).where("id", "=", steer.id).where("status", "=", "pending").executeTakeFirstOrThrow();
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({
        revision,
        updated_at: acceptedAt,
        ...(message ? {
          message_count: sql<number>`message_count + 1`,
          last_message_preview: preview(message),
        } : {}),
      })
        .where("id", "=", chatId)
        .where("revision", "=", Number(chat.revision))
        .executeTakeFirstOrThrow();
      await this.appendOutbox(
        trx,
        owner,
        chatId,
        revision,
        outcome === "accepted" ? "run.steered" : "run.steer_failed",
        {
          runId,
          turnId: steer.turn_id,
          messageId: steer.message_id,
          ...(steer.queued_turn_id ? { queuedTurnId: steer.queued_turn_id } : {}),
        },
      );
      return message;
    });
  }
}
