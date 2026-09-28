/**
 * Broker actions for bot workloads (spec 536, contracts/bot-broker-protocol.md).
 * Every frame is authorized by the bot registry: the runtime handle, current
 * generation, and bound run must match. Tool calls are checkpointed
 * `prepared` before dispatch and `observed_complete` or `effect_unknown`
 * after, and are never replayed. Refusals use the allowlisted codes only;
 * details are logged, never returned to the worker.
 */
import { createHash } from "node:crypto";
import {
  BotBrokerRequestSchema,
  BotImageChunkSchema,
  BotRunSpecSchema,
  type BotEvent,
  type BotImageChunk,
  type BotImageChunkRequest,
  type BotRunSpec,
  type BotToolErrorCode,
  type BotToolRequest,
  type BotToolResult,
} from "@matrix-os/contracts";
import { SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "@matrix-os/scope-runtime/bot-profile";
import { ScopeRuntimeBotInferenceRequestSchema } from "@matrix-os/scope-runtime/broker-protocol";
import type { BotEffectClass } from "./database.js";
import { forwardBotInference, type BotInferenceDependencies } from "./broker-inference.js";
import type { BotCheckpointsRepository } from "./repositories/checkpoints.js";
import type { BotSessionsRepository } from "./repositories/sessions.js";
import { BotStateError, withTransaction, type BotExecutor } from "./repositories/shared.js";
import type { BotRuntimeBinding, BotRuntimeRegistry } from "./runtime-registry.js";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_TIMEOUT_MS = 60_000;
/** Per-run event order entries kept after release; runs still bound are never evicted. */
const MAX_TRACKED_RUNS = 256;

/** A refusal with an allowlisted code, thrown by run sources, event sinks, and tool dispatchers. */
export class BotBrokerActionError extends Error {
  constructor(readonly code: BotToolErrorCode) {
    super(`Bot broker action refused: ${code}`);
    this.name = "BotBrokerActionError";
  }
}

/** The run the gateway admitted, and its input images. Implemented by the orchestrator (L8). */
export interface BotRunSource {
  loadRunSpec(binding: BotRuntimeBinding): Promise<BotRunSpec>;
  readImageChunk(binding: BotRuntimeBinding, request: BotImageChunkRequest): Promise<BotImageChunk>;
}

/** Receives ordered events for projection into canonical Chat (L8). */
export interface BotEventSink {
  publish(binding: BotRuntimeBinding, event: BotEvent): Promise<void>;
}

/** Concrete tools (artifacts, memory, interactions, integrations) plug in here (L8-L9). */
export interface BotToolDispatcher {
  effectClass(request: BotToolRequest): BotEffectClass;
  dispatch(binding: BotRuntimeBinding, request: BotToolRequest, signal: AbortSignal): Promise<{ result: BotToolResult; outcomeRef?: string }>;
}

function refusal(requestId: string, code: BotToolErrorCode) {
  return { version: 1 as const, requestId, ok: false as const, code };
}

function success(requestId: string, result: unknown) {
  return { version: 1 as const, requestId, ok: true as const, result };
}

function stateCode(error: BotStateError): BotToolErrorCode {
  if (error.code === "revision_conflict") return "stale_generation";
  if (error.code === "too_large" || error.code === "invalid_input") return "invalid_arguments";
  return "unavailable";
}

/**
 * Settles with `work`, or rejects when `signal` aborts first, so a dispatcher
 * that ignores cancellation cannot hold the broker past its timeout.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createBotBrokerActions(deps: {
  /** The owner database the repositories use; pre-dispatch checkpoint writes share one transaction on it. */
  db: BotExecutor;
  registry: BotRuntimeRegistry;
  sessions: BotSessionsRepository;
  checkpoints: BotCheckpointsRepository;
  runs: BotRunSource;
  events: BotEventSink;
  tools: BotToolDispatcher;
  inference: BotInferenceDependencies;
  now?: () => Date;
  toolTimeoutMs?: number;
  /** Test hook; capped at 256. */
  maxTrackedRuns?: number;
}) {
  const now = deps.now ?? (() => new Date());
  const toolTimeoutMs = Math.max(1, Math.min(Math.trunc(deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS));
  /**
   * Event order per run, least recently used first: the last published `seq`
   * and whether a publish is in flight. Frames arrive on concurrent sockets,
   * so the next `seq` is reserved before publishing and nothing else for the
   * run is accepted until that publish settles.
   */
  interface EventOrder {
    runtimeHandle: string;
    executionGeneration: string;
    lastSeq: number;
    publishing: boolean;
  }
  const eventOrder = new Map<string, EventOrder>();
  const maxTrackedRuns = Math.max(1, Math.min(Math.trunc(deps.maxTrackedRuns ?? MAX_TRACKED_RUNS), MAX_TRACKED_RUNS));

  /**
   * Evicts runs whose binding was released, least recently used first. A
   * bound run is never evicted: the registry allows at most 64 bindings, so
   * live entries alone keep the map bounded.
   */
  function evictOrders(): void {
    for (const [runId, order] of eventOrder) {
      if (eventOrder.size <= maxTrackedRuns) return;
      if (!deps.registry.lookupRun({ ...order, runId })) eventOrder.delete(runId);
    }
  }

  function trackOrder(runId: string, order: EventOrder): void {
    eventOrder.delete(runId);
    eventOrder.set(runId, order);
    evictOrders();
  }

  async function publishEvent(binding: BotRuntimeBinding, event: BotEvent): Promise<boolean> {
    const order = eventOrder.get(binding.runId) ?? {
      runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, lastSeq: -1, publishing: false,
    };
    // Events must arrive in order with no gaps, starting at 0 for each run.
    if (order.publishing || event.seq !== order.lastSeq + 1) return false;
    order.publishing = true;
    trackOrder(binding.runId, order);
    try {
      await deps.events.publish(binding, event);
      order.lastSeq = event.seq;
    } finally {
      order.publishing = false;
    }
    return true;
  }

  async function runTool(binding: BotRuntimeBinding, request: BotToolRequest): Promise<BotToolResult> {
    if (!binding.capabilities.includes(request.capability)) throw new BotBrokerActionError("denied");
    const effectClass = deps.tools.effectClass(request);
    const argsHash = createHash("sha256").update(canonicalJson(request.args)).digest("hex");
    // Prepared and dispatched commit together; the tool call itself runs outside the transaction.
    const id = await withTransaction(deps.db, async (trx) => {
      const prepared = await deps.checkpoints.prepare({
        ownerId: binding.ownerId,
        taskId: binding.taskId,
        runId: binding.runId,
        toolCallId: request.toolCallId,
        action: { capability: request.capability, argsHash },
        effectClass,
        now: now().toISOString(),
      }, trx);
      // A tool call ID is used once per run; a repeat is never dispatched again.
      if (!prepared.created) throw new BotBrokerActionError("denied");
      const checkpointId = { ownerId: binding.ownerId, checkpointId: prepared.checkpoint.checkpointId };
      await deps.checkpoints.markDispatched({ ...checkpointId, now: now().toISOString() }, trx);
      return checkpointId;
    });
    // The run may have been released while the checkpoint was written; nothing was dispatched.
    if (!deps.registry.lookupRun(binding)) {
      await deps.checkpoints.markObserved({ ...id, now: now().toISOString() });
      throw new BotBrokerActionError("stale_generation");
    }
    const signal = AbortSignal.any([deps.inference.lifetime, AbortSignal.timeout(toolTimeoutMs)]);
    try {
      const { result, outcomeRef } = await untilAborted(deps.tools.dispatch(binding, request, signal), signal);
      await deps.checkpoints.markObserved({ ...id, ...(outcomeRef ? { outcomeRef } : {}), now: now().toISOString() });
      return result;
    } catch (error: unknown) {
      // A refusal is decided before any effect; anything else leaves the effect unknown.
      if (error instanceof BotBrokerActionError) {
        await deps.checkpoints.markObserved({ ...id, now: now().toISOString() });
        throw error;
      }
      await deps.checkpoints.markEffectUnknown({ ...id, now: now().toISOString() });
      if (signal.aborted) throw new BotBrokerActionError("timeout");
      console.warn("[bots] tool dispatch failed:", error instanceof Error ? error.name : "UnknownError");
      throw new BotBrokerActionError("unavailable");
    }
  }

  return {
    /** True when the bot registry owns the frame's runtime handle at this generation. */
    owns: (input: { runtimeHandle: string; executionGeneration: string }) => deps.registry.lookup(input) !== null,
    /**
     * Handles one frame from a bot workload. Returns undefined for a frame
     * that is not a valid bot frame, so the server drops the connection.
     */
    async handleFrame(raw: unknown): Promise<Record<string, unknown> | undefined> {
      const action = raw && typeof raw === "object" ? (raw as { action?: unknown }).action : undefined;
      if (typeof action === "string" && action.startsWith("inference.")) {
        const request = ScopeRuntimeBotInferenceRequestSchema.safeParse(raw);
        if (!request.success) return undefined;
        const binding = deps.registry.lookup(request.data);
        if (!binding) return { version: 1, requestId: request.data.requestId, ok: false, error: "action_denied" };
        return forwardBotInference(request.data, binding, (modelId) => deps.registry.authorize({
          runtimeHandle: request.data.runtimeHandle,
          executionGeneration: request.data.executionGeneration,
          action: request.data.action,
          modelId,
        }), deps.inference);
      }
      const parsed = BotBrokerRequestSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const request = parsed.data;
      const binding = deps.registry.lookupRun(request);
      if (!binding) return refusal(request.requestId, "stale_generation");
      const key = { ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId };
      try {
        switch (request.action) {
          case "bot.run.load":
            return success(request.requestId, BotRunSpecSchema.parse(await deps.runs.loadRunSpec(binding)));
          case "bot.input.image":
            return success(request.requestId, BotImageChunkSchema.parse(await deps.runs.readImageChunk(binding, request.image)));
          case "bot.session.load": {
            const snapshot = await deps.sessions.load(key);
            return success(request.requestId, { revision: snapshot.revision, messages: snapshot.messages });
          }
          case "bot.session.save": {
            const saved = await deps.sessions.save({
              ...key,
              baseRevision: request.session.baseRevision,
              messages: request.session.messages,
              ...(request.session.compactedThroughSeq !== undefined ? { compactedThroughSeq: request.session.compactedThroughSeq } : {}),
              tokenEstimate: Math.ceil(JSON.stringify(request.session.messages).length / 4),
              runtimeVersions: { "@earendil-works/pi-agent-core": SCOPE_RUNTIME_BOT_HARNESS_VERSION },
              now: now().toISOString(),
            });
            return success(request.requestId, { revision: saved.revision });
          }
          case "bot.event":
            if (!await publishEvent(binding, request.event)) return refusal(request.requestId, "invalid_arguments");
            return success(request.requestId, { accepted: true });
          case "bot.tool":
            return success(request.requestId, await runTool(binding, request.tool));
        }
      } catch (error: unknown) {
        if (error instanceof BotBrokerActionError) return refusal(request.requestId, error.code);
        if (error instanceof BotStateError) return refusal(request.requestId, stateCode(error));
        console.warn("[bots] broker action failed:", error instanceof Error ? error.name : "UnknownError");
        return refusal(request.requestId, "unavailable");
      }
    },
    /** Forget per-run ordering state when a run is released. */
    forgetRun(runId: string): void {
      eventOrder.delete(runId);
    },
  };
}

export type BotBrokerActions = ReturnType<typeof createBotBrokerActions>;

/**
 * Registers the bot registry on the scope-runtime host: frames from bot
 * runtimes are handled whole by `actions`; nothing from a bot runtime ever
 * reaches the shared-Chat broker path.
 */
export function registerBotBroker(
  host: Pick<ScopeRuntimeHost, "registerAuthorizer">,
  actions: Pick<BotBrokerActions, "owns" | "handleFrame">,
): () => void {
  return host.registerAuthorizer({
    id: "bots",
    owns: actions.owns,
    authorize: async () => ({ allowed: false }),
    handleFrame: actions.handleFrame,
  });
}
