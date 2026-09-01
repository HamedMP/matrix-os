import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod/v4";
import {
  AgentProviderSummarySchema,
  AgentThreadEventSchema,
  ProviderIdSchema,
  SafeSetupActionSchema,
  type AgentAttachment,
  type AgentThreadEvent,
  type SafeSetupAction,
} from "@matrix-os/contracts";
import { createProjectManager } from "../project-manager.js";
import { createWorktreeManager } from "../worktree-manager.js";
import { safeDisplayPath } from "../chat/safe-activity-projection.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import { spawnIsolatedProviderProcess } from "./provider-process-isolation.js";
import {
  addPortableProviderCredentials,
  buildPiChildEnvironment,
  resolvePiCommand,
} from "./pi-process-environment.js";
import type {
  CodingHarnessCredentialLaunch,
  CodingHarnessCredentialResolver,
} from "./harness-credentials.js";
import { hasNativeHarnessAuth } from "./native-harness-auth.js";
import type {
  CodingAgentProviderAdapter,
  CodingAgentProviderEventPublisher,
} from "./provider-adapter.js";

/**
 * Direct-spawn provider adapter for the pi coding-agent CLI
 * (`@earendil-works/pi-coding-agent`, verified against v0.81.0).
 *
 * Each thread turn runs `pi --mode json --print --no-approve --session-id
 * <uuid> <prompt>` (execFile arg array, never a shell string) and parses
 * the NDJSON event stream on stdout into normalized AgentThreadEvents.
 *
 * Verified pi behavior the adapter relies on:
 * - `--mode json` emits only JSON lines on stdout; warnings go to stderr.
 * - `--session-id <uuid>` creates that exact session when missing and resumes
 *   it (with full history) when present. Sessions are scoped to the process
 *   cwd, so the resume state packs both the session id and the cwd.
 * - `-p/--print` runs non-interactively: tools execute without approval
 *   prompts, so approval.* events are unsupported by design.
 * - Startup failures exit 1 with `Error: ...` on stderr; SIGTERM exits 143.
 *
 * Unsupported (deferred): mid-turn approvals/user-input requests, steering,
 * RPC mode (`--mode rpc` has abort/steer commands but does not fit the
 * request/response turn contract).
 */

const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_500;
const MAX_ACTIVE_PROCESSES = 100;
const MAX_EVENTS_PER_RUN = 480;
const MAX_DELTA_CHARS = 3_500;
const MAX_TEXT_CHARS = 24_000;
const MAX_STDERR_CHARS = 8_192;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ID_CHARS = 64;
const MAX_PI_PROMPT_BYTES = 128 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

const PiResumeStateSchema = z.object({
  s: z.string().regex(SESSION_ID_PATTERN),
  c: z.string().min(1).max(400).startsWith("/"),
}).strict();

export interface PiSpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

export interface PiChildProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type PiSpawnFn = (command: string, args: string[], options: PiSpawnOptions) => PiChildProcess;

export type PiRunCommandFn = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

export interface PiCodingAgentProviderOptions {
  homePath: string;
  providerId?: string;
  command?: string;
  spawnFn?: PiSpawnFn;
  runCommand?: PiRunCommandFn;
  env?: Record<string, string>;
  resolveProjectPath?: (projectSlug: string) => Promise<string | null>;
  resolveWorktreePath?: (projectSlug: string, worktreeId: string) => Promise<string | null>;
  runTimeoutMs?: number;
  killGraceMs?: number;
  maxEvents?: number;
  resolveCredentialLaunch?: CodingHarnessCredentialResolver;
}

const execFileAsync = promisify(execFile);

const defaultRunCommand: PiRunCommandFn = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    env: options.env,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};

const defaultSpawnFn: PiSpawnFn = (command, args, options) =>
  spawnIsolatedProviderProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), DEFAULT_RUN_TIMEOUT_MS));
}

type PiCredentialResolution =
  | { kind: "resolved"; launch: CodingHarnessCredentialLaunch | undefined }
  | { kind: "aborted" }
  | { kind: "timed_out" }
  | { kind: "failed"; error: unknown };

function interruptedCredentialResolution(signal: AbortSignal | undefined): PiCredentialResolution {
  const reason = signal?.reason;
  return typeof reason === "object" && reason !== null && "name" in reason
      && reason.name === "TimeoutError"
    ? { kind: "timed_out" }
    : { kind: "aborted" };
}

