/**
 * Sandbox-side runner for `bot_agent` workloads (`scope-runtime-bot-v1`).
 *
 * It checks the fixed boundary, starts the private Unix inference bridge, and
 * serves the runtime's command socket. The bot runtime supplies the command
 * handler, so this module has no dependency on the agent loop. It imports
 * only side-effect-free modules and never the Chat worker entry, so the
 * bundled bot worker cannot start a Chat worker by accident.
 */
import type { IncomingMessage } from "node:http";
import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { SCOPE_RUNTIME_BOT_ADAPTER_ID, SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "./bot-profile.js";
import { inferenceActionForPath, startInferenceBridge } from "./inference-bridge.js";
import {
  ScopeRuntimeBotCommandSchema,
  ScopeRuntimeBotWorkerReplySchema,
  type ScopeRuntimeBotCommand,
  type ScopeRuntimeBotWorkerReply,
} from "./protocol.js";
import {
  EXECUTION_GENERATION_PATTERN,
  SCOPE_HANDLE_PATTERN,
  SCOPE_RUNTIME_HANDLE_PATTERN,
  prepareScopeRuntimeWorkerEnvironment,
  removeScopeRuntimeCommandSocket,
  scopeRuntimeWorkerFailure,
  verifyScopeRuntimeBoundary,
  waitForScopeRuntimeShutdown,
  writeScopeRuntimeReadiness,
} from "./worker-common.js";

const COMMAND_SOCKET = "/run/matrix-scope-command/worker.sock";
const BROKER_SOCKET = "/run/matrix-scope/broker.sock";
const INFERENCE_SOCKET = "/run/matrix-scope-command/inference.sock";
/** Relay commands carry identifiers and at most 8 KiB of steering text. */
const MAX_COMMAND_FRAME_BYTES = 16 * 1024;
/** One active run plus its steer and cancel commands. */
const MAX_COMMAND_CONNECTIONS = 4;
const FRAME_READ_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 920_000;
const CONTROL_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 5_000;
/** A funded background request may wait in the owner's queue for up to ten minutes before it is sent. */
const BOT_INFERENCE_TIMEOUT_MS = 11 * 60_000;
/** Lets replies already written (a cancelled run's outcome) flush before sockets are destroyed. */
const CLOSE_GRACE_MS = 1_000;

export interface ScopeRuntimeBotInvocation {
  runtimeHandle: string;
  scopeHandle: string;
  workload: "bot_agent";
  adapterId: string;
  harnessVersion: string;
  executionGeneration: string;
}

export function parseScopeRuntimeBotWorkerArguments(input: readonly string[]): ScopeRuntimeBotInvocation {
  const [runtimeHandle, scopeHandle, workload, adapterId, harnessVersion, executionGeneration] = input;
  if (input.length !== 6
    || typeof runtimeHandle !== "string" || !SCOPE_RUNTIME_HANDLE_PATTERN.test(runtimeHandle)
    || typeof scopeHandle !== "string" || !SCOPE_HANDLE_PATTERN.test(scopeHandle)
    || workload !== "bot_agent"
    || adapterId !== SCOPE_RUNTIME_BOT_ADAPTER_ID
    || harnessVersion !== SCOPE_RUNTIME_BOT_HARNESS_VERSION
    || typeof executionGeneration !== "string" || !EXECUTION_GENERATION_PATTERN.test(executionGeneration)) {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeInvocationError", "Invalid scope runtime worker invocation");
  }
  return { runtimeHandle, scopeHandle, workload, adapterId, harnessVersion, executionGeneration };
}

/** Thrown by a handler to refuse a command with an allowlisted reason. */
export class ScopeRuntimeBotCommandError extends Error {
  constructor(readonly code: "busy" | "invalid_command") {
    super(`Bot command refused: ${code}`);
    this.name = "ScopeRuntimeBotCommandError";
  }
}

export interface ScopeRuntimeBotHandler {
  handle(command: ScopeRuntimeBotCommand): Promise<Record<string, unknown>>;
  /** Called on SIGTERM; should cancel an active run so its session is saved. */
  shutdown?(): Promise<void>;
}

export interface ScopeRuntimeBotHandlerContext {
  runtimeHandle: string;
  executionGeneration: string;
  brokerSocket: string;
  bridgeOrigin: string;
  bridgeSocket?: string;
}

/** The relayed frame must name this runtime and generation exactly. */
export function parseScopeRuntimeBotCommandFrame(input: unknown, invocation: ScopeRuntimeBotInvocation): ScopeRuntimeBotCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ScopeRuntimeBotCommandError("invalid_command");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "command,executionGeneration,runtimeHandle,type,version"
    || value.version !== 1 || value.type !== "runtime.bot"
    || value.runtimeHandle !== invocation.runtimeHandle
    || value.executionGeneration !== invocation.executionGeneration) {
    throw new ScopeRuntimeBotCommandError("invalid_command");
  }
  const command = ScopeRuntimeBotCommandSchema.safeParse(value.command);
  if (!command.success) throw new ScopeRuntimeBotCommandError("invalid_command");
  return command.data;
}

function replyFrame(reply: ScopeRuntimeBotWorkerReply): string {
  return `${JSON.stringify(ScopeRuntimeBotWorkerReplySchema.parse(reply))}\n`;
}

