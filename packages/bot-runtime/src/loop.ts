import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Api, type ImageContent, type Model, type Provider } from "@earendil-works/pi-ai";
import type { BotRunCommand, BotRunOutcome, BotToolErrorCode } from "@matrix-os/contracts";
import { BotBrokerError, type BotBrokerClient } from "./broker-client.js";
import { createEventProjector } from "./events.js";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel } from "./providers.js";
import {
  BotSessionError,
  compactSession,
  decodeSession,
  encodeSession,
  fitForStorage,
  fitsWithToolPayloadCaps,
  needsCompaction,
  withoutImages,
} from "./session.js";
import { capabilityForToolName, createBotTools, type BotToolsState } from "./tools.js";

const SUMMARY_PROMPT = "Summarize the conversation between a person and their assistant bot. "
  + "Keep decisions, stated preferences, open tasks, and sources. Do not continue the conversation.";
const BUDGET_REASON = "This task reached its action budget. Summarize progress and stop.";
const SUMMARY_MAX_TOKENS = 2_048;

/** Steering handle for the active turn; it refuses once the turn stops taking input. */
export interface BotTurnControl {
  steer(text: string): boolean;
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
  let snapshot: { revision: number; messages: readonly Record<string, unknown>[] };
  let history: AgentMessage[];
  try {
    snapshot = await broker.loadSession();
    // Leading prompt/tool system messages are rebuilt from this run's revision.
    history = decodeSession(snapshot.messages).filter((message) => message.role !== "system");
  } catch (error: unknown) {
    return outcome(command, { status: "failed", failureCode: failureCodeOf(error, "session load"), toolActions: 0 });
  }
  // An abort listener never fires for a signal that is already aborted, so check first:
  // a run cancelled before it starts makes no model call and leaves the session as it was.
  if (input.signal?.aborted) {
    return outcome(command, { status: "cancelled", sessionRevision: snapshot.revision, toolActions: 0 });
  }
  const { provider, model } = input.route ?? createBridgeModel(command.route, input.bridgeOrigin, input.bridgeSocket);
  const tools: BotToolsState = { waitingForPerson: false, effectUnknown: false };
  let toolActions = 0;
  let budgetExhausted = false;
  let toolInFlight = false;
  let eventFailure: BotToolErrorCode | undefined;
  let runFailed = false;

  const agent = new Agent({
    initialState: {
      systemPrompt: command.systemPrompt,
      model,
      thinkingLevel: "off",
      tools: createBotTools({ capabilities: command.capabilities, broker, state: tools }),
      messages: history,
    },
    streamFn: (streamModel, context, options) => provider.streamSimple(streamModel, context, {
      ...options,
      // A Provider does not resolve auth itself. The worker only carries this
      // inert value; the loopback broker owns the funded credential.
      apiKey: BROKER_PLACEHOLDER_KEY,
      maxTokens: command.route.maxOutputTokens,
    }),
    toolExecution: "sequential",
    // A blocking question or a spent budget ends the turn even if a steer is queued; the steer is saved instead.
    shouldStopAfterTurn: () => tools.waitingForPerson || budgetExhausted,
    // Fail closed: the hook cannot throw, and anything past the budget is blocked.
    beforeToolCall: async () => {
      if (toolActions >= command.limits.maxToolActions) {
        budgetExhausted = true;
        return { block: true, reason: BUDGET_REASON, terminate: true };
      }
      toolActions += 1;
      return undefined;
    },
  });
  input.onAgent?.(agent);

  const project = createEventProjector({ send: (event) => broker.event(event), capabilityForTool: capabilityForToolName });
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
  const steered: AgentMessage[] = [];
  let steeringOpen = true;
  input.onControl?.({
    steer(text) {
      if (!steeringOpen) return false;
      const message: AgentMessage = { role: "user", content: text, timestamp: now() };
      steered.push(message);
      agent.steer(message);
      return true;
    },
  });
  const stopped = () => Boolean(eventFailure) || input.signal?.aborted === true || budgetExhausted
    || tools.waitingForPerson || Boolean(agent.state.errorMessage);

  try {
    if (command.turn.kind === "prompt") {
      const images: ImageContent[] = (command.turn.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      await agent.prompt(command.turn.text, images.length > 0 ? images : undefined);
    } else {
      await agent.continue();
    }
    await agent.waitForIdle();
    // A steer can land after Pi's last poll; answer it before closing the turn.
    while (!stopped() && agent.hasQueuedMessages()) {
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

  const unanswered = steered.filter((message) => !agent.state.messages.includes(message));
  let messages: AgentMessage[] = withoutImages([...agent.state.messages, ...unanswered]);
  try {
    // Summaries are best effort: a cancelled run skips them, and a failed call
    // falls back to storage fitting so the turn is still saved.
    const summarize = async (transcript: string) => {
      if (input.signal?.aborted) return "";
      try {
        const reply = await provider.streamSimple(model, normalizeContext({
          systemPrompt: SUMMARY_PROMPT,
          messages: [{ role: "user", content: transcript, timestamp: now() }],
        }), { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: SUMMARY_MAX_TOKENS,
          ...(input.signal ? { signal: input.signal } : {}) }).result();
        return reply.stopReason === "error" || reply.stopReason === "aborted" ? "" : textOf(reply);
      } catch (error: unknown) {
        console.warn("[bot-runtime] session summary failed:", error instanceof Error ? error.name : "UnknownError");
        return "";
      }
    };
    if (needsCompaction(messages, command.route.contextWindow)) {
      messages = await compactSession({ messages, now, summarize });
    }
    // Summarize down to the latest turn before storage would have to drop earlier turns.
    // A cancelled run never drops turns: if it cannot save whole, the previous session stays.
    if (!fitsWithToolPayloadCaps(messages)) {
      messages = await compactSession({ messages, now, summarize, keepRecentUserTurns: 1 });
    }
    const saved = await broker.saveSession({ baseRevision: snapshot.revision, messages: encodeSession(fitForStorage(messages, undefined, now, { allowDroppingTurns: input.signal?.aborted !== true })) });
    return outcome(command, { ...status, sessionRevision: saved.revision, toolActions });
  } catch (error: unknown) {
    const failureCode = failureCodeOf(error, "session save");
    // An unknown external effect still needs reconciliation even when the transcript is lost.
    const failedStatus = status.status === "uncertain" ? "uncertain" as const : "failed" as const;
    return outcome(command, { status: failedStatus, failureCode, sessionRevision: snapshot.revision, toolActions });
  }
}
