import { GatewayClient } from "@/lib/gateway-client";
import type { MobileTerminalSession } from "@/lib/terminal-state";
export { isSafeSessionId, parseTerminalSessions } from "@/lib/terminal-state";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type TerminalClientFrame =
  | { type: "attach"; sessionId?: string; cwd?: string; fromSeq?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
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
    await connection.attach();
    return connection;
  }
}

export class MobileTerminalConnection {
  private readonly attachFrame: TerminalClientFrame;
  private attached = false;

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

  attach(): Promise<void> {
    this.options.onStatus?.("connecting");

    this.ws.onmessage = (event) => {
      const frame = parseTerminalServerFrame(event.data);
      if (frame) this.options.onMessage(frame);
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let attachSent = false;
      const resolveAttach = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectAttach = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const handleOpen = () => {
        if (settled) return;
        if (!this.sendFrame(this.attachFrame)) {
          rejectAttach(new Error("Terminal connection opened before attach could be sent"));
          return;
        }
        this.attached = true;
        attachSent = true;
        if (this.options.cols && this.options.rows) {
          this.resize(this.options.cols, this.options.rows);
        }
        this.options.onStatus?.("open");
        resolveAttach();
      };
      this.ws.onopen = handleOpen;

      this.ws.onerror = () => {
        if (attachSent) this.options.onStatus?.("error");
        rejectAttach(new Error("Terminal connection failed before attach"));
      };

      this.ws.onclose = () => {
        if (!settled || attachSent) this.options.onStatus?.("closed");
        rejectAttach(new Error("Terminal connection closed before attach"));
      };

      if (this.ws.readyState === WS_OPEN) {
        handleOpen();
      }
    });
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
    const sent = this.attached ? this.sendFrame({ type: "detach" }) : false;
    this.close();
    return sent;
  }

  destroy(): boolean {
    const sent = this.attached ? this.sendFrame({ type: "destroy" }) : false;
    this.close();
    return sent;
  }

  close(): void {
    if (this.ws.readyState !== WS_CONNECTING && this.ws.readyState !== WS_OPEN) return;
    this.attached = false;
    this.ws.close();
  }

  private sendFrame(frame: TerminalClientFrame): boolean {
    if (this.ws.readyState !== WS_OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (err: unknown) {
      console.warn("[mobile] terminal websocket send failed", err instanceof Error ? err.name : typeof err);
      return false;
    }
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
