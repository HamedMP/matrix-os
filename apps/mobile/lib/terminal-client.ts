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
  | { type: "output"; data: string; seq?: number }
  | { type: "replay-start"; fromSeq?: number; toSeq?: number }
  | { type: "replay-end"; toSeq?: number }
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

  attach(): void {
    this.options.onStatus?.("connecting");

    this.ws.onopen = () => {
      this.attached = true;
      this.options.onStatus?.("open");
      this.sendFrame(this.attachFrame);
      if (this.options.cols && this.options.rows) {
        this.resize(this.options.cols, this.options.rows);
      }
    };

    this.ws.onmessage = (event) => {
      const frame = parseTerminalServerFrame(event.data);
      if (frame) this.options.onMessage(frame);
    };

    this.ws.onerror = () => {
      this.options.onStatus?.("error");
    };

    this.ws.onclose = () => {
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
    if (this.ws.readyState !== WS_CONNECTING && this.ws.readyState !== WS_OPEN) return;
    this.attached = false;
    this.ws.close();
  }

  private sendFrame(frame: TerminalClientFrame): boolean {
    if (this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }
}

export function buildTerminalWebSocketUrl(baseUrl: string, token?: string | null): string {
  const url = `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/terminal`;
  if (!token) return url;
  return `${url}?token=${encodeURIComponent(token)}`;
}

function parseTerminalServerFrame(data: unknown): TerminalServerFrame | null {
  if (typeof data !== "string") return null;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(data) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return null;
  if (frame.type === "attached" && typeof frame.sessionId === "string") {
    return {
      type: "attached",
      sessionId: frame.sessionId,
      cwd: typeof frame.cwd === "string" ? frame.cwd : undefined,
      replay: typeof frame.replay === "string" ? frame.replay : undefined,
    };
  }
  if (frame.type === "output" && typeof frame.data === "string") {
    return {
      type: "output",
      data: frame.data,
      seq: parseTerminalSeq(frame.seq),
    };
  }
  if (frame.type === "replay-start") {
    return {
      type: "replay-start",
      fromSeq: parseTerminalSeq(frame.fromSeq),
      toSeq: parseTerminalSeq(frame.toSeq),
    };
  }
  if (frame.type === "replay-end") {
    return {
      type: "replay-end",
      toSeq: parseTerminalSeq(frame.toSeq),
    };
  }
  if (frame.type === "exit") {
    return {
      type: "exit",
      exitCode: parseTerminalExitCode(frame.exitCode ?? frame.code),
    };
  }
  if (frame.type === "error") return { type: "error", message: typeof frame.message === "string" ? frame.message : undefined };
  return null;
}

function parseTerminalSeq(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function parseTerminalExitCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  return value;
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
