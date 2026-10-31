import { isDeepStrictEqual } from "node:util";
import type { RoutineCliSourceContext } from "./routine-cli-source-context.js";
import type { BotRuntimeBinding, BotRuntimeRegistry } from "./runtime-registry.js";
import type { RoutineCliResolvedTarget } from "./routine-cli-targets.js";
import type { BotStateTransaction } from "./events.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import type { RoutineCliMutationOperation } from "./routine-cli-requests.js";
import { createBotTasksRepository } from "./repositories/tasks.js";
import { RoutineCliError } from "./routine-cli-errors.js";
/** Existing live parent only: no canonical request ID, task, runtime or backgroundTaskId is created. */
export function currentRoutineParent(registry: Pick<BotRuntimeRegistry, "lookupRun" | "inferenceSignal">, source: RoutineCliSourceContext, target?: RoutineCliResolvedTarget): BotRuntimeBinding {
  const identity = source.identity;
  if (identity.kind !== "bot_child" || source.harness !== "claude") throw new RoutineCliError("permission_denied");
  const binding = registry.lookupRun({ ...identity, executionGeneration: source.generation });
  if (!binding || "kind" in binding || !binding.capabilities.includes("agent.task") || binding.group || binding.requestClass !== "interactive" || registry.inferenceSignal(binding)?.aborted !== false
    || binding.ownerId !== source.ownerId || binding.taskId !== identity.taskId || binding.subscription?.computerId !== source.computerId
    || target && (binding.ownerId !== target.ownerId || binding.botId !== target.botId || binding.chatId !== target.chatId || source.computerId !== target.computerId)) throw new RoutineCliError("permission_denied");
  return binding;
}
export async function proposeWithinExistingRoutineBinding(input: { registry: Pick<BotRuntimeRegistry, "lookupRun" | "inferenceSignal">; approvals: Pick<BotRoutineApprovals, "proposeWithin">;
  transaction: BotStateTransaction; source: RoutineCliSourceContext; target: RoutineCliResolvedTarget; operation: RoutineCliMutationOperation; now: string }) {
  const { registry, source, target, operation, transaction: tx } = input, binding = currentRoutineParent(registry, source, target);
  const assert = () => { if (!isDeepStrictEqual(currentRoutineParent(registry, source, target), binding)) throw new RoutineCliError("permission_denied"); };
  if (operation.operation !== "propose" || !binding.capabilities.includes("routine.propose") || binding.accessSourceId !== "matrix_chatgpt_plan"
    || binding.route.modelId !== operation.proposal.selection.model) throw new RoutineCliError("permission_denied");
  const run = await tx.db.selectFrom("chat_runs").select("id").where("id", "=", binding.runId).where("chat_id", "=", binding.chatId)
    .where("driver_kind", "=", "matrix_bot").where("interaction_mode", "=", "default").where("permission_mode", "=", "default")
    .where("status", "in", ["accepted", "running", "waiting_for_approval"]).forShare().executeTakeFirst();
  const tasks = createBotTasksRepository(tx.db), task = await tasks.get({ ownerId: binding.ownerId, taskId: binding.taskId }, tx.db);
  if (!run || !task || task.runId !== binding.runId || task.botId !== binding.botId || task.chatId !== binding.chatId || task.status !== "running") throw new RoutineCliError("permission_denied");
  assert(); const pending = await input.approvals.proposeWithin(tx, binding, operation.proposal); assert();
  const waiting = await tasks.transition({ ownerId: binding.ownerId, taskId: task.taskId, baseRevision: task.revision, to: "waiting_person", now: input.now }, tx.db);
  await tx.publish(binding.chatId, "bot.task.updated", { taskId: task.taskId, chatId: task.chatId, agentId: task.botId, status: waiting.status, revision: waiting.revision });
  assert(); return { disposition: "pending_approval" as const, interactionId: pending.interactionId };
}
