import { z } from "zod/v4";
import { buildAgentLaunch } from "../agent-launcher.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import {
  createCanonicalCliEventQueue,
  runCanonicalCli,
  type CanonicalCliSpawn,
} from "./cli-process.js";

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
    delta: z.object({ type: z.string(), text: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type ClaudeChatState = z.infer<typeof ClaudeChatStateSchema>;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_STREAM_BYTES = 1024 * 1024;

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

export function createClaudeChatProviderAdapter(options: {
  homePath: string;
  spawnFn?: CanonicalCliSpawn;
  timeoutMs?: number;
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

    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    let buffered = "";
    let streamedText = false;
    let resultText = "";
    let sawResult = false;
    let resultFailed = false;
    let emittedState = resumeState;

    const parseLine = (raw: string) => {
      if (!raw.trim()) return;
      const line = ClaudeStreamLineSchema.parse(JSON.parse(raw));
      if (line.session_id && (
        line.session_id !== emittedState?.sessionId
        || (line.model !== undefined && line.model !== emittedState.model)
      )) {
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
        queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
      }
      if (line.type === "result") {
        sawResult = true;
        resultText = line.result ?? "";
        resultFailed = line.is_error === true || line.subtype === "error";
      }
    };

    void runCanonicalCli({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      signal: input.signal,
      timeoutMs,
      maxStdoutBytes: MAX_STREAM_BYTES,
      spawnFn: options.spawnFn,
      onStdout(chunk) {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) parseLine(line);
      },
    }).then(() => {
      if (buffered.trim()) parseLine(buffered);
      if (!streamedText && resultText) {
        for (const delta of outputChunks(resultText)) {
          queue.push(CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta }));
        }
      }
      queue.push(CanonicalProviderRunEventSchema.parse(!sawResult || resultFailed
        ? {
            type: "run.completed",
            outcome: "failed",
            error: {
              code: "run_failed",
              safeMessage: "The Claude Run failed. Check Claude setup and try again.",
              retryable: true,
              recoveryActions: ["retry"],
            },
          }
        : { type: "run.completed", outcome: "completed" }));
      queue.finish();
    }).catch(() => {
      queue.push(CanonicalProviderRunEventSchema.parse({
        type: "run.completed",
        outcome: input.signal.aborted ? "aborted" : "failed",
        ...(input.signal.aborted ? {} : {
          error: {
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
