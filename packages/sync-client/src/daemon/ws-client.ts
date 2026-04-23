import { hostname } from "node:os";
import WebSocket, { type ClientOptions } from "ws";
import { z } from "zod/v4";
import type { SyncEvent } from "./types.js";

export interface WsClientOptions {
  gatewayUrl: string;
  token: string;
  peerId: string;
  hostname?: string;
  platform?: "darwin" | "linux" | "win32";
  clientVersion?: string;
  onEvent: (event: SyncEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
export const WS_HANDSHAKE_TIMEOUT_MS = 10_000;

const SyncEventMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sync:change"),
    path: z.string().min(1).max(1024),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    peerId: z.string().min(1).max(128),
    action: z.enum(["create", "update", "delete"]),
  }),
  z.object({
    type: z.literal("sync:conflict"),
    path: z.string().min(1).max(1024),
    localHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    remoteHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    conflictPath: z.string().min(1),
  }),
]);

export function parseSyncEventMessage(payload: string): SyncEvent | null {
  const msg = JSON.parse(payload) as { type?: string };
  if (!msg.type?.startsWith("sync:")) {
    return null;
  }
  return SyncEventMessageSchema.parse(msg);
}

export function buildSyncSubscribeMessage(
  options: Pick<WsClientOptions, "peerId" | "hostname" | "platform" | "clientVersion">,
): {
  type: "sync:subscribe";
  peerId: string;
  hostname: string;
  platform: "darwin" | "linux" | "win32";
  clientVersion: string;
} {
  return {
    type: "sync:subscribe",
    peerId: options.peerId,
    hostname: options.hostname ?? hostname(),
    platform: options.platform ?? (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"),
    clientVersion: options.clientVersion ?? process.env.MATRIXOS_SYNC_CLIENT_VERSION ?? "0.1.0",
  };
}

export function buildWebSocketOptions(
  token: string,
): ClientOptions {
  return {
    headers: { authorization: `Bearer ${token}` },
    handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
  };
}

export class SyncWsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: WsClientOptions) {}

  connect(): void {
    this.closed = false;
    this.doConnect();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "client shutdown");
      this.ws = null;
    }
  }

  private doConnect(): void {
    const wsUrl = this.options.gatewayUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");

    this.ws = new WebSocket(`${wsUrl}/ws`, buildWebSocketOptions(this.options.token));

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.startPing();
      this.sendSubscribe();
      this.options.onConnect?.();
    });

    this.ws.on("message", (data) => {
      try {
        const event = parseSyncEventMessage(data.toString());
        if (event) {
          this.options.onEvent(event);
        }
      } catch (err: unknown) {
        if (err instanceof SyntaxError) {
          this.options.onError?.(
            new Error("Received malformed sync message from gateway"),
          );
          return;
        }
        this.options.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });

    this.ws.on("close", () => {
      this.clearTimers();
      this.options.onDisconnect?.();
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.options.onError?.(err);
    });
  }

  private sendSubscribe(): void {
    this.ws?.send(JSON.stringify(buildSyncSubscribeMessage(this.options)));
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
