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
 * The run ends early on cancellation or at the task's 10-minute active-work
 * deadline. Waits for a person or for capacity end the run; they never hold
 * a runtime. Active runs are bounded by the runtime registry's capacity.
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
import { BotAdmissionError, type PrivateBotAdmission } from "./admission.js";
import { BotBrokerActionError, type BotEventSink, type BotRunSource } from "./broker-actions.js";
import { BotRecipeCatalogError, type BotRecipeCatalog } from "./recipe-catalog.js";
import type { BotBindingsRepository } from "./repositories/bindings.js";
import type { BotBlockedReason, BotTask, BotTasksRepository } from "./repositories/tasks.js";
import { BotRouteError, type ResolvedBotRoute } from "./route-resolver.js";
import { BOT_RUNTIME_REGISTRY_CAPACITY, type BotRuntimeRegistry } from "./runtime-registry.js";
import { buildBotSystemPrompt, BotSystemPromptError } from "./system-prompt.js";

const ACTIVE_DEADLINE_MS = 10 * 60_000;
/** How long a worker that took the cancel has to end its run before its runtime is stopped. */
const CANCEL_GRACE_MS = 10_000;
const MAX_TOOL_ACTIONS = 60;
const MAX_QUEUED_EVENTS = 1_000;
/** Tools the broker serves today; the rest of a recipe's set arrives with later layers. */
const SERVED_CAPABILITIES: readonly BotToolCapability[] = ["artifact.read", "artifact.write"];

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
}

export interface BotTurnHandle {
  events: AsyncIterable<BotTurnEvent>;
  result: Promise<BotTurnResult>;
}

interface ActiveRun {
  ownerId: string;
  spec?: BotRunSpec;
  runtime?: { runtimeHandle: string; executionGeneration: string };
  queue: CanonicalCliEventQueue<BotTurnEvent>;
  stopping?: "cancelled" | "deadline";
  finished?: boolean;
  grace?: ReturnType<typeof setTimeout>;
}

export class BotTurnError extends Error {
  constructor(readonly code: "capacity_exceeded" | "invalid_request") {
    super(`Bot turn refused: ${code}`);
    this.name = "BotTurnError";
  }
}

