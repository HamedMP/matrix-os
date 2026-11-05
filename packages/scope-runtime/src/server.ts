import { closeOwnedListener, retryableClose, socketIdentity } from "./socket-shutdown.js";
import { assertNamespaceSocket, type NamespacePathTrust } from "./namespace-ancestry.js";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { ScopeRuntimeRequestSchema, type ScopeRuntimeRequest, type ScopeRuntimeResponse } from "./protocol.js";

const MAX_FRAME_BYTES = 128 * 1024;
/** 32 requests each for ordinary work, renewal, cancellation and hard Stop. */
const MAX_CONNECTIONS = 128;
const MAX_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
/** Busy bot turns are bounded by the supervisor-owned runtime lease. */

interface ScopeRuntimeController {
  handle(request: ScopeRuntimeRequest, context?: { signal: AbortSignal }): Promise<ScopeRuntimeResponse>;
  close(): Promise<void> | void;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const entry = await lstat(socketPath);
    if (!entry.isSocket()) throw new Error("Scope runtime socket path is not a socket");
    await unlink(socketPath);
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
}

export function createScopeRuntimeServer(options: {
  socketPath: string;
  namespaceTrust?: NamespacePathTrust;
  controller: ScopeRuntimeController;
  maxConnections?: number;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
}) {
  const maxConnections = Math.max(1, Math.min(
    Math.trunc(options.maxConnections ?? MAX_CONNECTIONS),
    MAX_CONNECTIONS,
  ));
  const requestTimeoutMs = Math.max(1, Math.min(
    Math.trunc(options.requestTimeoutMs ?? 10_000),
    MAX_REQUEST_TIMEOUT_MS,
  ));
  const operationTimeoutMs = Math.max(1, Math.min(
    Math.trunc(options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS),
    MAX_REQUEST_TIMEOUT_MS,
  ));
  const sockets = new Set<Socket>();
  const operations = new Set<Promise<void>>();
  let server: Server | undefined;
  let stopping = false;
  let bound: ReturnType<typeof socketIdentity> | undefined;

  async function closeListener(): Promise<void> {
    if (!server) return;
    await closeOwnedListener(server, options.socketPath, options.namespaceTrust, bound);
    server = undefined;
  }

  function accept(socket: Socket): void {
    if (stopping || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const abort = new AbortController();
    let input = "";
    let oversized = false;
    let dispatched = false;
    socket.setEncoding("utf8");
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    socket.once("error", (error: unknown) => {
      console.warn("[scope-runtime] supervisor socket failed:",
        error instanceof Error ? error.name : "UnknownError");
    });
    socket.once("close", () => { sockets.delete(socket); abort.abort(); });
    socket.on("data", (chunk) => {
      if (oversized) return;
      if (dispatched) { socket.destroy(); return; }
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BYTES) {
        oversized = true;
        input = "";
        socket.destroy();
        return;
      }
      if (input.includes("\n")) {
        try {
          const request = ScopeRuntimeRequestSchema.parse(JSON.parse(input.trim()));
          if (request.type === "runtime.bot" && request.command.kind === "bot.run") dispatch();
        } catch (error: unknown) { socket.destroy(); }
      }
    });
    socket.once("end", () => {
      if (dispatched) { abort.abort(); socket.destroy(); return; }
      dispatch();
    });
    function dispatch(): void {
      if (oversized || stopping || operations.size >= maxConnections) {
        socket.destroy();
        return;
      }
      dispatched = true;
      socket.setTimeout(operationTimeoutMs, () => socket.destroy());
      const operation = (async () => {
        try {
          const frames = input.split("\n").filter((frame) => frame.trim().length > 0);
          if (frames.length !== 1) {
            socket.destroy();
            return;
          }
          const request = ScopeRuntimeRequestSchema.parse(JSON.parse(frames[0]!));
          if (request.type === "runtime.bot" && request.command.kind === "bot.run") {
            socket.setTimeout(0);
          }
          const response = await options.controller.handle(request, { signal: abort.signal });
          if (!stopping && !socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
          else socket.destroy();
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) {
            console.warn("[scope-runtime] rejected supervisor request");
          }
          socket.destroy();
        }
      })();
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch((error: unknown) => {
        console.warn("[scope-runtime] supervisor request cleanup failed:",
          error instanceof Error ? error.name : "UnknownError");
      });
    }
  }

  const close = retryableClose(async () => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
    // Controller shutdown stops workers through guarded launcher paths. Retain those
    // handles until placement is trusted; the transport remains inert on refusal.
    await closeListener();
    await options.controller.close();
    await Promise.allSettled([...operations]);
  });

  return {
    async start(): Promise<void> {
      if (stopping || server) throw new Error("Scope runtime server cannot start");
      if (options.namespaceTrust) await assertNamespaceSocket(options.socketPath, options.namespaceTrust);
      await removeStaleSocket(options.socketPath);
      const candidate = createServer({ allowHalfOpen: true }, accept);
      server = candidate;
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once("error", reject);
          candidate.listen(options.socketPath, resolve);
        });
        if (options.namespaceTrust) bound = socketIdentity(options.socketPath);
        await chmod(options.socketPath, 0o660);
      } catch (error: unknown) {
        if (candidate.listening) {
          stopping = true;
          await closeListener();
        } else { server = undefined; }
        throw error;
      }
    },
    connectionCount(): number {
      return sockets.size;
    },
    close,
  };
}
