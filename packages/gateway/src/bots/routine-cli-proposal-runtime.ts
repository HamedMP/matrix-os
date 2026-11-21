import { isDeepStrictEqual } from "node:util";
import type { BotRuntimeBinding, BotRuntimeRegistry } from "./runtime-registry.js";
import type { RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import type { RoutineCliProposalRecord } from "./repositories/routine-cli-proposals.js";
import { RoutineCliError } from "./routine-cli-errors.js";
/** Registered current runtime is authority; immutable dispatch identity alone never is. */
export function assertRoutineCliProposalBinding(registry: Pick<BotRuntimeRegistry, "lookupRun" | "inferenceSignal">, binding: BotRuntimeBinding,
  receipt: RoutineCliRequestRecord, dispatch: RoutineCliProposalRecord, signal: AbortSignal) {
  const current = registry.lookupRun(binding);
  if (signal.aborted || registry.inferenceSignal(binding)?.aborted !== false || !current || !isDeepStrictEqual(current, binding) || binding.group || binding.requestClass !== "interactive"
    || !binding.capabilities.includes("routine.propose") || binding.ownerId !== receipt.target.ownerId || binding.botId !== receipt.target.botId
    || binding.chatId !== receipt.target.chatId || binding.runId !== dispatch.run_id || binding.taskId !== dispatch.task_id
    || binding.accessSourceId !== "matrix_chatgpt_plan" || !binding.subscription || binding.subscription.computerId !== receipt.target.computerId
    || receipt.operation.operation !== "propose" || binding.route.modelId !== receipt.operation.proposal.selection.model) throw new RoutineCliError("permission_denied");
}
