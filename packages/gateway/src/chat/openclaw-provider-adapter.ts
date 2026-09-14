import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type {
  OpenClawRpcClient,
  OpenClawRpcEvent,
} from "../agent-config/openclaw-rpc.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import { safeToolActivity } from "./safe-activity-projection.js";

const SafeSessionReferenceSchema = z.string().min(1).max(512);
const OpenClawChatStateSchema = z.object({
  sessionKey: SafeSessionReferenceSchema,
  agentId: SafeSessionReferenceSchema.optional(),
}).strict();
const AcceptedSchema = z.object({
  runId: SafeSessionReferenceSchema,
  sessionKey: SafeSessionReferenceSchema.optional(),
  agentId: SafeSessionReferenceSchema.optional(),
  status: z.literal("accepted"),
  acceptedAt: z.number().int().nonnegative().optional(),
}).passthrough();
const AgentEventPayloadSchema = z.object({
  runId: SafeSessionReferenceSchema,
  sessionKey: SafeSessionReferenceSchema.optional(),
  agentId: SafeSessionReferenceSchema.optional(),
  seq: z.number().int().nonnegative(),
  stream: z.string().min(1).max(64),
  ts: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
}).passthrough();
const TerminalResponseSchema = z.object({
  runId: SafeSessionReferenceSchema.optional(),
  status: z.string().min(1).max(64),
}).passthrough();
const SteerResponseSchema = z.object({
  runId: SafeSessionReferenceSchema.optional(),
  status: z.enum(["started", "in_flight", "ok"]),
}).passthrough();

export type OpenClawChatState = z.infer<typeof OpenClawChatStateSchema>;

interface ActiveRun {
  ownerId: string;
  chatId: string;
  providerRunId: string;
  sessionKey?: string;
  agentId?: string;
  cancelled: boolean;
}

interface OpenClawChatProviderOptions {
  rpc: OpenClawRpcClient;
  homePath: string;
  timeoutMs?: number;
  maxBufferedEvents?: number;
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const MAX_RUN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 500;
const MAX_ACTIVE_RUNS = 128;

function providerReference(value: unknown, prefix: string): string {
  if (typeof value === "string") {
    const candidate = value.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate) && !candidate.includes("..")) {
      return candidate;
    }
    return `${prefix}${createHash("sha256").update(candidate).digest("hex").slice(0, 24)}`;
  }
  return `${prefix}unknown`;
}

function initialSessionKey(chatId: string): string {
  const digest = createHash("sha256").update(chatId).digest("hex").slice(0, 24);
  return `agent:main:matrix-chat-${digest}`;
}

function toolFailed(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === false
    || result.success === false
    || ["error", "failed", "failure"].includes(String(result.status ?? "").toLowerCase());
}

function chunks(value: string): string[] {
  const output: string[] = [];
  for (let offset = 0; offset < value.length; offset += 4_000) {
    const chunk = value.slice(offset, offset + 4_000);
    if (chunk) output.push(chunk);
  }
  return output;
}

function failure(): CanonicalProviderRunEvent {
  return CanonicalProviderRunEventSchema.parse({
    type: "run.completed",
    outcome: "failed",
    error: {
      code: "run_failed",
      safeMessage: "The OpenClaw run failed.",
      retryable: true,
      recoveryActions: ["retry"],
    },
  });
}

function completion(outcome: "completed" | "aborted"): CanonicalProviderRunEvent {
  return CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome });
}

type ToolActivity = ReturnType<typeof safeToolActivity>;

