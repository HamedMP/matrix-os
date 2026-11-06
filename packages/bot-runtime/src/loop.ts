import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Api, type ImageContent, type Model, type Provider } from "@earendil-works/pi-ai";
import type { BotRunCommand, BotRunOutcome, BotSessionSnapshot, BotToolErrorCode } from "@matrix-os/contracts";
import { BotBrokerError, type BotBrokerClient } from "./broker-client.js";
import { createEventProjector } from "./events.js";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel } from "./providers.js";
import {
  BotSessionError,
  compactSession,
  contextTextBytes,
  fitInferenceContext,
  SESSION_COMPACT_AT_BYTES,
  decodeSession,
  encodeSession,
  fitForStorage,
  withoutDerivedSummaries,
  withoutImages,
} from "./session.js";
import { capabilityForToolName, createBotTools, type BotToolsState } from "./tools.js";

const SUMMARY_PROMPT = "Summarize the conversation between a person and their assistant bot. "
  + "Keep decisions, stated preferences, open tasks, and sources. Do not continue the conversation.";
const BUDGET_REASON = "This task reached its action budget. Summarize progress and stop.";
const SUMMARY_MAX_TOKENS = 2_048;

/** Steering handle for the active turn; it refuses once the turn stops taking input. */
export interface BotTurnControl {
  steer(text: string, images?: readonly import("@matrix-os/contracts").BotImageInput[]): boolean;
}

export interface RunBotTurnInput {
  command: BotRunCommand;
  broker: BotBrokerClient;
  bridgeOrigin: string;
  bridgeSocket?: string;
  /** Tests inject a scripted provider; production always uses the loopback bridge. */
  route?: { provider: Provider<Api>; model: Model<Api> };
  signal?: AbortSignal;
  now?: () => number;
  onControl?(control: BotTurnControl): void;
  onAgent?(agent: Agent): void;
}

