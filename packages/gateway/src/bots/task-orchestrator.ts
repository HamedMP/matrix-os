import type { BotInputHistoryReader } from "./historical-input.js";
import { createBotWorkerDrain } from "./worker-drain.js";
import { BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES } from "@matrix-os/contracts";
import { prepareSteerableBotInputs, type SteerableBotInputs } from "./steerable-input.js";
import { deliverAcknowledgedSteer } from "../chat/steering-delivery.js";
import { sql } from "kysely";
import { isolatedChatModelMatches, isManagedCustomBot, type ChatAgent } from "@matrix-os/contracts";
import { sameCustomCoordinatorSelection } from "./custom-procedure.js";
import { recipeCoordinatorSelection } from "./coordinator-selection.js";
/**
 * Runs one bot turn in the bot workload (spec 536). For each canonical run:
 *
 * 1. Resolve the bot from the chat's live direct binding, its saved
 *    definition, and its recipe; a bot without them never runs.
 * 2. Create a task and move it to `running` with the run ID.
 * 3. Resolve the model route through Provider V3 and build the run spec the
 *    worker loads with `bot.run.load`.
 * 4. Admit a private runtime, relay `bot.run`, and stream the events the
 *    broker receives until the worker answers with the run's outcome.
 * 5. Move the task to its final state, then release the runtime.
 *
 * A running workload keeps its supervised runtime lease alive. Waits for a
 * person or for capacity end the run; they never hold a runtime. Active runs
 * are bounded by the runtime registry's capacity.
 */
import {
  BotRunOutcomeSchema,
  BotRunSpecSchema,
  type BotEvent,
  type BotRunSpec,
  type BotRunStatus,
  type BotToolCapability,
} from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import { createCanonicalCliEventQueue, type CanonicalCliEventQueue } from "../chat/cli-process.js";
import type { ScopeRuntimeHostClient } from "../scope-runtime-host/index.js";
import { BotAdmissionError, type PrivateBotAdmission, type GroupBotRunRequest } from "./admission.js";
import { readTrustedBotRunLimits } from "./trusted-inference-limits.js";
import { BotBrokerActionError, untilAborted, type BotEventSink, type BotRunSource } from "./broker-actions.js";
import { BotRecipeCatalogError, type BotRecipeCatalog } from "./recipe-catalog.js";
import type { BotBindingsRepository } from "./repositories/bindings.js";
import type { BotStateTransactions } from "./events.js";
import { beginBotTask } from "./task-begin.js";
import type { BotInteractionService } from "./interactions.js";
import type { BotMemoryService } from "./memory-service.js";
import { createBotTasksRepository, type BotBlockedReason, type BotTask } from "./repositories/tasks.js";
import { BotRouteError, type ResolvedBotRoute } from "./route-resolver.js";
import { requireGroupBotAuthority, type GroupBotAuthorizer, BOT_RUNTIME_REGISTRY_CAPACITY, isManagedPiBinding, type BotRuntimeRegistry } from "./runtime-registry.js";
import { readOwnerSoul, OwnerPersonalityError, type OwnerPersonalityConfig } from "./owner-personality.js";
import { buildBotSystemPrompt, BotSystemPromptError } from "./system-prompt.js";
import { BotSetupStepError, runBotSetupStep } from "./setup-step.js";

/** How long a worker that took the cancel has to end its run before its runtime is stopped. */
const CANCEL_GRACE_MS = 10_000;
const MAX_QUEUED_EVENTS = 1_000;
/** Tools the broker serves today; the rest of a recipe's set arrives with later layers. */
const SERVED_CAPABILITIES: readonly BotToolCapability[] = [
  "artifact.read", "artifact.write", "interaction.create", "memory.propose", "memory.search",
  "integration.inventory", "integration.call", "jev.inbox",
];

export type BotTurnEvent =
  | { kind: "event"; event: BotEvent["event"] }
  | { kind: "state"; state: BotChatRunState };

export interface BotChatRunState {
  taskId: string;
  runtimeHandle?: string;
  executionGeneration?: string;
}

export interface BotTurnResult {
  status: BotRunStatus;
  blockedReason?: BotBlockedReason;
  inputUnavailable?: boolean;
  /** Server proof: admission refused capacity before a worker was started. */
  retryableBeforeDispatch?: true;
}

export interface BotTurnHandle {
  events: AsyncIterable<BotTurnEvent>;
  result: Promise<BotTurnResult>;
}

