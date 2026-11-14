/** Socket framing/lifetime only. Authority remains in the existing registered routeFrame consumer. */
import { BOT_IMAGE_INFERENCE_FRAME_MAX_BYTES, INFERENCE_RESPONSE_FRAME_MAX_BYTES, BotBrokerRequestSchema } from "@matrix-os/contracts";
import { ScopeRuntimeBotInferenceRequestSchema, ScopeRuntimeBrokerRequestSchema, ScopeRuntimeBrokerResponseSchema,
  type ScopeRuntimeBrokerRequest, type ScopeRuntimeBrokerResponse } from "@matrix-os/scope-runtime/broker-protocol";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod/v4";
import { isInferenceStream, writeInferenceStream } from "./inference-stream-transport.js";
/** Unchanged shared/session and response caps; strict routine schema has its smaller existing tool bound. */
const MAX_REQUEST_FRAME_BYTES = 640 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024;
const MAX_BROKER_CONNECTIONS = 64;
const MAX_ROUTED_REQUEST_TIMEOUT_MS = 11 * 60_000;

function notFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeBrokerSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error("Unsafe scope broker socket path");
    await unlink(path);
  } catch (error: unknown) {
    if (!notFound(error)) throw error;
  }
}

export function createScopeRuntimeBrokerServer(options: {
  socketPath: string;
  broker: {
    handle(request: ScopeRuntimeBrokerRequest): Promise<ScopeRuntimeBrokerResponse>;
    close(): Promise<void> | void;
  };
  /**
   * Lets the registry that owns a frame's runtime handle take the whole frame
   * (bot workloads). Returns undefined to use the shared broker path; a
   * routed handler resolving undefined drops the connection.
   */
  routeFrame?(raw: unknown, signal: AbortSignal): Promise<Record<string, unknown> | undefined> | undefined;
  /** Explicitly registered Bot routes only; generic/shared frame caps remain unchanged. */
  botImageFrames?: boolean;
  maxConnections?: number;
  requestTimeoutMs?: number;
  /**
   * Idle timeout once a frame is routed. A routed handler bounds its own work
   * (a background model call may wait up to ten minutes for funded capacity).
   */
  routedRequestTimeoutMs?: number;
}) {
  const maxConnections = Math.max(1, Math.min(
    Math.trunc(options.maxConnections ?? MAX_BROKER_CONNECTIONS),
    MAX_BROKER_CONNECTIONS,
  ));
  const requestTimeoutMs = Math.max(1, Math.min(
    Math.trunc(options.requestTimeoutMs ?? 35_000),
    60_000,
  ));
  const routedRequestTimeoutMs = Math.max(1, Math.min(
    Math.trunc(options.routedRequestTimeoutMs ?? MAX_ROUTED_REQUEST_TIMEOUT_MS),
    MAX_ROUTED_REQUEST_TIMEOUT_MS,
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
    const transport = new AbortController();
    let input = "";
    let rejected = false;
    let started = false;
    let openRequest = false;
    socket.setEncoding("utf8");
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    socket.once("error", (error: unknown) => {
      console.warn("[collaboration] scope broker socket failed:",
        error instanceof Error ? error.name : "UnknownError");
    });
    socket.once("close", () => { sockets.delete(socket); transport.abort(new Error('Inference transport closed')); });
    socket.on("data", (chunk) => {
      if (rejected) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (started) {
        if (text.trim()) socket.destroy();
        return;
      }
      input += text;
      if (Buffer.byteLength(input, "utf8") > (options.botImageFrames ? BOT_IMAGE_INFERENCE_FRAME_MAX_BYTES : MAX_REQUEST_FRAME_BYTES)) {
        rejected = true;
        input = "";
        socket.destroy();
        return;
      }
      // Streaming and explicitly opted-in routine calls retain a cancellable write direction.
      // Existing non-routine/control frames still require their original EOF.
      const newline = input.indexOf('\n');
      if (newline >= 0) {
        try {
          const raw: unknown = JSON.parse(input.slice(0, newline));
          const candidate = ScopeRuntimeBotInferenceRequestSchema.safeParse(raw);
          const tool = BotBrokerRequestSchema.safeParse(raw);
          if (candidate.success && candidate.data.responseMode === 'stream'
            || tool.success && tool.data.action === "bot.tool" && tool.data.transport === "live") {
            if (input.slice(newline + 1).trim()) { rejected = true; socket.destroy(); return; }
            openRequest = true;
            dispatch();
          }
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) {
            console.warn('[scope-runtime] stream request validation failed:', error instanceof Error ? error.name : 'UnknownError');
            socket.destroy();
          }
        }
      }
    });
    socket.once("end", () => {
      if (openRequest) {
        transport.abort(new Error('Live broker consumer disconnected'));
        socket.destroy();
      } else dispatch();
    });
    function dispatch(): void {
      if (started) return;
      started = true;
      if (closed || rejected) {
        socket.destroy();
        return;
      }
      const operation = (async () => {
        try {
          const frames = input.split("\n").filter((frame) => frame.trim().length > 0);
          if (frames.length !== 1) {
            socket.destroy();
            return;
          }
          const raw: unknown = JSON.parse(frames[0]!);
          const live = BotBrokerRequestSchema.safeParse(raw);
          // A live frame without its newline terminator is truncated, never legacy EOF admission.
          if (live.success && live.data.action === "bot.tool" && live.data.transport === "live" && !openRequest) { socket.destroy(); return; }
          if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_FRAME_BYTES
            && (!options.botImageFrames || !ScopeRuntimeBotInferenceRequestSchema.safeParse(raw).success)) { socket.destroy(); return; }
          input = '';
          const routed = options.routeFrame?.(raw, transport.signal);
          let frame: string;
          let maxResponseFrameBytes = MAX_RESPONSE_FRAME_BYTES;
          if (routed) {
            socket.setTimeout(routedRequestTimeoutMs);
            const response = await routed;
            if (!response) {
              socket.destroy();
              return;
            }
            if (isInferenceStream(response)) {
              const request = ScopeRuntimeBotInferenceRequestSchema.safeParse(raw);
              if (!request.success || request.data.responseMode !== 'stream' || request.data.requestId !== response.requestId) {
                socket.destroy(); return;
              }
              await writeInferenceStream(socket, response, transport.signal);
              return;
            }
            if (ScopeRuntimeBotInferenceRequestSchema.safeParse(raw).success) {
              frame = `${JSON.stringify(ScopeRuntimeBrokerResponseSchema.parse(response))}\n`;
              maxResponseFrameBytes = INFERENCE_RESPONSE_FRAME_MAX_BYTES;
            } else {
              frame = `${JSON.stringify(response)}\n`;
            }
          } else {
            const request = ScopeRuntimeBrokerRequestSchema.parse(raw);
            const response = await options.broker.handle(request);
            frame = `${JSON.stringify(ScopeRuntimeBrokerResponseSchema.parse(response))}\n`;
            if (request.action !== "egress.fetch") maxResponseFrameBytes = INFERENCE_RESPONSE_FRAME_MAX_BYTES;
          }
          if (Buffer.byteLength(frame, "utf8") > maxResponseFrameBytes) {
            socket.destroy();
            return;
          }
          if (!closed && !socket.destroyed) socket.end(frame);
          else socket.destroy();
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
            console.warn("[collaboration] scope broker request failed:",
              error instanceof Error ? error.name : "UnknownError");
          }
          socket.destroy();
        }
      })();
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch((error: unknown) => {
        console.warn("[collaboration] scope broker request cleanup failed:",
          error instanceof Error ? error.name : "UnknownError");
      });
    }
  }

  return {
    async start(): Promise<void> {
      if (closed || server) throw new Error("Scope broker server cannot start");
      await removeBrokerSocket(options.socketPath);
      const candidate = createServer({ allowHalfOpen: true }, accept);
      server = candidate;
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once("error", reject);
          candidate.listen(options.socketPath, resolve);
        });
        // Workloads use systemd DynamicUser, so filesystem ownership cannot be
        // assigned ahead of launch. Authorization still requires an active,
        // unpredictable runtime handle and current execution generation.
        await chmod(options.socketPath, 0o666);
      } catch (error: unknown) {
        server = undefined;
        candidate.close();
        throw error;
      }
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
      await options.broker.close();
      try {
        const entry = await lstat(options.socketPath);
        if (entry.isSocket() && !entry.isSymbolicLink()) await unlink(options.socketPath);
      } catch (error: unknown) {
        if (!notFound(error)) {
          console.warn("[collaboration] scope broker socket cleanup failed:",
            error instanceof Error ? error.name : "UnknownError");
        }
      }
    },
  };
}
