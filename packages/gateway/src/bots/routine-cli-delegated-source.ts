import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { BotRuntimeBinding, BotRuntimeRegistry } from "./runtime-registry.js";
import type { RoutineSourceProducer } from "./routine-action-source-registry.js";
import type { CanonicalProviderRunEvent } from "../chat/provider-adapter.js";
import { currentRoutineParent } from "./routine-cli-existing-binding.js";
/** Host-owned actual child invocation plus independently admitted real parent. Unknown parent provenance
 * requires exact owner consent; capability names and the parent's mode never manufacture full authority. */
export function createDelegatedRoutineSourceProducer(options: { binding: BotRuntimeBinding; computerId: string; signal: AbortSignal;
  registry: Pick<BotRuntimeRegistry, "lookupRun" | "inferenceSignal">; current(): boolean; publish(event: CanonicalProviderRunEvent): void }): RoutineSourceProducer {
  const binding = structuredClone(options.binding), child = `child_${randomBytes(24).toString("hex")}`;
  const producer: RoutineSourceProducer = {
    source: { ownerId: binding.ownerId, computerId: options.computerId, harness: "claude", generation: binding.executionGeneration,
      identity: { kind: "bot_child", taskId: binding.taskId, runId: binding.runId, runtimeHandle: binding.runtimeHandle, childInvocationId: child },
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
      actions: [...(binding.capabilities.includes("routine.control") ? ["read" as const] : []), ...(binding.capabilities.includes("routine.propose") ? ["propose" as const] : []), ...(binding.capabilities.includes("routine.control") ? ["control" as const] : [])] },
    signal: options.signal, publish: options.publish,
    readPolicy: () => ({ live: !options.signal.aborted && options.current() && isDeepStrictEqual(options.registry.lookupRun(binding), binding) && options.registry.inferenceSignal(binding)?.aborted === false,
      scope: binding.group ? "shared" : "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: child }),
    async validateWithin(source, trx, _action, invocation) {
      if (!options.current() || options.signal.aborted || !isDeepStrictEqual(currentRoutineParent(options.registry, source), binding)) return false;
      const chat = await trx.selectFrom("chats").select("id").where("id", "=", binding.chatId).where("owner_id", "=", binding.ownerId)
        .where("owner_type", "=", "personal").where("lifecycle", "=", "active").where("collaboration", "is", null).forShare().executeTakeFirst();
      const run = await trx.selectFrom("chat_runs").select("id").where("id", "=", binding.runId).where("chat_id", "=", binding.chatId)
        .where("driver_kind", "=", "matrix_bot").where("permission_mode", "=", "default").where("interaction_mode", "=", "default")
        .where("status", "in", ["accepted", "running", "waiting_for_approval"]).forShare().executeTakeFirst();
      const task = await trx.selectFrom("bot_tasks").select("status").where("owner_id", "=", binding.ownerId).where("bot_id", "=", binding.botId)
        .where("chat_id", "=", binding.chatId).where("task_id", "=", binding.taskId).where("run_id", "=", binding.runId).forShare().executeTakeFirst();
      if (!chat || !run || !task) return false;
      if (task.status !== "running") {
        if (task.status !== "waiting_person" || !invocation) return false;
        // One-purpose FINAL consume check only: the same owning transaction inserted this immutable receipt.
        // New prepare/issue/target-resolution calls have no verified invocation here and cannot borrow the wait.
        const receipt = await trx.selectFrom("routine_cli_requests as q").innerJoin("bot_interactions as i", join => join.onRef("i.interaction_id", "=", sql<string>`q.admission ->> 'interactionId'`))
          .select("q.client_request_id").where("q.owner_id", "=", binding.ownerId).where("q.computer_id", "=", options.computerId)
          .where(sql<boolean>`q.source_invocation ->> 'invocationId' = ${invocation.invocationId}`)
          .where(sql<boolean>`q.source_invocation ->> 'sourceId' = ${invocation.sourceId}`)
          .where(sql<boolean>`q.source_invocation ->> 'operationDigest' = ${invocation.operationDigest}`)
          .where(sql<boolean>`q.admission ->> 'disposition' = 'pending_approval'`)
          .where("i.owner_id", "=", binding.ownerId).where("i.bot_id", "=", binding.botId).where("i.chat_id", "=", binding.chatId)
          .where("i.task_id", "=", binding.taskId).where("i.source_run_id", "=", binding.runId).where("i.kind", "=", "approval").executeTakeFirst();
        if (!receipt) return false;
      }
      return !options.signal.aborted && options.current() && isDeepStrictEqual(options.registry.lookupRun(binding), binding);
    },
  };
  currentRoutineParent(options.registry, producer.source); return producer;
}
