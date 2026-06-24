import { GatewayClient } from "@/lib/gateway-client";
import type { MobileTerminalSession } from "@/lib/terminal-state";
export { isSafeSessionId, parseTerminalSessions } from "@/lib/terminal-state";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
export const MOBILE_TERMINAL_KEEPALIVE_MS = 30_000;

export type TerminalClientFrame =
  | { type: "attach"; sessionId?: string; cwd?: string; fromSeq?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "detach" }
  | { type: "destroy" };

export type TerminalServerFrame =
  | { type: "attached"; sessionId: string; cwd?: string; replay?: string }
  | { type: "output"; data: string }
  | { type: "replay-start"; fromSeq?: number; toSeq?: number }
  | { type: "replay-end"; nextSeq?: number }
  | { type: "exit"; exitCode?: number | null }
  | { type: "error"; message?: string };

export interface MobileTerminalConnectOptions {
  sessionId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  fromSeq?: number;
  onMessage: (frame: TerminalServerFrame) => void;
  onStatus?: (status: "connecting" | "open" | "closed" | "error") => void;
}

export class MobileTerminalClient {
  constructor(private readonly gateway: GatewayClient) {}

  async listSessions(): Promise<MobileTerminalSession[]> {
    return this.gateway.getTerminalSessions();
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.gateway.deleteTerminalSession(sessionId);
  }

  async connect(options: MobileTerminalConnectOptions): Promise<MobileTerminalConnection | null> {
    const token = await this.gateway.getWsToken();
    this.gateway.setWebSocketToken(token);
    const ws = this.gateway.openTerminalWebSocket(token);
    const connection = new MobileTerminalConnection(ws, options);
    connection.attach();
    return connection;
  }
}

export class MobileTerminalConnection {
  private readonly attachFrame: TerminalClientFrame;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: MobileTerminalConnectOptions,
  ) {
    this.attachFrame = compactFrame({
      type: "attach",
      sessionId: options.sessionId,
      cwd: options.cwd,
      fromSeq: options.fromSeq,
    });
  }

  attach(): void {
    this.options.onStatus?.("connecting");

    this.ws.onopen = () => {
      if (this.closed) return;
      this.attached = true;
      this.options.onStatus?.("open");
      this.sendFrame(this.attachFrame);
      if (this.options.cols && this.options.rows) {
        this.resize(this.options.cols, this.options.rows);
      }
      this.startKeepalive();
    };

    this.ws.onmessage = (event) => {
      const frame = parseTerminalServerFrame(event.data);
      if (frame) this.options.onMessage(frame);
    };

    this.ws.onerror = () => {
      this.options.onStatus?.("error");
    };

    this.ws.onclose = () => {
      this.attached = false;
      this.closed = true;
      this.stopKeepalive();
      this.options.onStatus?.("closed");
    };
  }

  sendInput(data: string): boolean {
    return this.sendFrame({ type: "input", data });
  }

  resize(cols: number, rows: number): boolean {
    return this.sendFrame({
      type: "resize",
      cols: clampInteger(cols, 1, 500),
      rows: clampInteger(rows, 1, 200),
    });
  }

  detach(): boolean {
    const sent = this.sendFrame({ type: "detach" });
    this.close();
    return sent;
  }

  destroy(): boolean {
    const sent = this.sendFrame({ type: "destroy" });
    this.close();
    return sent;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.attached = false;
    this.stopKeepalive();
    if (this.ws.readyState !== WS_CONNECTING && this.ws.readyState !== WS_OPEN) return;
    this.ws.close();
  }

  private sendFrame(frame: TerminalClientFrame): boolean {
    if (this.closed) return false;
    if (this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      this.sendFrame({ type: "ping" });
    }, MOBILE_TERMINAL_KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}

export function buildTerminalWebSocketUrl(baseUrl: string, token?: string | null): string {
  const url = `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/terminal`;
  if (!token) return url;
  return `${url}?token=${encodeURIComponent(token)}`;
}

function parseTerminalServerFrame(data: unknown): TerminalServerFrame | null {
  if (typeof data !== "string") return null;
  try {
    const frame = JSON.parse(data) as TerminalServerFrame;
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return null;
    if (frame.type === "attached" && typeof frame.sessionId === "string") return frame;
    if (frame.type === "output" && typeof frame.data === "string") return frame;
    if (frame.type === "replay-start" || frame.type === "replay-end" || frame.type === "exit") return frame;
    if (frame.type === "error") return { type: "error", message: typeof frame.message === "string" ? frame.message : undefined };
    return null;
  } catch {
    return null;
  }
}

function compactFrame<T extends Record<string, unknown>>(frame: T): T {
  return Object.fromEntries(
    Object.entries(frame).filter(([, value]) => value !== undefined),
  ) as T;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
