// Terminal WebSocket client for the gateway shell protocol
// (packages/gateway/src/shell/ws.ts, specs/094 research R3). Framework-free:
// the WebSocket factory and timers are injectable so tests never need a
// network or real clocks.

export const LIVE_TAIL_FROM_SEQ = 9_007_199_254_740_991;

export type ShellSocketState =
  | "connecting"
  | "attached"
  | "reconnecting"
  | "connection-lost"
  | "ended"
  | "fatal";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ShellSocketEvents {
  onState(state: ShellSocketState, detail?: { code?: string }): void;
  onOutput(data: string, seq: number): void;
  onGap(): void;
  onExit(code: number): void;
}

export interface ShellSocketOptions {
  baseUrl: string;
  sessionName?: string;
  cwd?: string;
  runtimeSlot: string;
  events: ShellSocketEvents;
  createWebSocket?: (url: string) => WebSocketLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
}

const INPUT_CHUNK_CHARS = 32_768;
const PENDING_INPUT_MAX_CHUNKS = 64;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const BACKOFF_JITTER = 0.5;
const BACKOFF_MAX_EXPONENT = 10;
const ATTACH_HANDSHAKE_TIMEOUT_MS = BACKOFF_BASE_MS;
const CONNECTION_LOST_AFTER_FAILURES = 2;
const RESIZE_DEBOUNCE_STARTUP_MS = 220;
const RESIZE_DEBOUNCE_STEADY_MS = 90;
const STARTUP_SETTLE_AFTER_ATTACH_MS = 300;
const RESIZE_FALLBACK_AFTER_ATTACH_MS = 900;
const MIN_COLS = 1;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

// Lesson L5: these codes must never trigger a reconnect loop.
const FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "invalid_request",
  "attach_failed",
]);

type TimerHandle = ReturnType<typeof setTimeout>;

