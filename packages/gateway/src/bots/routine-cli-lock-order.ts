import { sql, type Transaction } from "kysely";
import type { RoutineCliOperation } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { ChatDatabase } from "../chat/database.js";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import { lockRoutineCliPreference, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { createBotRoutinesRepository } from "./repositories/routines.js";
import { RoutineCliError } from "./routine-cli-errors.js";

/** Preserve canonical control/scheduler order BEFORE any source-generation or policy/Chat locks.
 * This is the existing row gate, not authorization or admission; RequestService still checks the
 * locked row's existence/scope/revision and invokes the unchanged canonical control backend. */
export async function lockRoutineCliControl(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope, operation: RoutineCliOperation): Promise<void> {
  if (operation.operation === "pause" || operation.operation === "resume" || operation.operation === "archive") {
    if (!trx.isTransaction) throw new RoutineCliError("unavailable");
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await createBotRoutinesRepository(trx).lock(scope.ownerId, operation.routineId, trx);
  }
}
/** All actual producer policy checks retain preference -> owner -> source Chat/Run/Task -> target
 * Chat/binding locks. Remember takes the same preference/owner prefix. Reentrant later checks keep
 * those gates through commit; owner approval/network waits remain outside the transaction. */
export async function lockRoutineCliPolicyScope(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope): Promise<void> {
  await lockRoutineCliPreference(trx, scope);
  await lockChatAgentOwner(trx as unknown as Transaction<ChatDatabase>, { type: "personal", ownerId: scope.ownerId });
}
