import { connect, type Socket } from "node:net";
import { z } from "zod/v4";

export const FORWARD_WS_MAX_CONTROL_BYTES = 2048;
export const FORWARD_WS_MAX_FRAME_BYTES = 64 * 1024;
export const FORWARD_WS_IDLE_TIMEOUT_MS = 60_000;
export const FORWARD_WS_MAX_CONNECTIONS = 100;
const FORWARD_WS_MAX_PENDING_SOCKET_WRITE_BYTES = 256 * 1024;
const FORWARD_WS_BUFFER_HIGH_WATER_BYTES = 256 * 1024;
const FORWARD_WS_BUFFER_LOW_WATER_BYTES = 128 * 1024;
const FORWARD_WS_BACKPRESSURE_POLL_MS = 10;

const ForwardPortSchema = z.number().int().min(1).max(65_535);
const LoopbackHostSchema = z.union([
  z.literal("127.0.0.1"),
  z.literal("::1"),
  z.literal("localhost"),
]);

export const ForwardOpenMessageSchema = z.object({
  type: z.literal("open"),
  host: LoopbackHostSchema,
  port: ForwardPortSchema,
});

const ForwardControlMessageSchema = z.discriminatedUnion("type", [
  ForwardOpenMessageSchema,
  z.object({ type: z.literal("end") }),
  z.object({ type: z.literal("close") }),
]);

export type ForwardOpenMessage = z.infer<typeof ForwardOpenMessageSchema>;
export type ForwardTarget = { host: "127.0.0.1" | "::1"; port: number };

export interface ForwardDialer {
  (target: ForwardTarget): Socket;
}

interface ForwardWs {
  bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

interface ForwardWsMessageEvent {
  data: unknown;
}

interface ForwardConnectionState {
  socket: Socket;
  ws: ForwardWs;
  socketWriter: { write(chunk: Buffer): void; close(): void };
  wsBackpressure: { afterSend(): void; close(): void };
  opened: boolean;
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
}

interface PendingForwardConnectionState {
  ws: ForwardWs;
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface ForwardTunnelHub {
  createHandler(): {
    onOpen?(evt: unknown, ws: ForwardWs): void;
    onMessage?(evt: ForwardWsMessageEvent, ws: ForwardWs): void;
    onClose?(): void;
    onError?(): void;
  };
  close(): Promise<void>;
  activeConnectionsForTest(): ForwardConnectionState[];
}

export interface ForwardTunnelHubOptions {
  dial?: ForwardDialer;
  maxConnections?: number;
  maxFrameBytes?: number;
  maxControlBytes?: number;
  idleTimeoutMs?: number;
}

function forwardError(code: string): Error & { code: string } {
  return Object.assign(new Error("Request failed"), { code });
}

function sendJson(ws: ForwardWs, frame: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.warn("[forward/ws] send failed:", err.message);
    }
  }
}

function sendError(ws: ForwardWs, code: string): void {
  sendJson(ws, { type: "error", code, message: "Request failed" });
}

function closeWs(ws: ForwardWs): void {
  try {
    ws.close();
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.warn("[forward/ws] close failed:", err.message);
    }
  }
}

export function normalizeForwardTarget(host: string, port: number): ForwardTarget {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw forwardError("invalid_request");
  }
  if (host === "localhost" || host === "127.0.0.1") {
    return { host: "127.0.0.1", port };
  }
  if (host === "::1") {
    return { host: "::1", port };
  }
  throw forwardError("target_forbidden");
}

function bufferFromMessage(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(String(data));
}

function uint8ArrayFromBuffer(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buffer.byteLength);
  out.set(buffer);
  return out;
}

function isBinaryMessage(data: unknown): boolean {
  return Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

function defaultDialer(target: ForwardTarget): Socket {
  return connect({ host: target.host, port: target.port });
}

function createBoundedSocketWriter(
  socket: Socket,
  maxPendingBytes: number,
  onOverflow: () => void,
): { write(chunk: Buffer): void; close(): void } {
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let waitingDrain = false;
  let closed = false;

  const enqueue = (chunk: Buffer) => {
    pendingBytes += chunk.byteLength;
    if (pendingBytes > maxPendingBytes) {
      onOverflow();
      return;
    }
    pending.push(Buffer.from(chunk));
  };

  const flush = () => {
    if (closed) {
      return;
    }
    waitingDrain = false;
    while (pending.length > 0) {
      const next = pending.shift()!;
      pendingBytes -= next.byteLength;
      if (!socket.write(next)) {
        waitingDrain = true;
        return;
      }
    }
  };

  socket.on("drain", flush);

  return {
    write(chunk: Buffer) {
      if (closed || socket.destroyed) {
        return;
      }
      if (waitingDrain || pending.length > 0) {
        enqueue(chunk);
        return;
      }
      if (!socket.write(chunk)) {
        waitingDrain = true;
      }
    },
    close() {
      closed = true;
      pending.splice(0);
      pendingBytes = 0;
      socket.off("drain", flush);
    },
  };
}

function createWsBackpressureMonitor(
  source: Socket,
  ws: ForwardWs,
): { afterSend(): void; close(): void } {
  let closed = false;
  let paused = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const bufferedBytes = () => typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;

  const clearPoll = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const schedulePoll = () => {
    if (closed || pollTimer) {
      return;
    }
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (closed) {
        return;
      }
      if (bufferedBytes() <= FORWARD_WS_BUFFER_LOW_WATER_BYTES) {
        if (paused && !source.destroyed) {
          source.resume();
        }
        paused = false;
        return;
      }
      schedulePoll();
    }, FORWARD_WS_BACKPRESSURE_POLL_MS);
    pollTimer.unref?.();
  };

  return {
    afterSend() {
      if (closed || bufferedBytes() <= FORWARD_WS_BUFFER_HIGH_WATER_BYTES) {
        return;
      }
      if (!source.isPaused()) {
        source.pause();
        paused = true;
      }
      schedulePoll();
    },
    close() {
      closed = true;
      clearPoll();
    },
  };
}

