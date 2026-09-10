import { randomUUID } from "node:crypto";
import { access, constants, lstat, open, unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCOPE_RUNTIME_WORKER_HARNESS_VERSION = "2.1.240";

const RUNTIME_HANDLE = /^runtime_[a-f0-9]{32}$/;
const SCOPE_HANDLE = /^scope_[a-f0-9]{32}$/;
const EXECUTION_GENERATION = /^(0|[1-9][0-9]{0,19})$/;
const COMMAND_SOCKET = "/run/matrix-scope-command/worker.sock";
const SDK_DIRECTORY = "/opt/matrix/scope-sdk/sdk";
const NATIVE_EXECUTABLE = "/opt/matrix/scope-sdk/native/claude";
const BROKER_SOCKET = "/run/matrix-scope/broker.sock";
const MAX_CHAT_FRAME_BYTES = 128 * 1024;
const CHAT_TIMEOUT_MS = 50_000;

const SENSITIVE_ENVIRONMENT_KEY = /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)(?:$|_)/i;
const FORBIDDEN_PATHS = [
  "/home/matrix/home",
  "/opt/matrix/env",
  "/run/systemd/private",
  "/run/postgresql",
  "/var/run/docker.sock",
] as const;
const READINESS_DIRECTORY = "/run/matrix-scope-readiness";
const FIXED_ENVIRONMENT_SENTINEL = "--matrix-scope-fixed-environment";
const FIXED_WORKER_ENVIRONMENT = Object.freeze({
  HOME: "/workspace",
  PATH: "/opt/matrix/runtime/node/bin",
  MATRIX_SCOPE_RUNTIME: "1",
});
export const SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES = Object.freeze({
  ScopeRuntimeBrokerError: 80,
  ScopeRuntimeEnvironmentCapacityError: 81,
  ScopeRuntimeEnvironmentFixedError: 82,
  ScopeRuntimeEnvironmentKeyError: 83,
  ScopeRuntimeFilesystemError: 84,
  ScopeRuntimeIdentityUidError: 85,
  ScopeRuntimeIdentityWorkingDirectoryError: 86,
  ScopeRuntimeInvocationError: 87,
  ScopeRuntimeReadinessError: 88,
  ScopeRuntimeUnknownError: 89,
} as const);

export type ScopeRuntimeWorkerFailureName = keyof typeof SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES;

function workerFailure(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function parseScopeRuntimeWorkerArguments(input: readonly string[]) {
  const [runtimeHandle, scopeHandle, workload, adapterId, harnessVersion, executionGeneration] = input;
  if (input.length !== 6
    || typeof runtimeHandle !== "string" || !RUNTIME_HANDLE.test(runtimeHandle)
    || typeof scopeHandle !== "string" || !SCOPE_HANDLE.test(scopeHandle)
    || workload !== "chat_ai"
    || adapterId !== "claude-code"
    || harnessVersion !== SCOPE_RUNTIME_WORKER_HARNESS_VERSION
    || typeof executionGeneration !== "string" || !EXECUTION_GENERATION.test(executionGeneration)) {
    throw workerFailure("ScopeRuntimeInvocationError", "Invalid scope runtime worker invocation");
  }
  return { runtimeHandle, scopeHandle, workload, adapterId, harnessVersion, executionGeneration };
}

export function validateScopeRuntimeWorkerEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const entries = Object.entries(input);
  if (entries.length > 256) {
    throw workerFailure("ScopeRuntimeEnvironmentCapacityError", "Scope runtime environment exceeds capacity");
  }
  let bytes = 0;
  for (const [key, value] of entries) {
    if (key.length > 256 || (value?.length ?? 0) > 8_192 || SENSITIVE_ENVIRONMENT_KEY.test(key)) {
      throw workerFailure("ScopeRuntimeEnvironmentKeyError", "Unsafe scope runtime environment");
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value ?? "");
  }
  if (bytes > 64 * 1024
    || input.HOME !== "/workspace"
    || input.PATH !== "/opt/matrix/runtime/node/bin"
    || input.MATRIX_SCOPE_RUNTIME !== "1") {
    throw workerFailure("ScopeRuntimeEnvironmentFixedError", "Invalid scope runtime environment");
  }
  return input;
}

export function scrubScopeRuntimeWorkerEnvironment(
  input: Record<string, string | undefined>,
): Readonly<Record<string, string | undefined>> {
  const keys = Object.keys(input);
  if (keys.length > 256) {
    throw workerFailure("ScopeRuntimeEnvironmentCapacityError", "Scope runtime environment exceeds capacity");
  }
  for (const key of keys) {
    if (!Object.hasOwn(FIXED_WORKER_ENVIRONMENT, key)) delete input[key];
  }
  Object.assign(input, FIXED_WORKER_ENVIRONMENT);
  return validateScopeRuntimeWorkerEnvironment(input);
}

export function prepareScopeRuntimeWorkerEnvironment(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  executable: string,
  workerFile: string,
): {
  invocationArguments?: readonly string[];
  reexec?: {
    executable: string;
    arguments: string[];
    environment: Record<string, string>;
  };
} {
  if (args[0] === FIXED_ENVIRONMENT_SENTINEL) {
    scrubScopeRuntimeWorkerEnvironment(environment);
    return { invocationArguments: args.slice(1) };
  }
  return {
    reexec: {
      executable,
      arguments: [executable, workerFile, FIXED_ENVIRONMENT_SENTINEL, ...args],
      environment: { ...FIXED_WORKER_ENVIRONMENT },
    },
  };
}

