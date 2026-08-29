import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { CanonicalProviderModelIdSchema } from "@matrix-os/contracts";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import { createCanonicalCliEventQueue } from "./cli-process.js";
import {
  createHermesStdioClient,
  type HermesGatewayEvent,
  type HermesGatewaySpawn,
} from "./hermes-stdio-client.js";

const SafeSessionIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/);
const HermesChatStateSchema = z.object({ sessionId: SafeSessionIdSchema }).strict();
const HermesSessionSchema = z.object({
  session_id: SafeSessionIdSchema,
  stored_session_id: SafeSessionIdSchema.optional(),
  session_key: SafeSessionIdSchema.optional(),
}).passthrough();
const HermesDeltaSchema = z.object({ text: z.string().max(96 * 1024) }).passthrough();
const HermesInterimSchema = z.object({
  text: z.string().min(1).max(96 * 1024),
  already_streamed: z.boolean().default(false),
}).passthrough();
const HermesCompletionSchema = z.object({
  text: z.string().max(96 * 1024),
  status: z.enum(["complete", "completed", "interrupted", "error"]).default("complete"),
  response_previewed: z.boolean().default(false),
}).passthrough();
const HermesToolStartSchema = z.object({
  tool_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  name: z.string().trim().min(1).max(160),
}).passthrough();
const HermesToolCompleteSchema = HermesToolStartSchema.extend({
  result: z.unknown().optional(),
}).passthrough();
const HermesStatusUpdateSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  text: z.string().max(4_000).optional(),
}).passthrough();
const HermesReasoningAvailableSchema = z.object({ text: z.string().max(96 * 1024) }).passthrough();
const HermesSubagentStartSchema = z.object({
  subagent_id: z.string().min(1).max(256).optional(),
  task_index: z.number().int().min(0).max(10_000),
}).passthrough();
const HermesSubagentCompleteSchema = z.object({
  subagent_id: z.string().min(1).max(256).optional(),
  status: z.string().trim().min(1).max(80),
}).passthrough();
const HermesApprovalRequestSchema = z.object({
  request_id: z.string().min(1).max(256).optional(),
}).passthrough();
const HermesClarifyRequestSchema = z.object({
  request_id: z.string().min(1).max(256),
}).passthrough();
const HermesPromptResponseSchema = z.object({ status: z.literal("streaming") }).passthrough();
const HermesModelConfigResponseSchema = z.object({ confirm_required: z.boolean().optional() }).passthrough();
const HermesYoloResponseSchema = z.object({
  key: z.literal("yolo"),
  value: z.literal("1"),
  scope: z.literal("session"),
}).passthrough();
const HermesCwdResponseSchema = z.object({ cwd: z.string().min(1).max(4_096) }).passthrough();
type HermesCompletion = z.infer<typeof HermesCompletionSchema>;
type HermesCompletionResult =
  | { ok: true; value: HermesCompletion }
  | { ok: false; error: Error };
type HermesActivity = Extract<CanonicalProviderRunEvent, { type: "agent.activity" }>;

class HermesRunFailure extends Error {
  constructor(readonly reason: "run" | "interrupted" | "timeout", message: string) {
    super(message);
    this.name = "HermesRunFailure";
  }
}

export type HermesChatState = z.infer<typeof HermesChatStateSchema>;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 96 * 1024;
const DELTA_FLUSH_BYTES = 256;
const DELTA_FLUSH_INTERVAL_MS = 50;
// Reserve room in the 500-event canonical queue for a bounded final flush and terminal events.
const MAX_LIVE_DELTA_EVENTS = 350;
const MAX_ACTIVE_TOOL_ACTIVITIES = 128;
const MAX_ACTIVE_STATUS_ACTIVITIES = 16;

function selection(value: string): { provider: string; model: string } {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("Unsupported Hermes model selection");
  }
  const provider = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).parse(value.slice(0, separator));
  const model = CanonicalProviderModelIdSchema.parse(value.slice(separator + 1));
  return { provider, model };
}

function outputChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 4_000) {
    const chunk = text.slice(index, index + 4_000);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function hermesToolActivity(name: string): Pick<HermesActivity, "kind" | "label"> {
  const normalized = name.trim().toLowerCase();
  if (["terminal", "shell", "bash", "execute", "execute_code", "run_command"].includes(normalized)) {
    return { kind: "command", label: "Run command" };
  }
  if (["web_search", "web_extract", "browser", "browser_use"].includes(normalized)) {
    return { kind: "web_search", label: "Search the web" };
  }
  if (["delegate_task", "subagent", "spawn_subagent"].includes(normalized)) {
    return { kind: "delegation", label: "Delegated task" };
  }
  if (["todo", "plan", "update_plan"].includes(normalized)) {
    return { kind: "plan", label: "Update plan" };
  }
  if (/^(?:write|edit|patch|replace|apply)_?file$/.test(normalized) || normalized === "apply_patch") {
    return { kind: "file_change", label: "Update file" };
  }
  if (normalized.startsWith("mcp_") || normalized.includes("mcp")) {
    return { kind: "mcp_tool", label: "Use connected tool" };
  }
  if (normalized.includes("image") && (normalized.includes("inspect") || normalized.includes("analy"))) {
    return { kind: "image_inspection", label: "Inspect image" };
  }
  return { kind: "dynamic_tool", label: "Use tool" };
}

function hermesActivitySummary(kind: HermesActivity["kind"], failed: boolean): string {
  if (kind === "command") return failed ? "Command failed." : "Command completed.";
  if (kind === "web_search") return failed ? "Web search failed." : "Web search completed.";
  if (kind === "delegation") return failed ? "Delegated work failed." : "Delegated work completed.";
  if (kind === "file_change") return failed ? "File update failed." : "File update completed.";
  return failed ? "Tool failed." : "Tool completed.";
}

function hermesFailedActivityMessage(kind: HermesActivity["kind"]): string {
  if (kind === "command") return "A command failed during this Run.";
  if (kind === "web_search") return "A web search failed during this Run.";
  if (kind === "delegation") return "Delegated work failed during this Run.";
  if (kind === "file_change") return "A file update failed during this Run.";
  return "A tool failed during this Run.";
}

function providerReference(prefix: string, value: string): string {
  const candidate = `${prefix}${value}`;
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate)) return candidate;
  return `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (!map.has(key) && map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function hermesStatusActivity(kind: string): Pick<HermesActivity, "activityId" | "kind" | "label"> | undefined {
  const normalized = kind.trim().toLowerCase();
  if (["planning", "plan", "todo"].includes(normalized)) {
    return { activityId: "status_planning", kind: "plan", label: "Planning" };
  }
  if (["thinking", "reasoning"].includes(normalized)) {
    return { activityId: "status_reasoning", kind: "reasoning", label: "Analyzing" };
  }
  if (normalized === "compacting") {
    return { activityId: "status_compacting", kind: "phase", label: "Summarizing conversation" };
  }
  if (["process", "loop", "lifecycle"].includes(normalized)) {
    return { activityId: `status_${normalized}`, kind: "phase", label: "Working" };
  }
  return undefined;
}

function hermesToolFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  if (value.success === false || value.ok === false || value.error !== undefined) return true;
  return ["error", "failed", "failure"].includes(String(value.status ?? "").toLowerCase());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

export function createHermesChatProviderAdapter(options: {
  homePath: string;
  spawnFn?: HermesGatewaySpawn;
  timeoutMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}): CanonicalChatProviderAdapter<HermesChatState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function* execute(
    inputValue: CanonicalProviderRunInput<HermesChatState>,
    resumeState?: HermesChatState,
  ): AsyncGenerator<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    if (input.permissionMode !== "full_access") throw new Error("Unsupported Hermes permission mode");
    if (input.interactionMode !== "default") throw new Error("Unsupported Hermes interaction mode");
    const selected = selection(input.selection.model);
    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    const completion = deferred<HermesCompletionResult>();
    let liveSessionId: string | undefined;
    let durableSessionId: string | undefined;
    let currentSegment = "";
    let lastSealedSegment = "";
    let emittedOutputBytes = 0;
    let emittedDeltaEvents = 0;
    let pendingVisibleText = "";
    let deltaFlushTimer: NodeJS.Timeout | undefined;
    let separatorPending = false;
    let completionSettled = false;
    let failedActivityKind: HermesActivity["kind"] | undefined;
    const toolActivities = new Map<string, Pick<HermesActivity, "kind" | "label">>();
    const statusActivities = new Map<string, Pick<HermesActivity, "activityId" | "kind" | "label">>();
    let activeDelegationId: string | undefined;

    const emitAgentActivity = (activity: Omit<HermesActivity, "type">) => {
      queue.push(CanonicalProviderRunEventSchema.parse({ type: "agent.activity", ...activity }));
    };

    const completeStatusActivities = () => {
      for (const activity of statusActivities.values()) {
        emitAgentActivity({ ...activity, status: "completed" });
      }
      statusActivities.clear();
    };

    const flushVisibleText = (force = false) => {
      if (!pendingVisibleText || (!force && emittedDeltaEvents >= MAX_LIVE_DELTA_EVENTS)) return;
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
        deltaFlushTimer = undefined;
      }
      const text = pendingVisibleText;
      pendingVisibleText = "";
      for (const delta of outputChunks(text)) {
        queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
        emittedDeltaEvents += 1;
      }
    };

    const scheduleVisibleTextFlush = () => {
      if (deltaFlushTimer || emittedDeltaEvents >= MAX_LIVE_DELTA_EVENTS) return;
      deltaFlushTimer = setTimeout(() => {
        deltaFlushTimer = undefined;
        flushVisibleText();
      }, DELTA_FLUSH_INTERVAL_MS);
      deltaFlushTimer.unref?.();
    };

    const emitVisibleText = (text: string) => {
      if (!text) return;
      const separator = separatorPending && emittedOutputBytes > 0 ? "\n\n" : "";
      const addedBytes = Buffer.byteLength(separator + text, "utf8");
      if (emittedOutputBytes + addedBytes > MAX_OUTPUT_BYTES) {
        throw new HermesRunFailure("run", "Hermes output exceeded limit");
      }
      pendingVisibleText += separator + text;
      emittedOutputBytes += addedBytes;
      separatorPending = false;
      if (emittedDeltaEvents === 0) {
        flushVisibleText();
      } else if (emittedDeltaEvents < MAX_LIVE_DELTA_EVENTS
        && Buffer.byteLength(pendingVisibleText, "utf8") >= DELTA_FLUSH_BYTES) {
        flushVisibleText();
      } else if (emittedDeltaEvents < MAX_LIVE_DELTA_EVENTS) {
        scheduleVisibleTextFlush();
      }
    };

    const handleEvent = (event: HermesGatewayEvent) => {
      if (completionSettled || !liveSessionId || event.session_id !== liveSessionId) return;
      if (event.type === "message.delta") {
        const { text } = HermesDeltaSchema.parse(event.payload);
        if (!text) return;
        emitVisibleText(text);
        currentSegment += text;
      } else if (event.type === "message.interim") {
        const interim = HermesInterimSchema.parse(event.payload);
        if (interim.already_streamed) {
          if (interim.text !== currentSegment) {
            throw new Error("Hermes interim response did not match streamed output");
          }
        } else {
          if (currentSegment) separatorPending = true;
          emitVisibleText(interim.text);
        }
        lastSealedSegment = interim.text;
        currentSegment = "";
        separatorPending = emittedOutputBytes > 0;
      } else if (event.type === "message.complete") {
        const parsed = HermesCompletionSchema.parse(event.payload);
        completeStatusActivities();
        completionSettled = true;
        completion.resolve({ ok: true, value: parsed });
      } else if (event.type === "status.update") {
        const parsed = HermesStatusUpdateSchema.parse(event.payload);
        const activity = hermesStatusActivity(parsed.kind);
        if (!activity) return;
        setBounded(statusActivities, activity.activityId, activity, MAX_ACTIVE_STATUS_ACTIVITIES);
        emitAgentActivity({ ...activity, status: "running" });
      } else if (event.type === "reasoning.available") {
        HermesReasoningAvailableSchema.parse(event.payload);
        emitAgentActivity({
          activityId: "reasoning_summary",
          kind: "reasoning",
          label: "Reasoning complete",
          status: "completed",
        });
      } else if (event.type === "tool.start") {
        const parsed = HermesToolStartSchema.parse(event.payload);
        const activity = hermesToolActivity(parsed.name);
        setBounded(toolActivities, parsed.tool_id, activity, MAX_ACTIVE_TOOL_ACTIVITIES);
        emitAgentActivity({
          activityId: parsed.tool_id,
          ...activity,
          status: "running",
        });
      } else if (event.type === "tool.complete") {
        const parsed = HermesToolCompleteSchema.parse(event.payload);
        const activity = toolActivities.get(parsed.tool_id) ?? hermesToolActivity(parsed.name);
        toolActivities.delete(parsed.tool_id);
        const failed = hermesToolFailed(parsed.result);
        if (failed) failedActivityKind = activity.kind;
        emitAgentActivity({
          activityId: parsed.tool_id,
          ...activity,
          status: failed ? "failed" : "completed",
          summary: hermesActivitySummary(activity.kind, failed),
        });
      } else if (event.type === "subagent.start" || event.type === "subagent.spawn_requested") {
        const parsed = HermesSubagentStartSchema.parse(event.payload);
        activeDelegationId = providerReference("subagent_", parsed.subagent_id ?? String(parsed.task_index));
        emitAgentActivity({
          activityId: activeDelegationId,
          kind: "delegation",
          label: "Delegated task",
          status: "running",
        });
      } else if (event.type === "subagent.complete") {
        const parsed = HermesSubagentCompleteSchema.parse(event.payload);
        const activityId = parsed.subagent_id
          ? providerReference("subagent_", parsed.subagent_id)
          : activeDelegationId;
        if (!activityId) return;
        const normalizedStatus = parsed.status.toLowerCase();
        const status = ["completed", "complete", "success", "succeeded"].includes(normalizedStatus)
          ? "completed" as const
          : ["cancelled", "canceled", "aborted", "interrupted"].includes(normalizedStatus)
            ? "cancelled" as const
            : "failed" as const;
        if (status === "failed") failedActivityKind = "delegation";
        emitAgentActivity({
          activityId,
          kind: "delegation",
          label: "Delegated task",
          status,
          summary: status === "completed"
            ? "Delegated work completed."
            : status === "cancelled" ? "Delegated work cancelled." : "Delegated work failed.",
        });
        if (activityId === activeDelegationId) activeDelegationId = undefined;
      } else if (event.type === "approval.request") {
        const parsed = HermesApprovalRequestSchema.parse(event.payload);
        const approvalId = parsed.request_id
          ? providerReference("", parsed.request_id)
          : providerReference("approval_", JSON.stringify(event.payload));
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "approval.requested",
          approvalId,
          title: "Command approval required",
          risk: "high",
        }));
      } else if (event.type === "clarify.request") {
        const parsed = HermesClarifyRequestSchema.parse(event.payload);
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "input.requested",
          requestId: providerReference("", parsed.request_id),
          title: "Hermes needs input",
        }));
      } else if (event.type === "error") {
        completionSettled = true;
        completion.resolve({ ok: false, error: new Error("Hermes Run failed") });
      }
    };

    const hermesRoot = join(options.homePath, ".hermes", "hermes-agent");
    const existingPythonPath = process.env.PYTHONPATH?.trim();
    const client = createHermesStdioClient({
      command: join(hermesRoot, "venv", "bin", "python"),
      args: ["-u", "-m", "tui_gateway.entry"],
      cwd: input.executionRoot ?? options.homePath,
      env: {
        ...buildAgentRuntimeEnvironment(options.homePath),
        HERMES_PYTHON_SRC_ROOT: hermesRoot,
        PYTHONPATH: existingPythonPath ? `${hermesRoot}${delimiter}${existingPythonPath}` : hermesRoot,
        PYTHONUNBUFFERED: "1",
      },
      spawnFn: options.spawnFn,
      readyTimeoutMs: options.readyTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      onEvent: handleEvent,
      onFailure(error) {
        if (!completionSettled) {
          completionSettled = true;
          completion.resolve({ ok: false, error });
        }
      },
    });

    void (async () => {
      let totalTimer: NodeJS.Timeout | undefined;
      let abortRun: (() => void) | undefined;
      try {
        const stopped = new Promise<never>((_resolve, reject) => {
          abortRun = () => reject(new Error("Hermes Run aborted"));
          if (input.signal.aborted) return abortRun();
          input.signal.addEventListener("abort", abortRun, { once: true });
          totalTimer = setTimeout(() => reject(new HermesRunFailure("timeout", "Hermes Run timed out")), timeoutMs);
          totalTimer.unref?.();
        });
        const withinRun = <T>(operation: Promise<T>) => Promise.race([operation, stopped]);
        await withinRun(client.ready());
        const rawSession = resumeState
          ? await withinRun(client.request("session.resume", {
              session_id: resumeState.sessionId,
              cols: 120,
              source: "matrix-os-desktop",
              cwd: input.executionRoot ?? options.homePath,
              omit_messages: true,
            }))
          : await withinRun(client.request("session.create", {
              cols: 120,
              source: "matrix-os-desktop",
              cwd: input.executionRoot ?? options.homePath,
              provider: selected.provider,
              model: selected.model,
            }));
        const session = HermesSessionSchema.parse(rawSession);
        liveSessionId = session.session_id;
        durableSessionId = session.stored_session_id ?? session.session_key ?? resumeState?.sessionId;
        if (!durableSessionId) throw new Error("Hermes did not return a durable session");
        if (resumeState) {
          const modelConfig = HermesModelConfigResponseSchema.parse(await withinRun(client.request("config.set", {
            session_id: liveSessionId,
            key: "model",
            value: `${selected.model} --provider ${selected.provider} --session`,
            confirm_expensive_model: true,
          })));
          if (modelConfig.confirm_required) throw new Error("Hermes model selection requires confirmation");
        }
        const expectedCwd = input.executionRoot ?? options.homePath;
        const cwdResponse = HermesCwdResponseSchema.parse(await withinRun(client.request("session.cwd.set", {
          session_id: liveSessionId,
          cwd: expectedCwd,
        })));
        if (cwdResponse.cwd !== expectedCwd) throw new Error("Hermes execution root did not match");
        HermesYoloResponseSchema.parse(await withinRun(client.request("config.set", {
          session_id: liveSessionId,
          key: "yolo",
          value: "1",
          scope: "session",
        })));
        HermesPromptResponseSchema.parse(await withinRun(client.request("prompt.submit", {
          session_id: liveSessionId,
          text: input.prompt,
          surface: "desktop",
        })));
        const completionResult = await withinRun(completion.promise);
        if (!completionResult.ok) throw completionResult.error;
        const final = completionResult.value;
        if (Buffer.byteLength(final.text, "utf8") > MAX_OUTPUT_BYTES) {
          throw new HermesRunFailure("run", "Hermes output exceeded limit");
        }
        const previewAlreadySealed = final.response_previewed
          && !currentSegment
          && final.text === lastSealedSegment;
        if (!previewAlreadySealed) {
          if (!final.text.startsWith(currentSegment)) {
            throw new HermesRunFailure("run", "Hermes final response did not match streamed output");
          }
          emitVisibleText(final.text.slice(currentSegment.length));
        }
        flushVisibleText(true);
        if (final.status === "error") throw new HermesRunFailure("run", "Hermes Run failed");
        if (final.status === "interrupted" && !input.signal.aborted) {
          throw new HermesRunFailure("interrupted", "Hermes Run was interrupted");
        }
        if (durableSessionId && durableSessionId !== resumeState?.sessionId) {
          queue.push(CanonicalProviderRunEventSchema.parse({
            type: "state.updated",
            state: { sessionId: durableSessionId },
          }));
        }
        queue.push(CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "completed" }));
      } catch (error: unknown) {
        flushVisibleText(true);
        if (input.signal.aborted && liveSessionId) {
          try {
            await client.request("session.interrupt", { session_id: liveSessionId }, 1_000);
          } catch (interruptError: unknown) {
            console.warn("[chat/hermes] Interrupt acknowledgement unavailable:", interruptError instanceof Error ? interruptError.name : "UnknownError");
          }
        }
        console.warn("[chat/hermes] Provider Run failed:", error instanceof Error ? error.name : "UnknownError");
        const safeFailure = failedActivityKind
          ? { code: "run_failed" as const, safeMessage: hermesFailedActivityMessage(failedActivityKind) }
          : error instanceof HermesRunFailure
            ? {
                code: "run_failed" as const,
                safeMessage: error.reason === "interrupted"
                  ? "The Hermes Run was interrupted before completion."
                  : error.reason === "timeout" ? "The Hermes Run timed out." : "Hermes could not complete this Run.",
              }
            : {
                code: "provider_unavailable" as const,
                safeMessage: "The Hermes connection failed. Try again.",
              };
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "run.completed",
          outcome: input.signal.aborted ? "aborted" : "failed",
          ...(input.signal.aborted ? {} : {
            error: {
              ...safeFailure,
              retryable: true,
              recoveryActions: ["retry"],
            },
          }),
        }));
      } finally {
        if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
        if (totalTimer) clearTimeout(totalTimer);
        if (abortRun) input.signal.removeEventListener("abort", abortRun);
        await client.close();
        queue.finish();
      }
    })();

    yield* queue.values();
  }

  return {
    driverKind: "hermes",
    stateSchemaVersion: 1,
    parseState: (value) => HermesChatStateSchema.parse(value),
    serializeState: (value) => HermesChatStateSchema.parse(value),
    start: (input) => execute(input),
    resume: (input) => execute(input, HermesChatStateSchema.parse(input.resumeState)),
  };
}
