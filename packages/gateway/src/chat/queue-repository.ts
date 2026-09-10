import { randomUUID } from "node:crypto";
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
  CollaborationActorIdSchema,
  CollaborationIdSchema,
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
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import type {
  ChatDatabase,
  ChatQueuedTurnsTable,
  ChatsTable,
} from "./database.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError } from "./errors.js";
import {
  asIso,
  jsonb,
  messageAttribution,
  messageSearchText,
  parseJson,
  type ChatOutboxEventType,
  type ChatOwner,
} from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
const MAX_QUEUED_TURNS = 20;
const MAX_SHARED_PENDING_TURNS = 32;
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

export interface EnqueueSharedQueuedTurnInput extends Omit<EnqueueQueuedTurnInput, "baseRevision" | "createdAt"> {
  scopeId: string;
  requestingActorId: string;
  acceptedAuthEpoch: number;
  payloadHash: string;
  expectedRevision: number;
  acceptedAt: string;
  retryOfQueuedTurnId?: string;
}

export interface SharedQueuedTurn {
  id: string;
  chatId: string;
  scopeId: string;
  clientRequestId: string;
  requestingActorId: string;
  acceptedSequence: number;
  acceptedAuthEpoch: number;
  retryOfRequestId?: string;
  state: "queued" | "claimed" | "cancelled" | "interrupted" | "unauthorized" | "unavailable";
  parts: CanonicalQueueChatTurnRequest["parts"];
  selection: CanonicalQueueChatTurnRequest["selection"];
  createdAt: string;
  updatedAt: string;
}

export interface EnqueuedSharedQueuedTurn extends SharedQueuedTurn {
  pendingCount: number;
  alreadyAccepted: boolean;
}

export class SharedChatQueueError extends Error {
  constructor(readonly code: "capacity" | "conflict" | "forbidden" | "not_found" | "unavailable") {
    super("Shared Chat queue unavailable");
    this.name = "SharedChatQueueError";
  }
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

  async enqueueShared(
    ownerInput: ChatOwner,
    input: EnqueueSharedQueuedTurnInput,
  ): Promise<EnqueuedSharedQueuedTurn> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const scopeId = CollaborationIdSchema.parse(input.scopeId);
    const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(input.queuedTurnId);
    const retryOfQueuedTurnId = input.retryOfQueuedTurnId === undefined
      ? undefined
      : CanonicalChatQueuedTurnIdSchema.parse(input.retryOfQueuedTurnId);
    const clientRequestId = CollaborationIdSchema.parse(input.clientRequestId);
    const requestingActorId = CollaborationActorIdSchema.parse(input.requestingActorId);
    const selection = CanonicalChatModelSelectionSchema.parse(input.selection);
    const capabilitySnapshot = CanonicalChatRunSchema.shape.capabilitySnapshot.parse(input.capabilitySnapshot);
    const parts = CanonicalChatQueuedTurnSchema.shape.parts.parse(input.parts);
    const acceptedAt = new Date(input.acceptedAt).toISOString();
    if (!Number.isSafeInteger(input.acceptedAuthEpoch) || input.acceptedAuthEpoch < 0
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !/^[a-f0-9]{64}$/.test(input.payloadHash)) {
      throw new SharedChatQueueError("conflict");
    }