interface Dims {
  cols: number;
  rows: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class ShellSocket {
  private readonly opts: ShellSocketOptions;
  private readonly createWs: (url: string) => WebSocketLike;
  private readonly setT: typeof setTimeout;
  private readonly clearT: typeof clearTimeout;
  private readonly random: () => number;

  private socket: WebSocketLike | null = null;
  private currentState: ShellSocketState | null = null;
  private started = false;
  private disposed = false;
  private lastSeqValue = 0;
  private receivedOutput = false;
  private attachedSessionName: string | null = null;
  private detachPending = false;
  private failedAttempts = 0;
  private pendingInput: string[] = [];
  private lastKnownDims: Dims | null = null;
  private lastSentDims: Dims | null = null;
  private resizeSentSinceAttach = false;
  private inStartupWindow = true;
  private reconnectTimer: TimerHandle | null = null;
  private resizeTimer: TimerHandle | null = null;
  private settleTimer: TimerHandle | null = null;
  private fallbackTimer: TimerHandle | null = null;
  private handshakeTimer: TimerHandle | null = null;

  constructor(options: ShellSocketOptions) {
    const hasSession = typeof options.sessionName === "string" && options.sessionName.length > 0;
    const hasCwd = typeof options.cwd === "string" && options.cwd.length > 0;
    if (hasSession === hasCwd) {
      throw new Error("ShellSocket requires exactly one of sessionName or cwd");
    }
    this.opts = options;
    this.createWs = options.createWebSocket ?? defaultCreateWebSocket;
    this.setT = options.setTimeoutFn ?? (globalThis.setTimeout.bind(globalThis) as typeof setTimeout);
    this.clearT =
      options.clearTimeoutFn ?? (globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout);
    this.random = options.random ?? Math.random;
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  get state(): ShellSocketState {
    return this.currentState ?? "connecting";
  }

  connect(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.setState("connecting");
    this.openSocket(false);
  }

  sendInput(data: string): void {
    if (this.disposed || this.currentState === "ended" || this.currentState === "fatal") return;
    if (data.length === 0) return;
    for (let offset = 0; offset < data.length; offset += INPUT_CHUNK_CHARS) {
      const chunk = data.slice(offset, offset + INPUT_CHUNK_CHARS);
      if (this.currentState === "attached" && this.socket !== null) {
        this.sendFrame({ type: "input", data: chunk });
      } else {
        this.pendingInput.push(chunk);
        if (this.pendingInput.length > PENDING_INPUT_MAX_CHUNKS) {
          this.pendingInput.shift();
        }
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this.currentState === "ended" || this.currentState === "fatal") return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      console.warn("[shell-socket] ignoring non-finite resize dims");
      return;
    }
    this.lastKnownDims = {
      cols: clampInt(cols, MIN_COLS, MAX_COLS),
      rows: clampInt(rows, MIN_ROWS, MAX_ROWS),
    };
    if (this.resizeTimer !== null) this.clearT(this.resizeTimer);
    const debounceMs = this.inStartupWindow ? RESIZE_DEBOUNCE_STARTUP_MS : RESIZE_DEBOUNCE_STEADY_MS;
    this.resizeTimer = this.setT(() => {
      this.resizeTimer = null;
      this.flushResize();
    }, debounceMs);
  }

  detach(): void {
    if (this.disposed || this.currentState === "ended" || this.currentState === "fatal") return;
    this.detachPending = true;
    if (this.socket === null) {
      const sessionName = this.attachedSessionName ?? this.opts.sessionName ?? null;
      this.clearAllTimers();
      this.setState("ended");
      if (sessionName !== null && sessionName.length > 0) {
        this.openSocket(true);
      }
      return;
    }
    this.sendDetachFrame();
    this.endSession();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownSocket();
    this.clearAllTimers();
  }

  private openSocket(isReconnect: boolean): void {
    if (this.disposed) return;
    // Per-connection resize bookkeeping: a fresh attach starts a new startup
    // window and may need the last known dims resent.
    this.lastSentDims = null;
    this.resizeSentSinceAttach = false;
    this.inStartupWindow = true;

    const url = this.buildUrl(isReconnect);
    let socket: WebSocketLike;
    try {
      socket = this.createWs(url);
    } catch (err: unknown) {
      console.warn("[shell-socket] websocket create failed:", errorText(err));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    const onClosed = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.detachSocketHandlers(socket);
      try {
        socket.close();
      } catch (err: unknown) {
        console.warn("[shell-socket] websocket close failed:", errorText(err));
      }
      this.scheduleReconnect();
    };

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.clearAttachHandshakeTimer();
      this.handshakeTimer = this.setT(() => {
        if (this.socket !== socket || this.disposed) return;
        this.handshakeTimer = null;
        console.warn("[shell-socket] attach handshake timed out");
        onClosed();
      }, ATTACH_HANDSHAKE_TIMEOUT_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handleMessage(event.data);
    };
    socket.onclose = onClosed;
    socket.onerror = () => {
      console.warn("[shell-socket] websocket transport error");
      onClosed();
    };
  }

  private buildUrl(isReconnect: boolean): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "").replace(/^http(s?):\/\//, "ws$1://");
    const runtimeSuffix =
      this.opts.runtimeSlot !== "primary"
        ? `&runtime=${encodeURIComponent(this.opts.runtimeSlot)}`
        : "";
    const sessionName = isReconnect
      ? (this.attachedSessionName ?? this.opts.sessionName ?? null)
      : (this.opts.sessionName ?? null);
    if (sessionName !== null && sessionName.length > 0) {
      const fromSeq = isReconnect && this.receivedOutput ? this.lastSeqValue + 1 : LIVE_TAIL_FROM_SEQ;
      return `${base}/ws/terminal/session?session=${encodeURIComponent(sessionName)}&fromSeq=${fromSeq}${runtimeSuffix}`;
    }
    return `${base}/ws/terminal?cwd=${encodeURIComponent(this.opts.cwd ?? "")}${runtimeSuffix}`;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.currentState === "ended" || this.currentState === "fatal") return;
    // Attach-lifecycle timers belong to the connection that just dropped.
    if (this.settleTimer !== null) {
      this.clearT(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.fallbackTimer !== null) {
      this.clearT(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.clearAttachHandshakeTimer();
    const exponent = Math.min(this.failedAttempts, BACKOFF_MAX_EXPONENT);
    const baseDelay = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
    const delay = baseDelay * (1 - BACKOFF_JITTER * this.random());
    this.setState(
      this.failedAttempts >= CONNECTION_LOST_AFTER_FAILURES ? "connection-lost" : "reconnecting",
    );
    this.failedAttempts += 1;
    if (this.reconnectTimer !== null) this.clearT(this.reconnectTimer);
    this.reconnectTimer = this.setT(() => {
      this.reconnectTimer = null;
      this.openSocket(true);
    }, delay);
  }

  private handleMessage(data: unknown): void {
    if (this.disposed) return;
    if (typeof data !== "string") {
      console.warn("[shell-socket] ignoring non-string websocket frame");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err: unknown) {
      console.warn("[shell-socket] ignoring malformed websocket frame:", errorText(err));
      return;
    }
    if (parsed === null || typeof parsed !== "object") {
      console.warn("[shell-socket] ignoring non-object websocket frame");
      return;
    }
    const frame = parsed as Record<string, unknown>;
    switch (frame.type) {
      case "attached":
        this.handleAttached(frame);
        return;
      case "output":
        this.handleOutput(frame);
        return;
      case "exit":
        this.handleExit(frame);
        return;
      case "pong":
        return;
      case "replay-evicted":
        this.opts.events.onGap();
        return;
      case "error":
        this.handleErrorFrame(frame);
        return;
      default:
        console.warn("[shell-socket] ignoring unknown frame type:", String(frame.type));
    }
  }

  private handleAttached(frame: Record<string, unknown>): void {
    this.clearAttachHandshakeTimer();
    if (typeof frame.session === "string" && frame.session.length > 0) {
      this.attachedSessionName = frame.session;
    }
    if (this.detachPending) {
      this.sendDetachFrame();
      this.endSession();
      return;
    }
    this.failedAttempts = 0;
    this.setState("attached");
    this.flushPendingInput();
    this.scheduleAttachTimers();
  }

  private handleOutput(frame: Record<string, unknown>): void {
    const seq = frame.seq;
    const data = frame.data;
    if (typeof seq !== "number" || !Number.isFinite(seq) || typeof data !== "string") {
      console.warn("[shell-socket] ignoring invalid output frame");
      return;
    }
    this.lastSeqValue = seq;
    this.receivedOutput = true;
    this.opts.events.onOutput(data, seq);
  }

  private handleExit(frame: Record<string, unknown>): void {
    const code = frame.code;
    if (typeof code !== "number" || !Number.isFinite(code)) {
      console.warn("[shell-socket] ignoring invalid exit frame");
      return;
    }
    this.opts.events.onExit(code);
    this.endSession();
  }

  private handleErrorFrame(frame: Record<string, unknown>): void {
    this.clearAttachHandshakeTimer();
    const code = typeof frame.code === "string" ? frame.code : "unknown";
    if (FATAL_ERROR_CODES.has(code)) {
      this.teardownSocket();
      this.clearAllTimers();
      this.setState("fatal", { code });
      return;
    }
    console.warn("[shell-socket] non-fatal terminal error:", code);
  }

  private scheduleAttachTimers(): void {
    if (this.settleTimer !== null) this.clearT(this.settleTimer);
    if (this.fallbackTimer !== null) this.clearT(this.fallbackTimer);
    this.settleTimer = this.setT(() => {
      this.settleTimer = null;
      this.inStartupWindow = false;
    }, STARTUP_SETTLE_AFTER_ATTACH_MS);
    this.fallbackTimer = this.setT(() => {
      this.fallbackTimer = null;
      if (!this.resizeSentSinceAttach && this.lastKnownDims !== null) {
        this.flushResize();
      }
    }, RESIZE_FALLBACK_AFTER_ATTACH_MS);
  }

  private flushResize(): void {
    if (this.disposed || this.currentState !== "attached" || this.socket === null) return;
    const dims = this.lastKnownDims;
    if (dims === null) return;
    if (this.lastSentDims !== null && this.lastSentDims.cols === dims.cols && this.lastSentDims.rows === dims.rows) {
      return;
    }
    this.sendFrame({ type: "resize", cols: dims.cols, rows: dims.rows });
    this.lastSentDims = dims;
    this.resizeSentSinceAttach = true;
  }

  private flushPendingInput(): void {
    if (this.pendingInput.length === 0) return;
    const chunks = this.pendingInput;
    this.pendingInput = [];
    for (const chunk of chunks) {
      this.sendFrame({ type: "input", data: chunk });
    }
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (this.socket === null) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (err: unknown) {
      console.warn("[shell-socket] websocket send failed:", errorText(err));
    }
  }

  private sendDetachFrame(): void {
    this.sendFrame({ type: "detach" });
    this.detachPending = false;
  }

  private endSession(): void {
    this.teardownSocket();
    this.clearAllTimers();
    this.setState("ended");
  }

  private teardownSocket(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    this.detachSocketHandlers(socket);
    try {
      socket.close();
    } catch (err: unknown) {
      console.warn("[shell-socket] websocket close failed:", errorText(err));
    }
  }

  private detachSocketHandlers(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private clearAttachHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.clearT(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearAllTimers(): void {
    for (const key of [
      "reconnectTimer",
      "resizeTimer",
      "settleTimer",
      "fallbackTimer",
      "handshakeTimer",
    ] as const) {
      const handle = this[key];
      if (handle !== null) {
        this.clearT(handle);
        this[key] = null;
      }
    }
  }

  private setState(state: ShellSocketState, detail?: { code?: string }): void {
    if (this.disposed || this.currentState === state) return;
    this.currentState = state;
    this.opts.events.onState(state, detail);
  }
}