async function resolveCredentialsWithinRun(input: {
  resolver: CodingHarnessCredentialResolver | undefined;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<PiCredentialResolution> {
  const resolver = input.resolver;
  if (!resolver) {
    return input.signal?.aborted
      ? interruptedCredentialResolution(input.signal)
      : { kind: "resolved", launch: undefined };
  }
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(interruptedCredentialResolution(input.signal));
    const finish = (result: PiCredentialResolution) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    if (input.signal?.aborted) {
      finish(interruptedCredentialResolution(input.signal));
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: "timed_out" }), input.timeoutMs);
    timer.unref?.();

    let pending: Promise<CodingHarnessCredentialLaunch>;
    try {
      pending = resolver(input.signal);
    } catch (error: unknown) {
      finish({ kind: "failed", error });
      return;
    }
    void pending.then(
      (launch) => finish({ kind: "resolved", launch }),
      (error: unknown) => finish({ kind: "failed", error }),
    );
  });
}

function piPromptWithReferences(
  message: string,
  attachments: AgentAttachment[] | undefined,
  options: { homePath: string; executionRoot: string },
): string {
  const references = (attachments ?? [])
    .filter((attachment) => attachment.kind === "file" || attachment.kind === "structured_ref")
    .map((attachment) => {
      const path = safeDisplayPath(attachment.path, options);
      return `- ${attachment.label}${path ? `: ${path}` : ""}`;
    });
  const prompt = references.length > 0
    ? `${message}\n\nContext references:\n${references.join("\n")}`
    : message;
  if (Buffer.byteLength(prompt, "utf-8") > MAX_PI_PROMPT_BYTES) {
    throw new Error("Pi provider prompt is too large");
  }
  return prompt;
}

// SAFE_REFERENCE in the contracts allows [A-Za-z0-9_.:-]; pi tool-call ids
// contain "|", so normalize defensively and fall back to a synthetic id.
function safeReferenceId(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
  if (!/^[A-Za-z0-9]/.test(cleaned) || cleaned.includes("..")) return fallback;
  return cleaned;
}

// tool.started displayName/kind must satisfy SafeDisplayStringSchema, which
// rejects path/secret-shaped text. Tool names are provider identifiers, so
// restrict to a conservative charset and drop anything risky.
function safeToolName(raw: unknown): string {
  if (typeof raw !== "string") return "tool";
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (cleaned.length === 0) return "tool";
  if (/stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s|sk-/i.test(cleaned)) return "tool";
  return cleaned;
}

// Contracts require non-blank text per event. Chunk long text preserving
// order; fold whitespace-only chunks into the previous one so every emitted
// chunk parses, keeping each chunk <= 4000 chars / 16KB.
function chunkDisplayText(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += MAX_DELTA_CHARS) {
    const chunk = text.slice(index, index + MAX_DELTA_CHARS);
    if (chunk.trim().length === 0) {
      const last = out.at(-1);
      if (last !== undefined && last.length + chunk.length <= 4_000) {
        out[out.length - 1] = last + chunk;
      }
      continue;
    }
    out.push(chunk);
  }
  return out;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

interface PiRunCollectorOptions {
  threadId: string;
  scope: string;
  homePath: string;
  executionRoot: string;
  now: () => Date;
  nextEventId: () => string;
  maxEvents: number;
  streaming: boolean;
}

interface PiCollectedRun {
  events: AgentThreadEvent[];
  sessionId: string | null;
}

