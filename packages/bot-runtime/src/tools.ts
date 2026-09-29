import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { BOT_ARTIFACT_MAX_BYTES, BotToolRequestSchema, type BotToolCapability, type BotToolErrorCode, type BotToolRequest } from "@matrix-os/contracts";
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

// Mirrors of the broker's argument rules, so the advertised schema matches what the broker accepts.
const SERVICE = Type.String({ pattern: "^[a-z][a-z0-9_]{1,63}$", description: "Service slug from integration_inventory, e.g. gmail." });
const REFERENCE = { pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" } as const;
const WORKSPACE_PATH = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^/~\\\\\\u0000][^\\\\\\u0000]*$",
  description: "Relative path inside this bot's workspace, e.g. briefs/acme.md. No leading slash and no . or .. segments.",
});
/** Contract field names that differ from the model-facing parameter names. */
const PARAMETER_NAMES: Readonly<Record<string, string>> = {
  relPath: "path",
  url: "sourceUrl",
  questions: "question",
  label: "options",
  description: "options",
};

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
    parameters: Type.Object({ service: Type.Optional(SERVICE) }),
    toArgs: (params) => (typeof params.service === "string" ? { service: params.service } : {}),
  },
  {
    name: "integration_call",
    capability: "integration.call",
    description: "Run one action on a connected service account the bot is allowed to use.",
    parameters: Type.Object({
      service: SERVICE,
      action: Type.String({ ...REFERENCE, description: "Action id listed for the service." }),
      connectionId: Type.String({ ...REFERENCE, description: "Connection id from integration_inventory." }),
      params: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown(), { description: "Action parameters, at most 32 KiB." }),
    }),
    toArgs: (params) => ({ service: params.service, action: params.action, connectionId: params.connectionId, params: params.params }),
  },
  {
    name: "remember",
    capability: "memory.propose",
    description: "Remember an owner-stated preference, fact, or finished task. For owner-stated content, omit optional sourceUrl; never invent a URL. A pending-confirmation result is not active memory.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("preference"), Type.Literal("fact"), Type.Literal("episode")]),
      content: Type.String({ minLength: 1, maxLength: 4096 }),
      sourceUrl: Type.Optional(Type.String({ maxLength: 2048, pattern: "^https://", description: "Optional real HTTPS source link; omit for the owner's own statement." })),
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
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    toArgs: (params) => ({ query: params.query, limit: typeof params.limit === "number" ? params.limit : 5 }),
  },
  {
    name: "ask_person",
    capability: "interaction.create",
    description: "Ask the person one question. Use blocking only when you cannot continue without the answer.",
    parameters: Type.Object({
      header: Type.String({ minLength: 1, maxLength: 120, description: "Short title for the question." }),
      question: Type.String({ minLength: 1, maxLength: 600 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 10, uniqueItems: true })),
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
      path: WORKSPACE_PATH,
      content: Type.String({ maxLength: BOT_ARTIFACT_MAX_BYTES, description: "At most 192 KiB of UTF-8 text." }),
      mimeType: Type.Union(["text/markdown", "text/plain", "text/csv", "application/json", "text/html"].map((value) => Type.Literal(value))),
    }),
    toArgs: (params) => ({ relPath: params.path, content: params.content, mimeType: params.mimeType }),
  },
  {
    name: "read_artifact",
    capability: "artifact.read",
    description: "Read a text file from this bot's workspace.",
    parameters: Type.Object({ path: WORKSPACE_PATH }),
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

/** Names only the fields the broker rejected; never echoes values or validator text. */
function invalidArgumentsGuidance(paths: readonly (readonly PropertyKey[])[]): string {
  const fields = new Set<string>();
  for (const path of paths) {
    const name = [...path].reverse().find((part): part is string => typeof part === "string" && part !== "args" && part !== "payload");
    if (name && /^[A-Za-z]{1,32}$/.test(name)) fields.add(PARAMETER_NAMES[name] ?? name);
  }
  return fields.size > 0
    ? `${REFUSAL_GUIDANCE.invalid_arguments} Fix: ${[...fields].slice(0, 5).join(", ")}.`
    : REFUSAL_GUIDANCE.invalid_arguments;
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
      const checked = BotToolRequestSchema.safeParse({
        toolCallId: SAFE_CALL_ID.test(toolCallId) ? toolCallId : `call_${randomUUID()}`,
        capability: spec.capability,
        args: spec.toArgs(params as Record<string, unknown>, now),
      });
      if (!checked.success) throw new Error(invalidArgumentsGuidance(checked.error.issues.map((issue) => issue.path)));
      const request: BotToolRequest = checked.data;
      try {
        const result = await untilCancelled(input.broker.tool(request), signal, input.state);
        if (!result.ok) throw new Error(REFUSAL_GUIDANCE[result.code]);
        const terminate = spec.terminates?.(params as Record<string, unknown>) === true;
        if (terminate) input.state.waitingForPerson = true;
        return { content: result.content, details: undefined, ...(terminate ? { terminate: true } : {}) };
      } catch (error: unknown) {
        if (error instanceof ToolCancelledError) throw error;
        if (error instanceof BotBrokerError) throw new Error(REFUSAL_GUIDANCE[error.code]);
        if (error instanceof Error && Object.values(REFUSAL_GUIDANCE).some((guidance) => error.message.startsWith(guidance))) throw error;
        console.warn("[bot-runtime] tool dispatch failed:", error instanceof Error ? error.name : "UnknownError");
        throw new Error(REFUSAL_GUIDANCE.unavailable);
      }
    },
  }));
}
