import WebSocket from "ws";
import type { SyncEvent } from "./types.js";

export interface WsClientOptions {
  gatewayUrl: string;
  token: string;
  peerId: string;
  onEvent: (event: SyncEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

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

    this.ws = new WebSocket(`${wsUrl}/ws`, {
      headers: { authorization: `Bearer ${this.options.token}` },
    });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.startPing();
      this.sendSubscribe();
      this.options.onConnect?.();
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type?.startsWith("sync:")) {
          this.options.onEvent(msg as SyncEvent);
        }
      } catch {
        // Ignore unparseable messages
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
    this.ws?.send(
      JSON.stringify({
        type: "sync:subscribe",
        peerId: this.options.peerId,
      }),
    );
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