// Aggregating reducer: pi streams fine-grained deltas, but the provider
// contract delivers events as one batch at turn end, so deltas are
// accumulated per message and re-chunked within contract bounds. This also
// keeps chatty runs under the 500-event provider cap.
function createPiRunCollector(options: PiRunCollectorOptions) {
  const events: AgentThreadEvent[] = [];
  let sessionId: string | null = null;
  let dropped = 0;
  let assistantMessageCounter = 0;
  let assistantText = "";
  let assistantMessageId: string | null = null;
  let assistantEmittedChars = 0;
  let fallbackToolCounter = 0;
  // Each tracked tool needs at least a started + completed event. Reserving
  // half the run budget keeps both the event stream and the in-memory tool
  // registries bounded even if a provider emits starts without matching ends.
  const maxTrackedTools = Math.max(1, Math.floor(options.maxEvents / 2));
  const toolOutputs = new Map<string, string>();
  const toolTruncated = new Set<string>();

  function emit(event: AgentThreadEvent): void {
    if (events.length >= options.maxEvents) {
      dropped += 1;
      return;
    }
    events.push(AgentThreadEventSchema.parse(event));
  }

  function baseEvent() {
    return {
      eventId: options.nextEventId(),
      threadId: options.threadId,
      occurredAt: options.now().toISOString(),
    };
  }

  function emitPendingAssistantText(): void {
    if (!assistantMessageId || assistantEmittedChars >= assistantText.length) return;
    const pending = assistantText.slice(assistantEmittedChars);
    for (const chunk of chunkDisplayText(pending)) {
      emit({ ...baseEvent(), type: "assistant.text.delta", messageId: assistantMessageId, delta: chunk });
    }
    assistantEmittedChars = assistantText.length;
  }

  function flushAssistantText(): void {
    const text = assistantText;
    const messageId = assistantMessageId;
    if (!messageId) return;
    const bounded = truncateText(text, MAX_TEXT_CHARS);
    assistantText = bounded.text;
    if (options.streaming) {
      emitPendingAssistantText();
    } else {
      for (const chunk of chunkDisplayText(bounded.text)) {
        emit({ ...baseEvent(), type: "assistant.text.delta", messageId, delta: chunk });
      }
    }
    if (bounded.truncated) {
      emit({ ...baseEvent(), type: "assistant.text.delta", messageId, delta: "…" });
    }
    if (bounded.text.trim().length > 0) {
      emit({ ...baseEvent(), type: "assistant.text.completed", messageId });
    }
    assistantText = "";
    assistantMessageId = null;
    assistantEmittedChars = 0;
  }

  function flushTool(
    toolCallId: string,
    resultText: string | undefined,
    outcome: "success" | "failed" | "cancelled",
  ): void {
    if (!toolOutputs.has(toolCallId)) return;
    const accumulated = toolOutputs.get(toolCallId) ?? "";
    toolOutputs.delete(toolCallId);
    const truncatedByCap = toolTruncated.delete(toolCallId);
    const raw = resultText !== undefined && resultText.length > 0 ? resultText : accumulated;
    const bounded = truncateText(raw, MAX_TEXT_CHARS);
    const chunks = chunkDisplayText(bounded.text);
    chunks.forEach((chunk, index) => {
      emit({
        ...baseEvent(),
        type: "tool.output",
        toolCallId,
        text: chunk,
        ...(index === chunks.length - 1 && (bounded.truncated || truncatedByCap) ? { truncated: true } : {}),
      });
    });
    if (chunks.length === 0 && truncatedByCap) {
      emit({ ...baseEvent(), type: "tool.output", toolCallId, text: "…", truncated: true });
    }
    emit({
      ...baseEvent(),
      type: "tool.completed",
      toolCallId,
      outcome,
    });
  }

  function contentText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }

  function feedEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "session": {
        if (typeof event.id === "string" && event.id.length > 0 && event.id.length <= MAX_SESSION_ID_CHARS) {
          sessionId = event.id;
        }
        return;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!update || typeof update !== "object") return;
        const kind = (update as Record<string, unknown>).type;
        if (kind === "text_start") {
          flushAssistantText();
          assistantMessageCounter += 1;
          assistantMessageId = `msg_${options.scope}_${assistantMessageCounter}`;
          assistantText = "";
          assistantEmittedChars = 0;
          return;
        }
        if (kind === "text_delta") {
          if (!assistantMessageId) {
            assistantMessageCounter += 1;
            assistantMessageId = `msg_${options.scope}_${assistantMessageCounter}`;
          }
          const delta = (update as Record<string, unknown>).delta;
          if (typeof delta === "string" && assistantText.length < MAX_TEXT_CHARS) {
            assistantText += delta.slice(0, MAX_TEXT_CHARS - assistantText.length);
            if (options.streaming) emitPendingAssistantText();
          }
          return;
        }
        if (kind === "text_end") {
          const content = (update as Record<string, unknown>).content;
          if (typeof content === "string" && content.length > 0) {
            assistantText = content;
          }
          flushAssistantText();
          return;
        }
        // toolcall_start/delta/end and thinking_* carry no execution signal
        // the normalized stream needs; tool_execution_* events drive tools.
        return;
      }
      case "message_end": {
        const message = event.message;
        const role = message && typeof message === "object"
          ? (message as Record<string, unknown>).role
          : undefined;
        if (role === "assistant") {
          if (assistantText.trim().length === 0 && message && typeof message === "object") {
            const text = contentText((message as Record<string, unknown>).content);
            if (text.length > 0 && assistantMessageId) {
              assistantText = text;
            }
          }
          flushAssistantText();
        }
        return;
      }
      case "tool_execution_start": {
        flushAssistantText();
        const toolCallId = safeReferenceId(event.toolCallId, `tool_${options.scope}_${++fallbackToolCounter}`);
        const toolName = safeToolName(event.toolName);
        const normalizedToolName = toolName.toLowerCase();
        const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
          ? event.args as Record<string, unknown>
          : {};
        const readPath = normalizedToolName === "read"
          ? safeDisplayPath(args.path, {
              homePath: options.homePath,
              executionRoot: options.executionRoot,
            })
          : undefined;
        if (!toolOutputs.has(toolCallId) && toolOutputs.size >= maxTrackedTools) {
          dropped += 1;
          return;
        }
        toolOutputs.set(toolCallId, "");
        emit({
          ...baseEvent(),
          type: "tool.started",
          toolCallId,
          displayName: normalizedToolName === "read" ? "Read file" : toolName,
          kind: normalizedToolName === "read" ? "dynamic_tool" : toolName,
          ...(readPath ? { preview: readPath, previewKind: "path" as const } : {}),
        });
        return;
      }
      case "tool_execution_update": {
        const toolCallId = safeReferenceId(event.toolCallId, `tool_${options.scope}_${fallbackToolCounter}`);
        if (!toolOutputs.has(toolCallId)) return;
        const partial = event.partialResult;
        const text = partial && typeof partial === "object"
          ? contentText((partial as Record<string, unknown>).content)
          : "";
        if (text.length > 0) {
          if (text.length <= MAX_TEXT_CHARS) {
            toolOutputs.set(toolCallId, text);
          } else {
            toolOutputs.set(toolCallId, text.slice(0, MAX_TEXT_CHARS));
            toolTruncated.add(toolCallId);
          }
        }
        return;
      }
      case "tool_execution_end": {
        const toolCallId = safeReferenceId(event.toolCallId, `tool_${options.scope}_${fallbackToolCounter}`);
        const result = event.result;
        const resultText = result && typeof result === "object"
          ? contentText((result as Record<string, unknown>).content)
          : "";
        flushTool(toolCallId, resultText, event.isError === true ? "failed" : "success");
        return;
      }
      default:
        // agent_start/end, turn_start/end, agent_settled, queue_update,
        // compaction_*, auto_retry_*: lifecycle is store-owned; ignore.
        return;
    }
  }

  return {
    feedLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err: unknown) {
        if (err instanceof SyntaxError) {
          logCodingAgentWarning("pi provider skipped a non-JSON stdout line", err);
          return;
        }
        throw err;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      feedEvent(parsed as Record<string, unknown>);
    },
    drain(): AgentThreadEvent[] {
      return events.splice(0, events.length);
    },
    finish(): PiCollectedRun {
      flushAssistantText();
      // Any tool still open at stream end (e.g. SIGTERM mid-execution) is
      // completed as cancelled so chips never render as running forever.
      for (const toolCallId of [...toolOutputs.keys()]) {
        flushTool(toolCallId, undefined, "cancelled");
      }
      if (dropped > 0) {
        logCodingAgentWarning("pi provider dropped events beyond the run cap", new Error(`dropped=${dropped}`));
      }
      return { events, sessionId };
    },
  };
}

