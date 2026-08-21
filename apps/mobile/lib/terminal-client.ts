import { GatewayClient } from "@/lib/gateway-client";
import type { MobileTerminalSession } from "@/lib/terminal-state";
export { isSafeSessionId, parseTerminalSessions } from "@/lib/terminal-state";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

export type TerminalClientFrame =
  | { type: "attach"; sessionId?: string; cwd?: string; fromSeq?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "detach" }
  | { type: "destroy" };

export interface TerminalCanonicalSize {
  cols: number;
  rows: number;
}

export type TerminalServerFrame =
  | {
      type: "attached";
      sessionId: string;
      state: "running" | "exited";
      cwd?: string;
      replay?: string;
      canonicalSize: TerminalCanonicalSize | null;
      leaseEpoch: number | null;
    }
  | { type: "canonical-size"; cols: number; rows: number }
  | { type: "lease-revoked" }
  | { type: "presentation-reset" }
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
    const cols = clampInteger(options.cols ?? 80, 1, 500);
    const rows = clampInteger(options.rows ?? 24, 1, 200);
    const ws = this.gateway.openTerminalWebSocket(token, options.sessionId, options.fromSeq, {
      client: "hard",
      cols,
      rows,
      lease: "exclusive",
    });
    const connection = new MobileTerminalConnection(ws, options);
    connection.attach();
    return connection;
  }
}

export class MobileTerminalConnection {
  private attached = false;
  private leaseEpoch: number | null = null;
  private leaseHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: MobileTerminalConnectOptions,
  ) {}

  attach(): void {
    this.options.onStatus?.("connecting");

    // The session name, initial hard-grid dimensions, and exclusive lease are
    // supplied in the WS query, so no attach or startup resize frame is needed.
    this.ws.onopen = () => {
      this.attached = true;
      this.options.onStatus?.("open");
    };

    this.ws.onmessage = (event) => {
      const frame = parseTerminalServerFrame(event.data);
      if (!frame) return;
      if (frame.type === "attached") {
        this.leaseEpoch = frame.leaseEpoch;
        this.scheduleLeaseHeartbeat();
      } else if (frame.type === "lease-revoked") {
        this.leaseEpoch = null;
        this.clearLeaseHeartbeat();
      }
      this.options.onMessage(frame);
    };

    this.ws.onerror = () => {
      this.options.onStatus?.("error");
    };

    this.ws.onclose = () => {
      this.attached = false;
      this.leaseEpoch = null;
      this.clearLeaseHeartbeat();
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
    // Session deletion happens via the REST DELETE endpoint; over the shell WS we
    // simply detach this client (the endpoint has no "destroy" frame).
    const sent = this.sendFrame({ type: "detach" });
    this.close();
    return sent;
  }

  close(): void {
    this.clearLeaseHeartbeat();
    this.leaseEpoch = null;
    if (this.ws.readyState !== WS_CONNECTING && this.ws.readyState !== WS_OPEN) return;
    this.attached = false;
    this.ws.close();
  }

  private sendFrame(frame: TerminalClientFrame): boolean {
    if (this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private scheduleLeaseHeartbeat(): void {
    this.clearLeaseHeartbeat();
    if (this.leaseEpoch === null || !this.attached) return;
    this.leaseHeartbeatTimer = setTimeout(() => {
      this.leaseHeartbeatTimer = null;
      if (this.leaseEpoch === null || !this.attached) return;
      this.sendFrame({ type: "ping" });
      this.scheduleLeaseHeartbeat();
    }, LEASE_HEARTBEAT_INTERVAL_MS);
  }

  private clearLeaseHeartbeat(): void {
    if (this.leaseHeartbeatTimer === null) return;
    clearTimeout(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = null;
  }
}

export function buildTerminalWebSocketUrl(baseUrl: string, token?: string | null): string {
  const url = `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/terminal`;
  if (!token) return url;
  return `${url}?token=${encodeURIComponent(token)}`;
}

export function parseTerminalServerFrame(data: unknown): TerminalServerFrame | null {
  if (typeof data !== "string") return null;
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return null;
    if (frame.type === "attached") {
      const sessionId = typeof frame.session === "string"
        ? frame.session
        : typeof frame.sessionId === "string"
          ? frame.sessionId
          : null;
      if (!sessionId || (frame.state !== undefined && frame.state !== "running" && frame.state !== "exited")) {
        return null;
      }
      const lease = frame.lease && typeof frame.lease === "object"
        ? frame.lease as Record<string, unknown>
        : null;
      return {
        type: "attached",
        sessionId,
        state: frame.state === "exited" ? "exited" : "running",
        ...(typeof frame.cwd === "string" ? { cwd: frame.cwd } : {}),
        ...(typeof frame.replay === "string" ? { replay: frame.replay } : {}),
        canonicalSize: parseCanonicalSize(frame.canonicalSize),
        leaseEpoch: Number.isSafeInteger(lease?.epoch) && (lease?.epoch as number) > 0
          ? lease?.epoch as number
          : null,
      };
    }
    if (frame.type === "canonical-size") {
      const size = parseCanonicalSize(frame);
      return size ? { type: "canonical-size", ...size } : null;
    }
    if (frame.type === "lease-revoked") return { type: "lease-revoked" };
    if (frame.type === "presentation-reset") return { type: "presentation-reset" };
    if (frame.type === "output" && typeof frame.data === "string") {
      return { type: "output", data: frame.data };
    }
    if (frame.type === "replay-start") {
      return {
        type: "replay-start",
        ...(Number.isSafeInteger(frame.fromSeq) ? { fromSeq: frame.fromSeq as number } : {}),
        ...(Number.isSafeInteger(frame.toSeq) ? { toSeq: frame.toSeq as number } : {}),
      };
    }
    if (frame.type === "replay-end") {
      return {
        type: "replay-end",
        ...(Number.isSafeInteger(frame.nextSeq) ? { nextSeq: frame.nextSeq as number } : {}),
      };
    }
    if (frame.type === "exit") {
      const rawExitCode = frame.code ?? frame.exitCode;
      return {
        type: "exit",
        exitCode: typeof rawExitCode === "number" && Number.isFinite(rawExitCode)
          ? rawExitCode
          : rawExitCode === null
            ? null
            : undefined,
      };
    }
    if (frame.type === "error") return { type: "error", message: typeof frame.message === "string" ? frame.message : undefined };
    return null;
  } catch {
    return null;
  }
}

function parseCanonicalSize(value: unknown): TerminalCanonicalSize | null {
  if (!value || typeof value !== "object") return null;
  const size = value as Record<string, unknown>;
  if (
    !Number.isInteger(size.cols)
    || (size.cols as number) < 1
    || (size.cols as number) > 500
    || !Number.isInteger(size.rows)
    || (size.rows as number) < 1
    || (size.rows as number) > 200
  ) {
    return null;
  }
  return { cols: size.cols as number, rows: size.rows as number };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
