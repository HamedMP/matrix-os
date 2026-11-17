import { sql, type Transaction } from "kysely";
import type { RoutineCliOperation } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { ChatDatabase } from "../chat/database.js";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import { lockRoutineCliPreference, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { createBotRoutinesRepository } from "./repositories/routines.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import type { RoutineCliSourceContext } from "./routine-cli-source-context.js";
import { isRoutineDirectChatId } from "./routine-direct-chat-identity.js";
import { routineDirectChatSourceIsEligible } from "./routine-direct-chat-contexts.js";

type DirectControl = { routine_id: string; chat_id: string; bot_id: string };

/** Legacy routine rows precede source/Chat locks. Direct controls are identified from the immutable
 * persisted destination and deferred until after their proven origin lock, like direct fires. */
export async function lockRoutineCliControl(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope,
  operation: RoutineCliOperation): Promise<DirectControl | undefined> {
  if (operation.operation !== "pause" && operation.operation !== "resume" && operation.operation !== "archive") return;
  if (!trx.isTransaction) throw new RoutineCliError("unavailable");
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  const routine = await trx.selectFrom("bot_routines").select(["routine_id", "chat_id", "bot_id"])
    .where("owner_id", "=", scope.ownerId).where("routine_id", "=", operation.routineId).executeTakeFirst();
  if (routine && isRoutineDirectChatId(routine.chat_id)) return routine;
  await createBotRoutinesRepository(trx).lock(scope.ownerId, operation.routineId, trx);
}

/** A direct routine may only be controlled from its own source, after the current source/action
 * gate. Verify the exact mapping before locking the routine, never a caller-supplied origin. */
export async function lockRoutineCliDirectControl(trx: Transaction<OwnerBotDatabase>, source: RoutineCliSourceContext,
  routine: DirectControl | undefined): Promise<void> {
  if (!routine) return;
  if (source.identity.kind !== "chat_run" || !source.actions.includes("propose")) throw new RoutineCliError("not_found");
  const sourceChatId = source.identity.chatId;
  const mapping = await trx.selectFrom("routine_direct_chat_contexts").select("chat_id")
    .where("owner_id", "=", source.ownerId).where("computer_id", "=", source.computerId)
    .where("source_chat_id", "=", sourceChatId).where("chat_id", "=", routine.chat_id)
    .where("bot_id", "=", routine.bot_id).where("activated_at", "is not", null).executeTakeFirst();
  if (!mapping || !await routineDirectChatSourceIsEligible(trx, { ownerId: source.ownerId, sourceChatId }, { lock: true }))
    throw new RoutineCliError("not_found");
  await createBotRoutinesRepository(trx).lock(source.ownerId, routine.routine_id, trx);
}
/** All actual producer policy checks retain preference -> owner -> source Chat/Run/Task -> target
 * Chat/binding locks. Remember takes the same preference/owner prefix. Reentrant later checks keep
 * those gates through commit; owner approval/network waits remain outside the transaction. */
export async function lockRoutineCliPolicyScope(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope): Promise<void> {
  await lockRoutineCliPreference(trx, scope);
  await lockChatAgentOwner(trx as unknown as Transaction<ChatDatabase>, { type: "personal", ownerId: scope.ownerId });
}
