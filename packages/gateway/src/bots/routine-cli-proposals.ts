import { recoverExistingRoutineProposal } from "./routine-cli-existing-recovery.js";
import { proposeWithinExistingRoutineBinding } from "./routine-cli-existing-binding.js";
import type { Kysely, Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import type { RoutineCliSourceService } from "./routine-cli-source.js";
import type { RoutineCliTargetService } from "./routine-cli-targets.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import type { BotRuntimeBinding, BotRuntimeRegistry } from "./runtime-registry.js";
import { freezeIntent, type RoutineCliMutationAdmission, type RoutineCliAfterMutationCommit, type RoutineCliRequestDependencies } from "./routine-cli-requests.js";
import type { BotTurnResult } from "./task-orchestrator.js";
import { createBotContinuationAdmitter } from "./continuations.js";
import { createRoutineCliRequestsRepository, lockRoutineCliRequest, type RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import { createRoutineCliProposalsRepository } from "./repositories/routine-cli-proposals.js";
import { createBotTasksRepository, type BotTask } from "./repositories/tasks.js";
import { RoutineCliScopeSchema, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import { ROUTINE_CLI_REQUEST_PREFIX, newRoutineCliCanonicalRequestId, routineCliProposalInput, routineCliCanonicalRun, routineCliCanonicalHashMatches } from "./routine-cli-proposal-identity.js";
import { assertRoutineCliProposalBinding } from "./routine-cli-proposal-runtime.js";

export interface RoutineCliProposalTaskInput { ownerId: string; botId: string; chatId: string; runId: string; text: string; now: string }
export interface RoutineCliProposalRuntime {
  beginWithin(tx: BotStateTransaction, input: RoutineCliProposalTaskInput): Promise<{ task: BotTask; continued: false }>;
  consume(binding: BotRuntimeBinding, signal: AbortSignal): Promise<BotTurnResult | undefined>;
  recover(input: { ownerId: string; taskId: string; chatId?: string; runId?: string }): Promise<boolean>;
}
export interface RoutineCliProposalDependencies {
  db: Kysely<OwnerBotDatabase>; scope: RoutineCliScope; transact: BotStateTransactions;
  sources: Pick<RoutineCliSourceService, "validateAcceptedWithin">;
  targets: Pick<RoutineCliTargetService, "validatePinnedWithin" | "validateClaimedTargetWithin">;
  authorizeTarget: NonNullable<RoutineCliRequestDependencies["authorizeTarget"]>;
  approvals: Pick<BotRoutineApprovals, "proposeWithin">;
  registry: Pick<BotRuntimeRegistry, "lookupRun" | "inferenceSignal">;
  canonical: Parameters<typeof createBotContinuationAdmitter>[0] & { repository: Parameters<typeof createBotContinuationAdmitter>[0]["repository"] & Pick<import("../chat/repository.js").ChatRepository, "findTurnAdmission"> };
  now?: () => Date;
}
/** Internal one-intent handoff. Reservation/admission, task claim and approval are distinct durable stages.
 * No public issuer, manufactured binding, inference pass, retry loop or new scheduled executor. */
export function createRoutineCliProposals(deps: RoutineCliProposalDependencies) {
  const scope = RoutineCliScopeSchema.parse(deps.scope), ledger = createRoutineCliRequestsRepository(deps.db), dispatches = createRoutineCliProposalsRepository(deps.db);
  if ([deps.transact, deps.sources?.validateAcceptedWithin, deps.targets?.validateClaimedTargetWithin, deps.targets?.validatePinnedWithin,
    deps.authorizeTarget, deps.approvals?.proposeWithin, deps.registry?.lookupRun, deps.registry?.inferenceSignal,
    deps.canonical?.repository?.get, deps.canonical?.repository?.findTurnAdmission, deps.canonical?.repository?.findQueuedAdmission,
    deps.canonical?.orchestrator?.admitTurn, deps.canonical?.orchestrator?.enqueueQueuedTurn]
    .some(dependency => typeof dependency !== "function")) throw new RoutineCliError("unavailable");
  const admit = createBotContinuationAdmitter(deps.canonical), now = () => (deps.now?.() ?? new Date()).toISOString();
  const requireReceipt = async (requestId: string, tx: BotStateTransaction): Promise<RoutineCliRequestRecord> => {
    const receipt = await ledger.get(scope, requestId, tx.db);
    if (!receipt || receipt.operation.operation !== "propose" || receipt.target.ownerId !== scope.ownerId || receipt.target.computerId !== scope.computerId) throw new RoutineCliError("permission_denied");
    return receipt;
  };
  const resolveRun = async (input: { ownerId: string; chatId: string; runId: string }, tx: BotStateTransaction) => {
    const candidate = await tx.db.selectFrom("chat_runs as r").innerJoin("chat_turns as t", "t.id", "r.turn_id")
      .select(["r.client_request_id", "t.client_request_id as original_request_id"]).where("r.id", "=", input.runId).executeTakeFirst();
    const claimed = await tx.db.selectFrom("routine_cli_proposals").select("client_request_id").where("owner_id", "=", scope.ownerId)
      .where("computer_id", "=", scope.computerId).where("run_id", "=", input.runId).executeTakeFirst();
    if (!candidate?.client_request_id.startsWith(ROUTINE_CLI_REQUEST_PREFIX)
      && !candidate?.original_request_id.startsWith(ROUTINE_CLI_REQUEST_PREFIX) && !claimed) return undefined;
    if (!candidate?.client_request_id.startsWith(ROUTINE_CLI_REQUEST_PREFIX)) throw new RoutineCliError("permission_denied");
    const run = await routineCliCanonicalRun(tx.db, input);
    if (!run) throw new RoutineCliError("permission_denied");
    const dispatch = await dispatches.byCanonical(input.ownerId, run.client_request_id, tx.db);
    if (input.ownerId !== scope.ownerId || dispatch?.computer_id !== scope.computerId || !dispatch || run.driver_kind !== "matrix_bot" || run.attempt !== 1
      || run.original_request_id !== run.client_request_id
      || run.permission_mode !== "default" || run.interaction_mode !== "default") throw new RoutineCliError("permission_denied");
    if (!await routineCliCanonicalHashMatches(tx.db, run, input.chatId, dispatch.request_hash)) throw new RoutineCliError("permission_denied");
    const receipt = await requireReceipt(dispatch.client_request_id, tx);
    if (receipt.target.chatId !== input.chatId || routineCliProposalInput(receipt).hash !== dispatch.request_hash) throw new RoutineCliError("permission_denied");
    return { run, dispatch, receipt };
  };
  const recover: RoutineCliProposalRuntime["recover"] = async input => deps.transact(input.ownerId, async tx => {
    const row = await tx.db.selectFrom("routine_cli_proposals").selectAll().where("owner_id", "=", input.ownerId).where("computer_id", "=", scope.computerId)
      .where("task_id", "=", input.taskId).executeTakeFirst();
    if (!row) return recoverExistingRoutineProposal(tx, scope, input);
    if (row.stage !== "pending_approval" || !row.interaction_id || input.runId && row.run_id !== input.runId) return false;
    const receipt = await requireReceipt(row.client_request_id, tx);
    if (input.chatId && receipt.target.chatId !== input.chatId) return false;
    const interaction = await tx.db.selectFrom("bot_interactions as i").innerJoin("bot_approvals as a", "a.approval_id", "i.interaction_id")
      .select(["i.status", "i.task_id", "i.source_run_id", "a.run_id"])
      .where("i.owner_id", "=", input.ownerId).where("a.owner_id", "=", input.ownerId).where("i.bot_id", "=", receipt.target.botId)
      .where("a.bot_id", "=", receipt.target.botId).where("i.chat_id", "=", receipt.target.chatId).where("i.interaction_id", "=", row.interaction_id)
      .where("i.kind", "=", "approval").where("a.tool", "=", "routine.activate").executeTakeFirst();
    const task = await createBotTasksRepository(tx.db).get({ ownerId: input.ownerId, taskId: input.taskId }, tx.db);
    return !!interaction && !!task && task.botId === receipt.target.botId && task.chatId === receipt.target.chatId
      && interaction.task_id === task.taskId && interaction.source_run_id === row.run_id && interaction.run_id === row.run_id
      && (interaction.status !== "pending" || task.status === "waiting_person" && task.runId === row.run_id);
  });
  const admitMutation: RoutineCliMutationAdmission = async ({ transaction, source, target, operation }) => {
    if (operation.operation !== "propose") throw new RoutineCliError("unavailable");
    if (source.identity.kind === "bot_child") return proposeWithinExistingRoutineBinding({ registry: deps.registry, approvals: deps.approvals, transaction, source, target, operation, now: now() });
    if (source.identity.kind === "chat_run" && source.identity.chatId === target.chatId) throw new RoutineCliError("permission_denied");
    await dispatches.reserve({ scope, requestId: operation.requestId, canonicalRequestId: newRoutineCliCanonicalRequestId(),
      requestHash: routineCliProposalInput({ operation }).hash, now: now() }, transaction.db);
    return { disposition: "queued" };
  };
  const afterMutationCommit: RoutineCliAfterMutationCommit = async ({ operation, admission }) => {
    if (operation.operation !== "propose" || admission.disposition === "pending_approval") return;
    const selected = await deps.transact(scope.ownerId, async tx => {
      await lockRoutineCliRequest(tx.db as Transaction<OwnerBotDatabase>, scope, operation.requestId);
      const receipt = await requireReceipt(operation.requestId, tx), dispatch = await dispatches.get(scope, operation.requestId, tx.db, true);
      if (!dispatch || dispatch.stage !== "reserved" || dispatch.request_hash !== routineCliProposalInput(receipt).hash) return undefined;
      await dispatches.advance(dispatch, { stage: "submitting" }, now(), tx.db);
      return { receipt, dispatch };
    });
    if (!selected) return; // No replay, even when previous submit acknowledgement was lost.
    const { receipt, dispatch } = selected, owner = { type: "personal" as const, ownerId: scope.ownerId };
    try { await admit({ userId: scope.ownerId, source: "configured-container" }, { chatId: receipt.target.chatId,
      clientRequestId: dispatch.canonical_request_id, text: routineCliProposalInput(receipt).text }); }
    catch (error: unknown) { console.warn("[routine-cli-proposals] Canonical admission unconfirmed", error instanceof Error ? error.name : "UnknownError"); }
    // Reconcile exact original request/hash, never guess acceptance from a generic run status or retry.
    let stage: "canonical_queued" | "canonical_accepted" | "unknown" = "unknown";
    const queued = await deps.canonical.repository.findQueuedAdmission(owner, receipt.target.chatId, dispatch.canonical_request_id, dispatch.request_hash);
    if (queued) stage = "canonical_queued";
    else if (await deps.canonical.repository.findTurnAdmission(owner, receipt.target.chatId, dispatch.canonical_request_id, dispatch.request_hash)) stage = "canonical_accepted";
    await deps.transact(scope.ownerId, async tx => {
      const current = await dispatches.get(scope, operation.requestId, tx.db, true);
      if (current?.stage === "submitting") await dispatches.advance(current, { stage }, now(), tx.db);
    });
  };
  const beginWithin: RoutineCliProposalRuntime["beginWithin"] = async (tx, input) => {
    const found = await resolveRun(input, tx);
    if (!found || !["accepted", "running"].includes(found.run.status) || input.botId !== found.receipt.target.botId || input.text !== routineCliProposalInput(found.receipt).text) throw new RoutineCliError("permission_denied");
    const receipt = freezeIntent(found.receipt);
    return deps.sources.validateAcceptedWithin(tx.db as Transaction<OwnerBotDatabase>, receipt, async () => {
      await lockRoutineCliRequest(tx.db as Transaction<OwnerBotDatabase>, scope, receipt.requestId);
      const dispatch = await dispatches.get(scope, receipt.requestId, tx.db, true);
      if (!dispatch || !["submitting", "canonical_queued", "canonical_accepted"].includes(dispatch.stage) || dispatch.task_id || dispatch.run_id) throw new RoutineCliError("permission_denied");
      const target = freezeIntent(await deps.targets.validatePinnedWithin(tx.db as Transaction<OwnerBotDatabase>, receipt.source, "propose", receipt.target));
      if (await deps.authorizeTarget(freezeIntent({ source: receipt.source, invocation: receipt.invocation, target, operation: receipt.operation }), tx) !== true) throw new RoutineCliError("permission_denied");
      const tasks = createBotTasksRepository(tx.db), queued = await tasks.create({ ownerId: input.ownerId, botId: input.botId, chatId: input.chatId, now: input.now }, tx.db);
      const task = await tasks.transition({ ownerId: input.ownerId, taskId: queued.taskId, baseRevision: queued.revision, to: "running", runId: input.runId, now: input.now }, tx.db);
      await dispatches.advance(dispatch, { stage: "target_task_claimed", task_id: task.taskId, run_id: input.runId }, now(), tx.db);
      await tx.publish(task.chatId, "bot.task.updated", { taskId: task.taskId, chatId: task.chatId, agentId: task.botId, status: task.status, revision: task.revision });
      return { task, continued: false as const };
    });
  };
  const consume: RoutineCliProposalRuntime["consume"] = async (binding, signal) => {
    let intent = false;
    try {
      return await deps.transact(binding.ownerId, async tx => {
        const found = await resolveRun(binding, tx);
        if (!found) return undefined;
        intent = true;
        await lockRoutineCliRequest(tx.db as Transaction<OwnerBotDatabase>, scope, found.receipt.requestId);
        const dispatch = await dispatches.get(scope, found.receipt.requestId, tx.db, true);
        if (!dispatch || dispatch.stage !== "target_task_claimed") throw new RoutineCliError("permission_denied");
        const { receipt } = found;
        assertRoutineCliProposalBinding(deps.registry, binding, receipt, dispatch, signal);
        await deps.targets.validateClaimedTargetWithin(tx.db as Transaction<OwnerBotDatabase>, receipt.target);
        assertRoutineCliProposalBinding(deps.registry, binding, receipt, dispatch, signal);
        const pending = await deps.approvals.proposeWithin(tx, binding, receipt.operation.operation === "propose" ? receipt.operation.proposal : undefined);
        const tasks = createBotTasksRepository(tx.db), task = await tasks.get({ ownerId: binding.ownerId, taskId: binding.taskId }, tx.db);
        if (!task || task.status !== "running" || task.runId !== binding.runId) throw new RoutineCliError("permission_denied");
        const waiting = await tasks.transition({ ownerId: binding.ownerId, taskId: task.taskId, baseRevision: task.revision, to: "waiting_person", now: now() }, tx.db);
        await tx.publish(binding.chatId, "bot.task.updated", { taskId: task.taskId, chatId: task.chatId, agentId: task.botId, status: waiting.status, revision: waiting.revision });
        await dispatches.advance(dispatch, { stage: "pending_approval", interaction_id: pending.interactionId, runtime_handle: binding.runtimeHandle, execution_generation: binding.executionGeneration }, now(), tx.db);
        await deps.targets.validateClaimedTargetWithin(tx.db as Transaction<OwnerBotDatabase>, receipt.target);
        assertRoutineCliProposalBinding(deps.registry, binding, receipt, dispatch, signal);
        return { status: "waiting_person" as const }; // Already atomically settled; no generic settle afterward.
      });
    } catch (error: unknown) {
      if (!intent) throw error;
      console.warn("[routine-cli-proposals] Proposal outcome requires reconciliation", error instanceof Error ? error.name : "UnknownError");
      try { if (await recover(binding)) return { status: "waiting_person" }; }
      catch (readError: unknown) {
        console.warn("[routine-cli-proposals] Proposal readback unconfirmed", readError instanceof Error ? readError.name : "UnknownError");
        return { status: "uncertain" }; // Cannot safely overwrite a possibly committed waiting task.
      }
      throw error; // Known no committed pending proposal: ordinary failure settlement may run.
    }
  };
  return { admitMutation, afterMutationCommit, beginWithin, consume, recover };
}
export type RoutineCliProposals = ReturnType<typeof createRoutineCliProposals>;
