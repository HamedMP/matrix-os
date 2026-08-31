import {
  CanonicalChatIdSchema,
  CanonicalChatMessageSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatQueuedTurnIdSchema,
  CanonicalChatQueuedTurnSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunSchema,
  CanonicalChatTurnSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatExecutionRootRef,
  type CanonicalChatQueuedTurn,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalChatTurn,
  type CanonicalProviderDriverKind,
  type CanonicalQueueChatTurnRequest,
  type CanonicalUpdateQueuedChatTurnRequest,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  ChatDatabase,
  ChatQueuedTurnsTable,
  ChatsTable,
} from "./database.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError } from "./errors.js";
import {
  asIso,
  jsonb,
  messageSearchText,
  parseJson,
  type ChatOutboxEventType,
  type ChatOwner,
} from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
const MAX_QUEUED_TURNS = 20;
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;

export interface EnqueueQueuedTurnInput {
  chatId: string;
  baseRevision: number;
  queuedTurnId: string;
  clientRequestId: string;
  parts: CanonicalQueueChatTurnRequest["parts"];
  driverKind: CanonicalProviderDriverKind;
  selection: CanonicalQueueChatTurnRequest["selection"];
  interactionMode: string;
  permissionMode: string;
  executionRoot?: CanonicalChatExecutionRootRef;
  executionRootFingerprint?: string;
  capabilitySnapshot: CanonicalChatRun["capabilitySnapshot"];
  createdAt: string;
}

export interface EnqueuedQueuedTurn {
  queuedTurn: CanonicalChatQueuedTurn;
  queueDepth: number;
  alreadyQueued: boolean;
}

export interface CancelQueuedTurnInput {
  chatId: string;
  queuedTurnId: string;
  clientRequestId: string;
  baseRevision: number;
  cancelledAt: string;
}

export interface ReorderQueuedTurnsInput {
  chatId: string;
  clientRequestId: string;
  baseRevision: number;
  queuedTurnIds: string[];
  reorderedAt: string;
}

export interface UpdateQueuedTurnInput {
  chatId: string;
  queuedTurnId: string;
  clientRequestId: string;
  baseRevision: number;
  parts: CanonicalUpdateQueuedChatTurnRequest["parts"];
  updatedAt: string;
}

export interface ClaimNextQueuedTurnInput {
  chatId: string;
  turnId: string;
  runId: string;
  messageId: string;
  claimedAt: string;
}

export interface ClaimedQueuedTurn {
  queuedTurn: CanonicalChatQueuedTurn;
  message: CanonicalChatMessage;
  turn: CanonicalChatTurn;
  run: CanonicalChatRun;
  queueDepth: number;
}

