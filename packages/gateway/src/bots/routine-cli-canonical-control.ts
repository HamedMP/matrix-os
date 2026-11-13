import { RoutineCliError } from "./routine-cli-errors.js";
import type { BotRoutineControl } from "./routine-control.js";
import type { RoutineCliMutationAdmission, RoutineCliAfterMutationCommit } from "./routine-cli-requests.js";

/** Internal paired adapter. No proposal binding, scheduler, permission fallback or nested transaction. */
export function createRoutineCliCanonicalControl(deps: { control: BotRoutineControl }) {
  if (typeof deps.control?.controlWithin !== "function" || typeof deps.control?.afterControlCommit !== "function") throw new RoutineCliError("unavailable");
  const admitMutation: RoutineCliMutationAdmission = async ({ transaction, target, operation }) => {
    if (operation.operation === "propose") throw new RoutineCliError("unavailable");
    const routine = await deps.control.controlWithin(transaction, target.ownerId, target.botId, operation.routineId, {
      baseRevision: operation.baseRevision, status: operation.operation === "resume" ? "active" : operation.operation === "pause" ? "paused" : "archived",
    }, target.chatId);
    return { disposition: "applied", routine: { routineId: routine.routineId, status: routine.status, revision: routine.revision } };
  };
  const afterMutationCommit: RoutineCliAfterMutationCommit = async ({ target, operation, admission }) => {
    if (operation.operation === "propose" || admission.disposition !== "applied") return;
    await deps.control.afterControlCommit({ ownerId: target.ownerId, botId: target.botId, chatId: target.chatId, ...admission.routine });
  };
  return { admitMutation, afterMutationCommit };
}