export function createBotTaskOrchestrator(deps: {
  bindings: Pick<BotBindingsRepository, "forChat">;
  tasks: Pick<BotTasksRepository, "start" | "transition" | "get">;
  agents: Pick<ChatAgentStore, "get">;
  recipes: BotRecipeCatalog;
  resolveRoute(ownerId: string): Promise<ResolvedBotRoute>;
  admission: Pick<PrivateBotAdmission, "admit" | "release">;
  registry: Pick<BotRuntimeRegistry, "lookupRun">;
  client: Pick<ScopeRuntimeHostClient, "runBot">;
  onRunFinished?(runId: string): void;
  now?: () => Date;
  /** Active-work deadline per task; 10 minutes, and never longer. */
  activeDeadlineMs?: number;
  /** Test hook; 10 seconds, and never longer. */
  cancelGraceMs?: number;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const activeDeadlineMs = Math.max(1, Math.min(Math.trunc(deps.activeDeadlineMs ?? ACTIVE_DEADLINE_MS), ACTIVE_DEADLINE_MS));
  const cancelGraceMs = Math.max(1, Math.min(Math.trunc(deps.cancelGraceMs ?? CANCEL_GRACE_MS), CANCEL_GRACE_MS));
  /** At most one entry per bound runtime; the registry allows 64. */
  const active = new Map<string, ActiveRun>();

  async function directBot(ownerId: string, chatId: string): Promise<string | null> {
    const bindings = await deps.bindings.forChat({ ownerId, chatId });
    return bindings.find((binding) => binding.kind === "direct")?.botId ?? null;
  }

  async function settle(task: BotTask, status: BotRunStatus, blockedReason?: BotBlockedReason): Promise<BotTurnResult> {
    const to = status === "waiting_capacity" ? "blocked"
      : status === "uncertain" ? "failed"
      : status;
    const reason = status === "waiting_capacity" ? "capacity_unavailable" : blockedReason;
    try {
      await deps.tasks.transition({
        ownerId: task.ownerId, taskId: task.taskId, baseRevision: task.revision, to,
        ...(to === "blocked" ? { blockedReason: reason ?? "tool_unavailable" } : {}),
        now: now(),
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
  async function stopRuntime(run: ActiveRun, runId: string, reason: "cancelled" | "deadline"): Promise<void> {
    run.stopping ??= reason;
    const runtime = run.runtime;
    if (!runtime || run.finished) return;
    let delivered = false;
    try {
      delivered = (await deps.client.runBot({ ...runtime, command: { version: 1, kind: "bot.cancel", runId } })).ok;
    } catch (error: unknown) {
      console.warn("[bots] bot cancel was not delivered:", error instanceof Error ? error.name : "UnknownError");
    }
    if (!delivered) {
      await deps.admission.release(runtime.runtimeHandle);
      return;
    }
    run.grace ??= setTimeout(() => {
      if (!run.finished) void deps.admission.release(runtime.runtimeHandle);
    }, cancelGraceMs);
    run.grace.unref?.();
  }

  async function execute(input: { ownerId: string; chatId: string; runId: string; text: string; signal: AbortSignal }, run: ActiveRun): Promise<BotTurnResult> {
    const owner = { type: "personal" as const, ownerId: input.ownerId };
    const botId = await directBot(input.ownerId, input.chatId);
    const agent = botId ? await deps.agents.get(owner, botId) : null;
    if (!botId || !agent || agent.archived || !agent.recipeRef) return { status: "failed" };
    let recipe;
    try {
      recipe = deps.recipes.resolve(agent.recipeRef);
    } catch (error: unknown) {
      if (error instanceof BotRecipeCatalogError) return { status: "failed" };
      throw error;
    }
    const task = await deps.tasks.start({ ownerId: input.ownerId, botId, chatId: input.chatId, runId: input.runId, now: now() });
    run.queue.push({ kind: "state", state: { taskId: task.taskId } });
    if (input.signal.aborted) return settle(task, "cancelled");

    let resolved: ResolvedBotRoute;
    try {
      resolved = await deps.resolveRoute(input.ownerId);
    } catch (error: unknown) {
      if (!(error instanceof BotRouteError)) console.warn("[bots] model route unavailable:", error instanceof Error ? error.name : "UnknownError");
      return settle(task, "blocked", "model_unavailable");
    }
    const capabilities = recipe.capabilities.filter((capability) => SERVED_CAPABILITIES.includes(capability));
    try {
      run.spec = BotRunSpecSchema.parse({
        route: resolved.route,
        systemPrompt: buildBotSystemPrompt({ botName: agent.name, instructions: agent.instructions, recipe, now: new Date(now()) }),
        capabilities,
        limits: { maxToolActions: MAX_TOOL_ACTIONS },
        turn: { kind: "prompt", text: input.text },
      });
    } catch (error: unknown) {
      if (!(error instanceof BotSystemPromptError)) console.warn("[bots] run spec invalid:", error instanceof Error ? error.name : "UnknownError");
      return settle(task, "blocked", "policy_denied");
    }

    let runtime;
    try {
      runtime = await deps.admission.admit({
        ownerId: input.ownerId, botId, chatId: input.chatId, taskId: task.taskId, runId: input.runId,
        route: resolved.route, accessSourceId: resolved.accessSourceId, capabilities, requestClass: "interactive",
      });
    } catch (error: unknown) {
      if (!(error instanceof BotAdmissionError)) throw error;
      return settle(task, "blocked", error.code === "capacity_exceeded" ? "capacity_unavailable" : "root_unavailable");
    }
    run.runtime = { runtimeHandle: runtime.runtimeHandle, executionGeneration: runtime.executionGeneration };
    run.queue.push({ kind: "state", state: { taskId: task.taskId, ...run.runtime } });

    const onAbort = () => { void stopRuntime(run, input.runId, "cancelled"); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => { void stopRuntime(run, input.runId, "deadline"); }, Math.max(1, activeDeadlineMs - task.activeMs));
    try {
      // Cancelled while the runtime was being admitted: the run never starts.
      if (input.signal.aborted || run.stopping) return await settle(task, "cancelled");
      const reply = await deps.client.runBot({ ...run.runtime, command: { version: 1, kind: "bot.run", runId: input.runId } });
      const outcome = reply.ok ? BotRunOutcomeSchema.safeParse(reply.reply) : undefined;
      // Past the deadline only a finished reply stands; anything else would need more time.
      if (run.stopping === "deadline" && (!outcome?.success || outcome.data.status !== "completed")) {
        return await settle(task, "blocked", "deadline_reached");
      }
      if (!outcome?.success || outcome.data.runId !== input.runId) return await settle(task, run.stopping ? "cancelled" : "failed");
      return await settle(task, outcome.data.status, outcome.data.blockedReason);
    } catch (error: unknown) {
      if (!run.stopping) console.warn("[bots] bot run failed:", error instanceof Error ? error.name : "UnknownError");
      return await settle(task, run.stopping === "deadline" ? "blocked" : run.stopping ? "cancelled" : "failed",
        run.stopping === "deadline" ? "deadline_reached" : undefined);
    } finally {
      run.finished = true;
      if (run.grace) clearTimeout(run.grace);
      clearTimeout(deadline);
      input.signal.removeEventListener("abort", onAbort);
      await deps.admission.release(run.runtime.runtimeHandle);
    }
  }

  const runSource: BotRunSource = {
    async loadRunSpec(binding) {
      const spec = active.get(binding.runId)?.spec;
      if (!spec) throw new BotBrokerActionError("stale_generation");
      return spec;
    },
    async readImageChunk() {
      // Image turns arrive with attachment support; no admitted run carries images yet.
      throw new BotBrokerActionError("invalid_arguments");
    },
  };

  const eventSink: BotEventSink = {
    async publish(binding, event) {
      const run = active.get(binding.runId);
      if (!run || run.ownerId !== binding.ownerId) throw new BotBrokerActionError("stale_generation");
      run.queue.push({ kind: "event", event: event.event });
    },
  };

  return {
    runSource,
    eventSink,
    directBot,
    /** Starts one turn. Events stream until the run's outcome is known. */
    start(input: { ownerId: string; chatId: string; runId: string; text: string; signal: AbortSignal }): BotTurnHandle {
      if (!input.text.trim()) throw new BotTurnError("invalid_request");
      if (active.has(input.runId) || active.size >= BOT_RUNTIME_REGISTRY_CAPACITY) throw new BotTurnError("capacity_exceeded");
      const run: ActiveRun = { ownerId: input.ownerId, queue: createCanonicalCliEventQueue<BotTurnEvent>(MAX_QUEUED_EVENTS) };
      active.set(input.runId, run);
      const result = execute(input, run).finally(() => {
        active.delete(input.runId);
        deps.onRunFinished?.(input.runId);
        run.queue.finish();
      });
      return { events: run.queue.values(), result };
    },
    /** Relays a person's steering message to the running worker. */
    async steer(runId: string, text: string): Promise<boolean> {
      const run = active.get(runId);
      if (!run?.runtime || !deps.registry.lookupRun({ ...run.runtime, runId })) return false;
      const reply = await deps.client.runBot({ ...run.runtime, command: { version: 1, kind: "bot.steer", runId, text: text.slice(0, 8 * 1024) } });
      return reply.ok;
    },
    async cancel(runId: string): Promise<void> {
      const run = active.get(runId);
      if (run) await stopRuntime(run, runId, "cancelled");
    },
    /** A run the previous process lost: its task fails and nothing is replayed. */
    async abandon(input: { ownerId: string; taskId: string }): Promise<void> {
      const task = await deps.tasks.get({ ownerId: input.ownerId, taskId: input.taskId });
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
      await settle(task, "failed");
    },
  };
}

export type BotTaskOrchestrator = ReturnType<typeof createBotTaskOrchestrator>;
