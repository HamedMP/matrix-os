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
import { BotStateError } from "./repositories/shared.js";
import type { BotRuntimeBinding, BotRuntimeRegistry } from "./runtime-registry.js";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_TIMEOUT_MS = 60_000;
/** Per-run event order entries; well above the 64 live bot runtimes, evicted least recently used. */
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createBotBrokerActions(deps: {
  registry: BotRuntimeRegistry;
  sessions: BotSessionsRepository;
  checkpoints: BotCheckpointsRepository;
  runs: BotRunSource;
  events: BotEventSink;
  tools: BotToolDispatcher;
  inference: BotInferenceDependencies;
  now?: () => Date;
  toolTimeoutMs?: number;
}) {
  const now = deps.now ?? (() => new Date());
  const toolTimeoutMs = Math.max(1, Math.min(Math.trunc(deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS));
  /** Last accepted event `seq` per run, least recently used first. */
  const lastSeq = new Map<string, number>();

  function rememberSeq(runId: string, seq: number): void {
    lastSeq.delete(runId);
    lastSeq.set(runId, seq);
    while (lastSeq.size > MAX_TRACKED_RUNS) {
      const oldest = lastSeq.keys().next().value;
      if (oldest === undefined) break;
      lastSeq.delete(oldest);
    }
  }

  async function runTool(binding: BotRuntimeBinding, request: BotToolRequest): Promise<BotToolResult> {
    if (!binding.capabilities.includes(request.capability)) throw new BotBrokerActionError("denied");
    const effectClass = deps.tools.effectClass(request);
    const argsHash = createHash("sha256").update(canonicalJson(request.args)).digest("hex");
    const prepared = await deps.checkpoints.prepare({
      ownerId: binding.ownerId,
      taskId: binding.taskId,
      runId: binding.runId,
      toolCallId: request.toolCallId,
      action: { capability: request.capability, argsHash },
      effectClass,
      now: now().toISOString(),
    });
    // A tool call ID is used once per run; a repeat is never dispatched again.
    if (!prepared.created) throw new BotBrokerActionError("denied");
    const id = { ownerId: binding.ownerId, checkpointId: prepared.checkpoint.checkpointId };
    await deps.checkpoints.markDispatched({ ...id, now: now().toISOString() });
    const signal = AbortSignal.any([deps.inference.lifetime, AbortSignal.timeout(toolTimeoutMs)]);
    try {
      const { result, outcomeRef } = await deps.tools.dispatch(binding, request, signal);
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
          case "bot.event": {
            // Events must arrive in order with no gaps, starting at 0 for each run.
            const expected = (lastSeq.get(binding.runId) ?? -1) + 1;
            if (request.event.seq !== expected) return refusal(request.requestId, "invalid_arguments");
            await deps.events.publish(binding, request.event);
            rememberSeq(binding.runId, request.event.seq);
            return success(request.requestId, { accepted: true });
          }
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
      lastSeq.delete(runId);
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
    owns: actions.owns,
    authorize: async () => ({ allowed: false }),
    handleFrame: actions.handleFrame,
  });
}
