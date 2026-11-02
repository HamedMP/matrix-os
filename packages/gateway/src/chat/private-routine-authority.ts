import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import type { ChatOwner } from "./records.js";
import { ChatConflictError } from "./errors.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

/** Matches credential authority: a previously published scope never becomes private by deletion. */
export async function hasNonPrivateChatScope(executor: Executor, owner: ChatOwner, chatId: string): Promise<boolean> {
  const scope = await (executor as unknown as Kysely<OwnerCollaborationDatabase>)
    .selectFrom("collaboration_scopes").select("id")
    .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
    .where("kind", "=", "chat").where("resource_id", "=", chatId)
    .where("lifecycle", "not in", ["private", "preparing"]).executeTakeFirst();
  // Missing schema and database failures propagate; neither proves private authority.
  return Boolean(scope);
}

/** Caller holds the Chat row lock through admission/output commit. Never lock a scope after Chat. */
export async function assertPrivateRoutineRequest(executor: Executor, owner: ChatOwner, chatId: string, requestId: string): Promise<void> {
  if (!requestId.startsWith("req_routine_")) return;
  if (owner.type !== "personal" || await hasNonPrivateChatScope(executor, owner, chatId)) {
    throw new ChatConflictError(chatId, 0);
  }
}

/** Use the persisted original turn, including for retries whose run request ID changes. */
export async function assertPrivateRoutineRun(executor: Executor, owner: ChatOwner, chatId: string, runId: string): Promise<void> {
  const turn = await executor.selectFrom("chat_runs as run").innerJoin("chat_turns as turn", "turn.id", "run.turn_id")
    .select("turn.client_request_id").where("run.id", "=", runId).where("run.chat_id", "=", chatId).executeTakeFirst();
  if (turn) await assertPrivateRoutineRequest(executor, owner, chatId, turn.client_request_id);
}

/** Terminalize a legacy queue under its caller's Chat lock, without publishing its private input. */
export async function cancelNonPrivateRoutineQueue(executor: Executor, input: {
  chatId: string; queuedTurnId: string; position: number; baseRevision: number; at: string;
}): Promise<number> {
  const cancelled = await executor.updateTable("chat_queued_turns").set({
    status: "cancelled", cancelled_at: input.at, updated_at: input.at,
  }).where("id", "=", input.queuedTurnId).where("chat_id", "=", input.chatId).where("status", "=", "queued")
    .returning("id").executeTakeFirst();
  if (!cancelled) throw new ChatConflictError(input.chatId, input.baseRevision);
  await executor.updateTable("chat_queued_turns").set({ position: sql<number>`position - 1`, updated_at: input.at })
    .where("chat_id", "=", input.chatId).where("status", "=", "queued").where("position", ">", input.position).execute();
  const revision = input.baseRevision + 1;
  const chat = await executor.updateTable("chats").set({ revision, updated_at: input.at })
    .where("id", "=", input.chatId).where("revision", "=", input.baseRevision).returning("id").executeTakeFirst();
  if (!chat) throw new ChatConflictError(input.chatId, input.baseRevision);
  return revision;
}