function textOf(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function outcome(
  command: BotRunCommand,
  fields: Omit<BotRunOutcome, "runId">,
): BotRunOutcome {
  return { runId: command.runId, ...fields };
}

function failureCodeOf(error: unknown, context: string): BotToolErrorCode {
  if (error instanceof BotBrokerError) return error.code;
  if (!(error instanceof BotSessionError)) {
    console.warn(`[bot-runtime] ${context} failed:`, error instanceof Error ? error.name : "UnknownError");
  }
  return "unavailable";
}

/**
 * Runs one bot turn in the sandboxed workload. The agent holds no credential
 * and no network: model calls go through the private bridge and every tool
 * call is a broker request that the gateway authorizes and checkpoints.
 */
export async function runBotTurn(input: RunBotTurnInput): Promise<BotRunOutcome> {
  const { command, broker } = input;
  const now = input.now ?? Date.now;
  let snapshot: BotSessionSnapshot;
  let history: AgentMessage[];
  try {
    snapshot = await broker.loadSession();
    // Leading prompt/tool system messages are rebuilt from this run's revision.
    history = decodeSession(snapshot.messages).filter((message) => message.role !== "system");
    // Never summarize an invalidated summary: its original source turns may
    // already be compacted away, so discard derived context before inference.
    if (snapshot.needsRecompaction && !command.isolatedTurn?.target) history = withoutDerivedSummaries(history);
  } catch (error: unknown) {
    return outcome(command, { status: "failed", failureCode: failureCodeOf(error, "session load"), toolActions: 0 });
  }
  // An abort listener never fires for a signal that is already aborted, so check first:
  // a run cancelled before it starts makes no model call and leaves the session as it was.
  if (input.signal?.aborted) {
    return outcome(command, { status: "cancelled", sessionRevision: snapshot.revision, toolActions: 0 });
  }
  const isolated = command.isolatedTurn !== undefined;
  const canonical = command.isolatedTurn?.target;
  if (isolated && (command.turn.kind !== "prompt" || command.turn.images?.length || (!canonical && history.length)
    || (canonical && (canonical.runId !== command.runId || command.capabilities.length || snapshot.needsRecompaction))
    || command.route.maxOutputTokens !== 256 || command.limits.maxToolActions !== 1)) {
    return outcome(command, { status: "failed", failureCode: "denied", toolActions: 0 });
  }
  const { provider, model } = input.route ?? createBridgeModel(command.route, input.bridgeOrigin, input.bridgeSocket);
  // Unknown/invalid/truncated tools bypass beforeToolCall. Bound model work
  // itself: tool rounds, a final response and at most two session summaries.
  const maxInferenceCalls = isolated ? 1 : Math.min(command.limits.maxToolActions + 3, command.limits.maxInferenceCalls ?? 63);
  let inferenceCalls = 0;
  let summaryCalls = 0;
  const tools: BotToolsState = { waitingForPerson: false, effectUnknown: false };
  let toolActions = 0;
  let budgetExhausted = false;
  let toolInFlight = false;
  let eventFailure: BotToolErrorCode | undefined;
  let runFailed = false;

  const summarize = async (transcript: string, signal?: AbortSignal): Promise<string> => {
    // Retain the existing two-summary ceiling and leave one ordinary call.
    if (signal?.aborted || input.signal?.aborted || summaryCalls >= 2 || inferenceCalls + 1 >= maxInferenceCalls) return "";
    summaryCalls += 1;
    inferenceCalls += 1;
    const maxChars = Math.max(256, Math.floor(Math.min(SESSION_COMPACT_AT_BYTES,
      command.route.contextWindow * 4 * 0.8) / 4));
    try {
      const reply = await provider.streamSimple(model, normalizeContext({
        systemPrompt: SUMMARY_PROMPT,
        messages: [{ role: "user", content: transcript.slice(-maxChars), timestamp: now() }],
      }), { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: Math.min(SUMMARY_MAX_TOKENS, command.route.maxOutputTokens), maxRetries: 0,
        ...(signal ? { signal } : input.signal ? { signal: input.signal } : {}) }).result();
      return reply.stopReason === "error" || reply.stopReason === "aborted" ? "" : textOf(reply);
    } catch (error: unknown) {
      console.warn("[bot-runtime] session summary failed:", error instanceof Error ? error.name : "UnknownError");
      return "";
    }
  };

  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: command.systemPrompt,
      model,
      thinkingLevel: "off",
      tools: isolated ? [] : createBotTools({ capabilities: command.capabilities, broker, state: tools, routineModel: command.route.modelId }),
      messages: history,
    },
    streamFn: (streamModel, context, options) => {
      if (budgetExhausted || options?.signal?.aborted || input.signal?.aborted) throw new Error("Run stopped before inference");
      if (inferenceCalls >= maxInferenceCalls) throw new Error("Model action budget ended");
      inferenceCalls += 1;
      return provider.streamSimple(streamModel, context, {
      ...options,
      // A Provider does not resolve auth itself. The worker only carries this
      // inert value; the loopback broker owns the funded credential.
      apiKey: BROKER_PLACEHOLDER_KEY,
      maxTokens: command.route.maxOutputTokens,
      maxRetries: 0,
      ...(isolated ? { reasoning: undefined } : {}),
    }); },
    prepareRequest: async ({ context }, signal) => {
      if (isolated || signal?.aborted || input.signal?.aborted) return;
      // Pi invokes this after all tool results and queued corrections are appended.
      for (const pending of steered) if (context.messages.includes(pending.message)) pending.consumed = true;
      const overhead = new TextEncoder().encode(JSON.stringify({ systemPrompt: command.systemPrompt, tools: context.tools })).byteLength;
      const imageTokens = context.messages.reduce((total, message) => {
        if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return total;
        const images = message.content.filter((part): part is ImageContent => part.type === "image");
        return total + (images.length ? estimateMessageTokens({ role: "user", content: images, timestamp: now() }) : 0);
      }, 0);
      const maxTextBytes = Math.min(SESSION_COMPACT_AT_BYTES,
        Math.floor((command.route.contextWindow - command.route.maxOutputTokens) * 4 * 0.8) - overhead - imageTokens * 4);
      if (maxTextBytes <= 0) { budgetExhausted = true; agent.abort(); return; }
      if (estimateContextTokens(context.messages).tokens <= command.route.contextWindow * 0.8
        && contextTextBytes(context.messages) <= maxTextBytes) return;
      // Corrections belong to this active turn, not historical user turns:
      // keep its initial prompt (including images) and every injected steer.
      const keepRecentUserTurns = 1 + steered.filter(pending => pending.consumed).length;
      const compacted = await compactSession({ messages: context.messages, now, keepRecentUserTurns, summarize: transcript => summarize(transcript, signal) });
      if (signal?.aborted || input.signal?.aborted) return;
      // Hysteresis leaves room for the next tool result instead of retrying
      // an unavailable summary on every small message.
      const fitted = fitInferenceContext(compacted, Math.floor(maxTextBytes * 0.75));
      if (contextTextBytes(fitted) > maxTextBytes) {
        budgetExhausted = true;
        agent.abort();
        return;
      }
      agent.state.messages = fitted;
      return { context: { ...context, messages: fitted } };
    },
    toolExecution: "sequential",
    // Already-ACKed corrections drain at the next safe boundary before a
    // question releases the worker. They do not answer or authorize it.
    finishTurn: () => isolated || input.signal?.aborted || eventFailure || budgetExhausted
      || (tools.waitingForPerson && !agent.hasQueuedMessages()) ? { action: "end" } : undefined,
    // Fail closed: the hook cannot throw, and anything past the budget is blocked.
    beforeToolCall: async () => {
      if (isolated || toolActions >= command.limits.maxToolActions) {
        budgetExhausted = true;
        return { block: true, reason: BUDGET_REASON, terminate: true };
      }
      toolActions += 1;
      return undefined;
    },
  });
  input.onAgent?.(agent);

  const project = createEventProjector({ send: (event) => broker.event(event), capabilityForTool: capabilityForToolName, signal: input.signal });
  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") toolInFlight = true;
    if (event.type === "tool_execution_end") toolInFlight = false;
    try {
      await project(event);
    } catch (error: unknown) {
      eventFailure = error instanceof BotBrokerError ? error.code : "unavailable";
      if (!(error instanceof BotBrokerError)) console.warn("[bot-runtime] event forward failed:", error instanceof Error ? error.name : "UnknownError");
      agent.abort();
    }
  });
  const onAbort = () => agent.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  // Steering is accepted until the turn stops; anything Pi did not inject is saved as a person message.
  const steered: Array<{ message: AgentMessage; consumed: boolean }> = [];
  let steeringOpen = true;
  input.onControl?.({
    steer(text, images) {
      if (isolated || !steeringOpen || tools.askingPerson || tools.waitingForPerson || budgetExhausted
        || inferenceCalls >= maxInferenceCalls || input.signal?.aborted || eventFailure || agent.state.errorMessage) return false;
      if (images?.length && !command.route.input.includes("image")) return false;
      const message: AgentMessage = { role: "user", content: images?.length
        ? [{ type: "text", text }, ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))]
        : text, timestamp: now() };
      steered.push({ message, consumed: false });
      agent.steer(message);
      return true;
    },
  });
  const stopped = () => Boolean(eventFailure) || input.signal?.aborted === true || budgetExhausted
    || Boolean(agent.state.errorMessage);

  try {
    if (command.turn.kind === "prompt") {
      const images: ImageContent[] = (command.turn.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      await agent.prompt(command.turn.text, images.length > 0 ? images : undefined);
    } else {
      await agent.continue();
    }
    await agent.waitForIdle();
    // A steer can land after Pi's last poll; answer it before closing the turn.
    while (!isolated && !stopped() && agent.hasQueuedMessages()) {
      await agent.continue();
      await agent.waitForIdle();
    }
  } catch (error: unknown) {
    runFailed = true;
    console.warn("[bot-runtime] agent run failed:", error instanceof Error ? error.name : "UnknownError");
  } finally {
    // No await between the last queue check and closing, so no steer slips in unseen.
    steeringOpen = false;
    agent.clearAllQueues();
    input.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    project.close();
  }
  // Text still buffered or a timed flush that failed is settled before the outcome is decided.
  try {
    await project.drain();
  } catch (error: unknown) {
    eventFailure ??= error instanceof BotBrokerError ? error.code : "unavailable";
    if (!(error instanceof BotBrokerError)) console.warn("[bot-runtime] event forward failed:", error instanceof Error ? error.name : "UnknownError");
  }

  const status = (() => {
    if (eventFailure) return { status: "failed" as const, failureCode: eventFailure };
    if (runFailed) return { status: "failed" as const, failureCode: "unavailable" as const };
    if (input.signal?.aborted) return { status: tools.effectUnknown || toolInFlight ? "uncertain" as const : "cancelled" as const };
    if (budgetExhausted) return { status: "blocked" as const, blockedReason: "budget_exhausted" as const };
    if (tools.waitingForPerson) return { status: "waiting_person" as const };
    if (agent.state.errorMessage) return { status: "failed" as const, failureCode: "unavailable" as const };
    return { status: "completed" as const };
  })();

  const unanswered = steered.filter(pending => !pending.consumed && !agent.state.messages.includes(pending.message)).map(pending => pending.message);
  let messages: AgentMessage[] = withoutImages([...agent.state.messages, ...unanswered]);
  try {
    // No model request after final text. Context maintenance happens before
    // ordinary requests; terminal persistence uses bounded deterministic fitting.
    const saved = await broker.saveSession({
      baseRevision: snapshot.revision,
      ...(snapshot.needsRecompaction ? { recompactionHandled: true as const } : {}),
      messages: encodeSession(fitForStorage(messages, undefined, now, { allowDroppingTurns: !isolated && input.signal?.aborted !== true })),
    });
    return outcome(command, { ...status, sessionRevision: saved.revision, toolActions });
  } catch (error: unknown) {
    const failureCode = failureCodeOf(error, "session save");
    // An unknown external effect still needs reconciliation even when the transcript is lost.
    const failedStatus = status.status === "uncertain" ? "uncertain" as const : "failed" as const;
    return outcome(command, { status: failedStatus, failureCode, sessionRevision: snapshot.revision, toolActions });
  }
}
