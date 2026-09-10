import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { ScopeRuntimeRequestSchema, type ScopeRuntimeRequest, type ScopeRuntimeResponse } from "./protocol.js";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;

interface ScopeRuntimeController {
  handle(request: ScopeRuntimeRequest): Promise<ScopeRuntimeResponse>;
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
  let closed = false;

  function accept(socket: Socket): void {
    if (closed || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let input = "";
    let oversized = false;
    socket.setEncoding("utf8");
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    socket.once("error", (error: unknown) => {
      console.warn("[scope-runtime] supervisor socket failed:",
        error instanceof Error ? error.name : "UnknownError");
    });
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (oversized) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BYTES) {
        oversized = true;
        input = "";
        socket.destroy();
      }
    });
    socket.once("end", () => {
      if (oversized || closed) {
        socket.destroy();
        return;
      }
      socket.setTimeout(operationTimeoutMs, () => socket.destroy());
      const operation = (async () => {
        try {
          const frames = input.split("\n").filter((frame) => frame.trim().length > 0);
          if (frames.length !== 1) {
            socket.destroy();
            return;
          }
          const request = ScopeRuntimeRequestSchema.parse(JSON.parse(frames[0]!));
          const response = await options.controller.handle(request);
          if (!closed && !socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
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
    });
  }

  return {
    async start(): Promise<void> {
      if (closed || server) throw new Error("Scope runtime server cannot start");
      await removeStaleSocket(options.socketPath);
      const candidate = createServer({ allowHalfOpen: true }, accept);
      server = candidate;
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once("error", reject);
          candidate.listen(options.socketPath, resolve);
        });
        await chmod(options.socketPath, 0o660);
      } catch (error: unknown) {
        server = undefined;
        candidate.close();
        throw error;
      }
    },
    connectionCount(): number {
      return sockets.size;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const current = server;
      server = undefined;
      const serverClosed = current
        ? new Promise<void>((resolve) => current.close(() => resolve()))
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await serverClosed;
      await Promise.allSettled([...operations]);
      await options.controller.close();
      try {
        const entry = await lstat(options.socketPath);
        if (entry.isSocket()) await unlink(options.socketPath);
      } catch (error: unknown) {
        if (!isNotFound(error)) {
          console.warn("[scope-runtime] supervisor socket cleanup failed:",
            error instanceof Error ? error.name : "UnknownError");
        }
      }
    },
  };
}
