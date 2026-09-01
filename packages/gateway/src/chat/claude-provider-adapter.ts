import { z } from "zod/v4";
import { buildAgentLaunch } from "../agent-launcher.js";
import {
  buildKernelCredentialLaunch,
  type KernelCredentialLaunch,
} from "../kernel-credentials.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import {
  CanonicalCliError,
  createCanonicalCliEventQueue,
  runCanonicalCli,
  type CanonicalCliSpawn,
} from "./cli-process.js";
import {
  safeToolPreview,
  sanitizeAssistantText,
} from "./safe-activity-projection.js";

const ClaudeChatStateSchema = z.object({
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
  model: z.string().min(1).max(160).optional(),
}).strict();

const ClaudeStreamLineSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  model: z.string().min(1).max(160).optional(),
  event: z.object({
    type: z.string(),
    index: z.number().int().min(0).max(10_000).optional(),
    delta: z.object({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
    }).passthrough().optional(),
    content_block: z.object({
      type: z.string(),
      id: z.string().min(1).max(128).optional(),
      name: z.string().min(1).max(160).optional(),
      input: z.unknown().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type ClaudeChatState = z.infer<typeof ClaudeChatStateSchema>;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
// Claude's stream-json protocol repeats bounded tool-result envelopes throughout
// a Run, so healthy repository tasks routinely exceed one MiB in total. This is
// still a hard process-output ceiling; per-event projection and the queue remain
// independently bounded below.
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8_192;

function definedEnvironment(
  value: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (entry !== undefined) environment[name] = entry;
  }
  return environment;
}

function permissionMode(value: string, interactionMode: string) {
  if (interactionMode === "review") return "plan" as const;
  if (value === "supervised") return "default" as const;
  if (value === "auto_accept_edits") return "acceptEdits" as const;
  if (value === "auto") return "auto" as const;
  if (value === "full_access") return "bypassPermissions" as const;
  throw new Error("Unsupported Claude permission mode");
}

function outputChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 4_000) {
    const chunk = text.slice(index, index + 4_000);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function claudeActivity(name: string) {
  const normalized = name.trim().toLowerCase();
  if (["bash", "shell", "terminal", "execute", "run_command"].includes(normalized)) {
    return { kind: "command" as const, label: "Run command" };
  }
  if (["write", "edit", "apply_patch", "notebookedit"].includes(normalized)) {
    return { kind: "file_change" as const, label: "Update file" };
  }
  if (["websearch", "webfetch", "web_search"].includes(normalized)) {
    return { kind: "web_search" as const, label: "Search the web" };
  }
  if (["task", "agent", "delegate"].includes(normalized)) {
    return { kind: "delegation" as const, label: "Delegated task" };
  }
  return { kind: "dynamic_tool" as const, label: name };
}

function classifiedClaudeFailureEvidence(text: string) {
  if (/\b(?:unsupported|invalid) model\b|\bmodel\b.{0,120}\b(?:does not exist|not found|not available|unavailable|unsupported)\b/i.test(text)) {
    return {
      category: "unsupported_model" as const,
      safeError: {
        code: "model_unavailable" as const,
        safeMessage: "The selected Claude model is unavailable. Choose another model and try again.",
        retryable: false,
        recoveryActions: ["select_provider" as const],
      },
    };
  }
  if (/\b(?:authentication (?:failed|required)|unauthorized|not logged in|login required|invalid (?:api[ -]?key|x-api-key)|api[ -]?key.{0,80}(?:missing|required|invalid)|oauth.{0,80}(?:expired|required)|credentials?.{0,80}(?:missing|invalid|expired|required))\b|\bplease (?:run )?\/?login\b/i.test(text)) {
    return {
      category: "authentication" as const,
      safeError: {
        code: "authorization_failed" as const,
        safeMessage: "Claude needs to be connected before it can run. Open setup and connect Claude.",
        retryable: false,
        recoveryActions: ["open_setup_terminal" as const],
      },
    };
  }
  if (/\b(?:permission denied|not permitted|operation not permitted|access denied|requires? permission)\b/i.test(text)) {
    return {
      category: "permission" as const,
      safeError: {
        code: "authorization_failed" as const,
        safeMessage: "Claude was blocked by its current permissions. Review the permission mode and try again.",
        retryable: true,
        recoveryActions: ["retry" as const],
      },
    };
  }
  return undefined;
}

function classifiedClaudeCliFailure(error: unknown) {
  if (!(error instanceof CanonicalCliError)) return undefined;
  if (error.kind === "startup") {
    return {
      category: "startup" as const,
      safeError: {
        code: "provider_unavailable" as const,
        safeMessage: "Claude is not available on this runtime. Open setup and install or reconnect Claude.",
        retryable: false,
        recoveryActions: ["open_setup_terminal" as const],
      },
    };
  }
  if (error.kind === "timeout") {
    return {
      category: "timeout" as const,
      safeError: {
        code: "service_unavailable" as const,
        safeMessage: "Claude took too long to respond. Try the Run again.",
        retryable: true,
        recoveryActions: ["retry" as const],
      },
    };
  }
  if (error.kind === "invalid_output" || error.kind === "stdout_limit") {
    return {
      category: "invalid_protocol" as const,
      safeError: {
        code: "run_failed" as const,
        safeMessage: "Claude returned an invalid response. Try the Run again.",
        retryable: true,
        recoveryActions: ["retry" as const],
      },
    };
  }
  return undefined;
}

export function createClaudeChatProviderAdapter(options: {
  homePath: string;
  spawnFn?: CanonicalCliSpawn;
  timeoutMs?: number;
  resolveCredentialEnv?: () => Promise<Record<string, string | undefined> | undefined>;
  resolveCredentialLaunch?: () => Promise<KernelCredentialLaunch>;
}): CanonicalChatProviderAdapter<ClaudeChatState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function* execute(
    inputValue: CanonicalProviderRunInput<ClaudeChatState>,
    resumeState?: ClaudeChatState,
  ): AsyncGenerator<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    const cwd = input.executionRoot ?? options.homePath;
    const selectedPermission = permissionMode(input.permissionMode, input.interactionMode);
    const fullAccess = selectedPermission === "bypassPermissions";
    const launch = buildAgentLaunch({
      agent: "claude",
      cwd,
      runtimeHome: options.homePath,
      prompt: input.prompt,
      model: input.selection.model,
      modelOptions: input.selection.options ?? [],
      mode: input.interactionMode === "review" ? "review" : "default",
      approvalPolicy: fullAccess ? "never" : "on-request",
      sandbox: fullAccess
        ? { enabled: false, mode: "danger-full-access" }
        : { enabled: true, mode: "workspace-write", writableRoots: [cwd] },
      claudePermissionMode: selectedPermission,
      claudeOutputFormat: "stream-json",
      claudeIncludePartialMessages: true,
    });
    if (resumeState) {
      const separator = launch.args.indexOf("--");
      launch.args.splice(separator < 0 ? launch.args.length : separator, 0, "--resume", resumeState.sessionId);
    }
    const credentialLaunch = options.resolveCredentialLaunch
      ? await options.resolveCredentialLaunch()
      : {
          env: await (
            options.resolveCredentialEnv
            ?? (() => buildKernelCredentialLaunch(options.homePath).then((value) => value.env))
          )(),
        };
    const credentialEnv = credentialLaunch.env;
    const runEnv = credentialEnv === undefined
      ? launch.env
      : definedEnvironment({ ...credentialEnv, ...launch.env });

    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    let buffered = "";
    let stderrEvidence = "";
    let stderrEvidenceBytes = 0;
    let streamedText = false;
    let resultText = "";
    let sawResult = false;
    let resultFailed = false;
    let resultSubtype: "success" | "error" | "other" | undefined;
    let emittedState = resumeState;
    let pendingDelta = "";
    let pendingDeltaMessageId: string | undefined;
    let deltaFlushScheduled = false;
    let nextTextBlockId = 0;
    let nextReasoningBlockId = 0;
    const textMessageByIndex = new Map<number, string>();
    const toolInputByIndex = new Map<number, string>();
    const toolNameByIndex = new Map<number, string>();
    const activityByIndex = new Map<number, {
      activityId: string;
      kind: ReturnType<typeof claudeActivity>["kind"] | "reasoning";
      label: string;
      preview?: string;
      previewKind?: "command" | "path" | "text";
      detail?: string;
    }>();

    const flushPendingDelta = () => {
      deltaFlushScheduled = false;
      if (!pendingDelta) return;
      const text = pendingDelta;
      const messageId = pendingDeltaMessageId;
      pendingDelta = "";
      pendingDeltaMessageId = undefined;
      for (const delta of outputChunks(text)) {
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "assistant.delta",
          ...(messageId ? { messageId } : {}),
          delta,
        }));
      }
    };

    const enqueueDelta = (delta: string, messageId?: string) => {
      if (pendingDelta && pendingDeltaMessageId !== messageId) flushPendingDelta();
      pendingDeltaMessageId = messageId;
      pendingDelta += delta;
      if (pendingDelta.length >= 4_000) {
        flushPendingDelta();
      } else if (!deltaFlushScheduled) {
        deltaFlushScheduled = true;
        queueMicrotask(flushPendingDelta);
      }
    };

    const parseLine = (raw: string) => {
      if (!raw.trim()) return;
      const line = ClaudeStreamLineSchema.parse(JSON.parse(raw));
      if (line.session_id && (
        line.session_id !== emittedState?.sessionId
        || (line.model !== undefined && line.model !== emittedState.model)
      )) {
        flushPendingDelta();
        const state = ClaudeChatStateSchema.parse({
          sessionId: line.session_id,
          ...(line.model ? { model: line.model } : {}),
        });
        emittedState = state;
        queue.push(CanonicalProviderRunEventSchema.parse({ type: "state.updated", state }));
      }
      const delta = line.type === "stream_event"
        && line.event?.type === "content_block_delta"
        && line.event.delta?.type === "text_delta"
        ? line.event.delta.text
        : undefined;
      if (delta) {
        streamedText = true;
        enqueueDelta(sanitizeAssistantText(delta, {
          homePath: options.homePath,
          executionRoot: input.executionRoot,
        }), line.event?.index === undefined ? undefined : textMessageByIndex.get(line.event.index));
      }
      if (line.type === "stream_event" && line.event?.type === "content_block_delta"
        && line.event.index !== undefined && line.event.delta?.type === "input_json_delta"
        && line.event.delta.partial_json) {
        const current = toolInputByIndex.get(line.event.index) ?? "";
        if (current.length + line.event.delta.partial_json.length <= 16_000) {
          toolInputByIndex.set(line.event.index, `${current}${line.event.delta.partial_json}`);
        }
      }
      if (line.type === "stream_event" && line.event?.type === "content_block_start"
        && line.event.index !== undefined && line.event.content_block) {
        flushPendingDelta();
        const block = line.event.content_block;
        if (block.type === "text") {
          textMessageByIndex.set(line.event.index, `claude_text_${nextTextBlockId}`);
          nextTextBlockId += 1;
        } else if (block.type === "thinking") {
          const activity = {
            activityId: `reasoning_${nextReasoningBlockId}`,
            kind: "reasoning" as const,
            label: "Thinking",
          };
          nextReasoningBlockId += 1;
          activityByIndex.set(line.event.index, activity);
          queue.push(CanonicalProviderRunEventSchema.parse({
            type: "agent.activity",
            ...activity,
            status: "running",
          }));
        } else if (block.type === "tool_use" && block.id && block.name) {
          const activity = {
            activityId: block.id,
            ...claudeActivity(block.name),
            ...safeToolPreview(block.name, block.input, {
              homePath: options.homePath,
              executionRoot: input.executionRoot,
            }),
          };
          activityByIndex.set(line.event.index, activity);
          toolInputByIndex.set(line.event.index, "");
          toolNameByIndex.set(line.event.index, block.name);
          queue.push(CanonicalProviderRunEventSchema.parse({
            type: "agent.activity",
            ...activity,
            status: "running",
          }));
        }
      }
      if (line.type === "stream_event" && line.event?.type === "content_block_stop"
        && line.event.index !== undefined) {
        flushPendingDelta();
        const activity = activityByIndex.get(line.event.index);
        if (activity) {
          activityByIndex.delete(line.event.index);
          const partialInput = toolInputByIndex.get(line.event.index);
          toolInputByIndex.delete(line.event.index);
          const toolName = toolNameByIndex.get(line.event.index);
          toolNameByIndex.delete(line.event.index);
          let completedActivity = activity;
          if (partialInput && toolName) {
            try {
              const parsedInput: unknown = JSON.parse(partialInput);
              completedActivity = {
                ...activity,
                ...safeToolPreview(toolName, parsedInput, {
                  homePath: options.homePath,
                  executionRoot: input.executionRoot,
                }),
              };
            } catch (error: unknown) {
              console.warn("[chat-claude] Ignoring malformed bounded tool input:", error instanceof Error ? error.name : "UnknownError");
            }
          }
          queue.push(CanonicalProviderRunEventSchema.parse({
            type: "agent.activity",
            ...completedActivity,
            status: "completed",
          }));
        }
        textMessageByIndex.delete(line.event.index);
      }
      if (line.type === "result") {
        sawResult = true;
        resultSubtype = line.subtype === "success" || line.subtype === "error"
          ? line.subtype
          : line.subtype === undefined
            ? undefined
            : "other";
        resultText = sanitizeAssistantText(line.result ?? "", {
          homePath: options.homePath,
          executionRoot: input.executionRoot,
        });
        resultFailed = line.is_error === true || line.subtype === "error";
      }
    };

    const emitBufferedResult = () => {
      if (!resultFailed && !streamedText && resultText) {
        for (const delta of outputChunks(resultText)) {
          queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
        }
      }
    };

    void runCanonicalCli({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: runEnv,
      replaceEnv: credentialEnv !== undefined,
      signal: input.signal,
      timeoutMs: Math.min(timeoutMs, credentialLaunch.fundedRunTimeoutMs ?? timeoutMs),
      maxStdoutBytes: MAX_STREAM_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
      spawnFn: options.spawnFn,
      onStdout(chunk) {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) parseLine(line);
      },
      onStderr(chunk) {
        stderrEvidence += chunk.toString("utf8");
        stderrEvidenceBytes += chunk.byteLength;
      },
    }).then(() => {
      if (buffered.trim()) parseLine(buffered);
      flushPendingDelta();
      emitBufferedResult();
      const classifiedFailure = resultFailed
        ? classifiedClaudeFailureEvidence(`${resultText}\n${stderrEvidence}`)
        : undefined;
      if (!sawResult || resultFailed) {
        console.warn("[chat-claude] Claude CLI result did not complete the Run", {
          category: classifiedFailure?.category ?? (resultFailed ? "result_error" : "missing_result"),
          resultSubtype,
          resultHasText: resultText.length > 0,
          stderrEvidenceBytes,
        });
      }
      queue.push(CanonicalProviderRunEventSchema.parse(!sawResult || resultFailed
        ? {
            type: "run.completed",
            outcome: "failed",
            error: classifiedFailure?.safeError ?? (resultFailed
              ? {
                  code: "run_failed",
                  safeMessage: "Claude reported a failure before completing this Run. Try again, or open Claude setup if it continues.",
                  retryable: true,
                  recoveryActions: ["retry", "open_setup_terminal"],
                }
              : {
                  code: "run_failed",
                  safeMessage: "Claude returned an invalid response. Try the Run again.",
                  retryable: true,
                  recoveryActions: ["retry"],
                }),
          }
        : { type: "run.completed", outcome: "completed" }));
      queue.finish();
    }).catch((error: unknown) => {
      flushPendingDelta();
      if (sawResult && !resultFailed) {
        console.warn("[chat-claude] Claude CLI exited non-zero after a successful result", {
          cliFailureKind: error instanceof CanonicalCliError ? error.kind : "unknown",
          exitCode: error instanceof CanonicalCliError ? error.exitCode : undefined,
          signal: error instanceof CanonicalCliError ? error.signal : undefined,
        });
        emitBufferedResult();
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "run.completed",
          outcome: "completed",
        }));
        queue.finish();
        return;
      }
      const classifiedFailure = classifiedClaudeFailureEvidence(`${resultText}\n${stderrEvidence}`)
        ?? classifiedClaudeCliFailure(error);
      if (!input.signal.aborted) {
        console.warn("[chat-claude] Claude CLI Run failed", {
          category: classifiedFailure?.category ?? "provider_exit",
          cliFailureKind: error instanceof CanonicalCliError ? error.kind : "unknown",
          exitCode: error instanceof CanonicalCliError ? error.exitCode : undefined,
          signal: error instanceof CanonicalCliError ? error.signal : undefined,
          stderrEvidenceBytes,
        });
      }
      queue.push(CanonicalProviderRunEventSchema.parse({
        type: "run.completed",
        outcome: input.signal.aborted ? "aborted" : "failed",
        ...(input.signal.aborted ? {} : {
          error: classifiedFailure?.safeError ?? {
            code: "run_failed",
            safeMessage: "Claude could not complete this Run. Check its connection and retry.",
            retryable: true,
            recoveryActions: ["retry"],
          },
        }),
      }));
      queue.finish();
    });

    yield* queue.values();
  }

  return {
    driverKind: "claude_code",
    stateSchemaVersion: 1,
    parseState: (value) => ClaudeChatStateSchema.parse(value),
    serializeState: (value) => ClaudeChatStateSchema.parse(value),
    start: (input) => execute(input),
    resume: (input) => execute(input, ClaudeChatStateSchema.parse(input.resumeState)),
  };
}
