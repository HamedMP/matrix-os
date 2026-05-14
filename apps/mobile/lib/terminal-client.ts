import { GatewayClient } from "@/lib/gateway-client";
import type { MobileTerminalSession } from "@/lib/terminal-state";

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

type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (!token) {
      options.onStatus?.("error");
      return null;
    }
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
    if (!this.attached) return;
    this.attached = false;
    this.ws.close();
  }

  private sendFrame(frame: TerminalClientFrame): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }
}

export function parseTerminalSessions(value: unknown): MobileTerminalSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.sessionId !== "string" || !isSafeSessionId(candidate.sessionId)) {
      return [];
    }
    const session: MobileTerminalSession = {
      sessionId: candidate.sessionId,
      cwd: typeof candidate.cwd === "string" ? candidate.cwd : "~",
      state: typeof candidate.state === "string" ? candidate.state : "running",
    };
    if (typeof candidate.createdAt === "string") session.createdAt = candidate.createdAt;
    if (typeof candidate.lastAttachedAt === "string") session.lastAttachedAt = candidate.lastAttachedAt;
    if (typeof candidate.attachedClients === "number") session.attachedClients = candidate.attachedClients;
    if (typeof candidate.exitCode === "number" || candidate.exitCode === null) session.exitCode = candidate.exitCode;
    return [session];
  });
}

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_UUID.test(sessionId);
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

export function openTerminalWebSocket(
  baseUrl: string,
  token?: string | null,
  bearerToken?: string,
): WebSocket {
  const WebSocketWithOptions = WebSocket as unknown as ReactNativeWebSocketConstructor;
  return new WebSocketWithOptions(
    buildTerminalWebSocketUrl(baseUrl, token),
    [],
    bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : undefined,
  );
}