async function verifyBoundary(): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || uid < 61_184 || uid > 65_519) {
    throw workerFailure("ScopeRuntimeIdentityUidError", "Scope runtime identity unavailable");
  }
  if (process.cwd() !== "/workspace") {
    throw workerFailure("ScopeRuntimeIdentityWorkingDirectoryError", "Scope runtime identity unavailable");
  }
  validateScopeRuntimeWorkerEnvironment(process.env);
  for (const path of FORBIDDEN_PATHS) {
    try {
      await access(path);
      throw workerFailure("ScopeRuntimeFilesystemError", "Scope runtime forbidden path is accessible");
    } catch (error: unknown) {
      if (error instanceof Error && ["ENOENT", "EACCES", "EPERM"].includes(
        String((error as NodeJS.ErrnoException).code),
      )) continue;
      throw error;
    }
  }
  const broker = await lstat("/run/matrix-scope/broker.sock");
  if (!broker.isSocket() || broker.isSymbolicLink()) {
    throw workerFailure("ScopeRuntimeBrokerError", "Scope runtime broker unavailable");
  }
}

export async function writeScopeRuntimeReadiness(
  runtimeHandle: string,
  directory = READINESS_DIRECTORY,
): Promise<void> {
  if (!RUNTIME_HANDLE.test(runtimeHandle)) {
    throw workerFailure("ScopeRuntimeInvocationError", "Invalid scope runtime worker invocation");
  }
  const marker = await open(
    join(directory, "ready"),
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  try {
    await marker.writeFile(`${runtimeHandle}\n`);
  } finally {
    await marker.close();
  }
}

export function scopeRuntimeWorkerFailureName(error: unknown): ScopeRuntimeWorkerFailureName {
  const name = error instanceof Error ? error.name : "";
  return Object.hasOwn(SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES, name)
    ? name as ScopeRuntimeWorkerFailureName
    : "ScopeRuntimeUnknownError";
}

export function scopeRuntimeWorkerFailureExitCode(error: unknown): number {
  return SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES[scopeRuntimeWorkerFailureName(error)];
}

export function scopeRuntimeWorkerFailureForExitCode(
  exitCode: number,
): ScopeRuntimeWorkerFailureName | undefined {
  for (const [name, code] of Object.entries(SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES)) {
    if (code === exitCode) return name as ScopeRuntimeWorkerFailureName;
  }
  return undefined;
}

export async function waitForScopeRuntimeShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    // Signal listeners do not keep Node's event loop alive. Without this
    // referenced handle, the top-level await exits with status 13 before the
    // supervisor can use the ready worker.
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      resolve();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
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

function brokerRequest(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: BROKER_SOCKET });
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    socket.setTimeout(30_000, () => finish(workerFailure("ScopeRuntimeBrokerError", "Broker timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      response = Buffer.concat([response, bytes], response.length + bytes.length);
      if (response.length > 512 * 1024) {
        finish(workerFailure("ScopeRuntimeBrokerError", "Broker response exceeded capacity"));
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(response.subarray(0, newline).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(workerFailure("ScopeRuntimeBrokerError", "Broker response is invalid"));
          return;
        }
        finish(undefined, parsed as Record<string, unknown>);
      } catch (error: unknown) {
        finish(workerFailure("ScopeRuntimeBrokerError", "Broker response is invalid"));
      }
    });
    socket.once("error", () => finish(workerFailure("ScopeRuntimeBrokerError", "Broker unavailable")));
  });
}

async function readHttpBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.length;
    if (size > 256 * 1024) throw workerFailure("ScopeRuntimeBrokerError", "Provider request exceeded capacity");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function startInferenceBridge(
  invocation: ReturnType<typeof parseScopeRuntimeWorkerArguments>,
): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer(async (request, response) => {
    try {
      const body = await readHttpBody(request);
      const brokerResponse = await brokerRequest({
        version: 1,
        action: "inference.messages",
        requestId: randomUUID(),
        runtimeHandle: invocation.runtimeHandle,
        executionGeneration: invocation.executionGeneration,
        method: request.method,
        path: request.url,
        headers: {
          ...(typeof request.headers["anthropic-version"] === "string"
            ? { "anthropic-version": request.headers["anthropic-version"] } : {}),
          ...(typeof request.headers["anthropic-beta"] === "string"
            ? { "anthropic-beta": request.headers["anthropic-beta"] } : {}),
        },
        body,
      });
      if (brokerResponse.ok !== true || typeof brokerResponse.status !== "number"
        || typeof brokerResponse.body !== "string" || !brokerResponse.headers
        || typeof brokerResponse.headers !== "object") {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(brokerResponse.status, brokerResponse.headers as Record<string, string>);
      response.end(brokerResponse.body);
    } catch (error: unknown) {
      console.warn("[scope-runtime] inference bridge failed:",
        error instanceof Error ? error.name : "UnknownError");
      response.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw workerFailure("ScopeRuntimeBrokerError", "Bridge unavailable");
  return { server, port: address.port };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function executeChat(
  invocation: ReturnType<typeof parseScopeRuntimeWorkerArguments>,
  input: unknown,
): Promise<string> {
  const request = parseScopeRuntimeChatRequest(input, invocation);
  const bridge = await startInferenceBridge(invocation);
  try {
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
    await closeHttpServer(bridge.server);
  }
}

async function removeCommandSocket(): Promise<void> {
  try {
    const entry = await lstat(COMMAND_SOCKET);
    if (!entry.isSocket() || entry.isSymbolicLink()) {
      throw workerFailure("ScopeRuntimeFilesystemError", "Invalid command socket");
    }
    await unlink(COMMAND_SOCKET);
  } catch (error: unknown) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
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
  await verifyBoundary();
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
