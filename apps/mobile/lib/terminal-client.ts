import { GatewayClient } from "@/lib/gateway-client";
import type { MobileTerminalSession } from "@/lib/terminal-state";
export { isSafeSessionId, parseTerminalSessions } from "@/lib/terminal-state";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type TerminalClientFrame =
  | { type: "input"; terminalRef: TerminalRef; data: string }
  | { type: "resize"; terminalRef: TerminalRef; mode: "soft"; size: { cols: number; rows: number } }
  | { type: "detach"; terminalRef: TerminalRef }
  | { type: "ping"; terminalRef: TerminalRef };

type TerminalRef = { workspaceId: string; tabId: string };

export type TerminalServerFrame =
  | { type: "attached"; terminalRef: TerminalRef; canonicalSize: { cols: number; rows: number }; revision: number; nextSeq: number }
  | { type: "snapshot"; terminalRef: TerminalRef; ansi: string; seq: number; revision: number }
  | { type: "output"; terminalRef: TerminalRef; data: string; seq: number; revision: number }
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

  /** Create a new shell session and return its name (to then attach by name). */
  async createSession(): Promise<string | null> {
    return this.gateway.createTerminalSession();
  }

  async connect(options: MobileTerminalConnectOptions): Promise<MobileTerminalConnection | null> {
    // Shell-sessions: the session name is required and is passed in the WS query
    // (no attach frame). Attaching by name is what makes a session continuable
    // across shell, desktop and mobile.
    if (!options.sessionId) return null;
    const token = await this.gateway.getWsToken();
    this.gateway.setWebSocketToken(token);
    const ws = this.gateway.openTerminalWebSocket(token, options.sessionId, options.fromSeq);
    const connection = new MobileTerminalConnection(ws, options, async (fromSeq) => {
      const nextToken = await this.gateway.getWsToken();
      this.gateway.setWebSocketToken(nextToken);
      return this.gateway.openTerminalWebSocket(nextToken, options.sessionId, fromSeq);
    });
    connection.attach();
    return connection;
  }
}

export class MobileTerminalConnection {
  private attached = false;
  private readonly terminalRef: TerminalRef;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq: number;

  constructor(
    private ws: WebSocket,
    private readonly options: MobileTerminalConnectOptions,
    private readonly reconnect?: (fromSeq: number) => Promise<WebSocket>,
  ) {
    const [workspaceId, tabId] = options.sessionId?.split(":") ?? [];
    if (!/^tws_[0-9a-f]{32}$/.test(workspaceId ?? "") || !/^tt_[0-9a-f]{32}$/.test(tabId ?? "")) {
      throw new Error("Invalid terminal reference");
    }
    this.terminalRef = { workspaceId: workspaceId!, tabId: tabId! };
    this.lastSeq = options.fromSeq ?? 0;
  }

  attach(): void {
    this.options.onStatus?.("connecting");
    this.bindSocket(this.ws);
  }

  private bindSocket(ws: WebSocket): void {
    // The session name is supplied in the WS query, so no attach frame is sent;
    // we just announce our viewport size once the socket opens.
    ws.onopen = () => {
      if (this.ws !== ws || this.disposed) return;
      this.attached = true;
      this.reconnectAttempt = 0;
      this.options.onStatus?.("open");
      if (this.options.cols && this.options.rows) {
        this.resize(this.options.cols, this.options.rows);
      }
      this.scheduleHeartbeat();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.disposed) return;
      const frame = parseTerminalServerFrame(event.data);
      if (frame) {
        if ((frame.type === "snapshot" || frame.type === "output") && typeof frame.seq === "number") {
          this.lastSeq = Math.max(this.lastSeq, frame.seq);
        }
        this.options.onMessage(frame);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws || this.disposed) return;
      this.options.onStatus?.("error");
    };

    ws.onclose = () => {
      if (this.ws !== ws || this.disposed) return;
      this.attached = false;
      this.clearHeartbeat();
      this.options.onStatus?.("closed");
      this.scheduleReconnect();
    };
  }

  sendInput(data: string): boolean {
    return this.sendFrame({ type: "input", terminalRef: this.terminalRef, data });
  }

  resize(cols: number, rows: number): boolean {
    return this.sendFrame({
      type: "resize",
      terminalRef: this.terminalRef,
      mode: "soft",
      size: { cols: clampInteger(cols, 20, 500), rows: clampInteger(rows, 5, 200) },
    });
  }

  detach(): boolean {
    const sent = this.sendFrame({ type: "detach", terminalRef: this.terminalRef });
    this.close();
    return sent;
  }

  destroy(): boolean {
    // Session deletion happens via the REST DELETE endpoint; over the shell WS we
    // simply detach this client (the endpoint has no "destroy" frame).
    const sent = this.sendFrame({ type: "detach", terminalRef: this.terminalRef });
    this.close();
    return sent;
  }

  close(): void {
    this.disposed = true;
    this.clearReconnect();
    this.clearHeartbeat();
    if (this.ws.readyState !== WS_CONNECTING && this.ws.readyState !== WS_OPEN) return;
    this.attached = false;
    this.ws.close();
  }

  private sendFrame(frame: TerminalClientFrame): boolean {
    if (this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.reconnect || this.reconnectTimer) return;
    const base = Math.min(500 * 2 ** Math.min(this.reconnectAttempt, 10), 30_000);
    const delay = Math.floor(base * (0.5 + Math.random() * 0.5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      void this.reconnect!(this.lastSeq + 1).then((next) => {
        if (this.disposed) {
          next.close();
          return;
        }
        this.ws = next;
        this.options.onStatus?.("connecting");
        this.bindSocket(next);
      }).catch(() => {
        this.options.onStatus?.("error");
        this.scheduleReconnect();
      });
    }, delay);
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.disposed || !this.attached) return;
      this.sendFrame({ type: "ping", terminalRef: this.terminalRef });
      this.scheduleHeartbeat();
    }, 30_000);
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export function buildTerminalWebSocketUrl(baseUrl: string, refKey: string, token?: string | null): string {
  const [workspaceId, tabId] = refKey.split(":");
  const url = new URL(`${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/terminal/tab`);
  url.searchParams.set("workspaceId", workspaceId ?? "");
  url.searchParams.set("tabId", tabId ?? "");
  url.searchParams.set("client", "mobile");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function parseTerminalServerFrame(data: unknown): TerminalServerFrame | null {
  if (typeof data !== "string") return null;
  try {
    const frame = JSON.parse(data) as TerminalServerFrame;
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return null;
    if (frame.type === "attached" && frame.terminalRef && typeof frame.nextSeq === "number") return frame;
    if (frame.type === "snapshot" && typeof frame.ansi === "string") return frame;
    if (frame.type === "output" && typeof frame.data === "string") return frame;
    if (frame.type === "replay-start" || frame.type === "replay-end" || frame.type === "exit") return frame;
    if (frame.type === "error") return { type: "error", message: typeof frame.message === "string" ? frame.message : undefined };
    return null;
  } catch {
    return null;
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