// pi has no end-of-options marker (`--` is rejected as an unknown option,
// verified against v0.81.0). A leading "- " or "@" would be parsed as an
// option or an @file inclusion, so such prompts get a single leading space,
// which pi passes through as a positional message (verified).
function promptArg(prompt: string): string {
  if (prompt.startsWith("-") || prompt.startsWith("@")) return ` ${prompt}`;
  return prompt;
}

// Pi's built-in tools are `read`, `bash`, `edit`, and `write`. Only `read` is
// non-mutating, and `bash` can write anywhere regardless of cwd, so read_only
// is the sole sandbox mode this adapter can actually guarantee through the CLI.
const PI_READ_ONLY_TOOLS = ["read"] as const;

// The sandbox mode this adapter is able to enforce. Anything broader is refused
// rather than silently run unconfined; see enforceablePiSandboxMode.
const PI_ENFORCEABLE_SANDBOX_MODE = "read_only";

// Returns true when the requested sandbox mode can be genuinely enforced.
// Requests default to workspace_write, which needs OS-level confinement Pi does
// not provide, so those are rejected instead of being run with full access.
function isEnforceablePiSandboxMode(mode: string | undefined): boolean {
  return (mode ?? "workspace_write") === PI_ENFORCEABLE_SANDBOX_MODE;
}

interface PiRunInput {
  threadId: string;
  scope: string;
  prompt: string;
  cwd: string;
  sessionId: string;
  model?: string;
  signal?: AbortSignal;
  now: () => Date;
  nextEventId: () => string;
  publishEvents?: CodingAgentProviderEventPublisher;
}

function piModelArguments(reference: string | undefined): string[] {
  if (reference === undefined || reference === "provider-default") return [];
  const separator = reference.indexOf(":");
  if (separator < 1 || separator === reference.length - 1) return ["--model", reference];
  return ["--provider", reference.slice(0, separator), "--model", reference.slice(separator + 1)];
}