export function createForwardTunnelHub(options: ForwardTunnelHubOptions = {}): ForwardTunnelHub {
  const dial = options.dial ?? defaultDialer;
  const maxConnections = options.maxConnections ?? FORWARD_WS_MAX_CONNECTIONS;
  const maxFrameBytes = options.maxFrameBytes ?? FORWARD_WS_MAX_FRAME_BYTES;
  const maxControlBytes = options.maxControlBytes ?? FORWARD_WS_MAX_CONTROL_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? FORWARD_WS_IDLE_TIMEOUT_MS;
  const active = new Set<ForwardConnectionState>();
  const pending = new Set<PendingForwardConnectionState>();

  function createHandler() {
    let state: ForwardConnectionState | null = null;
    let pendingState: PendingForwardConnectionState | null = null;

    const cleanupPending = (close = true) => {
      const current = pendingState;
      if (!current) {
        return;
      }
      if (current.closed) {
        pending.delete(current);
        pendingState = null;
        return;
      }
      current.closed = true;
      clearTimeout(current.idleTimer);
      pending.delete(current);
      pendingState = null;
      if (close) {
        closeWs(current.ws);
      }
    };

    const cleanup = () => {
      const current = state;
      if (!current || current.closed) {
        return;
      }
      current.closed = true;
      clearTimeout(current.idleTimer);
      active.delete(current);
      current.socketWriter.close();
      current.wsBackpressure.close();
      current.socket.removeAllListeners();
      current.socket.destroy();
      closeWs(current.ws);
      state = null;
    };

    const touchPending = () => {
      if (!pendingState || pendingState.closed) {
        return;
      }
      clearTimeout(pendingState.idleTimer);
      pendingState.idleTimer = setTimeout(() => {
        if (pendingState && !pendingState.closed) {
          sendError(pendingState.ws, "idle_timeout");
        }
        cleanupPending();
      }, idleTimeoutMs);
      pendingState.idleTimer.unref?.();
    };

    const touch = () => {
      if (!state) {
        touchPending();
        return;
      }
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        if (state) {
          sendError(state.ws, "idle_timeout");
        }
        cleanup();
      }, idleTimeoutMs);
      state.idleTimer.unref?.();
    };

    const fail = (ws: ForwardWs, code: string) => {
      const hadOpenState = state !== null;
      const hadPendingState = pendingState !== null;
      sendError(ws, code);
      cleanup();
      if (hadPendingState) {
        cleanupPending();
        return;
      }
      if (!hadOpenState) {
        closeWs(ws);
      }
    };

    const openTarget = (ws: ForwardWs, message: ForwardOpenMessage) => {
      if (state) {
        fail(ws, "invalid_request");
        return;
      }
      const pendingReservation = pendingState ? 1 : 0;
      if (active.size + pending.size - pendingReservation >= maxConnections) {
        sendError(ws, "connection_limit");
        if (pendingState) {
          cleanupPending();
        } else {
          closeWs(ws);
        }
        return;
      }

      let target: ForwardTarget;
      try {
        target = normalizeForwardTarget(message.host, message.port);
      } catch (err: unknown) {
        const code = err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : "invalid_request";
        sendError(ws, code);
        if (pendingState) {
          cleanupPending();
        } else {
          closeWs(ws);
        }
        return;
      }

      let socket: Socket;
      try {
        socket = dial(target);
      } catch (err: unknown) {
        console.warn("[forward/ws] loopback dial failed:", err instanceof Error ? err.message : String(err));
        sendError(ws, "dial_failed");
        if (pendingState) {
          cleanupPending();
        } else {
          closeWs(ws);
        }
        return;
      }
      cleanupPending(false);
      let cleanupConnection = () => {};
      const socketWriter = createBoundedSocketWriter(socket, FORWARD_WS_MAX_PENDING_SOCKET_WRITE_BYTES, () => {
        sendError(ws, "buffer_overflow");
        cleanupConnection();
      });
      const wsBackpressure = createWsBackpressureMonitor(socket, ws);
      state = {
        socket,
        ws,
        socketWriter,
        wsBackpressure,
        opened: false,
        closed: false,
        idleTimer: setTimeout(() => {
          sendError(ws, "idle_timeout");
          cleanup();
        }, idleTimeoutMs),
      };
      state.idleTimer.unref?.();
      active.add(state);

      socket.on("connect", () => {
        if (!state || state.closed) {
          return;
        }
        state.opened = true;
        touch();
        sendJson(ws, { type: "ready" });
      });
      socket.on("data", (chunk: Buffer) => {
        if (!state || state.closed) {
          return;
        }
        touch();
        for (let offset = 0; offset < chunk.byteLength; offset += maxFrameBytes) {
          try {
            ws.send(uint8ArrayFromBuffer(Buffer.from(chunk.subarray(offset, offset + maxFrameBytes))));
            state.wsBackpressure.afterSend();
          } catch (err: unknown) {
            if (err instanceof Error) {
              console.warn("[forward/ws] send failed:", err.message);
            }
            cleanup();
            return;
          }
        }
      });
      cleanupConnection = cleanup;
      socket.on("end", () => {
        sendJson(ws, { type: "end" });
        cleanup();
      });
      socket.on("close", cleanup);
      socket.on("error", (err: unknown) => {
        console.warn("[forward/ws] loopback dial/socket failed:", err instanceof Error ? err.message : String(err));
        sendError(ws, state?.opened ? "socket_failed" : "dial_failed");
        cleanup();
      });
    };

    return {
      onOpen(_evt: unknown, ws: ForwardWs) {
        if (state || pendingState) {
          return;
        }
        if (active.size + pending.size >= maxConnections) {
          sendError(ws, "connection_limit");
          closeWs(ws);
          return;
        }
        pendingState = {
          ws,
          closed: false,
          idleTimer: setTimeout(() => {
            if (pendingState && !pendingState.closed) {
              sendError(ws, "idle_timeout");
            }
            cleanupPending();
          }, idleTimeoutMs),
        };
        pendingState.idleTimer.unref?.();
        pending.add(pendingState);
      },
      onMessage(evt: ForwardWsMessageEvent, ws: ForwardWs) {
        if (isBinaryMessage(evt.data)) {
          const chunk = bufferFromMessage(evt.data);
          if (!state?.opened) {
            fail(ws, "invalid_request");
            return;
          }
          if (chunk.byteLength > maxFrameBytes) {
            fail(ws, "frame_too_large");
            return;
          }
          touch();
          state.socketWriter.write(chunk);
          return;
        }

        const raw = String(evt.data);
        if (Buffer.byteLength(raw, "utf8") > maxControlBytes) {
          fail(ws, "invalid_request");
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err: unknown) {
          if (!(err instanceof SyntaxError)) {
            console.warn("[forward/ws] control parse failed:", err);
          }
          fail(ws, "invalid_request");
          return;
        }

        const result = ForwardControlMessageSchema.safeParse(parsed);
        if (!result.success) {
          const code =
            parsed &&
            typeof parsed === "object" &&
            "type" in parsed &&
            (parsed as { type?: unknown }).type === "open" &&
            "host" in parsed &&
            typeof (parsed as { host?: unknown }).host === "string" &&
            !LoopbackHostSchema.safeParse((parsed as { host: string }).host).success
              ? "target_forbidden"
              : "invalid_request";
          fail(ws, code);
          return;
        }

        touch();
        if (result.data.type === "open") {
          openTarget(ws, result.data);
          return;
        }
        sendJson(ws, { type: result.data.type });
        if (state) {
          cleanup();
        } else {
          cleanupPending();
        }
      },
      onClose() {
        cleanup();
        cleanupPending(false);
      },
      onError() {
        cleanup();
        cleanupPending(false);
      },
    };
  }

  return {
    createHandler,
    async close() {
      for (const connection of Array.from(pending)) {
        sendJson(connection.ws, { type: "close" });
        clearTimeout(connection.idleTimer);
        connection.closed = true;
        closeWs(connection.ws);
        pending.delete(connection);
      }
      for (const connection of Array.from(active)) {
        sendJson(connection.ws, { type: "close" });
        clearTimeout(connection.idleTimer);
        connection.closed = true;
        connection.socketWriter.close();
        connection.wsBackpressure.close();
        connection.socket.removeAllListeners();
        connection.socket.destroy();
        closeWs(connection.ws);
        active.delete(connection);
      }
    },
    activeConnectionsForTest() {
      return Array.from(active);
    },
  };
}
