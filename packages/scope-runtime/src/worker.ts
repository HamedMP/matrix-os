import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { startInferenceBridge } from "./inference-bridge.js";
import {
  EXECUTION_GENERATION_PATTERN as EXECUTION_GENERATION,
  SCOPE_HANDLE_PATTERN as SCOPE_HANDLE,
  SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION,
  SCOPE_RUNTIME_CODEX_HARNESS_VERSION,
  SCOPE_RUNTIME_HANDLE_PATTERN as RUNTIME_HANDLE,
  prepareScopeRuntimeWorkerEnvironment,
  removeScopeRuntimeCommandSocket,
  scopeRuntimeWorkerFailure as workerFailure,
  scopeRuntimeWorkerFailureExitCode,
  verifyScopeRuntimeBoundary,
  waitForScopeRuntimeShutdown,
  writeScopeRuntimeReadiness,
} from "./worker-common.js";

export {
  SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION,
  SCOPE_RUNTIME_CODEX_HARNESS_VERSION,
  SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES,
  SCOPE_RUNTIME_WORKER_HARNESS_VERSION,
  prepareScopeRuntimeWorkerEnvironment,
  scopeRuntimeWorkerFailureExitCode,
  scopeRuntimeWorkerFailureForExitCode,
  scopeRuntimeWorkerFailureName,
  scrubScopeRuntimeWorkerEnvironment,
  validateScopeRuntimeWorkerEnvironment,
  verifyScopeRuntimeBoundary,
  waitForScopeRuntimeShutdown,
  writeScopeRuntimeReadiness,
  type ScopeRuntimeWorkerFailureName,
} from "./worker-common.js";

const COMMAND_SOCKET = "/run/matrix-scope-command/worker.sock";
const SDK_DIRECTORY = "/opt/matrix/scope-sdk/sdk";
const NATIVE_EXECUTABLE = "/opt/matrix/scope-sdk/native/claude";
const BROKER_SOCKET = "/run/matrix-scope/broker.sock";
const MAX_CHAT_FRAME_BYTES = 128 * 1024;
const CHAT_TIMEOUT_MS = 50_000;
const CODEX_EXECUTABLE = "/opt/matrix/runtime/node/bin/codex";
const MAX_CODEX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_CODEX_EVENTS = 2_048;
const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "sleep_tool",
  "code_mode",
  "code_mode_host",
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "tool_suggest",
  "goals",
  "standalone_web_search",
  "image_generation",
] as const;

export function parseScopeRuntimeWorkerArguments(input: readonly string[]) {
  const [runtimeHandle, scopeHandle, workload, adapterId, harnessVersion, executionGeneration] = input;
  if (input.length !== 6
    || typeof runtimeHandle !== "string" || !RUNTIME_HANDLE.test(runtimeHandle)
    || typeof scopeHandle !== "string" || !SCOPE_HANDLE.test(scopeHandle)
    || workload !== "chat_ai"
    || !((adapterId === "claude-code" && harnessVersion === SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION)
      || (adapterId === "codex" && harnessVersion === SCOPE_RUNTIME_CODEX_HARNESS_VERSION))
    || typeof executionGeneration !== "string" || !EXECUTION_GENERATION.test(executionGeneration)) {
    throw workerFailure("ScopeRuntimeInvocationError", "Invalid scope runtime worker invocation");
  }
  return { runtimeHandle, scopeHandle, workload, adapterId, harnessVersion, executionGeneration };
}

export function parseScopeRuntimeChatRequest(
  input: unknown,
  invocation: ReturnType<typeof parseScopeRuntimeWorkerArguments>,
): { requestId: string; model: string; prompt: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw workerFailure("ScopeRuntimeInvocationError", "Invalid Chat request");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = [
    "executionGeneration", "model", "prompt", "runtimeHandle", "type", "version",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || value.version !== 1 || value.type !== "runtime.chat"
    || value.runtimeHandle !== invocation.runtimeHandle
    || value.executionGeneration !== invocation.executionGeneration
    || typeof value.model !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/.test(value.model)
    || typeof value.prompt !== "string" || value.prompt.length < 1
    || Buffer.byteLength(value.prompt, "utf8") > 64 * 1024) {
    throw workerFailure("ScopeRuntimeInvocationError", "Invalid Chat request");
  }
  return { requestId: randomUUID(), model: value.model, prompt: value.prompt };
}

