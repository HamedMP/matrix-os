import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { BotToolCapability, BotToolErrorCode, BotToolRequest } from "@matrix-os/contracts";
import { BotBrokerError, type BotBrokerClient } from "./broker-client.js";

/** Model-facing guidance per refusal. Never includes provider, path, or server detail. */
const REFUSAL_GUIDANCE: Record<BotToolErrorCode, string> = {
  denied: "This action is not allowed for this bot.",
  not_granted: "This bot does not have access for that yet. Ask the person to connect or allow it.",
  approval_required: "This needs the person's approval first. Describe the exact change and ask them.",
  invalid_arguments: "The request was not valid. Check the arguments and try once more.",
  unavailable: "That service is unavailable right now. Tell the person what is blocked.",
  timeout: "That took too long and was stopped. Tell the person it may need to be retried.",
  budget_exhausted: "This task reached its action budget. Summarize progress and stop.",
  stale_generation: "This run was superseded. Stop now.",
};

const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface ToolSpec {
  name: string;
  capability: BotToolCapability;
  description: string;
  parameters: TSchema;
  toArgs(params: Record<string, unknown>, now: () => Date): Record<string, unknown>;
  /** A blocking question ends the turn; the run resumes when the person answers. */
  terminates?(params: Record<string, unknown>): boolean;
}

const SPECS: ToolSpec[] = [
  {
    name: "integration_inventory",
    capability: "integration.inventory",
    description: "List the person's connected services this bot may see. Optionally filter by service slug.",
    parameters: Type.Object({ service: Type.Optional(Type.String({ maxLength: 64 })) }),
    toArgs: (params) => (typeof params.service === "string" ? { service: params.service } : {}),
  },
  {
    name: "integration_call",
    capability: "integration.call",
    description: "Run one action on a connected service account the bot is allowed to use.",
    parameters: Type.Object({
      service: Type.String({ maxLength: 64 }),
      action: Type.String({ maxLength: 128 }),
      connectionId: Type.String({ maxLength: 128 }),
      params: Type.Record(Type.String(), Type.Unknown()),
    }),
    toArgs: (params) => ({ service: params.service, action: params.action, connectionId: params.connectionId, params: params.params }),
  },
  {
    name: "remember",
    capability: "memory.propose",
    description: "Remember a preference, fact, or finished task. Say where it came from.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("preference"), Type.Literal("fact"), Type.Literal("episode")]),
      content: Type.String({ maxLength: 4096 }),
      sourceUrl: Type.Optional(Type.String({ maxLength: 2048 })),
    }),
    toArgs: (params, now) => ({
      kind: params.kind,
      scope: "bot",
      content: params.content,
      source: { ...(typeof params.sourceUrl === "string" ? { url: params.sourceUrl } : {}), at: now().toISOString() },
    }),
  },
  {
    name: "recall",
    capability: "memory.search",
    description: "Search what this bot remembers.",
    parameters: Type.Object({ query: Type.String({ maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    toArgs: (params) => ({ query: params.query, limit: typeof params.limit === "number" ? params.limit : 5 }),
  },
  {
    name: "ask_person",
    capability: "interaction.create",
    description: "Ask the person one question. Use blocking only when you cannot continue without the answer.",
    parameters: Type.Object({
      header: Type.String({ maxLength: 60 }),
      question: Type.String({ maxLength: 600 }),
      options: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 10 })),
      blocking: Type.Boolean(),
    }),
    toArgs: (params) => ({
      blocking: params.blocking,
      payload: {
        kind: "question",
        questions: [{
          questionId: "q1",
          header: params.header,
          question: params.question,
          ...(Array.isArray(params.options) && params.options.length > 0
            ? { options: params.options.map((label) => ({ label, description: label })) }
            : {}),
        }],
      },
    }),
    terminates: (params) => params.blocking === true,
  },
  {
    name: "write_artifact",
    capability: "artifact.write",
    description: "Save a text file in this bot's workspace, then read it back to confirm.",
    parameters: Type.Object({
      path: Type.String({ maxLength: 256 }),
      content: Type.String(),
      mimeType: Type.Union(["text/markdown", "text/plain", "text/csv", "application/json", "text/html"].map((value) => Type.Literal(value))),
    }),
    toArgs: (params) => ({ relPath: params.path, content: params.content, mimeType: params.mimeType }),
  },
  {
    name: "read_artifact",
    capability: "artifact.read",
    description: "Read a text file from this bot's workspace.",
    parameters: Type.Object({ path: Type.String({ maxLength: 256 }) }),
    toArgs: (params) => ({ relPath: params.path }),
  },
];

export interface BotToolsState {
  /** Set when a blocking question ended the turn. */
  waitingForPerson: boolean;
  /** Set when a run was cancelled while a broker call was outstanding; its effect is unknown. */
  effectUnknown: boolean;
}

class ToolCancelledError extends Error {
  constructor() {
    super("The run was stopped before this action finished.");
    this.name = "ToolCancelledError";
  }
}

/** Resolves with the broker result, or rejects as soon as the run is cancelled. */
function untilCancelled<T>(pending: Promise<T>, signal: AbortSignal | undefined, state: BotToolsState): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      state.effectUnknown = true;
      reject(new ToolCancelledError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export function capabilityForToolName(name: string): BotToolCapability | undefined {
  return SPECS.find((spec) => spec.name === name)?.capability;
}

export function createBotTools(input: {
  capabilities: readonly BotToolCapability[];
  broker: BotBrokerClient;
  state: BotToolsState;
  now?: () => Date;
}): AgentTool[] {
  const now = input.now ?? (() => new Date());
  return SPECS.filter((spec) => input.capabilities.includes(spec.capability)).map((spec): AgentTool => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
      const request = {
        toolCallId: SAFE_CALL_ID.test(toolCallId) ? toolCallId : `call_${randomUUID()}`,
        capability: spec.capability,
        args: spec.toArgs(params as Record<string, unknown>, now),
      } as BotToolRequest;
      try {
        const result = await untilCancelled(input.broker.tool(request), signal, input.state);
        if (!result.ok) throw new Error(REFUSAL_GUIDANCE[result.code]);
        const terminate = spec.terminates?.(params as Record<string, unknown>) === true;
        if (terminate) input.state.waitingForPerson = true;
        return { content: result.content, details: undefined, ...(terminate ? { terminate: true } : {}) };
      } catch (error: unknown) {
        if (error instanceof ToolCancelledError) throw error;
        if (error instanceof BotBrokerError) throw new Error(REFUSAL_GUIDANCE[error.code]);
        if (error instanceof Error && Object.values(REFUSAL_GUIDANCE).includes(error.message)) throw error;
        console.warn("[bot-runtime] tool dispatch failed:", error instanceof Error ? error.name : "UnknownError");
        throw new Error(REFUSAL_GUIDANCE.unavailable);
      }
    },
  }));
}