async function dispatch(
  raw: string,
  invocation: ScopeRuntimeBotInvocation,
  handler: ScopeRuntimeBotHandler,
  socket: Socket,
): Promise<ScopeRuntimeBotWorkerReply> {
  try {
    const frames = raw.split("\n").filter((frame) => frame.trim().length > 0);
    if (frames.length !== 1) return { version: 1, ok: false, error: "invalid_command" };
    const command = parseScopeRuntimeBotCommandFrame(JSON.parse(frames[0]!), invocation);
    socket.setTimeout(command.kind === "bot.run" ? RUN_TIMEOUT_MS : CONTROL_TIMEOUT_MS, () => socket.destroy());
    const reply = await handler.handle(command);
    return ScopeRuntimeBotWorkerReplySchema.parse({ version: 1, ok: true, reply });
  } catch (error: unknown) {
    if (error instanceof ScopeRuntimeBotCommandError) return { version: 1, ok: false, error: error.code };
    if (error instanceof SyntaxError) return { version: 1, ok: false, error: "invalid_command" };
    console.warn("[scope-runtime] bot command failed:", error instanceof Error ? error.name : "UnknownError");
    return { version: 1, ok: false, error: "unavailable" };
  }
}

/**
 * Serves one request per connection. Unlike the single-use Chat socket, a
 * bot runtime keeps one long `bot.run` connection open while steer and cancel
 * arrive on their own short connections.
 */
export async function startBotCommandServer(options: {
  socketPath: string;
  invocation: ScopeRuntimeBotInvocation;
  handler: ScopeRuntimeBotHandler;
  maxConnections?: number;
}): Promise<{ server: Server; close(): Promise<void> }> {
  const maxConnections = Math.max(1, Math.min(options.maxConnections ?? MAX_COMMAND_CONNECTIONS, MAX_COMMAND_CONNECTIONS));
  const sockets = new Set<Socket>();
  await removeScopeRuntimeCommandSocket(options.socketPath);
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", (error: unknown) => {
      console.warn("[scope-runtime] bot command socket failed:", error instanceof Error ? error.name : "UnknownError");
    });
    let input = "";
    let oversized = false;
    socket.setEncoding("utf8");
    socket.setTimeout(FRAME_READ_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (oversized) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_COMMAND_FRAME_BYTES) {
        oversized = true;
        socket.destroy();
      }
    });
    socket.once("end", () => {
      if (oversized) return;
      void dispatch(input, options.invocation, options.handler, socket).then((reply) => {
        if (!socket.destroyed) socket.end(replyFrame(reply));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  // DynamicUser plus the fixed 0077 umask creates an owner-only socket. The
  // capability-free supervisor cannot bypass that UID's permissions. Its
  // private 0700 runtime directory limits host access; frames still require
  // this runtime's unpredictable handle and exact execution generation.
  try {
    await chmod(options.socketPath, 0o666);
  } catch (error: unknown) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeScopeRuntimeCommandSocket(options.socketPath);
    throw error;
  }
  return {
    server,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
      for (const socket of sockets) socket.destroy();
      await closed;
      await removeScopeRuntimeCommandSocket(options.socketPath);
    },
  };
}

/** Bot adapters route by API path; anything else on the bridge is refused. */
export function botInferenceAction(request: Pick<IncomingMessage, "method" | "url">) {
  return request.method === "POST" ? inferenceActionForPath(request.url) : undefined;
}

export async function runScopeRuntimeBotWorker(options: {
  createHandler(context: ScopeRuntimeBotHandlerContext): ScopeRuntimeBotHandler | Promise<ScopeRuntimeBotHandler>;
  /** The file Node re-executes with the fixed environment; the bundle's own path in production. */
  entryFile?: string;
  args?: readonly string[];
}): Promise<void> {
  const environment = prepareScopeRuntimeWorkerEnvironment(
    options.args ?? process.argv.slice(2),
    process.env,
    process.execPath,
    options.entryFile ?? fileURLToPath(import.meta.url),
  );
  if (environment.reexec) {
    if (typeof process.execve !== "function") {
      throw scopeRuntimeWorkerFailure("ScopeRuntimeInvocationError", "Scope runtime worker re-exec unavailable");
    }
    process.execve(environment.reexec.executable, environment.reexec.arguments, environment.reexec.environment);
  }
  const invocation = parseScopeRuntimeBotWorkerArguments(environment.invocationArguments ?? []);
  await verifyScopeRuntimeBoundary();
  await removeScopeRuntimeCommandSocket(INFERENCE_SOCKET);
  const bridge = await startInferenceBridge({
    brokerSocket: BROKER_SOCKET,
    socketPath: INFERENCE_SOCKET,
    runtimeHandle: invocation.runtimeHandle,
    executionGeneration: invocation.executionGeneration,
    actionFor: botInferenceAction,
    brokerTimeoutMs: BOT_INFERENCE_TIMEOUT_MS,
  });
  let commands: Awaited<ReturnType<typeof startBotCommandServer>> | undefined;
  let handler: ScopeRuntimeBotHandler | undefined;
  try {
    handler = await options.createHandler({
      runtimeHandle: invocation.runtimeHandle,
      executionGeneration: invocation.executionGeneration,
      brokerSocket: BROKER_SOCKET,
      // URL syntax for the SDK only. Its fetch adapter connects over AF_UNIX.
      bridgeOrigin: "http://127.0.0.1",
      bridgeSocket: INFERENCE_SOCKET,
    });
    commands = await startBotCommandServer({ socketPath: COMMAND_SOCKET, invocation, handler });
    try {
      await writeScopeRuntimeReadiness(invocation.runtimeHandle);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      throw scopeRuntimeWorkerFailure("ScopeRuntimeReadinessError", "Scope runtime readiness unavailable");
    }
    process.stdout.write("scope_runtime_bot_worker_ready\n");
    await waitForScopeRuntimeShutdown();
    if (handler.shutdown) {
      await Promise.race([
        handler.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
      ]);
    }
  } finally {
    await commands?.close();
    await bridge.close();
  }
}