export function toQueuedTurn(row: Selectable<ChatQueuedTurnsTable>): CanonicalChatQueuedTurn {
  return CanonicalChatQueuedTurnSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    clientRequestId: row.client_request_id,
    position: Number(row.position),
    parts: parseJson(row.parts),
    selection: parseJson(row.selection),
    interactionMode: row.interaction_mode,
    permissionMode: row.permission_mode,
    ...(row.execution_root === null ? {} : { executionRoot: parseJson(row.execution_root) }),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

async function ownedChat(
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
): Promise<Selectable<ChatsTable> | undefined> {
  return executor.selectFrom("chats").selectAll()
    .where("id", "=", chatId)
    .where("owner_type", "=", owner.type)
    .where("owner_id", "=", owner.ownerId)
    .forUpdate()
    .executeTakeFirst();
}

export class ChatQueueRepository {
  constructor(
    private readonly kysely: Kysely<ChatDatabase>,
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

  async enqueue(
    ownerInput: ChatOwner,
    input: EnqueueQueuedTurnInput,
  ): Promise<EnqueuedQueuedTurn> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(input.queuedTurnId);
    const clientRequestId = CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const selection = CanonicalChatModelSelectionSchema.parse(input.selection);
    const capabilitySnapshot = CanonicalChatRunSchema.shape.capabilitySnapshot.parse(
      input.capabilitySnapshot,
    );
    const createdAt = new Date(input.createdAt).toISOString();

    return this.transact(async (trx) => {
      const chat = await ownedChat(trx, owner, chatId);
      if (!chat) throw new ChatNotFoundError(chatId);
      const duplicate = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("chat_id", "=", chatId)
        .where("client_request_id", "=", clientRequestId)
        .executeTakeFirst();
      if (duplicate) {
        if (duplicate.status !== "queued") {
          throw new ChatConflictError(chatId, Number(chat.revision));
        }
        const depth = await this.queueDepth(trx, chatId);
        return { queuedTurn: toQueuedTurn(duplicate), queueDepth: depth, alreadyQueued: true };
      }
      if (chat.lifecycle !== "active" || Number(chat.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      const activeRun = await trx.selectFrom("chat_runs").select("id")
        .where("chat_id", "=", chatId)
        .where("status", "in", [...ACTIVE_RUNS])
        .executeTakeFirst();
      if (!activeRun) throw new ChatBusyError(chatId);
      const queueDepth = await this.queueDepth(trx, chatId);
      if (queueDepth >= MAX_QUEUED_TURNS) throw new ChatBusyError(chatId);
      const position = queueDepth + 1;
      const inserted = await trx.insertInto("chat_queued_turns").values({
        id: queuedTurnId,
        chat_id: chatId,
        client_request_id: clientRequestId,
        position,
        status: "queued",
        parts: jsonb(input.parts),
        driver_kind: input.driverKind,
        instance_id: selection.instanceId,
        selection: jsonb(selection),
        interaction_mode: input.interactionMode,
        permission_mode: input.permissionMode,
        execution_root: input.executionRoot ? jsonb(input.executionRoot) : null,
        execution_root_fingerprint: input.executionRootFingerprint ?? null,
        capability_snapshot: jsonb(capabilitySnapshot),
        claimed_turn_id: null,
        claimed_run_id: null,
        cancelled_at: null,
        created_at: createdAt,
        updated_at: createdAt,
      }).returningAll().executeTakeFirstOrThrow();
      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({
        revision,
        updated_at: createdAt,
      }).where("id", "=", chatId)
        .where("revision", "=", input.baseRevision)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(chat.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "queue.enqueued", {
        queuedTurnId,
        position,
      });
      return {
        queuedTurn: toQueuedTurn(inserted),
        queueDepth: position,
        alreadyQueued: false,
      };
    });
  }

  async list(ownerInput: ChatOwner, chatIdInput: string): Promise<CanonicalChatQueuedTurn[]> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(chatIdInput);
    const owned = await this.kysely.selectFrom("chats").select("id")
      .where("id", "=", chatId)
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    if (!owned) return [];
    const rows = await this.kysely.selectFrom("chat_queued_turns").selectAll()
      .where("chat_id", "=", chatId)
      .where("status", "=", "queued")
      .orderBy("position")
      .limit(MAX_QUEUED_TURNS)
      .execute();
    return rows.map(toQueuedTurn);
  }

  async cancel(
    ownerInput: ChatOwner,
    input: CancelQueuedTurnInput,
  ): Promise<{ queuedTurnId: string; queueDepth: number; cancellation: "cancelled" | "already_cancelled" }> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(input.queuedTurnId);
    CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const cancelledAt = new Date(input.cancelledAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await ownedChat(trx, owner, chatId);
      if (!chat) throw new ChatNotFoundError(chatId);
      const queued = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("id", "=", queuedTurnId)
        .where("chat_id", "=", chatId)
        .forUpdate()
        .executeTakeFirst();
      if (!queued) throw new ChatNotFoundError(chatId);
      const pendingSteer = await trx.selectFrom("chat_run_steers").select("id")
        .where("queued_turn_id", "=", queuedTurnId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (pendingSteer) throw new ChatConflictError(chatId, Number(chat.revision));
      if (queued.status === "cancelled") {
        return {
          queuedTurnId,
          queueDepth: await this.queueDepth(trx, chatId),
          cancellation: "already_cancelled" as const,
        };
      }
      if (queued.status !== "queued" || chat.lifecycle !== "active"
        || Number(chat.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      await trx.updateTable("chat_queued_turns").set({
        status: "cancelled",
        cancelled_at: cancelledAt,
        updated_at: cancelledAt,
      }).where("id", "=", queuedTurnId).where("status", "=", "queued").executeTakeFirstOrThrow();
      await trx.updateTable("chat_queued_turns")
        .set({ position: sql<number>`position - 1`, updated_at: cancelledAt })
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .where("position", ">", Number(queued.position))
        .execute();
      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({ revision, updated_at: cancelledAt })
        .where("id", "=", chatId)
        .where("revision", "=", input.baseRevision)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(chat.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "queue.cancelled", {
        queuedTurnId,
        position: Number(queued.position),
      });
      return {
        queuedTurnId,
        queueDepth: await this.queueDepth(trx, chatId),
        cancellation: "cancelled" as const,
      };
    });
  }

  async reorder(
    ownerInput: ChatOwner,
    input: ReorderQueuedTurnsInput,
  ): Promise<{ queuedTurns: CanonicalChatQueuedTurn[] }> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const queuedTurnIds = input.queuedTurnIds.map((id) => CanonicalChatQueuedTurnIdSchema.parse(id));
    if (new Set(queuedTurnIds).size !== queuedTurnIds.length || queuedTurnIds.length > MAX_QUEUED_TURNS) {
      throw new ChatConflictError(chatId, input.baseRevision);
    }
    const reorderedAt = new Date(input.reorderedAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await ownedChat(trx, owner, chatId);
      if (!chat) throw new ChatNotFoundError(chatId);
      const current = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .orderBy("position")
        .forUpdate()
        .execute();
      const currentIds = current.map((row) => row.id);
      if (currentIds.length !== queuedTurnIds.length
        || currentIds.some((id) => !queuedTurnIds.includes(id))) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      if (currentIds.every((id, index) => id === queuedTurnIds[index])) {
        return { queuedTurns: current.map(toQueuedTurn) };
      }
      if (chat.lifecycle !== "active" || Number(chat.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      await trx.updateTable("chat_queued_turns").set({ status: "claimed" })
        .where("chat_id", "=", chatId).where("status", "=", "queued").execute();
      for (const [index, id] of queuedTurnIds.entries()) {
        await trx.updateTable("chat_queued_turns").set({
          position: index + 1,
          updated_at: reorderedAt,
        }).where("chat_id", "=", chatId).where("id", "=", id).where("status", "=", "claimed").execute();
      }
      await trx.updateTable("chat_queued_turns").set({ status: "queued" })
        .where("chat_id", "=", chatId)
        .where("id", "in", queuedTurnIds)
        .where("status", "=", "claimed")
        .execute();
      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({ revision, updated_at: reorderedAt })
        .where("id", "=", chatId)
        .where("revision", "=", input.baseRevision)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(chat.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "queue.reordered", { queuedTurnIds });
      const rows = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("chat_id", "=", chatId).where("status", "=", "queued").orderBy("position").execute();
      return { queuedTurns: rows.map(toQueuedTurn) };
    });
  }

  async update(
    ownerInput: ChatOwner,
    input: UpdateQueuedTurnInput,
  ): Promise<{ queuedTurn: CanonicalChatQueuedTurn }> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(input.queuedTurnId);
    CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const parts = CanonicalChatQueuedTurnSchema.shape.parts.parse(input.parts);
    const updatedAt = new Date(input.updatedAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await ownedChat(trx, owner, chatId);
      if (!chat) throw new ChatNotFoundError(chatId);
      const queued = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("id", "=", queuedTurnId)
        .where("chat_id", "=", chatId)
        .forUpdate()
        .executeTakeFirst();
      if (!queued) throw new ChatNotFoundError(chatId);
      const pendingSteer = await trx.selectFrom("chat_run_steers").select("id")
        .where("queued_turn_id", "=", queuedTurnId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      const existingParts = CanonicalChatQueuedTurnSchema.shape.parts.parse(parseJson(queued.parts));
      if (!pendingSteer && queued.status === "queued"
        && JSON.stringify(existingParts) === JSON.stringify(parts)) {
        return { queuedTurn: toQueuedTurn(queued) };
      }
      if (pendingSteer || queued.status !== "queued" || chat.lifecycle !== "active"
        || Number(chat.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      const updated = await trx.updateTable("chat_queued_turns").set({
        parts: jsonb(parts),
        updated_at: updatedAt,
      }).where("id", "=", queuedTurnId)
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(chat.revision));
      const revision = input.baseRevision + 1;
      const chatUpdate = await trx.updateTable("chats").set({ revision, updated_at: updatedAt })
        .where("id", "=", chatId)
        .where("revision", "=", input.baseRevision)
        .returning("id")
        .executeTakeFirst();
      if (!chatUpdate) throw new ChatConflictError(chatId, Number(chat.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "queue.updated", {
        queuedTurnId,
        position: Number(queued.position),
      });
      return { queuedTurn: toQueuedTurn(updated) };
    });
  }

  async claimNext(
    ownerInput: ChatOwner,
    input: ClaimNextQueuedTurnInput,
  ): Promise<ClaimedQueuedTurn | null> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const turnId = CanonicalChatTurnSchema.shape.id.parse(input.turnId);
    const runId = CanonicalChatRunSchema.shape.id.parse(input.runId);
    const messageId = CanonicalChatMessageSchema.shape.id.parse(input.messageId);
    const claimedAt = new Date(input.claimedAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await ownedChat(trx, owner, chatId);
      if (!chat) throw new ChatNotFoundError(chatId);
      if (chat.lifecycle !== "active") return null;
      const active = await trx.selectFrom("chat_runs").select("id")
        .where("chat_id", "=", chatId).where("status", "in", [...ACTIVE_RUNS]).executeTakeFirst();
      if (active) return null;
      const candidate = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .orderBy("position")
        .executeTakeFirst();
      if (!candidate) return null;
      const row = await trx.updateTable("chat_queued_turns").set({
        status: "claimed",
        updated_at: claimedAt,
      }).where("id", "=", candidate.id)
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      const queuedTurn = toQueuedTurn(row);
      const parts = CanonicalChatQueuedTurnSchema.shape.parts.parse(parseJson(row.parts));
      const selection = CanonicalChatModelSelectionSchema.parse(parseJson(row.selection));
      const capabilitySnapshot = CanonicalChatRunSchema.shape.capabilitySnapshot.parse(parseJson(row.capability_snapshot));
      const message = CanonicalChatMessageSchema.parse({
        id: messageId,
        chatId,
        seq: Number(chat.message_count) + 1,
        role: "user",
        state: "committed",
        turnId,
        parts,
        createdAt: claimedAt,
      });
      const turn = CanonicalChatTurnSchema.parse({
        id: turnId,
        chatId,
        clientRequestId: row.client_request_id,
        baseMessageSeq: Number(chat.message_count),
        inputMessageId: message.id,
        status: "accepted",
        createdAt: claimedAt,
        updatedAt: claimedAt,
      });
      const run = CanonicalChatRunSchema.parse({
        id: runId,
        chatId,
        turnId,
        attempt: 1,
        driverKind: row.driver_kind,
        instanceId: row.instance_id,
        selection,
        interactionMode: row.interaction_mode,
        permissionMode: row.permission_mode,
        ...(row.execution_root === null ? {} : { executionRoot: parseJson(row.execution_root) }),
        ...(row.execution_root_fingerprint === null ? {} : {
          executionRootFingerprint: row.execution_root_fingerprint,
        }),
        status: "accepted",
        historyBoundarySeq: Number(chat.message_count),
        capabilitySnapshot,
        createdAt: claimedAt,
        updatedAt: claimedAt,
      });
      await trx.insertInto("chat_messages").values({
        id: message.id,
        chat_id: chatId,
        seq: message.seq,
        role: message.role,
        state: message.state,
        turn_id: turn.id,
        run_id: null,
        parts: jsonb(message.parts),
        byte_count: new TextEncoder().encode(JSON.stringify(message)).byteLength,
        search_text: messageSearchText(message),
        created_at: claimedAt,
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
      await trx.insertInto("chat_turns").values({
        id: turn.id,
        chat_id: chatId,
        client_request_id: turn.clientRequestId,
        base_message_seq: turn.baseMessageSeq,
        input_message_id: turn.inputMessageId,
        status: turn.status,
        created_at: claimedAt,
        updated_at: claimedAt,
      }).execute();
      await trx.insertInto("chat_runs").values({
        id: run.id,
        chat_id: chatId,
        turn_id: turn.id,
        client_request_id: turn.clientRequestId,
        attempt: run.attempt,
        driver_kind: run.driverKind,
        instance_id: run.instanceId,
        selection: jsonb(run.selection),
        interaction_mode: run.interactionMode,
        permission_mode: run.permissionMode,
        execution_root: run.executionRoot ? jsonb(run.executionRoot) : null,
        execution_root_fingerprint: run.executionRootFingerprint ?? null,
        status: run.status,
        outcome: null,
        started_at: null,
        completed_at: null,
        history_boundary_seq: run.historyBoundarySeq,
        capability_snapshot: jsonb(run.capabilitySnapshot),
        created_at: claimedAt,
        updated_at: claimedAt,
      }).execute();
      await trx.updateTable("chat_queued_turns").set({
        claimed_turn_id: turn.id,
        claimed_run_id: run.id,
      }).where("id", "=", row.id).where("status", "=", "claimed").executeTakeFirstOrThrow();
      await trx.updateTable("chat_queued_turns").set({
        position: sql<number>`position - 1`,
        updated_at: claimedAt,
      }).where("chat_id", "=", chatId).where("status", "=", "queued")
        .where("position", ">", Number(row.position)).execute();
      const revision = Number(chat.revision) + 1;
      const updatedChat = await trx.updateTable("chats").set({
        revision,
        message_count: sql<number>`message_count + 1`,
        current_selection: jsonb(selection),
        attention: "none",
        last_message_preview: message.parts.find((part) => part.type === "text")?.text.slice(0, 280) ?? null,
        updated_at: claimedAt,
      }).where("id", "=", chatId)
        .where("revision", "=", Number(chat.revision))
        .returning("id")
        .executeTakeFirst();
      if (!updatedChat) throw new ChatConflictError(chatId, Number(chat.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "queue.claimed", {
        queuedTurnId: row.id,
        turnId: turn.id,
        runId: run.id,
      });
      await this.appendOutbox(trx, owner, chatId, revision, "turn.accepted", {
        turnId: turn.id,
        runId: run.id,
      });
      return {
        queuedTurn,
        message,
        turn,
        run,
        queueDepth: await this.queueDepth(trx, chatId),
      };
    });
  }

  async listQueuedChatIds(ownerInput: ChatOwner, limit = MAX_QUEUED_TURNS): Promise<string[]> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_QUEUED_TURNS));
    const rows = await this.kysely.selectFrom("chat_queued_turns as queued")
      .innerJoin("chats as chat", "chat.id", "queued.chat_id")
      .select("queued.chat_id")
      .where("queued.status", "=", "queued")
      .where("chat.owner_type", "=", owner.type)
      .where("chat.owner_id", "=", owner.ownerId)
      .groupBy("queued.chat_id")
      .orderBy("queued.chat_id")
      .limit(boundedLimit)
      .execute();
    return rows.map((row) => row.chat_id);
  }

  private async queueDepth(executor: Executor, chatId: string): Promise<number> {
    const result = await executor.selectFrom("chat_queued_turns")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("chat_id", "=", chatId)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }
}