function normalizeEvent(
  payload: z.infer<typeof AgentEventPayloadSchema>,
  options: { homePath: string; executionRoot?: string; toolActivities: Map<string, ToolActivity> },
): CanonicalProviderRunEvent[] {
  if (payload.stream === "assistant") {
    const value = typeof payload.data.delta === "string"
      ? payload.data.delta
      : typeof payload.data.text === "string"
        ? payload.data.text
        : "";
    return chunks(value).map((delta) => CanonicalProviderRunEventSchema.parse({
      type: "assistant.delta",
      delta,
    }));
  }
  if (payload.stream === "tool") {
    const phase = typeof payload.data.phase === "string" ? payload.data.phase : "";
    if (!["start", "input_delta", "update", "review", "result"].includes(phase)) return [];
    const toolCallId = providerReference(payload.data.toolCallId, "tool_");
    const rawName = typeof payload.data.name === "string" ? payload.data.name : "tool";
    const name = rawName.trim().toLowerCase() === "exec" ? "execute" : rawName;
    let activity = options.toolActivities.get(toolCallId);
    if (phase === "start" || activity === undefined) {
      activity = safeToolActivity(name, payload.data.args, options);
      if (!options.toolActivities.has(toolCallId) && options.toolActivities.size >= 128) {
        const oldest = options.toolActivities.keys().next().value;
        if (oldest !== undefined) options.toolActivities.delete(oldest);
      }
      options.toolActivities.set(toolCallId, activity);
    }
    const failed = payload.data.isError === true || toolFailed(payload.data.result);
    const status = phase === "result" ? failed ? "failed" : "completed" : "running";
    return [CanonicalProviderRunEventSchema.parse({
      type: "agent.activity",
      activityId: toolCallId,
      kind: activity.kind,
      label: activity.displayName,
      status,
      ...(activity.preview === undefined ? {} : { preview: activity.preview }),
      ...(activity.previewKind === undefined ? {} : { previewKind: activity.previewKind }),
      ...(activity.detail === undefined ? {} : { detail: activity.detail }),
    })];
  }
  if (payload.stream === "lifecycle") {
    const phase = typeof payload.data.phase === "string" ? payload.data.phase : "";
    if (phase === "start") {
      return [CanonicalProviderRunEventSchema.parse({
        type: "agent.activity",
        activityId: "openclaw_run",
        kind: "phase",
        label: "Working",
        status: "running",
      })];
    }
    if (phase === "end") {
      return [CanonicalProviderRunEventSchema.parse({
        type: "agent.activity",
        activityId: "openclaw_run",
        kind: "phase",
        label: "Working",
        status: "completed",
      })];
    }
  }
  return [];
}

