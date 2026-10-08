import { GatewayClient } from "@/lib/gateway-client";
import type { MobileTerminalSession } from "@/lib/terminal-state";
export { isSafeSessionId, parseTerminalSessions } from "@/lib/terminal-state";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const TERMINAL_INPUT_CHUNK_CHARS = 32_768;
const TERMINAL_GRID_LIMITS = { minCols: 20, maxCols: 500, minRows: 5, maxRows: 200 };

export type TerminalClientFrame =
  | { type: "input"; terminalRef: TerminalRef; data: string }
  | { type: "binary"; terminalRef: TerminalRef; dataBase64: string }
  | { type: "resize"; terminalRef: TerminalRef; mode: "hard"; size: TerminalGridSize }
  | { type: "detach"; terminalRef: TerminalRef }
  | { type: "ping"; terminalRef: TerminalRef };

type TerminalRef = { workspaceId: string; tabId: string };
export type TerminalGridSize = { cols: number; rows: number };

export type TerminalServerFrame =
  | { type: "attached"; terminalRef: TerminalRef; canonicalSize: TerminalGridSize; revision: number; nextSeq: number; capabilities?: string[]; ownership?: "writer" | "observer"; leaseEpoch?: number }
  | { type: "snapshot"; terminalRef: TerminalRef; ansi: string; seq: number; revision: number; canonicalSize?: TerminalGridSize }
  | { type: "canonical-size"; canonicalSize: TerminalGridSize }
  | { type: "output"; terminalRef: TerminalRef; data: string; seq: number; revision: number }
  | { type: "replay-start"; fromSeq?: number; toSeq?: number }
  | { type: "replay-end"; nextSeq?: number }
  | { type: "exit"; exitCode?: number | null }
  | { type: "lease-revoked"; terminalRef: TerminalRef; epoch: number | null }
  | { type: "error"; message?: string };

export interface MobileTerminalConnectOptions {
  sessionId?: string;
  cwd?: string;
  /** The grid that fits this screen; declared to the computer while this client holds the write lease. */
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

  /** Create a terminal tab and return its serialized TerminalRef. */
  async createSession(): Promise<string | null> {
    return this.gateway.createTerminalSession();
  }