interface ActiveRun {
  ownerId: string;
  chatId: string;
  inputs?: SteerableBotInputs;
  signal: AbortSignal;
  setupAbort: AbortController;
  prelaunch: AbortController;
  spec?: BotRunSpec;
  runtime?: { runtimeHandle: string; executionGeneration: string };
  renewal?: { stop(): Promise<void> };
  queue: CanonicalCliEventQueue<BotTurnEvent>;
  stopping?: "cancelled" | "lease_lost" | "deadline";
  finished?: boolean;
  worker?: ReturnType<typeof createBotWorkerDrain>;
  releasing?: Promise<void>;
}

export class BotTurnError extends Error {
  constructor(readonly code: "capacity_exceeded" | "invalid_request") {
    super(`Bot turn refused: ${code}`);
    this.name = "BotTurnError";
  }
}

export function createBotTaskOrchestrator(deps: {
  homePath?: string; expectedOwnerId?: string | null; inputHistory?: BotInputHistoryReader;
  assertSource?(binding: import("./runtime-registry.js").PiRuntimeBinding, signal: AbortSignal): Promise<void>;
  bindings: Pick<BotBindingsRepository, "forChat">;
  /** Task writes and their `bot.task.updated` events commit together. */
  transact: BotStateTransactions;
  interactions?: Pick<BotInteractionService, "answerWithMessage">;
  routineTools?: boolean;
  memory?: Pick<BotMemoryService, "admitted">;
  agents: Pick<ChatAgentStore, "get">;
  recipes: BotRecipeCatalog;
  resolveProcedure?(ownerId: string, agent: ChatAgent): Promise<import("./recipe-catalog.js").BotRecipe>;
  resolveRoute(selection?: import("@matrix-os/contracts").CanonicalChatModelSelection, requestClass?: "interactive" | "background"): Promise<ResolvedBotRoute>;
  executorReady?(ownerId: string, botId: string): Promise<boolean>;
  /** Exact run-bound owner policy route; groups never consult the personal default resolver. */
  resolveGroupRoute?(input: { ownerId: string; chatId: string; runId: string; group: GroupBotRunRequest }): Promise<ResolvedBotRoute>;
  admission: Pick<PrivateBotAdmission, "admit" | "release" | "startRenewal"> & Partial<Pick<PrivateBotAdmission, "ownsDirectChat">>;
  personality?: OwnerPersonalityConfig;
  isolatedChat?: import("../chat/isolated-chat-envelope.js").IsolatedChatAuthority;
  /** Server-owned canonical run identity; must resolve requesting actor, scope and shared root. */
  resolveGroupRun?(input: { ownerId: string; chatId: string; runId: string }): Promise<GroupBotRunRequest>;
  authorizeGroup?: GroupBotAuthorizer;
  registry: Pick<BotRuntimeRegistry, "lookupRun" | "cancelInference">;
  client: Pick<ScopeRuntimeHostClient, "runBot">;
  onRunFinished?(runId: string): void;
  now?: () => Date;
  /** Test hook; 10 seconds, and never longer. */
  cancelGraceMs?: number;
}) {
  const limits = readTrustedBotRunLimits();
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const cancelGraceMs = Math.max(1, Math.min(Math.trunc(deps.cancelGraceMs ?? CANCEL_GRACE_MS), CANCEL_GRACE_MS));
  /** At most one entry per bound runtime; the registry allows 64. */
  const active = new Map<string, ActiveRun>();

  async function directBot(ownerId: string, chatId: string): Promise<string | null> {
    const bindings = await deps.bindings.forChat({ ownerId, chatId });
    return bindings.find((binding) => binding.kind === "direct")?.botId ?? null;
  }

  function taskEvent(task: BotTask) {
    return {
      taskId: task.taskId, chatId: task.chatId, agentId: task.botId, status: task.status,
      ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}), revision: task.revision,
    };
  }

  /**
   * Starts the run's task: the bot's task waiting for the owner continues
   * with this message; otherwise a new task begins.
   */
  async function begin(input: { ownerId: string; botId: string; chatId: string; runId: string; text: string; backgroundTaskId?: string }): Promise<{ task: BotTask; continued: boolean }> {
    return deps.transact(input.ownerId, tx => beginBotTask(tx, { ...input, now: now() }));
  }

  async function settle(task: BotTask, status: BotRunStatus, blockedReason?: BotBlockedReason): Promise<BotTurnResult> {
    const to = status === "waiting_capacity" ? "blocked"
      : status === "uncertain" ? "failed"
      : status;
    const reason = status === "waiting_capacity" ? "capacity_unavailable" : blockedReason;
    try {
      await deps.transact(task.ownerId, async (tx) => {
        const at = now();
        // A fast answer may already be queued while its source turn is settling.
        // Retain that exact run's continuation; a later run must still complete.
        const waiting = to === "completed" && await tx.db.selectFrom("bot_interactions").select("interaction_id")
          .where("owner_id", "=", task.ownerId).where("task_id", "=", task.taskId)
          .where("blocking", "=", true).where(eb => eb.or([
            eb("status", "=", "pending"),
            eb.and([eb("status", "=", "resolved"), eb("source_run_id", "=", task.runId ?? ""),
              eb("expires_at", ">", at), eb(sql<string>`jsonb_typeof(resolution -> 'continuation')`, "=", "string")]),
          ]))
          .executeTakeFirst() !== undefined;
        const settled = await createBotTasksRepository(tx.db).transition({
          ownerId: task.ownerId, taskId: task.taskId, baseRevision: task.revision, to: waiting ? "waiting_person" : to,
          ...(to === "blocked" ? { blockedReason: reason ?? "tool_unavailable" } : {}),
          now: at,
        }, tx.db);
        await tx.publish(settled.chatId, "bot.task.updated", taskEvent(settled));
      });
    } catch (error: unknown) {
      console.warn("[bots] task state was not recorded:", error instanceof Error ? error.name : "UnknownError");
    }
    return { status, ...(to === "blocked" ? { blockedReason: reason ?? "tool_unavailable" } : {}) };
  }

  /**
   * Asks the worker to stop the run. A worker that does not take the cancel
   * (the run has not started, or it is unresponsive) is stopped outright,
   * which ends the pending `bot.run` relay; one that takes it but does not
   * end its run within the grace period is stopped the same way.
   */
  async function stopRenewal(run: ActiveRun): Promise<void> {
    try {
      await run.renewal?.stop();
    } catch (error: unknown) {
      console.warn("[bots] bot runtime renewal could not stop:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  function releaseRuntime(run: ActiveRun, runtimeHandle: string): Promise<void> {
    return run.releasing ??= deps.admission.release(runtimeHandle);
  }

  async function stopRuntime(run: ActiveRun, runId: string, reason: "cancelled" | "lease_lost" | "deadline"): Promise<void> {
    if (run.stopping) return;
    run.stopping = reason;
    if (reason === "cancelled") run.worker?.stop();
    else if (run.worker) void run.worker.release().catch((error: unknown) => {
      console.warn("[bots] revoked runtime release failed:", error instanceof Error ? error.name : "UnknownError");
    });
    run.setupAbort.abort(new DOMException("Bot run stopped", "AbortError"));
    run.inputs?.dispose();
    const renewalStopped = stopRenewal(run);
    const runtime = run.runtime;
    const wasRunning = Boolean(runtime && !run.finished);
    const binding = runtime && wasRunning ? deps.registry.lookupRun({ ...runtime, runId }) : undefined;
    if (binding) deps.registry.cancelInference(binding);
    let cancelReply: Promise<boolean> | undefined;
    try {
      if (runtime && wasRunning) cancelReply = deps.client.runBot({ ...runtime, command: { version: 1, kind: "bot.cancel", runId } }).then(
        (reply) => reply.ok,
        (error: unknown) => {
          console.warn("[bots] bot cancel was not delivered:", error instanceof Error ? error.name : "UnknownError");
          return false;
        },
      );
    } catch (error: unknown) {
      console.warn("[bots] bot cancel was not delivered:", error instanceof Error ? error.name : "UnknownError");
    }
    await renewalStopped;
    if (!runtime || !wasRunning) return;
    let delivered = false;
    try {
      delivered = await cancelReply ?? false;
    } catch (error: unknown) {
      console.warn("[bots] bot cancel was not delivered:", error instanceof Error ? error.name : "UnknownError");
    }
    if (!delivered) {
      await (run.worker?.release() ?? releaseRuntime(run, runtime.runtimeHandle));
      return;
    }
  }

  async function groupWait<T>(run: ActiveRun, work: () => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([run.signal, AbortSignal.timeout(10_000)]);
    signal.throwIfAborted();
    const value = await untilAborted(work(), signal);
    signal.throwIfAborted();
    return value;
  }

  function groupFailure(run: ActiveRun, error: unknown): BotTurnResult {
    if (run.signal.aborted) return { status: "cancelled" };
    if (error instanceof Error && error.name === "TimeoutError") return { status: "blocked", blockedReason: "deadline_reached" };
    return { status: "failed" };
  }

  async function execute(input: { ownerId: string; chatId: string; runId: string; text: string; parts?: readonly import("@matrix-os/contracts").CanonicalChatMessagePart[]; selection?: import("@matrix-os/contracts").CanonicalChatModelSelection; signal: AbortSignal; backgroundTaskId?: string }, run: ActiveRun): Promise<BotTurnResult> {
    const owner = { type: "personal" as const, ownerId: input.ownerId };
    const setup = <T>(operation: () => Promise<T>, onLateSuccess?: (value: T) => void | Promise<void>) =>
      runBotSetupStep(operation, run.setupAbort.signal, onLateSuccess);
    const interrupted = (error: unknown) => error instanceof BotSetupStepError;
    const interruptedStatus = (): BotRunStatus => run.stopping === "cancelled" ? "cancelled" : "failed";
    let bindings: Awaited<ReturnType<typeof deps.bindings.forChat>>;
    try {
      await setup(() => Promise.all([...active.values()].filter(previous => previous !== run && previous.stopping
        && previous.ownerId === input.ownerId && previous.chatId === input.chatId).map(previous => previous.worker?.done)));
      bindings = await setup(() => deps.bindings.forChat({ ownerId: input.ownerId, chatId: input.chatId }));
    }
    catch (error: unknown) {
      if (!interrupted(error)) console.warn("[bots] bot binding unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { status: interruptedStatus() };
    }
    // Ambiguous direct/group bindings never get an authority fallback.
    if (bindings.length !== 1) return { status: "failed" };
    const chatBinding = bindings[0]!;
    // Personal routines cannot borrow shared authority or mutate a group task.
    if (input.backgroundTaskId && chatBinding.kind !== "direct") return { status: "failed" };
    let group: GroupBotRunRequest | undefined;
    if (chatBinding.kind === "group") {
      if (run.signal.aborted) return { status: "cancelled" };
      if (!deps.resolveGroupRun) return { status: "failed" };
      try { group = await groupWait(run, () => deps.resolveGroupRun!(input)); } catch (error: unknown) {
        console.warn("[bots] group run context unavailable:", error instanceof Error ? error.name : "UnknownError");
        return groupFailure(run, error);
      }
      if (!group) return { status: "failed" };
      try { await groupWait(run, () => requireGroupBotAuthority({ ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, group: group! }, deps.authorizeGroup)); } catch (error: unknown) {
        console.warn("[bots] group turn denied:", error instanceof Error ? error.name : "UnknownError");
        return groupFailure(run, error);
      }
    }
    const botId = chatBinding.botId;
    let agent: ChatAgent | null;
    try { agent = botId ? await setup(() => deps.agents.get(owner, botId)) : null; }
    catch (error: unknown) {
      if (!interrupted(error)) console.warn("[bots] bot binding unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { status: interruptedStatus() };
    }
    if (!botId || !agent || agent.archived || !agent.recipeRef) return { status: "failed" };
    let recipe;
    try {
      if (isManagedCustomBot(agent) && (!deps.resolveProcedure || !sameCustomCoordinatorSelection(input.selection, agent.selection))) return { status: "failed" };
      recipe = deps.resolveProcedure ? await setup(() => deps.resolveProcedure!(input.ownerId, agent)) : deps.recipes.resolve(agent.recipeRef);
    } catch (error: unknown) {
      if (interrupted(error)) return { status: interruptedStatus() };
      if (error instanceof BotRecipeCatalogError || error instanceof BotRouteError) return { status: "failed" };
      throw error;
    }
    let selection: import("@matrix-os/contracts").CanonicalChatModelSelection | undefined;
    let isolatedModel: import("@matrix-os/contracts").IsolatedChatEnvelope["modelId"] | undefined;
    try {
      isolatedModel = !group ? deps.isolatedChat?.selectCanonical?.({ ownerId: input.ownerId, chatId: input.chatId,
        botId, recipeRef: agent.recipeRef }) : undefined;
      if (isolatedModel) {
        selection = recipeCoordinatorSelection(input.selection, agent.selection);
        deps.isolatedChat?.selectCanonical?.({ ownerId: input.ownerId, chatId: input.chatId,
          botId, recipeRef: agent.recipeRef, ...(selection ? { modelId: selection.model } : {}) });
        if (input.parts?.some(part => part.type !== "text")) throw new Error("Isolated Bot unavailable");
        if (recipe.identitySource !== "owner_soul" || selection && (selection.instanceId !== "matrix_pi_default" || selection.options?.length)) throw new Error("Isolated Bot unavailable");
        selection = { instanceId: "matrix_pi_default", model: isolatedModel === "anthropic/claude-sonnet-5"
          ? "claude-sonnet-5" : isolatedModel };
      }
    } catch (error: unknown) {
      console.warn("[bots] coordinator unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { status: "blocked", blockedReason: "policy_denied" };
    }
    let task: BotTask;
    let continued: boolean;
    try {
      ({ task, continued } = await setup(
        () => begin({ ownerId: input.ownerId, botId, chatId: input.chatId, runId: input.runId, text: input.text, ...(input.backgroundTaskId ? {backgroundTaskId:input.backgroundTaskId}: {}) }),
        ({ task: lateTask }) => settle(lateTask, interruptedStatus()).then(() => undefined),
      ));
    } catch (error: unknown) {
      if (!interrupted(error)) console.warn("[bots] bot task could not begin:", error instanceof Error ? error.name : "UnknownError");
      return { status: interruptedStatus() };
    }
    run.queue.push({ kind: "state", state: { taskId: task.taskId } });
    if (isolatedModel && continued) return settle(task, "blocked", "policy_denied");
    // A reply in Chat answers a question the waiting task still has open.
    try {
      if (continued && !group) await setup(async () => { await deps.interactions?.answerWithMessage({ ownerId: input.ownerId, taskId: task.taskId, chatId: input.chatId, text: input.text }); });
    } catch (error: unknown) {
      console.warn("[bots] task answer failed:", error instanceof Error ? error.name : "UnknownError");
      return settle(task, interrupted(error) ? interruptedStatus() : "failed");
    }
    if (input.signal.aborted) return settle(task, "cancelled");

    let resolved: ResolvedBotRoute;
    try {
      if (group) {
        if (!deps.resolveGroupRoute) throw new BotRouteError("model_unavailable");
        resolved = await groupWait(run, () => deps.resolveGroupRoute!({ ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, group: group! }));
      } else {
        const requested = isolatedModel ? selection : recipeCoordinatorSelection(input.selection, agent.selection);
        if (input.backgroundTaskId && (isolatedModel || requested?.instanceId !== "matrix_chatgpt_plan")) throw new BotRouteError("model_unavailable");
        resolved = await setup(() => input.backgroundTaskId ? deps.resolveRoute(requested, "background") : deps.resolveRoute(requested));
        if (input.backgroundTaskId && (resolved.accessSourceId !== "matrix_chatgpt_plan" || !resolved.subscription)) throw new BotRouteError("model_unavailable");
        if (isolatedModel) {
          if (resolved.accessSourceId !== "matrix_included" || resolved.subscription || resolved.anthropicApi
            || !isolatedChatModelMatches(isolatedModel, resolved.route.modelId)) throw new BotRouteError("model_unavailable");
          resolved = { ...resolved, route: { ...resolved.route, maxOutputTokens: 256 } };
        }
      }
    } catch (error: unknown) {
      if (interrupted(error)) return settle(task, interruptedStatus());
      if (group && run.signal.aborted) return settle(task, "cancelled");
      if (group && error instanceof Error && error.name === "TimeoutError") return settle(task, "blocked", "deadline_reached");
      if (!(error instanceof BotRouteError)) console.warn("[bots] model route unavailable:", error instanceof Error ? error.name : "UnknownError");
      return settle(task, "blocked", "model_unavailable");
    }
    // Shared turns cannot mount the runtime owner's personal uploads or retained input history.
    if (group && input.parts?.some(part => part.type === "attachment_reference")) {
      return { ...await settle(task, input.signal.aborted ? "cancelled" : "blocked", "policy_denied"), inputUnavailable: !input.signal.aborted };
    }
    try {
      run.inputs = await setup(() => prepareSteerableBotInputs({ homePath: group ? undefined : deps.homePath, expectedOwnerId: deps.expectedOwnerId, ownerId: input.ownerId, chatId: input.chatId, runId: input.runId, history: isolatedModel || group ? undefined : deps.inputHistory, historyFileRead: recipe.capabilities.includes("artifact.read"), parts: input.parts ?? [], route: resolved.route, imageTotalMaximum: resolved.accessSourceId === "matrix_included" ? BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES : undefined, signal: input.signal,
        assertActive: () => { if (run.stopping || run.finished || active.get(input.runId) !== run) throw new BotBrokerActionError("stale_generation"); } }),
      (lateInputs) => lateInputs.dispose());
    } catch (error: unknown) {
      if (interrupted(error)) return settle(task, interruptedStatus());
      if (!(error instanceof BotBrokerActionError)) console.warn("[bots] submitted input unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { ...await settle(task, input.signal.aborted ? "cancelled" : "blocked", "policy_denied"), inputUnavailable: !input.signal.aborted };
    }
    const capabilities = isolatedModel ? [] : recipe.capabilities.filter((capability) => SERVED_CAPABILITIES.includes(capability)
      && (!group || ["integration.inventory", "integration.call"].includes(capability)));
    if (!isolatedModel && !group && !input.backgroundTaskId && deps.routineTools) capabilities.push("routine.propose", "routine.control");
    if (run.inputs.fileAliases.length && !capabilities.includes("artifact.read")) return settle(task, "blocked", "policy_denied");
    try { if (!isolatedModel && !group && !input.backgroundTaskId && await setup(async () => await deps.executorReady?.(input.ownerId, botId))) capabilities.push('agent.task'); }
    catch (error) { console.warn('[bots] Saved task executor unavailable:', error instanceof Error ? error.name : 'UnknownError'); return interrupted(error) ? settle(task, interruptedStatus()) : settle(task, 'blocked', 'policy_denied'); }
    let memory: string[];
    try {
      memory = !group && deps.memory ? await setup(() => deps.memory!.admitted({ ownerId: input.ownerId, botId, chatId: input.chatId })) : [];
    } catch (error: unknown) {
      console.warn("[bots] admitted memory failed:", error instanceof Error ? error.name : "UnknownError");
      return settle(task, interrupted(error) ? interruptedStatus() : "failed");
    }
    try {
      let ownerSoul: string | undefined;
      if (!group && recipe.identitySource === "owner_soul" && deps.personality?.runtimeOwnerId === input.ownerId) {
        if (!await setup(async () => await deps.admission.ownsDirectChat?.({ ownerId: input.ownerId, botId, chatId: input.chatId }))) {
          throw new OwnerPersonalityError("unsafe_file");
        }
        ownerSoul = await setup(() => readOwnerSoul(deps.personality!.homePath));
      }
      run.spec = BotRunSpecSchema.parse({
        route: resolved.route,
        systemPrompt: buildBotSystemPrompt({ botName: agent.name, instructions: isManagedCustomBot(agent) ? recipe.instructions : agent.instructions, recipe, memory, ownerSoul, audience: group ? "group" : "personal", now: new Date(now()) }),
        capabilities,
        limits: isolatedModel ? { maxToolActions: 1, maxInferenceCalls: 1 } : limits,
        turn: { kind: "prompt", text: run.inputs.prompt(input.text), ...(run.inputs.imageCount ? { imageCount: run.inputs.imageCount } : {}) },
      });
    } catch (error: unknown) {
      if (interrupted(error)) return settle(task, interruptedStatus());
      if (error instanceof OwnerPersonalityError) console.warn("[bots] personality unavailable:", error.code);
      else if (!(error instanceof BotSystemPromptError)) console.warn("[bots] run spec invalid:", error instanceof Error ? error.name : "UnknownError");
      return settle(task, "blocked", "policy_denied");
    }

    let runtime;
    try {
      await setup(() => run.inputs!.revalidate());
      runtime = await setup(() => deps.admission.admit({
        ownerId: input.ownerId, botId, chatId: input.chatId, taskId: task.taskId, runId: input.runId,
        ...(isolatedModel ? { recipeRef: agent.recipeRef } : {}),
        ...(isManagedCustomBot(agent) ? { managedDefinitionRevision: agent.revision } : {}),
        route: resolved.route, accessSourceId: resolved.accessSourceId, ...(resolved.subscription ? { subscription: resolved.subscription } : {}), ...(resolved.anthropicApi ? { anthropicApi: resolved.anthropicApi } : {}), capabilities, requestClass: input.backgroundTaskId ? "background" : "interactive",
        ...(group ? { group, expectedRootFingerprint: group.executionRootFingerprint, signal: run.signal } : {}),
      }), (lateRuntime) => deps.admission.release(lateRuntime.runtimeHandle));
    } catch (error: unknown) {
      if (interrupted(error)) return settle(task, interruptedStatus());
      if (!(error instanceof BotAdmissionError)) throw error;
      if (group && run.signal.aborted) return settle(task, "cancelled");
      const result = await settle(task, "blocked", error.code === "capacity_exceeded" ? "capacity_unavailable" : "root_unavailable");
      return !group && error.code === "capacity_exceeded" ? { ...result, retryableBeforeDispatch: true } : result;
    }
    const binding = deps.registry.lookupRun({ runtimeHandle: runtime.runtimeHandle, executionGeneration: runtime.executionGeneration, runId: input.runId });
    if (!binding || isManagedPiBinding(binding)) { await deps.admission.release(runtime.runtimeHandle); return settle(task, "failed"); }
    run.runtime = { runtimeHandle: runtime.runtimeHandle, executionGeneration: runtime.executionGeneration };
    run.queue.push({ kind: "state", state: { taskId: task.taskId, ...run.runtime } });

    let onStopped: () => void = () => undefined;
    const stopped = new Promise<null>((resolve) => {
      onStopped = () => resolve(null);
      if (run.setupAbort.signal.aborted) resolve(null);
      else run.setupAbort.signal.addEventListener("abort", onStopped, { once: true });
    });
    try {
      run.renewal = deps.admission.startRenewal(binding, (error: unknown) => {
        console.warn("[bots] bot runtime lease lost:", error instanceof Error ? error.name : "UnknownError");
        void stopRuntime(run, input.runId, "lease_lost").catch((stopError: unknown) => {
          console.warn("[bots] bot lease-loss cancellation failed:", stopError instanceof Error ? stopError.name : "UnknownError");
        });
      }, ...(group ? [group.executionRoot] as const : [] as const));
      // Cancelled while the runtime was being admitted: the run never starts.
      if (input.signal.aborted || run.stopping) return await settle(task, run.stopping === "lease_lost" ? "failed" : "cancelled");
      run.inputs.bind(binding);
      if (isolatedModel) {
        const binding = deps.registry.lookupRun({ ...run.runtime, runId: input.runId });
        if (!binding) return await settle(task, "blocked", "policy_denied");
        const isolatedTurn = await setup(() => deps.isolatedChat!.claim(binding));
        if (run.stopping === "lease_lost") return await settle(task, "failed");
        if (!isolatedTurn?.target) return await settle(task, "blocked", "policy_denied");
        run.spec = BotRunSpecSchema.parse({ ...run.spec, isolatedTurn });
      }
      await setup(() => run.inputs!.revalidate());
      if (run.stopping === "lease_lost") return await settle(task, "failed");
      await setup(async () => { await deps.assertSource?.(binding, input.signal); });
      if (input.signal.aborted || run.stopping) return await settle(task, run.stopping === "lease_lost" ? "failed" : "cancelled");
      run.worker = createBotWorkerDrain({ graceMs: cancelGraceMs,
        release: () => releaseRuntime(run, run.runtime!.runtimeHandle),
        onError: error => console.warn("[bots] bot runtime grace release failed:", error instanceof Error ? error.name : "UnknownError"),
      });
      const reply = await Promise.race([
        run.worker.track(deps.client.runBot({ ...run.runtime, command: { version: 1, kind: "bot.run", runId: input.runId }, signal: run.worker.signal })),
        stopped,
      ]);
      // Stop is final even if an uncooperative worker replies with success afterward.
      if (run.stopping === "cancelled") return await settle(task, "cancelled");
      if (run.stopping === "lease_lost" || reply === null) return await settle(task, "failed");
      const outcome = reply.ok ? BotRunOutcomeSchema.safeParse(reply.reply) : undefined;
      if (!outcome?.success || outcome.data.runId !== input.runId) return await settle(task, "failed");
      return await settle(task, outcome.data.status, outcome.data.blockedReason);
    } catch (error: unknown) {
      if (!run.stopping) console.warn("[bots] bot run failed:", error instanceof Error ? error.name : "UnknownError");
      return await settle(task, run.stopping === "cancelled" ? "cancelled" : "failed");
    } finally {
      run.finished = true;
      run.setupAbort.signal.removeEventListener("abort", onStopped);
      await stopRenewal(run);
      if (run.stopping && run.worker) run.worker.stop();
      else await (run.worker?.release() ?? releaseRuntime(run, run.runtime.runtimeHandle));
    }
  }

  const runSource: BotRunSource = {
    async loadRunSpec(binding) {
      const run = active.get(binding.runId);
      const spec = run?.spec;
      if (!spec || run.stopping || run.finished || run.ownerId !== binding.ownerId || run.chatId !== binding.chatId
        || run.runtime?.runtimeHandle !== binding.runtimeHandle || run.runtime.executionGeneration !== binding.executionGeneration) throw new BotBrokerActionError("stale_generation");
      return spec;
    },
    async readImageChunk(binding, request) {
      const run = active.get(binding.runId);
      if (!run?.inputs) throw new BotBrokerActionError("stale_generation");
      run.inputs.assertAuthorized(binding);
      await deps.assertSource?.(binding, run.signal);
      const chunk = await run.inputs.readImageChunk(binding, request);
      await deps.assertSource?.(binding, run.signal);
      run.inputs.assertAuthorized(binding);
      return chunk;
    },
  };

  const eventSink: BotEventSink = {
    async publish(binding, event) {
      const run = active.get(binding.runId);
      if (!run || run.stopping || run.finished || run.ownerId !== binding.ownerId || run.chatId !== binding.chatId
        || run.runtime?.runtimeHandle !== binding.runtimeHandle || run.runtime.executionGeneration !== binding.executionGeneration) {
        throw new BotBrokerActionError("stale_generation");
      }
      run.queue.push({ kind: "event", event: event.event });
    },
  };

  return {
    runSource,
    eventSink,
    directBot,
    async readSubmittedArtifact(binding: import("./runtime-registry.js").PiRuntimeBinding, args: Extract<import("@matrix-os/contracts").BotToolRequest, { capability: "artifact.read" }>["args"]) {
      const run = active.get(binding.runId);
      if (!run?.inputs) throw new BotBrokerActionError("stale_generation");
      run.inputs.assertAuthorized(binding);
      await deps.assertSource?.(binding, run.signal);
      const result = await run.inputs.readArtifact(binding, args);
      await deps.assertSource?.(binding, run.signal);
      run.inputs.assertAuthorized(binding);
      return result;
    },
    /** Starts one turn. Events stream until the run's outcome is known. */
    start(input: { ownerId: string; chatId: string; runId: string; text: string; parts?: readonly import("@matrix-os/contracts").CanonicalChatMessagePart[]; selection?: import("@matrix-os/contracts").CanonicalChatModelSelection; signal: AbortSignal; backgroundTaskId?: string }): BotTurnHandle {
      if (!input.text.trim() && !input.parts?.some(part => part.type === "attachment_reference")) throw new BotTurnError("invalid_request");
      if (active.has(input.runId) || active.size >= BOT_RUNTIME_REGISTRY_CAPACITY) throw new BotTurnError("capacity_exceeded");
      const prelaunch = new AbortController();
      const run: ActiveRun = { ownerId: input.ownerId, chatId: input.chatId, prelaunch, signal: AbortSignal.any([input.signal, prelaunch.signal]), setupAbort: prelaunch, queue: createCanonicalCliEventQueue<BotTurnEvent>(MAX_QUEUED_EVENTS) };
      active.set(input.runId, run);
      const onAbort = () => {
        void stopRuntime(run, input.runId, "cancelled").catch((error: unknown) => {
          console.warn("[bots] bot cancellation failed:", error instanceof Error ? error.name : "UnknownError");
        });
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      const result = execute(input, run).finally(() => {
        run.finished = true;
        input.signal.removeEventListener("abort", onAbort);
        run.inputs?.dispose();
        run.queue.finish();
        const forget = () => { active.delete(input.runId); deps.onRunFinished?.(input.runId); };
        // Keep the bounded slot until the worker's checkpoint/release finishes.
        if (run.stopping && run.worker) void run.worker.done.then(forget).catch((error: unknown) => {
          console.warn("[bots] run cleanup failed:", error instanceof Error ? error.name : "UnknownError");
        });
        else forget();
      });
      return { events: run.queue.values(), result };
    },
    /** Relays a person's steering message to the running worker. */
    async steer(runId: string, text: string, parts: readonly import("@matrix-os/contracts").CanonicalChatMessagePart[] = []): Promise<boolean> {
      const run = active.get(runId);
      if (!run?.runtime || run.finished || run.stopping || run.signal.aborted || run.spec?.isolatedTurn) return false;
      const binding = deps.registry.lookupRun({ ...run.runtime, runId });
      if (!binding) return false;
      if (binding.group) {
        try { await groupWait(run, () => requireGroupBotAuthority({ ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, group: binding.group! }, deps.authorizeGroup)); } catch (error: unknown) {
          console.warn("[bots] group steering denied:", error instanceof Error ? error.name : "UnknownError");
          return false;
        }
      }
      if (!run.inputs || (binding.group && parts.some(part => part.type === "attachment_reference"))) return false;
      return run.inputs.steer(binding, parts, text, async payload => {
        await deps.assertSource?.(binding, run.signal);
        run.inputs!.assertAuthorized(binding);
        return deliverAcknowledgedSteer(() => deps.client.runBot({ ...run.runtime!, command: { version: 1, kind: "bot.steer", runId, ...payload } }));
      });
    },
    async cancel(runId: string): Promise<void> {
      const run = active.get(runId);
      if (run) await stopRuntime(run, runId, "cancelled");
    },
    /** A run the previous process lost: its task fails and nothing is replayed. */
    async abandon(input: { ownerId: string; taskId: string }): Promise<void> {
      const task = await deps.transact(input.ownerId, (tx) => createBotTasksRepository(tx.db).get({ ownerId: input.ownerId, taskId: input.taskId }, tx.db));
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
      await settle(task, "failed");
    },
  };
}

export type BotTaskOrchestrator = ReturnType<typeof createBotTaskOrchestrator>;
