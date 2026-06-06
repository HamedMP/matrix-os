import { connect, type Socket } from "node:net";
import { z } from "zod/v4";

export const FORWARD_WS_MAX_CONTROL_BYTES = 2048;
export const FORWARD_WS_MAX_FRAME_BYTES = 64 * 1024;
export const FORWARD_WS_IDLE_TIMEOUT_MS = 60_000;
export const FORWARD_WS_MAX_CONNECTIONS = 100;

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
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

interface ForwardWsMessageEvent {
  data: unknown;
}

interface ForwardConnectionState {
  socket: Socket;
  ws: ForwardWs;
  opened: boolean;
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

export function createForwardTunnelHub(options: ForwardTunnelHubOptions = {}): ForwardTunnelHub {
  const dial = options.dial ?? defaultDialer;
  const maxConnections = options.maxConnections ?? FORWARD_WS_MAX_CONNECTIONS;
  const maxFrameBytes = options.maxFrameBytes ?? FORWARD_WS_MAX_FRAME_BYTES;
  const maxControlBytes = options.maxControlBytes ?? FORWARD_WS_MAX_CONTROL_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? FORWARD_WS_IDLE_TIMEOUT_MS;
  const active = new Set<ForwardConnectionState>();

  function createHandler() {
    let state: ForwardConnectionState | null = null;

    const cleanup = () => {
      const current = state;
      if (!current || current.closed) {
        return;
      }
      current.closed = true;
      clearTimeout(current.idleTimer);
      active.delete(current);
      current.socket.removeAllListeners();
      current.socket.destroy();
      closeWs(current.ws);
      state = null;
    };

    const touch = () => {
      if (!state) {
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
      sendError(ws, code);
      cleanup();
      if (!state) {
        closeWs(ws);
      }
    };

    const openTarget = (ws: ForwardWs, message: ForwardOpenMessage) => {
      if (state) {
        fail(ws, "invalid_request");
        return;
      }
      if (active.size >= maxConnections) {
        sendError(ws, "connection_limit");
        closeWs(ws);
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
        closeWs(ws);
        return;
      }

      let socket: Socket;
      try {
        socket = dial(target);
      } catch (err: unknown) {
        console.warn("[forward/ws] loopback dial failed:", err instanceof Error ? err.message : String(err));
        sendError(ws, "dial_failed");
        closeWs(ws);
        return;
      }
      state = {
        socket,
        ws,
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
          } catch (err: unknown) {
            if (err instanceof Error) {
              console.warn("[forward/ws] send failed:", err.message);
            }
            cleanup();
            return;
          }
        }
      });
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
        if (active.size >= maxConnections) {
          sendError(ws, "connection_limit");
          closeWs(ws);
        }
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
          state.socket.write(chunk);
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
        cleanup();
      },
      onClose: cleanup,
      onError: cleanup,
    };
  }

  return {
    createHandler,
    async close() {
      for (const connection of Array.from(active)) {
        sendJson(connection.ws, { type: "close" });
        clearTimeout(connection.idleTimer);
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