    return this.transact(async (executor) => {
      const trx = executor as unknown as Transaction<OwnerCollaborationDatabase>;
      const scope = await trx.selectFrom("collaboration_scopes").selectAll()
        .where("id", "=", scopeId)
        .forUpdate()
        .executeTakeFirst();
      if (!scope || scope.owner_id !== owner.ownerId || scope.owner_type !== owner.type
        || scope.kind !== "chat" || scope.resource_id !== chatId) {
        throw new SharedChatQueueError("not_found");
      }
      if (scope.lifecycle !== "shared" || scope.membership_mode !== "direct"
        || Number(scope.auth_epoch) !== input.acceptedAuthEpoch) {
        throw new SharedChatQueueError("unavailable");
      }
      const member = await trx.selectFrom("collaboration_members").select(["role", "status", "expires_at"])
        .where("scope_id", "=", scopeId)
        .where("actor_id", "=", requestingActorId)
        .forUpdate()
        .executeTakeFirst();
      if (!member || member.status !== "accepted"
        || (member.expires_at !== null && new Date(member.expires_at).getTime() <= new Date(acceptedAt).getTime())) {
        throw new SharedChatQueueError("not_found");
      }
      if (member.role === "viewer") throw new SharedChatQueueError("forbidden");

      const chat = await ownedChat(executor, owner, chatId);
      if (!chat) throw new SharedChatQueueError("not_found");
      if (chat.lifecycle !== "active" || !sharedBindingMatches(chat.collaboration, scopeId)) {
        throw new SharedChatQueueError("unavailable");
      }
      const duplicate = await trx.selectFrom("chat_queued_turns").selectAll()
        .where("chat_id", "=", chatId)
        .where("requesting_actor_id", "=", requestingActorId)
        .where("actor_request_id", "=", clientRequestId)
        .executeTakeFirst();
      if (duplicate) {
        if (duplicate.payload_hash !== input.payloadHash || duplicate.collaboration_scope_id !== scopeId) {
          throw new SharedChatQueueError("conflict");
        }
        const pendingCount = await this.sharedPendingCount(executor, chatId);
        return { ...toSharedQueuedTurn(duplicate), pendingCount, alreadyAccepted: true };
      }
      if (Number(chat.revision) !== input.expectedRevision) {
        throw new SharedChatQueueError("conflict");
      }
      const pendingCount = await this.sharedPendingCount(executor, chatId);
      if (pendingCount >= MAX_SHARED_PENDING_TURNS) throw new SharedChatQueueError("capacity");
      const lastAccepted = await trx.selectFrom("chat_queued_turns")
        .select(({ fn }) => fn.max<number>("accepted_seq").as("accepted_seq"))
        .where("chat_id", "=", chatId)
        .where("collaboration_scope_id", "=", scopeId)
        .executeTakeFirst();
      const acceptedSequence = Number(lastAccepted?.accepted_seq ?? 0) + 1;
      const position = pendingCount + 1;
      const inserted = await trx.insertInto("chat_queued_turns").values({
        id: queuedTurnId,
        chat_id: chatId,
        client_request_id: `req_${clientRequestId.replaceAll("-", "")}`,
        actor_request_id: clientRequestId,
        requesting_actor_id: requestingActorId,
        collaboration_scope_id: scopeId,
        accepted_seq: acceptedSequence,
        payload_hash: input.payloadHash,
        accepted_auth_epoch: input.acceptedAuthEpoch,
        retry_of_queued_turn_id: retryOfQueuedTurnId ?? null,
        position,
        status: "queued",
        parts: jsonb(parts),
        driver_kind: input.driverKind,
        instance_id: selection.instanceId,
        selection: jsonb(selection),
        interaction_mode: input.interactionMode,
        permission_mode: input.permissionMode,
        execution_root: null,
        execution_root_fingerprint: null,
        capability_snapshot: jsonb(capabilitySnapshot),
        claimed_turn_id: null,
        claimed_run_id: null,
        cancelled_at: null,
        created_at: acceptedAt,
        updated_at: acceptedAt,
      }).returningAll().executeTakeFirstOrThrow();
      const revision = Number(chat.revision) + 1;
      const updated = await trx.updateTable("chats").set({ revision, updated_at: acceptedAt })
        .where("id", "=", chatId)
        .where("revision", "=", Number(chat.revision))
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new SharedChatQueueError("conflict");
      await appendSharedEvent(trx, {
        scopeId,
        resourceId: chatId,
        revision,
        authorityGeneration: Number(scope.authority_generation),
        eventType: "chat.ai_request.accepted",
        payload: { queuedTurnId, acceptedSequence, actorId: requestingActorId, state: "queued" },
        createdAt: acceptedAt,
      });
      return {
        ...toSharedQueuedTurn(inserted),
        pendingCount: position,
        alreadyAccepted: false,
      };
    });
  }

  async listShared(ownerInput: ChatOwner, chatIdInput: string): Promise<SharedQueuedTurn[]> {
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
      .where("collaboration_scope_id", "is not", null)
      .orderBy("accepted_seq", "asc")
      .limit(100)
      .execute();
    return rows.map(toSharedQueuedTurn);
  }

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
      if (chat.lifecycle !== "active") {
        throw new ChatConflictError(chatId, Number(chat.revision));
      }
      if (chat.collaboration !== null) {
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
      // Run output advances the chat-wide revision while the user is composing.
      // Appending a uniquely keyed queued turn does not overwrite concurrent state,
      // so serialize on the locked Chat row and advance its current revision.
      const currentRevision = Number(chat.revision);
      const revision = currentRevision + 1;
      const updated = await trx.updateTable("chats").set({
        revision,
        updated_at: createdAt,
      }).where("id", "=", chatId)
        .where("revision", "=", currentRevision)
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
      const candidateScope = await trx.selectFrom("chat_queued_turns")
        .select(["collaboration_scope_id", "requesting_actor_id", "accepted_auth_epoch"])
        .where("chat_id", "=", chatId)
        .where("status", "=", "queued")
        .orderBy("position")
        .executeTakeFirst();
      let sharedScope: {
        id: string;
        authority_generation: number;
        lifecycle: string;
        auth_epoch: number;
        execution_generation: number | null;
        execution_eligibility: unknown;
      } | undefined;
      let sharedAdmission: "allowed" | "unauthorized" | "unavailable" = "allowed";
      if (candidateScope?.collaboration_scope_id) {
        const sharedTrx = trx as unknown as Transaction<OwnerCollaborationDatabase>;
        sharedScope = await sharedTrx.selectFrom("collaboration_scopes")
          .select([
            "id", "authority_generation", "lifecycle", "auth_epoch",
            "execution_generation", "execution_eligibility",
          ])
          .where("id", "=", candidateScope.collaboration_scope_id)
          .forUpdate()
          .executeTakeFirst();
        if (!sharedScope) return null;
        if (sharedScope.lifecycle !== "shared" || sharedScope.execution_generation === null
          || sharedScope.execution_eligibility === null) {
          sharedAdmission = "unavailable";
        } else if (!candidateScope.requesting_actor_id || candidateScope.accepted_auth_epoch === null
          || Number(candidateScope.accepted_auth_epoch) !== Number(sharedScope.auth_epoch)) {
          sharedAdmission = "unauthorized";
        } else {
          const member = await sharedTrx.selectFrom("collaboration_members")
            .select(["role", "status", "expires_at"])
            .where("scope_id", "=", sharedScope.id)
            .where("actor_id", "=", candidateScope.requesting_actor_id)
            .forUpdate()
            .executeTakeFirst();
          if (!member || member.status !== "accepted" || member.role === "viewer"
            || (member.expires_at !== null && new Date(member.expires_at).getTime() <= new Date(claimedAt).getTime())) {
            sharedAdmission = "unauthorized";
          }
        }
      }
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
      if (candidate.collaboration_scope_id && sharedAdmission !== "allowed") {
        const terminalized = await trx.updateTable("chat_queued_turns").set({
          status: sharedAdmission,
          updated_at: claimedAt,
        }).where("id", "=", candidate.id)
          .where("status", "=", "queued")
          .returning("id")
          .executeTakeFirst();
        if (!terminalized) return null;
        await trx.updateTable("chat_queued_turns")
          .set({ position: sql<number>`position - 1`, updated_at: claimedAt })
          .where("chat_id", "=", chatId)
          .where("status", "=", "queued")
          .where("position", ">", Number(candidate.position))
          .execute();
        const revision = Number(chat.revision) + 1;
        await trx.updateTable("chats").set({ revision, updated_at: claimedAt })
          .where("id", "=", chatId)
          .where("revision", "=", Number(chat.revision))
          .executeTakeFirstOrThrow();
        await appendSharedEvent(trx as unknown as Transaction<OwnerCollaborationDatabase>, {
          scopeId: candidate.collaboration_scope_id,
          resourceId: chatId,
          revision,
          authorityGeneration: Number(sharedScope?.authority_generation ?? 0),
          eventType: `chat.ai_request.${sharedAdmission}`,
          payload: { queuedTurnId: candidate.id, actorId: candidate.requesting_actor_id, state: sharedAdmission },
          createdAt: claimedAt,
        });
        return null;
      }
      const pendingSteer = await trx.selectFrom("chat_run_steers").select("id")
        .where("queued_turn_id", "=", candidate.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (pendingSteer) return null;
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
        ...(row.requesting_actor_id ? { actorId: row.requesting_actor_id, purpose: "ai_request" } : {}),
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
        ...messageAttribution(message),
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
      if (row.collaboration_scope_id && sharedScope) {
        await appendSharedEvent(trx as unknown as Transaction<OwnerCollaborationDatabase>, {
          scopeId: row.collaboration_scope_id,
          resourceId: chatId,
          revision,
          authorityGeneration: Number(sharedScope.authority_generation),
          eventType: "chat.ai_request.claimed",
          payload: { queuedTurnId: row.id, turnId: turn.id, runId: run.id, state: "claimed" },
          createdAt: claimedAt,
        });
      } else {
        await this.appendOutbox(trx, owner, chatId, revision, "queue.claimed", {
          queuedTurnId: row.id,
          turnId: turn.id,
          runId: run.id,
        });
        await this.appendOutbox(trx, owner, chatId, revision, "turn.accepted", {
          turnId: turn.id,
          runId: run.id,
        });
      }
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

  private async sharedPendingCount(executor: Executor, chatId: string): Promise<number> {
    const row = await executor.selectFrom("chat_queued_turns")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("chat_id", "=", chatId)
      .where("collaboration_scope_id", "is not", null)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

function toSharedQueuedTurn(row: Selectable<ChatQueuedTurnsTable>): SharedQueuedTurn {
  const createdAt = asIso(row.created_at);
  const updatedAt = asIso(row.updated_at);
  if (!row.collaboration_scope_id || !row.requesting_actor_id || !row.actor_request_id || row.accepted_seq === null
    || row.accepted_auth_epoch === null || !createdAt || !updatedAt) {
    throw new SharedChatQueueError("unavailable");
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    scopeId: row.collaboration_scope_id,
    clientRequestId: row.actor_request_id,
    requestingActorId: row.requesting_actor_id,
    acceptedSequence: Number(row.accepted_seq),
    acceptedAuthEpoch: Number(row.accepted_auth_epoch),
    ...(row.retry_of_queued_turn_id ? { retryOfRequestId: row.retry_of_queued_turn_id } : {}),
    state: row.status,
    parts: CanonicalChatQueuedTurnSchema.shape.parts.parse(parseJson(row.parts)),
    selection: CanonicalChatModelSelectionSchema.parse(parseJson(row.selection)),
    createdAt,
    updatedAt,
  };
}

function sharedBindingMatches(value: unknown, scopeId: string): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return !!parsed && typeof parsed === "object"
      && (parsed as { scopeId?: unknown }).scopeId === scopeId
      && (parsed as { executionFenced?: unknown }).executionFenced === true;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[chat/queue] collaboration binding decode failed", error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}

async function appendSharedEvent(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: {
    scopeId: string;
    resourceId: string;
    revision: number;
    authorityGeneration: number;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: string;
  },
): Promise<void> {
  const latest = await trx.selectFrom("collaboration_events")
    .select(({ fn }) => fn.max<number>("scope_seq").as("scope_seq"))
    .where("scope_id", "=", input.scopeId)
    .executeTakeFirst();
  await trx.insertInto("collaboration_events").values({
    scope_id: input.scopeId,
    scope_seq: Number(latest?.scope_seq ?? 0) + 1,
    event_id: randomUUID(),
    resource_kind: "chat",
    resource_id: input.resourceId,
    revision: input.revision,
    authority_generation: input.authorityGeneration,
    event_type: input.eventType,
    payload: jsonb(input.payload),
    created_at: input.createdAt,
  }).execute();
}
