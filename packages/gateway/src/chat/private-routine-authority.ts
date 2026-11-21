import { sql, type Expression, type Kysely, type Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";
import { ChatConflictError } from "./errors.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

/** Matches credential authority: a previously published scope never becomes private by deletion. */
export function hasNonPrivateChatScopeSql(
  ownerType: Expression<string>,
  ownerId: Expression<string>,
  chatId: Expression<string>,
) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM collaboration_scopes scope
    WHERE scope.owner_type = ${ownerType} AND scope.owner_id = ${ownerId}
      AND scope.kind = 'chat' AND scope.resource_id = ${chatId}
      AND scope.lifecycle NOT IN ('private', 'preparing')
  )`;
}

export async function hasNonPrivateChatScope(executor: Executor, owner: ChatOwner, chatId: string): Promise<boolean> {
  const predicate = hasNonPrivateChatScopeSql(sql.val(owner.type), sql.val(owner.ownerId), sql.val(chatId));
  const result = await sql<{ non_private: boolean }>`SELECT ${predicate} AS non_private`.execute(executor);
  // Missing schema and database failures propagate; neither proves private authority.
  return result.rows[0]!.non_private;
}

/** Caller holds the Chat row lock through admission/output commit. Never lock a scope after Chat. */
export async function assertPrivateRoutineRequest(executor: Executor, owner: ChatOwner, chatId: string, requestId: string): Promise<void> {
  if (!requestId.startsWith("req_routine_")) return;
  if (owner.type !== "personal" || await hasNonPrivateChatScope(executor, owner, chatId)) {
    throw new ChatConflictError(chatId, 0);
  }
}

/** Preserve source identity when a routine queue is steered into an ordinary turn or retried. */
export async function assertPrivateRoutineTurn(executor: Executor, owner: ChatOwner, chatId: string, turnId: string): Promise<void> {
  const turn = await executor.selectFrom("chat_turns").select("client_request_id")
    .where("id", "=", turnId).where("chat_id", "=", chatId).executeTakeFirst();
  if (turn?.client_request_id.startsWith("req_routine_")) {
    return assertPrivateRoutineRequest(executor, owner, chatId, turn.client_request_id);
  }
  const queued = await executor.selectFrom("chat_queued_turns").select("client_request_id")
    .where("chat_id", "=", chatId).where("claimed_turn_id", "=", turnId)
    .where("client_request_id", "like", "req\\_routine\\_%").limit(1).executeTakeFirst();
  if (queued) await assertPrivateRoutineRequest(executor, owner, chatId, queued.client_request_id);
}

/** Use the persisted turn, including retries whose run request ID changes. */
export async function assertPrivateRoutineRun(executor: Executor, owner: ChatOwner, chatId: string, runId: string): Promise<void> {
  const run = await executor.selectFrom("chat_runs").select("turn_id")
    .where("id", "=", runId).where("chat_id", "=", chatId).executeTakeFirst();
  if (run) await assertPrivateRoutineTurn(executor, owner, chatId, run.turn_id);
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
