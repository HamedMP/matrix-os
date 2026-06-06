import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocket as DefaultWebSocket } from "ws";

export interface ForwardSpec {
  localHost: "127.0.0.1";
  localPort: number;
  remoteHost: "127.0.0.1" | "::1" | "localhost";
  remotePort: number;
}

export interface PortForwardEventData {
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  connectionId?: number;
  code?: string;
}

export interface PortForwardHandle extends ForwardSpec {
  ready: Promise<void>;
  closed: Promise<void>;
  close(): Promise<void>;
}

interface ForwardWebSocket {
  readyState: number;
  binaryType?: string;
  send(data: string | Buffer): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): ForwardWebSocket;
  off?(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): ForwardWebSocket;
}

export interface StartPortForwardOptions extends ForwardSpec {
  gatewayUrl: string;
  token: string;
  maxConnections?: number;
  maxFrameBytes?: number;
  idleTimeoutMs?: number;
  WebSocketImpl?: new (url: string, options?: { headers?: Record<string, string> }) => ForwardWebSocket;
  onEvent?: (type: string, data: PortForwardEventData) => void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_PENDING_TCP_BYTES = 256 * 1024;

function invalidForwardSpec(): Error & { code: string } {
  return Object.assign(new Error("Request failed"), { code: "invalid_forward_spec" });
}

function validatePort(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw invalidForwardSpec();
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw invalidForwardSpec();
  }
  return parsed;
}

function parseExplicitSpec(spec: string): { localPort: number; remoteHost: ForwardSpec["remoteHost"]; remotePort: number } {
  const bracketedIpv6 = spec.match(/^(\d+):\[::1\]:(\d+)$/);
  if (bracketedIpv6) {
    return {
      localPort: validatePort(bracketedIpv6[1]!),
      remoteHost: "::1",
      remotePort: validatePort(bracketedIpv6[2]!),
    };
  }

  const parts = spec.split(":");
  if (parts.length !== 3) {
    throw invalidForwardSpec();
  }
  const remoteHost = parts[1]!;
  if (!LOOPBACK_HOSTS.has(remoteHost)) {
    throw invalidForwardSpec();
  }
  return {
    localPort: validatePort(parts[0]!),
    remoteHost: remoteHost as ForwardSpec["remoteHost"],
    remotePort: validatePort(parts[2]!),
  };
}

export function parseForwardSpec(spec: string): ForwardSpec {
  const trimmed = spec.trim();
  if (/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    const port = validatePort(trimmed);
    return {
      localHost: "127.0.0.1",
      localPort: port,
      remoteHost: "127.0.0.1",
      remotePort: port,
    };
  }
  const explicit = parseExplicitSpec(trimmed);
  return {
    localHost: "127.0.0.1",
    ...explicit,
  };
}