export interface ScopeCodexExecLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildScopeCodexExecLaunch(input: {
  bridgePort: number;
  model: string;
  prompt: string;
}): ScopeCodexExecLaunch {
  if (!Number.isSafeInteger(input.bridgePort) || input.bridgePort < 1 || input.bridgePort > 65_535
    || !/^[A-Za-z0-9._:/-]{1,256}$/.test(input.model)
    || input.prompt.length < 1 || Buffer.byteLength(input.prompt, "utf8") > 64 * 1024) {
    throw workerFailure("ScopeRuntimeInvocationError", "Invalid Codex scope execution");
  }
  const provider = [
    "{ name = \"Matrix scope broker\"",
    `base_url = \"http://127.0.0.1:${input.bridgePort}/v1\"`,
    "wire_api = \"responses\"",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "stream_idle_timeout_ms = 30000",
    "supports_websockets = false }",
  ].join(", ");
  return {
    command: CODEX_EXECUTABLE,
    args: [
      "--ask-for-approval", "never",
      "--sandbox", "read-only",
      "--strict-config",
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      "--config", `model_providers.matrix_scope=${provider}`,
      "--config", "model_provider=\"matrix_scope\"",
      "--config", "disable_response_storage=true",
      "--config", "web_search=\"disabled\"",
      "--config", "tools.update_plan.enabled=false",
      "--config", "tools.experimental_request_user_input.enabled=false",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--skip-git-repo-check",
      "--model", input.model,
      "--", input.prompt,
    ],
    env: {
      HOME: "/workspace",
      PATH: "/opt/matrix/runtime/node/bin",
      NO_COLOR: "1",
      MATRIX_SCOPE_RUNTIME: "1",
    },
  };
}

export function parseScopeCodexJsonEvents(lines: readonly string[]): string {
  if (lines.length > MAX_CODEX_EVENTS) throw new Error("Codex result unavailable");
  let completed = false;
  let failed = false;
  let text: string | undefined;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_CODEX_EVENT_LINE_BYTES) {
      throw new Error("Codex result unavailable");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw new Error("Codex result unavailable");
      throw new Error("Codex result unavailable");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type === "turn.failed" || event.type === "error") failed = true;
    if (event.type === "turn.completed") completed = true;
    if (event.type === "item.completed" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") text = item.text;
    }
  }
  if (failed || !completed || text === undefined || Buffer.byteLength(text, "utf8") > 96 * 1024) {
    throw new Error("Codex result unavailable");
  }
  return text;
}

