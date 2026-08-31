import {
  CanonicalChatIdSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatQueuedTurnIdSchema,
  CanonicalChatQueuedTurnSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatExecutionRootRef,
  type CanonicalChatQueuedTurn,
  type CanonicalChatRun,
  type CanonicalProviderDriverKind,
  type CanonicalQueueChatTurnRequest,
} from "@matrix-os/contracts";
import { type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  ChatDatabase,
  ChatQueuedTurnsTable,
  ChatsTable,
} from "./database.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError } from "./errors.js";
import { asIso, jsonb, parseJson, type ChatOutboxEventType, type ChatOwner } from "./records.js";

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

  private async queueDepth(executor: Executor, chatId: string): Promise<number> {
    const result = await executor.selectFrom("chat_queued_turns")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("chat_id", "=", chatId)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }
}
