import { isRoutineDirectChatId } from "../bots/routine-direct-chat-identity.js";
import { sql, type Expression, type Kysely, type QueryExecutorProvider, type Transaction } from "kysely";
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

export async function hasNonPrivateChatScope(executor: QueryExecutorProvider, owner: ChatOwner, chatId: string): Promise<boolean> {
  const predicate = hasNonPrivateChatScopeSql(sql.val(owner.type), sql.val(owner.ownerId), sql.val(chatId));
  const result = await sql<{ non_private: boolean }>`SELECT ${predicate} AS non_private`.execute(executor);
  // Missing schema and database failures propagate; neither proves private authority.
  return result.rows[0]!.non_private;
}

/** A named recipient must have the direct Chat to itself. */
export function hasOtherBotBindingSql(chatId: Expression<string>, expectedBotId?: Expression<string>) {
  return sql<boolean>`EXISTS (SELECT 1 FROM bot_chat_bindings binding WHERE binding.chat_id = ${chatId}
    AND binding.removed_at IS NULL
    AND (binding.kind <> 'direct' ${expectedBotId ? sql`OR binding.bot_id <> ${expectedBotId}` : sql``}))`;
}

/** A source (or destination) must be an active, personal Chat with no wider audience. */
export async function privateBotSourceChat(db: Executor, owner: ChatOwner, chatId: string, expectedBotId?: string) {
  if (owner.type !== "personal" || isRoutineDirectChatId(chatId)) return undefined;
  return db.selectFrom("chats").select("title")
    .where("id", "=", chatId).where("owner_type", "=", "personal").where("owner_id", "=", owner.ownerId)
    .where("lifecycle", "=", "active").where("project_id", "is", null).where("collaboration", "is", null)
    .where(eb => eb.not(hasOtherBotBindingSql(eb.ref("chats.id"), expectedBotId ? sql.val(expectedBotId) : undefined)))
    .where(eb => eb.not(hasNonPrivateChatScopeSql(eb.ref("chats.owner_type"), eb.ref("chats.owner_id"), eb.ref("chats.id"))))
    .where(eb => eb.not(eb.exists(eb.selectFrom("chat_shares").select("id")
      .whereRef("chat_shares.chat_id", "=", "chats.id").where("expires_at", ">", new Date()))))
    .executeTakeFirst();
}

function isPrivateAutomaticRequest(requestId: string): boolean {
  return requestId.startsWith("req_routine_") || requestId.startsWith("req_slack_summary_");
}

/** Caller holds the Chat row lock through admission/output commit. Never lock a scope after Chat.
 * Private automatic sources include routines and opted-in Slack summaries. */
export async function assertPrivateRoutineRequest(executor: Executor, owner: ChatOwner, chatId: string, requestId: string): Promise<void> {
  if (!isPrivateAutomaticRequest(requestId)) return;
  if (owner.type !== "personal" || await hasNonPrivateChatScope(executor, owner, chatId)) {
    throw new ChatConflictError(chatId, 0);
  }
}

/** Preserve private source identity when an automatic queue is steered into an ordinary turn or retried. */
export async function assertPrivateRoutineTurn(executor: Executor, owner: ChatOwner, chatId: string, turnId: string): Promise<void> {
  const turn = await executor.selectFrom("chat_turns").select("client_request_id")
    .where("id", "=", turnId).where("chat_id", "=", chatId).executeTakeFirst();
  if (turn && isPrivateAutomaticRequest(turn.client_request_id)) {
    return assertPrivateRoutineRequest(executor, owner, chatId, turn.client_request_id);
  }
  const queued = await executor.selectFrom("chat_queued_turns").select("client_request_id")
    .where("chat_id", "=", chatId).where("claimed_turn_id", "=", turnId)
    .where(eb => eb.or([
      eb("client_request_id", "like", "req\\_routine\\_%"),
      eb("client_request_id", "like", "req\\_slack\\_summary\\_%"),
    ])).limit(1).executeTakeFirst();
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
