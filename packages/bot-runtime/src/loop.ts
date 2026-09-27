import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Api, type ImageContent, type Model, type Provider } from "@earendil-works/pi-ai";
import type { BotRunCommand, BotRunOutcome, BotToolErrorCode } from "@matrix-os/contracts";
import { BotBrokerError, type BotBrokerClient } from "./broker-client.js";
import { createEventProjector } from "./events.js";
import { createBridgeModel } from "./providers.js";
import { BotSessionError, compactSession, decodeSession, encodeSession, needsCompaction } from "./session.js";
import { capabilityForToolName, createBotTools, type BotToolsState } from "./tools.js";

const SUMMARY_PROMPT = "Summarize the conversation between a person and their assistant bot. "
  + "Keep decisions, stated preferences, open tasks, and sources. Do not continue the conversation.";
const BUDGET_REASON = "This task reached its action budget. Summarize progress and stop.";
const SUMMARY_MAX_TOKENS = 2_048;

export interface RunBotTurnInput {
  command: BotRunCommand;
  broker: BotBrokerClient;
  bridgeOrigin: string;
  /** Tests inject a scripted provider; production always uses the loopback bridge. */
  route?: { provider: Provider<Api>; model: Model<Api> };
  signal?: AbortSignal;
  now?: () => number;
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

/**
 * Runs one bot turn in the sandboxed workload. The agent holds no credential
 * and no network: model calls go through the loopback bridge and every tool
 * call is a broker request that the gateway authorizes and checkpoints.
 */
export async function runBotTurn(input: RunBotTurnInput): Promise<BotRunOutcome> {
  const { command, broker } = input;
  const now = input.now ?? Date.now;
  const snapshot = await broker.loadSession();
  // Leading prompt/tool system messages are rebuilt from this run's revision.
  const history = decodeSession(snapshot.messages).filter((message) => message.role !== "system");
  const { provider, model } = input.route ?? createBridgeModel(command.route, input.bridgeOrigin);
  const tools: BotToolsState = { waitingForPerson: false, effectUnknown: false };
  let toolActions = 0;
  let budgetExhausted = false;
  let toolInFlight = false;
  let eventFailure: BotToolErrorCode | undefined;

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
      maxTokens: command.route.maxOutputTokens,
    }),
    toolExecution: "sequential",
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

  try {
    if (command.turn.kind === "prompt") {
      const images: ImageContent[] = (command.turn.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      await agent.prompt(command.turn.text, images.length > 0 ? images : undefined);
    } else {
      await agent.continue();
    }
    await agent.waitForIdle();
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  const status = (() => {
    if (eventFailure) return { status: "failed" as const, failureCode: eventFailure };
    if (input.signal?.aborted) return { status: tools.effectUnknown || toolInFlight ? "uncertain" as const : "cancelled" as const };
    if (budgetExhausted) return { status: "blocked" as const, blockedReason: "budget_exhausted" as const };
    if (tools.waitingForPerson) return { status: "waiting_person" as const };
    if (agent.state.errorMessage) return { status: "failed" as const, failureCode: "unavailable" as const };
    return { status: "completed" as const };
  })();

  let messages: AgentMessage[] = [...agent.state.messages];
  try {
    if (needsCompaction(messages, command.route.contextWindow)) {
      messages = await compactSession({
        messages,
        now,
        summarize: async (transcript) => {
          const reply = await provider.streamSimple(model, normalizeContext({
            systemPrompt: SUMMARY_PROMPT,
            messages: [{ role: "user", content: transcript, timestamp: now() }],
          }), { maxTokens: SUMMARY_MAX_TOKENS }).result();
          return textOf(reply);
        },
      });
    }
    const saved = await broker.saveSession({ baseRevision: snapshot.revision, messages: encodeSession(messages) });
    return outcome(command, { ...status, sessionRevision: saved.revision, toolActions });
  } catch (error: unknown) {
    const failureCode: BotToolErrorCode = error instanceof BotBrokerError ? error.code : "unavailable";
    if (!(error instanceof BotBrokerError) && !(error instanceof BotSessionError)) {
      console.warn("[bot-runtime] session save failed:", error instanceof Error ? error.name : "UnknownError");
    }
    return outcome(command, { status: "failed", failureCode, sessionRevision: snapshot.revision, toolActions });
  }
}