export function createOpenClawChatProviderAdapter(
  options: OpenClawChatProviderOptions,
): CanonicalChatProviderAdapter<OpenClawChatState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw new RangeError("Invalid OpenClaw Chat run timeout");
  }
  if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1 || maxBufferedEvents > 1_000) {
    throw new RangeError("Invalid OpenClaw Chat event buffer cap");
  }
  const activeRuns = new Map<string, ActiveRun>();

  function modelSelection(value: string): { provider: string; model: string } | undefined {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) return undefined;
    const provider = value.slice(0, separator);
    const model = value.slice(separator + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(provider) || model.length > 512) return undefined;
    return { provider, model };
  }

  function track(runId: string, active: ActiveRun): void {
    if (!activeRuns.has(runId) && activeRuns.size >= MAX_ACTIVE_RUNS) {
      const oldest = activeRuns.keys().next().value;
      if (oldest !== undefined) activeRuns.delete(oldest);
    }
    activeRuns.set(runId, active);
  }

  async function abortRun(active: ActiveRun, state?: OpenClawChatState): Promise<void> {
    active.cancelled = true;
    const sessionKey = active.sessionKey ?? state?.sessionKey;
    if (!sessionKey) return;
    const agentId = active.agentId ?? state?.agentId;
    try {
      await options.rpc.call("chat.abort", {
        sessionKey,
        runId: active.providerRunId,
        ...(agentId === undefined ? {} : { agentId }),
      }, AbortSignal.timeout(10_000), { timeoutMs: 10_000 });
    } catch (error: unknown) {
      // Cancellation is best effort. The active agent request remains bounded.
      console.warn(
        "[chat-openclaw] cancellation request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  async function* run(
    input: CanonicalProviderRunInput<OpenClawChatState>,
  ): AsyncIterable<CanonicalProviderRunEvent> {
    parseCanonicalProviderRunInput(input);
    const selectedModel = modelSelection(input.selection.model);
    if (!selectedModel) {
      yield failure();
      return;
    }
    const buffered: z.infer<typeof AgentEventPayloadSchema>[] = [];
    let wake = Promise.withResolvers<void>();
    let overflowed = false;
    let protocolFailed = false;
    let settled = false;
    let terminalValue: unknown;
    let terminalError: unknown;
    const toolActivities = new Map<string, ToolActivity>();
    const requestedSessionKey = input.resumeState?.sessionKey ?? initialSessionKey(input.chatId);
    const active: ActiveRun = {
      ownerId: input.owner.ownerId,
      chatId: input.chatId,
      providerRunId: input.runId,
      sessionKey: requestedSessionKey,
      agentId: input.resumeState?.agentId,
      cancelled: false,
    };
    track(input.runId, active);

    const onEvent = (event: OpenClawRpcEvent) => {
      if (event.event !== "agent") return;
      const parsed = AgentEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.runId !== active.providerRunId) return;
      if (buffered.length >= maxBufferedEvents) {
        overflowed = true;
      } else {
        buffered.push(parsed.data);
      }
      wake.resolve();
    };
    const onAbort = () => { void abortRun(active, input.resumeState); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();

    const call = options.rpc.call("agent", {
      message: input.prompt,
      provider: selectedModel.provider,
      model: selectedModel.model,
      sessionKey: requestedSessionKey,
      deliver: false,
      timeout: Math.ceil(timeoutMs / 1_000),
      idempotencyKey: input.runId,
    }, new AbortController().signal, {
      expectFinal: true,
      timeoutMs: Math.min(timeoutMs + 5_000, MAX_RUN_TIMEOUT_MS),
      onAccepted(value) {
        const parsed = AcceptedSchema.safeParse(value);
        if (!parsed.success) {
          protocolFailed = true;
          wake.resolve();
          return;
        }
        active.providerRunId = parsed.data.runId;
        if (parsed.data.sessionKey !== undefined) active.sessionKey = parsed.data.sessionKey;
        active.agentId = parsed.data.agentId;
        if (active.cancelled) void abortRun(active, input.resumeState);
        wake.resolve();
      },
      onEvent,
    });
    void call.then(
      (value) => { terminalValue = value; settled = true; wake.resolve(); },
      (error: unknown) => { terminalError = error; settled = true; wake.resolve(); },
    );

    let publishedState = false;
    try {
      while (!settled || buffered.length > 0) {
        if (!publishedState && active.sessionKey) {
          publishedState = true;
          yield CanonicalProviderRunEventSchema.parse({
            type: "state.updated",
            state: {
              sessionKey: active.sessionKey,
              ...(active.agentId === undefined ? {} : { agentId: active.agentId }),
            },
          });
        }
        const next = buffered.shift();
        if (next) {
          for (const event of normalizeEvent(next, {
            homePath: options.homePath,
            executionRoot: input.executionRoot,
            toolActivities,
          })) yield event;
          continue;
        }
        if (settled) break;
        const waiting = wake.promise;
        await waiting;
        if (wake.promise === waiting) wake = Promise.withResolvers<void>();
      }
      const terminal = TerminalResponseSchema.safeParse(terminalValue);
      if (active.cancelled || input.signal.aborted) {
        yield completion("aborted");
      } else if (overflowed || protocolFailed || terminalError !== undefined
        || !terminal.success || terminal.data.status !== "ok") {
        yield failure();
      } else {
        yield completion("completed");
      }
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      activeRuns.delete(input.runId);
    }
  }

  return {
    driverKind: "openclaw",
    stateSchemaVersion: 1,
    parseState(value) {
      return OpenClawChatStateSchema.parse(value);
    },
    serializeState(value) {
      return OpenClawChatStateSchema.parse(value);
    },
    start(input) {
      return run(input);
    },
    resume(input) {
      return run(input);
    },
    async cancel(input) {
      const state = input.state === undefined ? undefined : OpenClawChatStateSchema.parse(input.state);
      const active = activeRuns.get(input.runId) ?? {
        ownerId: input.owner.ownerId,
        chatId: input.chatId,
        providerRunId: input.runId,
        sessionKey: state?.sessionKey,
        agentId: state?.agentId,
        cancelled: true,
      };
      await abortRun(active, state);
    },
    async steer(input) {
      const active = activeRuns.get(input.runId);
      if (!active
        || active.ownerId !== input.owner.ownerId
        || active.chatId !== input.chatId
        || active.cancelled
        || !active.sessionKey) {
        throw new Error("OpenClaw steering Run unavailable");
      }
      const response = SteerResponseSchema.parse(await options.rpc.call("sessions.steer", {
        key: active.sessionKey,
        runId: active.providerRunId,
        message: input.prompt,
        idempotencyKey: input.clientRequestId,
      }, AbortSignal.timeout(10_000), { timeoutMs: 10_000 }));
      if (response.runId !== undefined && response.runId !== active.providerRunId) {
        throw new Error("OpenClaw steering target changed");
      }
    },
  };
}