  async connect(options: MobileTerminalConnectOptions): Promise<MobileTerminalConnection | null> {
    // The serialized TerminalRef selects the shared workspace tab in the WS query.
    if (!options.sessionId) return null;
    const token = await this.gateway.getWsToken();
    this.gateway.setWebSocketToken(token);
    const ws = this.gateway.openTerminalWebSocket(token, options.sessionId, options.fromSeq, "exclusive");
    const connection = new MobileTerminalConnection(ws, options, async (fromSeq, ownership) => {
      const nextToken = await this.gateway.getWsToken();
      this.gateway.setWebSocketToken(nextToken);
      return this.gateway.openTerminalWebSocket(nextToken, options.sessionId, fromSeq, ownership);
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
  private binaryInputSupported = false;
  private hasWriteOwnership = false;
  private requestedOwnership: "exclusive" | "observe" = "exclusive";
  private viewport: TerminalGridSize | null = null;
  /** Null until the computer confirms this socket as the writer, and again once it stops being one. */
  private declaredViewport: TerminalGridSize | null = null;
  private canDeclareViewport = false;

  constructor(
    private ws: WebSocket,
    private readonly options: MobileTerminalConnectOptions,
    private readonly reconnect?: (fromSeq: number, ownership: "exclusive" | "observe") => Promise<WebSocket>,
  ) {
    const [workspaceId, tabId] = options.sessionId?.split(":") ?? [];
    if (!/^tws_[0-9a-f]{32}$/.test(workspaceId ?? "") || !/^tt_[0-9a-f]{32}$/.test(tabId ?? "")) {
      throw new Error("Invalid terminal reference");
    }
    this.terminalRef = { workspaceId: workspaceId!, tabId: tabId! };
    this.lastSeq = options.fromSeq ?? 0;
    if (options.cols && options.rows) this.viewport = clampGridSize(options.cols, options.rows);
  }

  attach(): void {
    this.options.onStatus?.("connecting");
    this.bindSocket(this.ws);
  }

  private bindSocket(ws: WebSocket): void {
    this.binaryInputSupported = false;
    this.hasWriteOwnership = false;
    this.canDeclareViewport = false;
    this.declaredViewport = null;
    // The TerminalRef is supplied in the WS query. The viewport is declared
    // once the computer confirms the write lease: only the writer may size the
    // shared grid, and a resize sent by a follower is answered with an error.
    ws.onopen = () => {
      if (this.ws !== ws || this.disposed) return;
      this.attached = true;
      this.hasWriteOwnership = this.requestedOwnership === "exclusive";
      this.reconnectAttempt = 0;
      this.options.onStatus?.("open");
      this.scheduleHeartbeat();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.disposed) return;
      const frame = parseTerminalServerFrame(event.data);
      if (frame) {
        if (frame.type === "attached") {
          this.binaryInputSupported = frame.capabilities?.includes("binary-input-v1") ?? false;
          this.hasWriteOwnership = frame.ownership !== "observer";
          if (frame.ownership === "observer") this.requestedOwnership = "observe";
          else if (frame.leaseEpoch !== undefined) this.requestedOwnership = "exclusive";
          this.canDeclareViewport = this.hasWriteOwnership;
          this.declaredViewport = null;
          this.declareViewport();
        }
        if (frame.type === "lease-revoked") {
          this.hasWriteOwnership = false;
          this.requestedOwnership = "observe";
          this.canDeclareViewport = false;
          this.declaredViewport = null;
        }
        if ((frame.type === "snapshot" || frame.type === "output") && typeof frame.seq === "number") {
          this.lastSeq = Math.max(this.lastSeq, frame.seq);
        }
        this.options.onMessage(frame);
        // An exited terminal has nothing left to attach to. Reconnecting would
        // only be refused, and would replace the ended state with an error.
        if (frame.type === "exit") this.close();
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
    if (!this.hasWriteOwnership) return false;
    return this.sendFrame({ type: "input", terminalRef: this.terminalRef, data });
  }

  sendBinary(data: string): boolean {
    if (!this.hasWriteOwnership || data.length === 0) return false;
    for (const value of data) {
      if (value.charCodeAt(0) > 0xff) return false;
    }
    let sent = true;
    for (let offset = 0; offset < data.length; offset += TERMINAL_INPUT_CHUNK_CHARS) {
      const chunk = data.slice(offset, offset + TERMINAL_INPUT_CHUNK_CHARS);
      sent = (this.binaryInputSupported
        ? this.sendFrame({
            type: "binary",
            terminalRef: this.terminalRef,
            dataBase64: binaryStringToBase64(chunk),
          })
        : this.sendInput(chunk)) && sent;
    }
    return sent;
  }

  /**
   * Record the grid that fits this screen and, while this client is the
   * writer, size the shared grid to it. Returns whether a resize was sent.
   */
  resize(cols: number, rows: number): boolean {
    this.viewport = clampGridSize(cols, rows);
    return this.declareViewport();
  }

  private declareViewport(): boolean {
    const viewport = this.viewport;
    if (!viewport || !this.canDeclareViewport) return false;
    if (this.declaredViewport?.cols === viewport.cols && this.declaredViewport.rows === viewport.rows) return false;
    const sent = this.sendFrame({ type: "resize", terminalRef: this.terminalRef, mode: "hard", size: viewport });
    if (sent) this.declaredViewport = viewport;
    return sent;
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
      void this.reconnect!(this.lastSeq + 1, this.requestedOwnership).then((next) => {
        if (this.disposed) {
          next.close();
          return;
        }
        this.ws = next;
        this.options.onStatus?.("connecting");
        this.bindSocket(next);
      }).catch((err: unknown) => {
        console.warn("[mobile] terminal reconnect failed", err instanceof Error ? err.name : typeof err);
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

function binaryStringToBase64(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const a = value.charCodeAt(index);
    const hasB = index + 1 < value.length;
    const hasC = index + 2 < value.length;
    const b = hasB ? value.charCodeAt(index + 1) : 0;
    const c = hasC ? value.charCodeAt(index + 2) : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += hasB ? alphabet[(triple >> 6) & 63] : "=";
    output += hasC ? alphabet[triple & 63] : "=";
  }
  return output;
}

export function buildTerminalWebSocketUrl(baseUrl: string, refKey: string, token?: string | null): string {
  const [workspaceId, tabId] = refKey.split(":");
  const url = new URL(`${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/terminal/tab`);
  url.searchParams.set("workspaceId", workspaceId ?? "");
  url.searchParams.set("tabId", tabId ?? "");
  url.searchParams.set("client", "mobile");
  url.searchParams.set("inputCapability", "binary-input-v1");
  url.searchParams.set("lease", "exclusive");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function parseTerminalServerFrame(data: unknown): TerminalServerFrame | null {
  if (typeof data !== "string") return null;
  try {
    const frame = JSON.parse(data) as TerminalServerFrame;
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return null;
    if (frame.type === "attached" && frame.terminalRef && typeof frame.nextSeq === "number") {
      const canonicalSize = parseGridSize(frame.canonicalSize);
      if (!canonicalSize) return null;
      const capabilities = Array.isArray(frame.capabilities)
        ? frame.capabilities.slice(0, 8)
          .filter((value): value is string => value === "binary-input-v1")
        : undefined;
      return { ...frame, canonicalSize, ...(capabilities ? { capabilities } : {}) };
    }
    if (frame.type === "snapshot" && typeof frame.ansi === "string") {
      const { canonicalSize: rawSize, ...snapshot } = frame;
      const canonicalSize = parseGridSize(rawSize);
      return canonicalSize ? { ...snapshot, canonicalSize } : snapshot;
    }
    if (frame.type === "canonical-size") {
      const canonicalSize = parseGridSize(frame.canonicalSize);
      return canonicalSize ? { type: "canonical-size", canonicalSize } : null;
    }
    if (frame.type === "output" && typeof frame.data === "string") return frame;
    if (frame.type === "replay-start" || frame.type === "replay-end" || frame.type === "exit") return frame;
    if (frame.type === "lease-revoked" && frame.terminalRef && (typeof frame.epoch === "number" || frame.epoch === null)) return frame;
    if (frame.type === "error") return { type: "error", message: typeof frame.message === "string" ? frame.message : undefined };
    return null;
  } catch (err: unknown) {
    console.warn("[mobile] terminal websocket frame was not valid JSON", err instanceof Error ? err.name : typeof err);
    return null;
  }
}

function clampGridSize(cols: number, rows: number): TerminalGridSize {
  return {
    cols: clampInteger(cols, TERMINAL_GRID_LIMITS.minCols, TERMINAL_GRID_LIMITS.maxCols),
    rows: clampInteger(rows, TERMINAL_GRID_LIMITS.minRows, TERMINAL_GRID_LIMITS.maxRows),
  };
}

/** The emulator is resized to this, so anything outside the gateway's grid contract is refused. */
function parseGridSize(value: unknown): TerminalGridSize | null {
  if (!value || typeof value !== "object") return null;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < TERMINAL_GRID_LIMITS.minCols || cols > TERMINAL_GRID_LIMITS.maxCols) return null;
  if (rows < TERMINAL_GRID_LIMITS.minRows || rows > TERMINAL_GRID_LIMITS.maxRows) return null;
  return { cols, rows };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