export function createForwardWebSocketUrl(gatewayUrl: string): string {
  const url = new URL("/ws/forward", gatewayUrl.replace(/\/+$/, ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function bufferFromWsMessage(data: unknown): Buffer {
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

export async function startPortForward(options: StartPortForwardOptions): Promise<PortForwardHandle> {
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const WebSocketImpl = options.WebSocketImpl ?? (DefaultWebSocket as unknown as StartPortForwardOptions["WebSocketImpl"]);
  if (!WebSocketImpl) {
    throw Object.assign(new Error("Request failed"), { code: "websocket_unavailable" });
  }
  const eventData = (connectionId?: number, code?: string): PortForwardEventData => ({
    localHost: options.localHost,
    localPort: options.localPort,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    connectionId,
    code,
  });

  let nextConnectionId = 1;
  const active = new Set<{
    tcp: Socket;
    ws: ForwardWebSocket;
    idleTimer: ReturnType<typeof setTimeout>;
  }>();
  const server = createServer((tcp) => {
    if (active.size >= maxConnections) {
      options.onEvent?.("connection_rejected", {
        ...eventData(undefined, "connection_limit"),
      });
      tcp.destroy();
      return;
    }

    const connectionId = nextConnectionId++;
    const ws = new WebSocketImpl(createForwardWebSocketUrl(options.gatewayUrl), {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    ws.binaryType = "arraybuffer";
    let remoteReady = false;
    let pendingTcpBytes = 0;
    const pendingTcpChunks: Buffer[] = [];
    const state = {
      tcp,
      ws,
      idleTimer: setTimeout(() => {
        options.onEvent?.("connection_idle_timeout", eventData(connectionId, "idle_timeout"));
        cleanup();
      }, idleTimeoutMs),
    };
    state.idleTimer.unref?.();
    active.add(state);
    options.onEvent?.("connection_open", eventData(connectionId));

    const touch = () => {
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        options.onEvent?.("connection_idle_timeout", {
          ...eventData(connectionId, "idle_timeout"),
        });
        cleanup();
      }, idleTimeoutMs);
      state.idleTimer.unref?.();
    };

    const cleanup = () => {
      if (!active.delete(state)) {
        return;
      }
      clearTimeout(state.idleTimer);
      tcp.off("data", onTcpData);
      tcp.off("close", cleanup);
      tcp.off("error", onTcpError);
      ws.off?.("open", onWsOpen);
      ws.off?.("message", onWsMessage);
      ws.off?.("close", cleanup);
      ws.off?.("error", onWsError);
      if (!tcp.destroyed) {
        tcp.destroy();
      }
      try {
        ws.close();
      } catch (err: unknown) {
        if (err instanceof Error) {
          options.onEvent?.("connection_error", eventData(connectionId, "close_failed"));
        }
      }
      options.onEvent?.("connection_close", eventData(connectionId));
    };

    const onTcpData = (chunk: Buffer) => {
      touch();
      if (chunk.byteLength > maxFrameBytes) {
        options.onEvent?.("connection_error", eventData(connectionId, "frame_too_large"));
        cleanup();
        return;
      }
      if (!remoteReady) {
        pendingTcpBytes += chunk.byteLength;
        if (pendingTcpBytes > MAX_PENDING_TCP_BYTES) {
          options.onEvent?.("connection_error", eventData(connectionId, "buffer_overflow"));
          cleanup();
          return;
        }
        pendingTcpChunks.push(Buffer.from(chunk));
        return;
      }
      try {
        ws.send(Buffer.from(chunk));
      } catch (err: unknown) {
        if (err instanceof Error) {
          options.onEvent?.("connection_error", eventData(connectionId, "send_failed"));
        }
        cleanup();
      }
    };

    const onTcpError = () => {
      options.onEvent?.("connection_error", eventData(connectionId, "tcp_failed"));
      cleanup();
    };

    const onWsOpen = () => {
      touch();
      try {
        ws.send(JSON.stringify({ type: "open", host: options.remoteHost, port: options.remotePort }));
      } catch (err: unknown) {
        if (err instanceof Error) {
          options.onEvent?.("connection_error", eventData(connectionId, "send_failed"));
        }
        cleanup();
      }
    };

    const onWsMessage = (data: unknown, isBinary?: unknown) => {
      touch();
      const binaryFrame =
        isBinary === true ||
        (isBinary === undefined && (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)));
      if (binaryFrame) {
        const chunk = bufferFromWsMessage(data);
        if (chunk.byteLength > maxFrameBytes) {
          options.onEvent?.("connection_error", eventData(connectionId, "frame_too_large"));
          cleanup();
          return;
        }
        tcp.write(chunk);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) {
          options.onEvent?.("connection_error", eventData(connectionId, "control_failed"));
        }
        cleanup();
        return;
      }
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        const type = (parsed as { type?: unknown }).type;
        if (type === "ready") {
          remoteReady = true;
          try {
            for (const pendingChunk of pendingTcpChunks.splice(0)) {
              ws.send(pendingChunk);
            }
          } catch (err: unknown) {
            if (err instanceof Error) {
              options.onEvent?.("connection_error", eventData(connectionId, "send_failed"));
            }
            cleanup();
            return;
          }
          pendingTcpBytes = 0;
          return;
        }
        if (type === "error") {
          const parsedRecord = parsed as Record<string, unknown>;
          const code = typeof parsedRecord.code === "string"
            ? parsedRecord.code
            : "forward_failed";
          options.onEvent?.("connection_error", eventData(connectionId, code));
        }
      }
      cleanup();
    };

    const onWsError = () => {
      options.onEvent?.("connection_error", eventData(connectionId, "websocket_failed"));
      cleanup();
    };

    tcp.on("data", onTcpData);
    tcp.on("close", cleanup);
    tcp.on("error", onTcpError);
    ws.on("open", onWsOpen);
    ws.on("message", onWsMessage);
    ws.on("close", cleanup);
    ws.on("error", onWsError);
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.localPort, options.localHost, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      options.localPort = address.port;
      options.onEvent?.("ready", eventData());
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => {
    server.once("close", resolve);
  });

  const closeServer = async () => {
    for (const state of Array.from(active)) {
      clearTimeout(state.idleTimer);
      state.tcp.destroy();
      try {
        state.ws.close();
      } catch (err: unknown) {
        if (err instanceof Error) {
          options.onEvent?.("connection_error", eventData(undefined, "close_failed"));
        }
      }
      active.delete(state);
    }
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err?: Error) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  };

  await ready;
  return {
    localHost: options.localHost,
    localPort: options.localPort,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    ready,
    closed,
    close: closeServer,
  };
}
