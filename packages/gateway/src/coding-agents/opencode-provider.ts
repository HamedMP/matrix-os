import { execFile, spawn } from "node:child_process";
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
import { logCodingAgentWarning } from "./diagnostics.js";
import type {
  CodingHarnessCredentialLaunch,
  CodingHarnessCredentialResolver,
} from "./harness-credentials.js";
import {
  addPortableProviderCredentials,
  buildPiChildEnvironment,
} from "./pi-process-environment.js";
import type {
  CodingAgentProviderAdapter,
  CodingAgentProviderEventPublisher,
} from "./provider-adapter.js";
import { hasNativeHarnessAuth } from "./native-harness-auth.js";

const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_500;
const MAX_ACTIVE_PROCESSES = 100;
const MAX_EVENTS = 480;
const MAX_SEEN_PARTS = 512;
const MAX_RECORDS = 4_096;
const MAX_TEXT_CHARS = 24_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const OpenCodeResumeStateSchema = z.object({
  s: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
  c: z.string().min(1).max(400).startsWith("/"),
}).strict();

interface SpawnOptions { cwd: string; env: Record<string, string> }
interface ChildProcess {
  stdout: {
    on(event: "data", listener: (chunk: Buffer) => void): void;
    once(event: "end" | "close", listener: () => void): void;
  };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  once(event: "exit", listener: (code: number | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}
export type OpenCodeSpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

export interface OpenCodeCodingAgentProviderOptions {
  homePath: string;
  providerId?: string;
  command?: string;
  env?: Record<string, string>;
  spawnFn?: OpenCodeSpawnFn;
  runCommand?: RunCommand;
  resolveCredentialLaunch: CodingHarnessCredentialResolver;
  resolveProjectPath?: (projectSlug: string) => Promise<string | null>;
  resolveWorktreePath?: (projectSlug: string, worktreeId: string) => Promise<string | null>;
  runTimeoutMs?: number;
  killGraceMs?: number;
}

const execFileAsync = promisify(execFile);
const defaultSpawn: OpenCodeSpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
const defaultRunCommand: RunCommand = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function safeId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
  return /^[A-Za-z0-9]/.test(cleaned) && !cleaned.includes("..") ? cleaned : fallback;
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string") return "tool";
  const cleaned = value.replace(/[^A-Za-z0-9 _-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || "tool";
}

function promptWithReferences(message: string, attachments: AgentAttachment[] | undefined): string {
  const references = (attachments ?? [])
    .filter((attachment) => attachment.kind === "structured_ref")
    .map((attachment) => `- ${attachment.label}${attachment.path ? `: ${attachment.path}` : ""}`);
  const prompt = references.length > 0 ? `${message}\n\nContext references:\n${references.join("\n")}` : message;
  if (Buffer.byteLength(prompt, "utf-8") > MAX_PROMPT_BYTES) throw new Error("OpenCode prompt is too large");
  return prompt;
}

function modelSlug(reference: string | undefined): string | undefined {
  if (!reference || reference === "provider-default") return undefined;
  const separator = reference.indexOf(":");
  return separator > 0 ? `${reference.slice(0, separator)}/${reference.slice(separator + 1)}` : reference;
}

function readOnlyConfig(baseUrl: string | undefined): string {
  return JSON.stringify({
    // Canonical Chat already limits OpenCode to non-mutating tools. Disabling
    // snapshots avoids indexing the owner's entire Matrix HOME (which may
    // contain nested repositories and transient lock files) before each turn.
    snapshot: false,
    permission: {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
    },
    ...(baseUrl ? { provider: { anthropic: { options: { baseURL: baseUrl } } } } : {}),
  });
}

function childEnvironment(
  base: Record<string, string> | undefined,
  credentialEnv: Record<string, string>,
  homePath: string,
): Record<string, string> {
  const ownerEnvironment = buildPiChildEnvironment({ ...base, HOME: homePath });
  ownerEnvironment.HOME = homePath;
  const env = addPortableProviderCredentials(ownerEnvironment, credentialEnv);
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "1";
  env.OPENCODE_CONFIG_CONTENT = readOnlyConfig(env.ANTHROPIC_BASE_URL);
  return env;
}

type CredentialResolution =
  | { kind: "resolved"; launch: CodingHarnessCredentialLaunch }
  | { kind: "aborted" }
  | { kind: "timed_out" }
  | { kind: "failed"; error: unknown };

function interruptedCredentialResolution(signal: AbortSignal | undefined): CredentialResolution {
  const reason = signal?.reason;
  return typeof reason === "object" && reason !== null && "name" in reason
      && reason.name === "TimeoutError"
    ? { kind: "timed_out" }
    : { kind: "aborted" };
}

async function resolveCredentialsWithinRun(input: {
  resolver: CodingHarnessCredentialResolver;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<CredentialResolution> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(interruptedCredentialResolution(input.signal));
    const finish = (result: CredentialResolution) => {
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
      pending = input.resolver(input.signal);
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

function eventBase(threadId: string, now: () => Date, nextEventId: () => string) {
  return { eventId: nextEventId(), threadId, occurredAt: now().toISOString() };
}

function statusEvent(
  threadId: string,
  status: "running" | "completed" | "aborted",
  now: () => Date,
  nextEventId: () => string,
): AgentThreadEvent {
  return AgentThreadEventSchema.parse({ ...eventBase(threadId, now, nextEventId), type: "thread.status", status });
}

function completedEvent(
  threadId: string,
  outcome: "completed" | "failed" | "aborted",
  now: () => Date,
  nextEventId: () => string,
): AgentThreadEvent {
  return AgentThreadEventSchema.parse({ ...eventBase(threadId, now, nextEventId), type: "thread.completed", outcome });
}

function failureEvent(threadId: string, code: string, safeMessage: string, now: () => Date, nextEventId: () => string) {
  return AgentThreadEventSchema.parse({
    ...eventBase(threadId, now, nextEventId),
    type: "thread.error",
    error: { code, safeMessage, retryable: code !== "sandbox_unavailable", recoveryActions: code === "sandbox_unavailable" ? [] : ["retry"] },
  });
}

function terminalEvents(
  threadId: string,
  outcome: "completed" | "failed" | "aborted",
  now: () => Date,
  nextEventId: () => string,
): AgentThreadEvent[] {
  if (outcome === "failed") {
    return [failureEvent(threadId, "provider_run_failed", "Agent run could not continue. Try again.", now, nextEventId), completedEvent(threadId, outcome, now, nextEventId)];
  }
  return [statusEvent(threadId, outcome === "completed" ? "completed" : "aborted", now, nextEventId), completedEvent(threadId, outcome, now, nextEventId)];
}

function collectLine(input: {
  line: string;
  threadId: string;
  scope: string;
  now: () => Date;
  nextEventId: () => string;
  events: AgentThreadEvent[];
  seenParts: Set<string>;
}): { sessionId?: string; failed?: boolean; limitExceeded?: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.line);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      logCodingAgentWarning("OpenCode event parse failed", error);
    }
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const sessionId = typeof record.sessionID === "string" && OpenCodeResumeStateSchema.shape.s.safeParse(record.sessionID).success
    ? record.sessionID
    : undefined;
  if (record.type === "error") return { sessionId, failed: true };
  const part = record.part;
  if (!part || typeof part !== "object") return { sessionId };
  const value = part as Record<string, unknown>;
  const supportedText = record.type === "text" && value.type === "text";
  const supportedTool = record.type === "tool_use" && value.type === "tool";
  if (!supportedText && !supportedTool) return { sessionId };
  const partId = safeId(value.id, `part_${input.scope}_${input.seenParts.size + 1}`);
  if (input.seenParts.has(partId)) return { sessionId };
  if (input.seenParts.size >= MAX_SEEN_PARTS) return { sessionId, limitExceeded: true };
  const text = supportedText && typeof value.text === "string" && value.text.trim()
    ? value.text.slice(0, MAX_TEXT_CHARS)
    : null;
  const eventCount = supportedTool ? 3 : text === null ? 0 : 2;
  if (input.events.length + eventCount > MAX_EVENTS) return { sessionId, limitExceeded: true };
  input.seenParts.add(partId);
  if (text !== null) {
    const messageId = `msg_${partId}`;
    input.events.push(
      AgentThreadEventSchema.parse({ ...eventBase(input.threadId, input.now, input.nextEventId), type: "assistant.text.delta", messageId, delta: text }),
      AgentThreadEventSchema.parse({ ...eventBase(input.threadId, input.now, input.nextEventId), type: "assistant.text.completed", messageId }),
    );
  }
  if (supportedTool) {
    const toolCallId = safeId(value.callID, `tool_${partId}`);
    const name = safeToolName(value.tool);
    const state = value.state && typeof value.state === "object" ? value.state as Record<string, unknown> : {};
    const output = state.status === "completed" && typeof state.output === "string"
      ? state.output.slice(0, MAX_TEXT_CHARS)
      : state.status === "error" && typeof state.error === "string"
        ? "The tool could not complete."
        : "Tool finished.";
    input.events.push(
      AgentThreadEventSchema.parse({ ...eventBase(input.threadId, input.now, input.nextEventId), type: "tool.started", toolCallId, displayName: name, kind: name }),
      AgentThreadEventSchema.parse({ ...eventBase(input.threadId, input.now, input.nextEventId), type: "tool.output", toolCallId, text: output, ...(output.length === MAX_TEXT_CHARS ? { truncated: true } : {}) }),
      AgentThreadEventSchema.parse({ ...eventBase(input.threadId, input.now, input.nextEventId), type: "tool.completed", toolCallId, outcome: state.status === "error" ? "failed" : "success" }),
    );
  }
  return { sessionId };
}

export function createOpenCodeCodingAgentProvider(
  options: OpenCodeCodingAgentProviderOptions,
): CodingAgentProviderAdapter {
  const providerId = ProviderIdSchema.parse(options.providerId ?? "opencode");
  const command = options.command ?? "opencode";
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runTimeoutMs = Math.max(1, Math.min(options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS));
  const killGraceMs = Math.max(1, Math.min(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 10_000));
  const active = new Map<string, { abort: () => void; evict: () => void }>();
  const resolveProjectPath = options.resolveProjectPath ?? (async (slug: string) => {
    const result = await createProjectManager({ homePath: options.homePath }).getProject(slug);
    return result.ok ? result.project.localPath : null;
  });
  const resolveWorktreePath = options.resolveWorktreePath ?? (async (slug: string, id: string) => {
    const result = await createWorktreeManager({ homePath: options.homePath }).listWorktrees(slug);
    return result.ok ? result.worktrees.find((candidate) => candidate.id === id)?.path ?? null : null;
  });

  async function execute(input: {
    threadId: string;
    scope: string;
    prompt: string;
    cwd: string;
    model?: string;
    sessionId?: string;
    signal?: AbortSignal;
    now: () => Date;
    nextEventId: () => string;
    publishEvents?: CodingAgentProviderEventPublisher;
  }): Promise<{ events: AgentThreadEvent[]; outcome: "completed" | "failed" | "aborted"; sessionId?: string }> {
    const runDeadline = Date.now() + runTimeoutMs;
    const credentialResolution = await resolveCredentialsWithinRun({
      resolver: options.resolveCredentialLaunch,
      signal: input.signal,
      timeoutMs: runTimeoutMs,
    });
    if (credentialResolution.kind === "aborted") return { events: [], outcome: "aborted" };
    if (credentialResolution.kind === "timed_out") return { events: [], outcome: "failed" };
    if (credentialResolution.kind === "failed") {
      if (input.signal?.aborted) return { events: [], outcome: "aborted" };
      logCodingAgentWarning("OpenCode credential resolution failed", credentialResolution.error);
      return { events: [], outcome: "failed" };
    }
    const launch = credentialResolution.launch;
    // Supplying a title prevents OpenCode from dispatching a separate title
    // model before the selected run. That auxiliary request can hang or reject
    // Codex subscription models even though the requested model is healthy.
    const args = ["run", "--format", "json", "--pure", "--title", "Matrix Chat"];
    const selectedModel = modelSlug(input.model);
    if (selectedModel) args.push("--model", selectedModel);
    if (input.sessionId) args.push("--session", input.sessionId);
    // yargs treats leading-dash prompt text as options unless it follows the
    // end-of-options marker. Keep all user text in the variadic message.
    args.push("--", input.prompt);
    const env = childEnvironment(options.env, launch.env, options.homePath);
    const configuredTimeoutMs = launch.maxRunMs ? Math.min(runTimeoutMs, launch.maxRunMs) : runTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(configuredTimeoutMs, runDeadline - Date.now()));
    return await new Promise((resolve) => {
      let child: ChildProcess;
      try { child = spawnFn(command, args, { cwd: input.cwd, env }); } catch (error: unknown) {
        logCodingAgentWarning("OpenCode spawn failed", error);
        resolve({ events: [], outcome: "failed" });
        return;
      }
      let settled = false;
      let terminationReason: "user_abort" | "timeout" | "failure" | undefined;
      let failed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let exitObserved = false;
      let exitCode: number | null = null;
      let stdoutDrained = false;
      let sessionId = input.sessionId;
      let stdout = "";
      let stdoutBytes = 0;
      let stderrText = "";
      let recordCount = 0;
      let publishError: unknown;
      let publishQueue = Promise.resolve();
      const events: AgentThreadEvent[] = [];
      const seenParts = new Set<string>();

      function queueEvents(pending: AgentThreadEvent[]): void {
        if (!input.publishEvents || pending.length === 0) return;
        publishQueue = publishQueue.then(async () => {
          if (publishError) return;
          try {
            await input.publishEvents!({ events: pending });
          } catch (error: unknown) {
            publishError = error;
            logCodingAgentWarning("OpenCode event publish failed", error);
          }
        });
      }

      function drainEvents(): void {
        if (input.publishEvents) queueEvents(events.splice(0, events.length));
      }
      const stop = (reason: NonNullable<typeof terminationReason>) => {
        if (settled || terminationReason) return;
        terminationReason = reason;
        if (timer) clearTimeout(timer);
        try { child.kill("SIGTERM"); } catch (error: unknown) { logCodingAgentWarning("OpenCode termination failed", error); }
        killTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill("SIGKILL"); } catch (error: unknown) { logCodingAgentWarning("OpenCode forced termination failed", error); }
          finish(null);
        }, killGraceMs);
        killTimer.unref?.();
      };
      const tracked = {
        abort: () => stop("user_abort"),
        evict: () => stop("failure"),
      };
      while (active.size >= MAX_ACTIVE_PROCESSES) {
        const oldest = active.keys().next().value as string | undefined;
        if (!oldest) break;
        active.get(oldest)?.evict();
        active.delete(oldest);
      }
      active.set(input.threadId, tracked);
      timer = setTimeout(() => {
        stop("timeout");
      }, timeoutMs);
      timer.unref?.();
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        input.signal?.removeEventListener("abort", tracked.abort);
        if (active.get(input.threadId) === tracked) active.delete(input.threadId);
        const tail = stdout.trim();
        if (tail && !terminationReason && !failed) feed(tail);
        const result = {
          events,
          outcome: terminationReason === "user_abort"
            ? "aborted"
            : failed || publishError || terminationReason === "timeout" || terminationReason === "failure" || code !== 0
              ? "failed"
              : "completed",
          ...(sessionId ? { sessionId } : {}),
        } as const;
        if (result.outcome === "failed" && stderrText.trim()) {
          logCodingAgentWarning(
            "OpenCode run failed",
            new Error(`exit=${code} stderr=${stderrText.slice(0, 512)}`),
          );
        }
        void publishQueue.then(() => {
          resolve(publishError ? { ...result, events: [], outcome: "failed" } : result);
        });
      };
      const feed = (line: string) => {
        recordCount += 1;
        if (recordCount > MAX_RECORDS) {
          failed = true;
          stop("failure");
          return;
        }
        const result = collectLine({ line, threadId: input.threadId, scope: input.scope, now: input.now, nextEventId: input.nextEventId, events, seenParts });
        sessionId = result.sessionId ?? sessionId;
        failed ||= result.failed === true;
        drainEvents();
        if (result.limitExceeded) {
          failed = true;
          stop("failure");
        }
      };
      child.stdout.on("data", (chunk) => {
        if (settled || terminationReason) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) { failed = true; stop("failure"); stdout = ""; return; }
        stdout += chunk.toString("utf-8");
        if (Buffer.byteLength(stdout, "utf-8") > MAX_STDOUT_BUFFER_BYTES) { failed = true; stop("failure"); stdout = ""; return; }
        let index = stdout.indexOf("\n");
        while (index >= 0 && !terminationReason && !settled) {
          feed(stdout.slice(0, index).replace(/\r$/, ""));
          stdout = stdout.slice(index + 1);
          index = stdout.indexOf("\n");
        }
      });
      const onStdoutDrained = () => {
        if (stdoutDrained || settled) return;
        stdoutDrained = true;
        if (exitObserved) finish(exitCode);
      };
      const onExit = (code: number | null) => {
        if (settled || exitObserved) return;
        exitObserved = true;
        exitCode = code;
        if (terminationReason || failed || stdoutDrained) {
          finish(code);
          return;
        }
        if (timer) clearTimeout(timer);
        drainTimer = setTimeout(() => {
          if (settled) return;
          failed = true;
          stdout = "";
          finish(code);
        }, killGraceMs);
        drainTimer.unref?.();
      };
      child.stdout.once("end", onStdoutDrained);
      child.stdout.once("close", onStdoutDrained);
      child.stderr.on("data", (chunk) => {
        if (stderrText.length >= 8_192) return;
        stderrText += chunk.toString("utf-8").slice(0, 8_192 - stderrText.length);
      });
      child.once("error", (error) => { logCodingAgentWarning("OpenCode process failed", error); failed = true; finish(-1); });
      child.once("exit", onExit);
      if (input.signal?.aborted) tracked.abort();
      else input.signal?.addEventListener("abort", tracked.abort, { once: true });
    });
  }

  async function cwdFor(projectId?: string, worktreeId?: string): Promise<string | null> {
    if (projectId && worktreeId) return resolveWorktreePath(projectId, worktreeId);
    if (projectId) return resolveProjectPath(projectId);
    return options.homePath;
  }

  function parseResume(raw: string) {
    try {
      return OpenCodeResumeStateSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        logCodingAgentWarning("OpenCode resume parse failed", error);
      }
      return null;
    }
  }

  function setupActions(): SafeSetupAction[] {
    return SafeSetupActionSchema.array().parse([{
      id: "opencode_install", kind: "foreground_terminal", label: "Install OpenCode",
      command: "sh -lc 'export MATRIX_NODE_PREFIX=\"${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}\"; export PATH=\"$MATRIX_NODE_PREFIX/bin:$PATH\"; npm install -g --prefix \"$MATRIX_NODE_PREFIX\" opencode-ai@latest'",
    }, {
      id: "opencode_connect", kind: "foreground_terminal", label: "Connect OpenCode",
      command: "sh -lc 'export MATRIX_NODE_PREFIX=\"${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}\"; export PATH=\"$MATRIX_NODE_PREFIX/bin:$PATH\"; opencode auth login'",
    }]);
  }

  return {
    providerId,
    initialRunExecution: "background",
    async getSummary({ now }) {
      let installed = false;
      try {
        await runCommand(command, ["--version"], {
          cwd: options.homePath,
          timeout: PROBE_TIMEOUT_MS,
          env: buildPiChildEnvironment({ ...options.env, HOME: options.homePath }),
        });
        installed = true;
      }
      catch (error: unknown) { logCodingAgentWarning("OpenCode binary probe failed", error); }
      const authenticated = installed && await hasNativeHarnessAuth(options.homePath, "opencode");
      return AgentProviderSummarySchema.parse({
        id: providerId, displayName: "OpenCode", kind: "opencode",
        availability: authenticated ? "available" : installed ? "auth_required" : "unavailable",
        installStatus: installed ? "installed" : "missing",
        authStatus: authenticated ? "authenticated" : "unknown",
        supportedModes: ["default"], defaultMode: "default", setupActions: [], lastCheckedAt: now().toISOString(),
      });
    },
    async healthCheck({ now, principal, signal }) { return { ok: (await this.getSummary!({ now, principal, signal })).installStatus === "installed" }; },
    buildSetupAction: setupActions,
    async startThread({ thread, request, signal, now, nextEventId, publishEvents }) {
      if ((request.sandboxMode ?? "workspace_write") !== "read_only") {
        return { events: [failureEvent(thread.id, "sandbox_unavailable", "This agent can only run in read-only mode on this computer.", now, nextEventId), completedEvent(thread.id, "failed", now, nextEventId)] };
      }
      let cwd: string | null = null;
      try { cwd = await cwdFor(request.projectId, request.worktreeId); } catch (error: unknown) { logCodingAgentWarning("OpenCode workspace resolution failed", error); }
      if (!cwd) return { events: terminalEvents(thread.id, "failed", now, nextEventId) };
      const prompt = promptWithReferences(request.prompt, request.attachments);
      const running = statusEvent(thread.id, "running", now, nextEventId);
      if (publishEvents) await publishEvents({ events: [running] });
      const run = await execute({
        threadId: thread.id,
        scope: thread.id,
        prompt,
        cwd,
        model: request.model,
        signal,
        now,
        nextEventId,
        publishEvents,
      });
      const resume = run.sessionId ? JSON.stringify(OpenCodeResumeStateSchema.parse({ s: run.sessionId, c: cwd })) : undefined;
      return {
        events: [...(publishEvents ? [] : [running]), ...run.events, ...terminalEvents(thread.id, run.outcome, now, nextEventId)],
        ...(resume ? { resumeState: { conversationId: resume } } : {}),
      };
    },
    async resumeTurn({ thread, turn, resumeState, signal, now, nextEventId, publishEvents }) {
      if ((turn.sandboxMode ?? "workspace_write") !== "read_only") return { events: [], outcome: "failed", resumeState };
      const resume = parseResume(resumeState.conversationId);
      if (!resume) return { events: [], outcome: "failed", resumeState };
      const run = await execute({
        threadId: thread.id,
        scope: turn.turnId,
        prompt: promptWithReferences(turn.message, turn.attachments),
        cwd: resume.c,
        model: turn.model,
        sessionId: resume.s,
        signal,
        now,
        nextEventId,
        publishEvents,
      });
      return { events: run.events, outcome: run.outcome, resumeState };
    },
    abortThread({ thread, now, nextEventId }) {
      active.get(thread.id)?.abort();
      return [statusEvent(thread.id, "aborted", now, nextEventId), completedEvent(thread.id, "aborted", now, nextEventId)];
    },
    submitApproval() { return []; },
    submitInput() { return []; },
  };
}
