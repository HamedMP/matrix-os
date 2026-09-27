/**
 * Person interactions (`bot_interactions`): questions, account choices,
 * connect requests, and approvals that a bot raises in a conversation.
 * At most one blocking interaction is pending per task (partial unique
 * index), and an owner has at most 32 pending interactions, counted inside
 * the insert transaction under an owner advisory lock. Resolution claims the
 * row at its revision, so the caller can enqueue exactly one continuation in
 * the same transaction.
 */
import { sql, type Selectable } from "kysely";
import type { BotInteractionsTable } from "../database.js";
import {
  BotStateError,
  isChatOwnerViolation,
  isUniqueViolation,
  isoTimestamp,
  newBotStateId,
  optionalIsoTimestamp,
  toSafeInteger,
  withTransaction,
  type BotExecutor,
} from "./shared.js";

export const MAX_PENDING_INTERACTIONS_PER_OWNER = 32;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_CONNECT_LIFETIME_MS = 15 * 60_000;
const MAX_EXPIRE_BATCH = 200;
const encoder = new TextEncoder();

export type BotInteractionKind = BotInteractionsTable["kind"];

export interface BotInteractionRecord {
  interactionId: string;
  ownerId: string;
  botId: string;
  chatId: string;
  taskId: string;
  kind: BotInteractionKind;
  payload: Record<string, unknown>;
  responderActorId: string;
  blocking: boolean;
  status: BotInteractionsTable["status"];
  resolution: Record<string, unknown> | null;
  expiresAt: string;
  revision: number;
  createdAt: string;
  resolvedAt: string | null;
}

function parseJson(value: Record<string, unknown> | string | null): Record<string, unknown> | null {
  if (value === null) return null;
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
}

function fromRow(row: Selectable<BotInteractionsTable>): BotInteractionRecord {
  return {
    interactionId: row.interaction_id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    taskId: row.task_id,
    kind: row.kind,
    payload: parseJson(row.payload) ?? {},
    responderActorId: row.responder_actor_id,
    blocking: row.blocking,
    status: row.status,
    resolution: parseJson(row.resolution),
    expiresAt: isoTimestamp(row.expires_at),
    revision: toSafeInteger(row.revision),
    createdAt: isoTimestamp(row.created_at),
    resolvedAt: optionalIsoTimestamp(row.resolved_at),
  };
}

function boundedJson(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value);
  if (encoder.encode(encoded).byteLength > MAX_PAYLOAD_BYTES) throw new BotStateError("too_large");
  return encoded;
}