async function runScopeCodexExec(input: {
  bridgePort: number;
  model: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  input.signal.throwIfAborted();
  const launch = buildScopeCodexExecLaunch(input);
  const child = spawn(launch.command, launch.args, {
    cwd: "/workspace",
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let stderrBytes = 0;
  const abort = () => child.kill("SIGTERM");
  input.signal.addEventListener("abort", abort, { once: true });
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    if (lines.length >= MAX_CODEX_EVENTS || Buffer.byteLength(line, "utf8") > MAX_CODEX_EVENT_LINE_BYTES) {
      child.kill("SIGTERM");
      return;
    }
    lines.push(line);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_CODEX_EVENT_LINE_BYTES) child.kill("SIGTERM");
  });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    input.signal.throwIfAborted();
    if (exit.code !== 0 || exit.signal !== null || stderrBytes > MAX_CODEX_EVENT_LINE_BYTES) {
      throw new Error("Codex result unavailable");
    }
    return parseScopeCodexJsonEvents(lines);
  } finally {
    input.signal.removeEventListener("abort", abort);
    stdout.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function executeChat(
  invocation: ReturnType<typeof parseScopeRuntimeWorkerArguments>,
  input: unknown,
): Promise<string> {
  const request = parseScopeRuntimeChatRequest(input, invocation);
  const bridge = await startInferenceBridge({
    brokerSocket: BROKER_SOCKET,
    runtimeHandle: invocation.runtimeHandle,
    executionGeneration: invocation.executionGeneration,
    actionFor: () => (invocation.adapterId === "codex" ? "inference.responses" : "inference.messages"),
  });
  try {
    if (invocation.adapterId === "codex") {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), CHAT_TIMEOUT_MS);
      try {
        return await runScopeCodexExec({
          bridgePort: bridge.port,
          model: request.model,
          prompt: request.prompt,
          signal: abortController.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    const runtime = await import(pathToFileURL(`${SDK_DIRECTORY}/sdk.mjs`).href) as {
      query?: (input: unknown) => AsyncIterable<Record<string, unknown>>;
    };
    if (typeof runtime.query !== "function") throw workerFailure("ScopeRuntimeInvocationError", "SDK unavailable");
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), CHAT_TIMEOUT_MS);
    let text: string | undefined;
    try {
      for await (const message of runtime.query({
        prompt: request.prompt,
        options: {
          abortController,
          allowedTools: [],
          cwd: "/workspace",
          disallowedTools: ["*"],
          env: {
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "scope-runtime-placeholder",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CONFIG_DIR: "/workspace/.claude",
            HOME: "/workspace",
            NO_COLOR: "1",
            PATH: "/opt/matrix/runtime/node/bin",
          },
          executable: "node",
          maxTurns: 1,
          model: request.model,
          pathToClaudeCodeExecutable: NATIVE_EXECUTABLE,
          persistSession: false,
          settingSources: [],
          tools: [],
        },
      })) {
        if (message.type === "result" && message.subtype === "success"
          && message.is_error !== true && typeof message.result === "string") text = message.result;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (text === undefined || Buffer.byteLength(text, "utf8") > 96 * 1024) {
      throw workerFailure("ScopeRuntimeInvocationError", "SDK result unavailable");
    }
    return text;
  } finally {
    await bridge.close();
  }
}

async function removeCommandSocket(): Promise<void> {
  await removeScopeRuntimeCommandSocket(COMMAND_SOCKET);
}

interface SingleUseCommandSocketSlot<T extends { destroy(): void }> {
  claim(socket: T, subscribeClose: (listener: () => void) => void): boolean;
  destroyActive(): void;
}

export function createSingleUseCommandSocketSlot<T extends { destroy(): void }>(): SingleUseCommandSocketSlot<T> {
  let claimed = false;
  let active: T | undefined;
  return {
    claim(socket, subscribeClose) {
      if (claimed) {
        socket.destroy();
        return false;
      }
      claimed = true;
      active = socket;
      subscribeClose(() => {
        if (active === socket) active = undefined;
      });
      return true;
    },
    destroyActive() {
      const socket = active;
      active = undefined;
      socket?.destroy();
    },
  };
}

async function startCommandServer(
  invocation: ReturnType<typeof parseScopeRuntimeWorkerArguments>,
  socketSlot: SingleUseCommandSocketSlot<Socket>,
): Promise<Server> {
  await removeCommandSocket();
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    if (!socketSlot.claim(socket, (listener) => socket.once("close", listener))) return;
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(CHAT_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CHAT_FRAME_BYTES) socket.destroy();
    });
    socket.once("end", () => {
      void (async () => {
        try {
          const frames = input.split("\n").filter((frame) => frame.trim());
          if (frames.length !== 1) throw workerFailure("ScopeRuntimeInvocationError", "Invalid Chat frame");
          const raw: unknown = JSON.parse(frames[0]!);
          const text = await executeChat(invocation, raw);
          if (!socket.destroyed) socket.end(`${JSON.stringify({
            version: 1,
            type: "runtime.chat.result",
            requestId: randomUUID(),
            ok: true,
            runtimeHandle: invocation.runtimeHandle,
            executionGeneration: invocation.executionGeneration,
            text,
          })}\n`);
        } catch (error: unknown) {
          console.warn("[scope-runtime] Chat execution failed:",
            error instanceof Error ? error.name : "UnknownError");
          socket.destroy();
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(COMMAND_SOCKET, resolve);
  });
  return server;
}

export async function runScopeRuntimeWorker(args = process.argv.slice(2)): Promise<void> {
  const environment = prepareScopeRuntimeWorkerEnvironment(
    args,
    process.env,
    process.execPath,
    fileURLToPath(import.meta.url),
  );
  if (environment.reexec) {
    if (typeof process.execve !== "function") {
      throw workerFailure("ScopeRuntimeInvocationError", "Scope runtime worker re-exec unavailable");
    }
    process.execve(
      environment.reexec.executable,
      environment.reexec.arguments,
      environment.reexec.environment,
    );
  }
  const invocation = parseScopeRuntimeWorkerArguments(environment.invocationArguments ?? []);
  await verifyScopeRuntimeBoundary();
  const commandSocket = createSingleUseCommandSocketSlot<Socket>();
  const commandServer = await startCommandServer(invocation, commandSocket);
  try {
    await writeScopeRuntimeReadiness(invocation.runtimeHandle);
  } catch (error: unknown) {
    commandServer.close();
    if (!(error instanceof Error)) throw error;
    throw workerFailure("ScopeRuntimeReadinessError", "Scope runtime readiness unavailable");
  }
  process.stdout.write("scope_runtime_worker_ready\n");
  try {
    await waitForScopeRuntimeShutdown();
  } finally {
    commandSocket.destroyActive();
    commandServer.close();
    await new Promise<void>((resolve) => commandServer.close(() => resolve()));
    await removeCommandSocket();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runScopeRuntimeWorker().catch((error: unknown) => {
    console.error("scope_runtime_worker_failed:", error instanceof Error ? error.name : "UnknownError");
    process.exitCode = scopeRuntimeWorkerFailureExitCode(error);
  });
}