interface PiRunResult {
  events: AgentThreadEvent[];
  outcome: "completed" | "failed" | "aborted";
  sessionId: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function visibleSetupCommand(command: string): string {
  const foreground = [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
    command,
    'exec "${SHELL:-sh}" -l',
  ].join("; ");
  return `sh -lc ${shellQuote(foreground)}`;
}

export function createPiCodingAgentProvider(options: PiCodingAgentProviderOptions): CodingAgentProviderAdapter {
  const providerId = ProviderIdSchema.parse(options.providerId ?? "pi");
  const command = resolvePiCommand(options.command, options.env);
  const homePath = options.homePath;
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runTimeoutMs = boundedTimeout(options.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS);
  const killGraceMs = Math.max(1, Math.min(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 30_000));
  const maxEvents = Math.max(1, Math.min(options.maxEvents ?? MAX_EVENTS_PER_RUN, MAX_EVENTS_PER_RUN));
  const activeProcesses = new Map<string, { abort: () => void }>();

  const resolveProjectPath = options.resolveProjectPath ?? (async (projectSlug: string) => {
    const projects = createProjectManager({ homePath });
    const result = await projects.getProject(projectSlug);
    return result.ok ? result.project.localPath : null;
  });
  const resolveWorktreePath = options.resolveWorktreePath ?? (async (projectSlug: string, worktreeId: string) => {
    const worktrees = createWorktreeManager({ homePath });
    const listed = await worktrees.listWorktrees(projectSlug);
    if (!listed.ok) return null;
    return listed.worktrees.find((candidate) => candidate.id === worktreeId)?.path ?? null;
  });

  function trackProcess(threadId: string, abort: () => void): { abort: () => void } {
    if (activeProcesses.size >= MAX_ACTIVE_PROCESSES) {
      const oldest = activeProcesses.keys().next().value as string | undefined;
      if (oldest) {
        const stale = activeProcesses.get(oldest);
        activeProcesses.delete(oldest);
        try {
          stale?.abort();
        } catch (err: unknown) {
          logCodingAgentWarning("pi provider stale process eviction failed", err);
        }
      }
    }
    const tracked = { abort };
    activeProcesses.set(threadId, tracked);
    return tracked;
  }

  function untrackProcess(threadId: string, tracked: { abort: () => void }): void {
    if (activeProcesses.get(threadId) === tracked) activeProcesses.delete(threadId);
  }

  function terminate(
    proc: PiChildProcess,
    killTimer: { current?: ReturnType<typeof setTimeout> },
    afterKill: () => void,
  ): void {
    try {
      proc.kill("SIGTERM");
    } catch (err: unknown) {
      logCodingAgentWarning("pi provider SIGTERM failed", err);
    }
    killTimer.current = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (err: unknown) {
        logCodingAgentWarning("pi provider SIGKILL failed", err);
      } finally {
        afterKill();
      }
    }, killGraceMs);
    killTimer.current.unref?.();
  }

  async function runPi(input: PiRunInput): Promise<PiRunResult> {
    const runDeadline = Date.now() + runTimeoutMs;
    const collector = createPiRunCollector({
      threadId: input.threadId,
      scope: input.scope,
      homePath: options.homePath,
      executionRoot: input.cwd,
      now: input.now,
      nextEventId: input.nextEventId,
      maxEvents,
      streaming: input.publishEvents !== undefined,
    });
    const args = [
      "--mode", "json",
      "--print",
      // Keep canonical runs independent from owner extensions, skills, prompt
      // templates, context files, update checks, and telemetry. Native auth and
      // the explicitly selected model still come from the owner-local HOME.
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      // Pi exposes no `--sandbox` flag, so confinement is enforced by scoping
      // the tool allowlist to the non-mutating `read` tool. Threads are refused
      // at start unless they asked for read_only, so every run that reaches
      // here is read-only by construction.
      "--tools", PI_READ_ONLY_TOOLS.join(","),
      // Pi's file-trust switch: ignore project-local extensions, skills, and
      // context files from cloned repositories. This is NOT a tool-approval
      // bypass -- dropping it would make Pi trust untrusted repo config.
      "--no-approve",
      ...piModelArguments(input.model),
      "--session-id", input.sessionId,
      promptArg(input.prompt),
    ];
    const credentialResolution = await resolveCredentialsWithinRun({
      resolver: options.resolveCredentialLaunch,
      signal: input.signal,
      timeoutMs: runTimeoutMs,
    });
    if (credentialResolution.kind === "aborted") {
      return { events: [], outcome: "aborted", sessionId: input.sessionId };
    }
    if (credentialResolution.kind === "timed_out") {
      return { events: [], outcome: "failed", sessionId: input.sessionId };
    }
    if (credentialResolution.kind === "failed") {
      logCodingAgentWarning("pi provider credential resolution failed", credentialResolution.error);
      return { events: [], outcome: "failed", sessionId: input.sessionId };
    }
    const credentialLaunch = credentialResolution.launch;
    const ownerEnvironment = buildPiChildEnvironment({
      ...options.env,
      HOME: homePath,
    });
    ownerEnvironment.HOME = homePath;
    const env = addPortableProviderCredentials(
      ownerEnvironment,
      credentialLaunch?.env,
    );
    const effectiveRunTimeoutMs = credentialLaunch?.maxRunMs
      ? Math.min(runTimeoutMs, credentialLaunch.maxRunMs)
      : runTimeoutMs;
    const remainingRunTimeoutMs = Math.max(1, Math.min(
      effectiveRunTimeoutMs,
      runDeadline - Date.now(),
    ));

    return await new Promise<PiRunResult>((resolve) => {
      let proc: PiChildProcess;
      try {
        proc = spawnFn(command, args, { cwd: input.cwd, env });
      } catch (err: unknown) {
        logCodingAgentWarning("pi provider spawn failed", err);
        resolve({ events: [], outcome: "failed", sessionId: input.sessionId });
        return;
      }
      let settled = false;
      let terminationReason: "user_abort" | "timeout" | "failure" | undefined;
      let stdoutBuffer = "";
      let stdoutBytes = 0;
      let stderrText = "";
      let publishError: unknown;
      let publishQueue = Promise.resolve();
      const killTimer: { current?: ReturnType<typeof setTimeout> } = {};

      function queueEvents(events: AgentThreadEvent[]): void {
        if (!input.publishEvents || events.length === 0) return;
        publishQueue = publishQueue.then(async () => {
          if (publishError) return;
          try {
            await input.publishEvents!({ events });
          } catch (err: unknown) {
            publishError = err;
            logCodingAgentWarning("pi provider event publish failed", err);
          }
        });
      }

      function drainCollector(): void {
        if (input.publishEvents) queueEvents(collector.drain());
      }

      function finishCollector(): PiCollectedRun {
        const collected = collector.finish();
        if (!input.publishEvents) return collected;
        queueEvents(collected.events);
        return { ...collected, events: [] };
      }

      const timeoutTimer = setTimeout(() => {
        requestTermination("timeout");
      }, remainingRunTimeoutMs);
      timeoutTimer.unref?.();

      const onAbort = () => {
        requestTermination("user_abort");
      };
      const trackedProcess = trackProcess(input.threadId, onAbort);
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }

      function settle(result: PiRunResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer.current) clearTimeout(killTimer.current);
        input.signal?.removeEventListener("abort", onAbort);
        untrackProcess(input.threadId, trackedProcess);
        void publishQueue.then(() => {
          resolve(publishError ? { ...result, events: [], outcome: "failed" } : result);
        });
      }

      function settleAfterForcedTermination(): void {
        if (settled) return;
        const collected = finishCollector();
        const sessionId = collected.sessionId ?? input.sessionId;
        if (terminationReason === "timeout") {
          logCodingAgentWarning("pi provider run cut off", new Error(`run bounded at ${remainingRunTimeoutMs}ms`));
        }
        settle({
          events: collected.events,
          outcome: terminationReason === "user_abort" ? "aborted" : "failed",
          sessionId,
        });
      }

      function requestTermination(reason: NonNullable<typeof terminationReason>): void {
        if (terminationReason || settled) return;
        terminationReason = reason;
        clearTimeout(timeoutTimer);
        terminate(proc, killTimer, settleAfterForcedTermination);
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          logCodingAgentWarning("pi provider stdout cap exceeded", new Error("stdout byte cap exceeded"));
          requestTermination("failure");
          stdoutBuffer = "";
          return;
        }
        stdoutBuffer += chunk.toString("utf-8");
        if (stdoutBuffer.length > 8 * 1024 * 1024) {
          logCodingAgentWarning("pi provider stdout cap exceeded", new Error("stdout buffer overflow"));
          requestTermination("failure");
          stdoutBuffer = "";
          return;
        }
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          collector.feedLine(line);
          drainCollector();
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (stderrText.length < MAX_STDERR_CHARS) {
          stderrText += chunk.toString("utf-8").slice(0, MAX_STDERR_CHARS - stderrText.length);
        }
      });
      proc.once("error", (err: Error) => {
        logCodingAgentWarning("pi provider process error", err);
        settle({ events: [], outcome: "failed", sessionId: input.sessionId });
      });
      proc.once("exit", (code: number | null) => {
        if (settled) return;
        const tail = stdoutBuffer.trim();
        if (tail.length > 0) {
          collector.feedLine(tail);
          drainCollector();
        }
        const collected = finishCollector();
        const sessionId = collected.sessionId ?? input.sessionId;
        if (terminationReason === "user_abort") {
          settle({ events: collected.events, outcome: "aborted", sessionId });
          return;
        }
        if (terminationReason === "timeout") {
          logCodingAgentWarning("pi provider run cut off", new Error(`run bounded at ${effectiveRunTimeoutMs}ms`));
          settle({ events: collected.events, outcome: "failed", sessionId });
          return;
        }
        if (terminationReason === "failure") {
          settle({ events: collected.events, outcome: "failed", sessionId });
          return;
        }
        if (code !== 0) {
          logCodingAgentWarning("pi provider run failed", new Error(`exit=${code} stderr=${stderrText.slice(0, 512)}`));
          settle({ events: collected.events, outcome: "failed", sessionId });
          return;
        }
        settle({ events: collected.events, outcome: "completed", sessionId });
      });
    });
  }

  function statusEvent(input: {
    threadId: string;
    status: "running" | "completed" | "aborted";
    now: () => Date;
    nextEventId: () => string;
  }): AgentThreadEvent {
    return AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: input.nextEventId(),
      threadId: input.threadId,
      occurredAt: input.now().toISOString(),
      status: input.status,
    });
  }

  function completedEvent(input: {
    threadId: string;
    outcome: "completed" | "failed" | "aborted";
    now: () => Date;
    nextEventId: () => string;
  }): AgentThreadEvent {
    return AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: input.nextEventId(),
      threadId: input.threadId,
      occurredAt: input.now().toISOString(),
      outcome: input.outcome,
    });
  }

  function safeRunFailureEvent(threadId: string, now: () => Date, nextEventId: () => string): AgentThreadEvent {
    return AgentThreadEventSchema.parse({
      type: "thread.error",
      eventId: nextEventId(),
      threadId,
      occurredAt: now().toISOString(),
      error: {
        code: "provider_run_failed",
        safeMessage: "Agent run could not continue. Try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  }

  // Refusing a sandbox mode is not a transient run failure, so it gets its own
  // non-retryable event instead of the generic "try again" message.
  function sandboxRefusedEvents(
    threadId: string,
    now: () => Date,
    nextEventId: () => string,
  ): AgentThreadEvent[] {
    return [
      AgentThreadEventSchema.parse({
        type: "thread.error",
        eventId: nextEventId(),
        threadId,
        occurredAt: now().toISOString(),
        error: {
          code: "sandbox_unavailable",
          safeMessage:
            "This agent can only run in read-only mode on this computer. Start the chat in read-only mode.",
          retryable: false,
          recoveryActions: [],
        },
      }),
      completedEvent({ threadId, outcome: "failed", now, nextEventId }),
    ];
  }

  function terminalEvents(
    threadId: string,
    outcome: "completed" | "failed" | "aborted",
    now: () => Date,
    nextEventId: () => string,
  ): AgentThreadEvent[] {
    if (outcome === "completed") {
      return [
        statusEvent({ threadId, status: "completed", now, nextEventId }),
        completedEvent({ threadId, outcome: "completed", now, nextEventId }),
      ];
    }
    if (outcome === "aborted") {
      return [
        statusEvent({ threadId, status: "aborted", now, nextEventId }),
        completedEvent({ threadId, outcome: "aborted", now, nextEventId }),
      ];
    }
    return [
      safeRunFailureEvent(threadId, now, nextEventId),
      completedEvent({ threadId, outcome: "failed", now, nextEventId }),
    ];
  }

  function packResumeState(sessionId: string, cwd: string): string | null {
    const parsed = PiResumeStateSchema.safeParse({ s: sessionId, c: cwd });
    if (!parsed.success) {
      logCodingAgentWarning("pi provider resume state invalid", new Error("run returned invalid resume state"));
      return null;
    }
    return JSON.stringify(parsed.data);
  }

  function parseResumeState(raw: string): { sessionId: string; cwd: string | null } | null {
    try {
      const parsed = PiResumeStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { sessionId: parsed.data.s, cwd: parsed.data.c };
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        logCodingAgentWarning("pi provider resume state parse failed", err);
      }
    }
    if (SESSION_ID_PATTERN.test(raw)) return { sessionId: raw, cwd: null };
    return null;
  }

  async function probeInstalled(): Promise<boolean> {
    try {
      await runCommand(command, ["--version"], {
        cwd: homePath,
        timeout: PROBE_TIMEOUT_MS,
        env: buildPiChildEnvironment({ ...options.env, HOME: homePath }),
      });
      return true;
    } catch (err: unknown) {
      logCodingAgentWarning("pi provider binary probe failed", err);
      return false;
    }
  }

  return {
    providerId,
    initialRunExecution: "background",

    async getSummary({ now }) {
      const installed = await probeInstalled();
      const authenticated = installed && await hasNativeHarnessAuth(homePath, "pi");
      return AgentProviderSummarySchema.parse({
        id: providerId,
        displayName: "Pi",
        kind: "pi",
        availability: authenticated ? "available" : installed ? "auth_required" : "unavailable",
        installStatus: installed ? "installed" : "missing",
        // Pi has no non-interactive auth command. Readiness checks only bounded
        // metadata at its fixed owner-local auth path; credential bytes stay CLI-owned.
        authStatus: authenticated ? "authenticated" : "unknown",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: now().toISOString(),
      });
    },

    async healthCheck() {
      return { ok: await probeInstalled() };
    },

    buildSetupAction(): SafeSetupAction[] {
      return SafeSetupActionSchema.array().max(2).parse([
        {
          id: "pi_install",
          kind: "foreground_terminal",
          label: "Install Pi",
          command: visibleSetupCommand(
            'npm install -g --prefix "$MATRIX_NODE_PREFIX" @earendil-works/pi-coding-agent@latest',
          ),
        },
        {
          id: "pi_connect",
          kind: "foreground_terminal",
          label: "Connect Pi",
          command: visibleSetupCommand("pi"),
        },
      ]);
    },

    async startThread({ thread, request, signal, now, nextEventId, publishEvents }) {
      // Fail closed before resolving a workspace or spawning: Pi cannot enforce
      // workspace_write or full_access, so honouring them would mean running
      // with the gateway account's unrestricted filesystem access while the UI
      // advertises a scoped sandbox.
      if (!isEnforceablePiSandboxMode(request.sandboxMode)) {
        logCodingAgentWarning(
          "pi provider refused unsupported sandbox mode",
          new Error(`unsupported sandbox mode: ${request.sandboxMode ?? "workspace_write"}`),
        );
        return { events: sandboxRefusedEvents(thread.id, now, nextEventId) };
      }

      let cwd: string | null = null;
      try {
        if (request.worktreeId && request.projectId) {
          cwd = await resolveWorktreePath(request.projectId, request.worktreeId);
        } else if (request.projectId) {
          cwd = await resolveProjectPath(request.projectId);
        } else {
          cwd = homePath;
        }
      } catch (err: unknown) {
        logCodingAgentWarning("pi provider workspace resolution failed", err);
        cwd = null;
      }
      if (!cwd) {
        return {
          events: terminalEvents(thread.id, "failed", now, nextEventId),
        };
      }

      const runningEvent = statusEvent({ threadId: thread.id, status: "running", now, nextEventId });
      if (publishEvents) await publishEvents({ events: [runningEvent] });
      const sessionId = randomUUID();
      let prompt: string;
      try {
        prompt = piPromptWithReferences(request.prompt, request.attachments, {
          homePath,
          executionRoot: cwd,
        });
      } catch (err: unknown) {
        logCodingAgentWarning("pi provider prompt construction failed", err);
        return { events: terminalEvents(thread.id, "failed", now, nextEventId) };
      }
      const run = await runPi({
        threadId: thread.id,
        scope: thread.id,
        prompt,
        cwd,
        sessionId,
        model: request.model,
        signal,
        now,
        nextEventId,
        publishEvents,
      });
      const conversationId = packResumeState(run.sessionId, cwd);
      return {
        events: [
          ...(publishEvents ? [] : [runningEvent]),
          ...run.events,
          ...terminalEvents(thread.id, run.outcome, now, nextEventId),
        ],
        ...(conversationId ? { resumeState: { conversationId } } : {}),
      };
    },

    async resumeTurn({ thread, turn, resumeState, signal, now, nextEventId, publishEvents }) {
      const parsed = parseResumeState(resumeState.conversationId);
      if (!parsed) {
        logCodingAgentWarning("pi provider resume state invalid", new Error("resume state mismatch"));
        return { events: [], outcome: "failed" as const, resumeState };
      }
      let cwd = parsed.cwd;
      if (!cwd) {
        try {
          cwd = thread.projectId ? await resolveProjectPath(thread.projectId) : homePath;
        } catch (err: unknown) {
          logCodingAgentWarning("pi provider workspace resolution failed", err);
          cwd = null;
        }
      }
      if (!cwd) {
        return { events: [], outcome: "failed" as const, resumeState };
      }
      let prompt: string;
      try {
        prompt = piPromptWithReferences(turn.message, turn.attachments, {
          homePath,
          executionRoot: cwd,
        });
      } catch (err: unknown) {
        logCodingAgentWarning("pi provider prompt construction failed", err);
        return { events: [], outcome: "failed" as const, resumeState };
      }
      const run = await runPi({
        threadId: thread.id,
        scope: turn.turnId,
        prompt,
        cwd,
        sessionId: parsed.sessionId,
        model: turn.model,
        signal,
        now,
        nextEventId,
        publishEvents,
      });
      const conversationId = packResumeState(run.sessionId, cwd);
      return {
        events: run.events,
        outcome: run.outcome,
        resumeState: conversationId ? { conversationId } : resumeState,
      };
    },

    async abortThread({ thread, now, nextEventId }) {
      const active = activeProcesses.get(thread.id);
      if (active) {
        try {
          active.abort();
        } catch (err: unknown) {
          logCodingAgentWarning("pi provider abort kill failed", err);
        }
      }
      return [
        statusEvent({ threadId: thread.id, status: "aborted", now, nextEventId }),
        completedEvent({ threadId: thread.id, outcome: "aborted", now, nextEventId }),
      ];
    },

    submitApproval() {
      // pi -p runs tools without interactive approvals; nothing to submit.
      return [];
    },

    submitInput() {
      return [];
    },
  };
}
