/**
 * Bot creation operations (`bot_operations`). A creation is reserved with
 * server-chosen bot and chat IDs, then moves `reserved` → `file_created` →
 * `active`, or to `failed_recoverable` from any unfinished step. Retries with
 * the same client request ID and payload hash return the same operation, so
 * reconciliation after a crash reuses the same IDs.
 */
import { sql, type Selectable } from "kysely";
import type { BotOperationsTable, BotOperationStatus } from "../database.js";
import { BotStateError, isoTimestamp, newBotStateId, toSafeInteger, type BotExecutor } from "./shared.js";

const MAX_UNFINISHED_LIST = 100;

export interface BotOperation {
  ownerId: string;
  clientRequestId: string;
  botId: string;
  chatId: string;
  workspaceRelPath: string;
  payloadHash: string;
  status: BotOperationStatus;
  failureCode: string | null;
  attempts: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: Selectable<BotOperationsTable>): BotOperation {
  return {
    ownerId: row.owner_id,
    clientRequestId: row.client_request_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    workspaceRelPath: row.workspace_rel_path,
    payloadHash: row.payload_hash,
    status: row.status,
    failureCode: row.failure_code,
    attempts: row.attempts,
    revision: toSafeInteger(row.revision),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

/** Which statuses each target may be reached from. */
const TRANSITIONS: Readonly<Record<Exclude<BotOperationStatus, "reserved">, readonly BotOperationStatus[]>> = {
  file_created: ["reserved", "failed_recoverable"],
  active: ["file_created"],
  failed_recoverable: ["reserved", "file_created", "failed_recoverable"],
};

export function createBotOperationsRepository(db: BotExecutor) {
  async function get(ownerId: string, clientRequestId: string, executor: BotExecutor = db): Promise<BotOperation | undefined> {
    const row = await executor.selectFrom("bot_operations").selectAll()
      .where("owner_id", "=", ownerId).where("client_request_id", "=", clientRequestId)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  async function transition(input: {
    ownerId: string;
    clientRequestId: string;
    baseRevision: number;
    to: Exclude<BotOperationStatus, "reserved">;
    failureCode?: string;
    now: string;
  }, executor: BotExecutor = db): Promise<BotOperation> {
    if ((input.to === "failed_recoverable") !== (input.failureCode !== undefined)) {
      throw new BotStateError("invalid_transition");
    }
    const row = await executor.updateTable("bot_operations")
      .set((eb) => ({
        status: input.to,
        failure_code: input.failureCode ?? null,
        attempts: input.to === "failed_recoverable" ? eb("attempts", "+", 1) : eb.ref("attempts"),
        revision: sql<number>`revision + 1`,
        updated_at: input.now,
      }))
      .where("owner_id", "=", input.ownerId)
      .where("client_request_id", "=", input.clientRequestId)
      .where("revision", "=", input.baseRevision)
      .where("status", "in", [...TRANSITIONS[input.to]])
      .returningAll()
      .executeTakeFirst();
    if (row) return fromRow(row);
    const current = await get(input.ownerId, input.clientRequestId, executor);
    if (!current) throw new BotStateError("not_found");
    throw new BotStateError(current.revision !== input.baseRevision ? "revision_conflict" : "invalid_transition");
  }

  return {
    get,
    /**
     * Reserves a creation, or returns the existing one for the same request.
     * A different payload under the same request ID is a conflict (409).
     */
    async reserve(input: {
      ownerId: string;
      clientRequestId: string;
      payloadHash: string;
      now: string;
    }, executor: BotExecutor = db): Promise<{ operation: BotOperation; created: boolean }> {
      const botId = newBotStateId("bot");
      const inserted = await executor.insertInto("bot_operations").values({
        owner_id: input.ownerId,
        client_request_id: input.clientRequestId,
        bot_id: botId,
        chat_id: newBotStateId("chat"),
        workspace_rel_path: `bots/${botId}`,
        payload_hash: input.payloadHash,
        status: "reserved",
        failure_code: null,
        created_at: input.now,
        updated_at: input.now,
      }).onConflict((conflict) => conflict.columns(["owner_id", "client_request_id"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { operation: fromRow(inserted), created: true };
      const existing = await get(input.ownerId, input.clientRequestId, executor);
      if (!existing) throw new BotStateError("not_found");
      if (existing.payloadHash !== input.payloadHash) throw new BotStateError("conflict");
      return { operation: existing, created: false };
    },
    markFileCreated: (input: { ownerId: string; clientRequestId: string; baseRevision: number; now: string }, executor?: BotExecutor) =>
      transition({ ...input, to: "file_created" }, executor),
    /** Call inside the transaction that commits the chat and its direct binding. */
    markActive: (input: { ownerId: string; clientRequestId: string; baseRevision: number; now: string }, executor?: BotExecutor) =>
      transition({ ...input, to: "active" }, executor),
    markFailed: (input: { ownerId: string; clientRequestId: string; baseRevision: number; failureCode: string; now: string }, executor?: BotExecutor) =>
      transition({ ...input, to: "failed_recoverable" }, executor),
    /**
     * Unfinished creations last touched before `olderThan`, oldest first, for
     * reconciliation. `maxAttempts` leaves out operations that already failed
     * that many times, so they cannot crowd every batch.
     */
    async listUnfinished(input: { olderThan: string; limit?: number; maxAttempts?: number }, executor: BotExecutor = db): Promise<BotOperation[]> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_UNFINISHED_LIST), MAX_UNFINISHED_LIST));
      let query = executor.selectFrom("bot_operations").selectAll()
        .where("status", "<>", "active")
        .where("updated_at", "<", input.olderThan);
      if (input.maxAttempts !== undefined) query = query.where("attempts", "<", input.maxAttempts);
      const rows = await query
        .orderBy("updated_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(fromRow);
    },
  };
}

export type BotOperationsRepository = ReturnType<typeof createBotOperationsRepository>;