export function createBotInteractionsRepository(db: BotExecutor) {
  async function get(input: { ownerId: string; interactionId: string }, executor: BotExecutor = db): Promise<BotInteractionRecord | undefined> {
    const row = await executor.selectFrom("bot_interactions").selectAll()
      .where("owner_id", "=", input.ownerId).where("interaction_id", "=", input.interactionId)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  return {
    get,
    async create(input: {
      ownerId: string;
      botId: string;
      chatId: string;
      taskId: string;
      kind: BotInteractionKind;
      payload: Record<string, unknown>;
      responderActorId: string;
      blocking: boolean;
      expiresAt: string;
      now: string;
    }, executor: BotExecutor = db): Promise<BotInteractionRecord> {
      const lifetime = Date.parse(input.expiresAt) - Date.parse(input.now);
      if (!(lifetime > 0) || lifetime > (input.kind === "connect_request" ? MAX_CONNECT_LIFETIME_MS : MAX_LIFETIME_MS)) {
        throw new BotStateError("invalid_input");
      }
      const payload = boundedJson(input.payload);
      return withTransaction(executor, async (trx) => {
        // Serializes concurrent creates per owner so the cap cannot be overrun.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-interactions:${input.ownerId}`}, 0))`.execute(trx);
        // An overdue pending interaction of this task still holds the blocking slot until swept.
        await trx.updateTable("bot_interactions")
          .set({ status: "expired", resolved_at: input.now, revision: sql<number>`revision + 1` })
          .where("owner_id", "=", input.ownerId).where("task_id", "=", input.taskId)
          .where("status", "=", "pending").where("expires_at", "<=", input.now)
          .execute();
        const pending = await trx.selectFrom("bot_interactions")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("owner_id", "=", input.ownerId).where("status", "=", "pending").where("expires_at", ">", input.now)
          .executeTakeFirstOrThrow();
        if (Number(pending.count) >= MAX_PENDING_INTERACTIONS_PER_OWNER) throw new BotStateError("capacity_exceeded");
        try {
          const row = await trx.insertInto("bot_interactions").values({
            interaction_id: newBotStateId("in"),
            owner_id: input.ownerId,
            bot_id: input.botId,
            chat_id: input.chatId,
            task_id: input.taskId,
            kind: input.kind,
            payload,
            responder_actor_id: input.responderActorId,
            blocking: input.blocking,
            status: "pending",
            resolution: null,
            expires_at: input.expiresAt,
            created_at: input.now,
            resolved_at: null,
          }).returningAll().executeTakeFirstOrThrow();
          return fromRow(row);
        } catch (error: unknown) {
          if (isUniqueViolation(error, "idx_bot_interactions_one_blocking")) throw new BotStateError("conflict");
          if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
          throw error;
        }
      });
    },
    /**
     * Resolves a pending interaction at its revision, only by the designated
     * responder and before it expires. Pass the transaction that enqueues the
     * continuation so both commit together.
     */
    async resolve(input: {
      ownerId: string;
      interactionId: string;
      baseRevision: number;
      responderActorId: string;
      resolution: Record<string, unknown>;
      now: string;
    }, executor: BotExecutor = db): Promise<BotInteractionRecord> {
      const resolution = boundedJson(input.resolution);
      const row = await executor.updateTable("bot_interactions")
        .set({ status: "resolved", resolution, resolved_at: input.now, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", input.ownerId).where("interaction_id", "=", input.interactionId)
        .where("status", "=", "pending").where("revision", "=", input.baseRevision)
        .where("responder_actor_id", "=", input.responderActorId).where("expires_at", ">", input.now)
        .returningAll()
        .executeTakeFirst();
      if (row) return fromRow(row);
      const current = await get(input, executor);
      // Someone who is not the responder learns nothing about the interaction.
      if (!current || current.responderActorId !== input.responderActorId) throw new BotStateError("not_found");
      if (current.revision !== input.baseRevision) throw new BotStateError("revision_conflict");
      throw new BotStateError("invalid_transition");
    },
    async cancel(input: { ownerId: string; interactionId: string; now: string }, executor: BotExecutor = db): Promise<boolean> {
      const row = await executor.updateTable("bot_interactions")
        .set({ status: "cancelled", resolved_at: input.now, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", input.ownerId).where("interaction_id", "=", input.interactionId)
        .where("status", "=", "pending")
        .returning("interaction_id")
        .executeTakeFirst();
      return row !== undefined;
    },
    /** Expires overdue pending interactions in a bounded batch and returns them for follow-up. */
    async expireDue(input: { now: string; limit?: number }, executor: BotExecutor = db): Promise<BotInteractionRecord[]> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_EXPIRE_BATCH), MAX_EXPIRE_BATCH));
      const rows = await executor.updateTable("bot_interactions")
        .set({ status: "expired", resolved_at: input.now, revision: sql<number>`revision + 1` })
        .where("interaction_id", "in", (eb) => eb.selectFrom("bot_interactions").select("interaction_id")
          .where("status", "=", "pending").where("expires_at", "<=", input.now)
          .orderBy("expires_at", "asc").limit(limit))
        .where("status", "=", "pending")
        .returningAll()
        .execute();
      return rows.map(fromRow);
    },
    /** Pending, unexpired interactions for a conversation, oldest first. */
    async listPending(input: { ownerId: string; chatId: string; now: string }, executor: BotExecutor = db): Promise<BotInteractionRecord[]> {
      const rows = await executor.selectFrom("bot_interactions").selectAll()
        .where("owner_id", "=", input.ownerId).where("chat_id", "=", input.chatId)
        .where("status", "=", "pending").where("expires_at", ">", input.now)
        .orderBy("created_at", "asc")
        .limit(MAX_PENDING_INTERACTIONS_PER_OWNER)
        .execute();
      return rows.map(fromRow);
    },
  };
}

export type BotInteractionsRepository = ReturnType<typeof createBotInteractionsRepository>;
