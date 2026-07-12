// One multiplexed kernel /ws connection (contracts/gateway-contract.md,
// "Kernel /ws"). Framework-free: WebSocket factory, timers, and randomness
// are injectable for tests. Known message types are validated with zod;
// unknown types pass through to subscribers for forward compatibility.
import { z } from "zod/v4";

export type KernelConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export interface KernelServerMessage {
  type: string;
  [key: string]: unknown;
}

export type KernelClientMessage =
  | { type: "message"; text: string; sessionId?: string; requestId: string }
  | { type: "abort"; requestId: string }
  | { type: "approval_response"; id: string; approved: boolean }
  | { type: "ping" };

// Structurally identical to the browser WebSocket subset the socket needs.
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface KernelSocketOptions {
  baseUrl: string;
  runtimeSlot: string;
  createWebSocket?: (url: string) => WebSocketLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

const SUBSCRIBER_CAP = 64;
const SEND_QUEUE_CAP = 32;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const OFFLINE_AFTER_FAILURES = 3;
const MAX_FRAME_CHARS = 1_000_000;

const requestIdField = z.string().min(1).max(256).optional();

export const KnownKernelMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("kernel:init"), sessionId: z.string(), requestId: requestIdField }),
  z.looseObject({ type: z.literal("kernel:text"), text: z.string(), requestId: requestIdField }),
  z.looseObject({ type: z.literal("kernel:tool_start"), tool: z.string(), requestId: requestIdField }),
  z.looseObject({
    type: z.literal("kernel:tool_end"),
    input: z.record(z.string(), z.unknown()).optional(),
    requestId: requestIdField,
  }),
  z.looseObject({ type: z.literal("kernel:result"), data: z.unknown(), requestId: requestIdField }),
  z.looseObject({ type: z.literal("kernel:error"), message: z.string(), requestId: requestIdField }),
  z.looseObject({ type: z.literal("kernel:aborted"), requestId: requestIdField }),
  z.looseObject({ type: z.literal("session:switched"), sessionId: z.string() }),
  z.looseObject({
    type: z.literal("task:created"),
    task: z.looseObject({ id: z.string(), type: z.string(), status: z.string(), input: z.string() }),
  }),
  z.looseObject({ type: z.literal("task:updated"), taskId: z.string(), status: z.string() }),
  z.looseObject({
    type: z.literal("approval:request"),
    id: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    timeout: z.number(),
  }),
  z.looseObject({ type: z.literal("pong") }),
]);

export type KnownKernelMessage = z.infer<typeof KnownKernelMessageSchema>;

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  KnownKernelMessageSchema.options.map((option) => option.shape.type.value),
);

const BaseMessageSchema = z.looseObject({ type: z.string().min(1).max(128) });

export function parseKernelServerMessage(value: unknown): KernelServerMessage | null {
  const base = BaseMessageSchema.safeParse(value);
  if (!base.success) return null;
  if (KNOWN_TYPES.has(base.data.type)) {
    const known = KnownKernelMessageSchema.safeParse(base.data);
    return known.success ? known.data : null;
  }
  return base.data;
}

export function buildKernelWsUrl(baseUrl: string, runtimeSlot: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  const url = `${base}/ws`;
  if (runtimeSlot === "primary") return url;
  return `${url}?runtime=${encodeURIComponent(runtimeSlot)}`;
}

type MessageHandler = (msg: KernelServerMessage) => void;
type StateHandler = (state: KernelConnectionState) => void;

export class KernelSocket {
  private readonly baseUrl: string;
  private readonly runtimeSlot: string;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly random: () => number;

  private socket: WebSocketLike | null = null;
  private readonly handlers = new Set<MessageHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly sendQueue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private consecutiveFailures = 0;
  private currentState: KernelConnectionState = "connecting";
  private disposed = false;

  constructor(options: KernelSocketOptions) {
    this.baseUrl = options.baseUrl;
    this.runtimeSlot = options.runtimeSlot;
    this.createWebSocket =
      options.createWebSocket ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    // Browser timers perform a receiver check. Keeping the bare functions on
    // the socket and later calling `this.setTimeoutFn(...)` binds `this` to the
    // KernelSocket and throws "Illegal invocation" in Electron.
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
    this.random = options.random ?? Math.random;
  }

  get state(): KernelConnectionState {
    return this.currentState;
  }

  connect(): void {
    if (this.disposed) return;
    if (
      this.socket &&
      (this.socket.readyState === WS_OPEN || this.socket.readyState === WS_CONNECTING)
    ) {
      return;
    }
    this.clearReconnectTimer();

    const url = buildKernelWsUrl(this.baseUrl, this.runtimeSlot);
    let socket: WebSocketLike;
    try {
      socket = this.createWebSocket(url);
    } catch (err: unknown) {
      console.warn(
        "[kernel-socket] failed to create websocket:",
        err instanceof Error ? err.message : err,
      );
      this.handleConnectionLoss();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.consecutiveFailures = 0;
      this.setState("connected");
      this.drainQueue();
    };

    socket.onmessage = (event) => {
      this.handleFrame(event.data);
    };

    socket.onclose = () => {
      if (this.disposed) return;
      this.socket = null;
      this.handleConnectionLoss();
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch (err: unknown) {
        console.warn(
          "[kernel-socket] close after error failed:",
          err instanceof Error ? err.message : err,
        );
      }
    };
  }

  subscribe(handler: MessageHandler): () => void {
    if (this.handlers.size >= SUBSCRIBER_CAP) {
      throw new Error(`KernelSocket subscriber cap (${SUBSCRIBER_CAP}) exceeded`);
    }
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStateChange(handler: StateHandler): () => void {
    if (this.stateHandlers.size >= SUBSCRIBER_CAP) {
      throw new Error(`KernelSocket state-subscriber cap (${SUBSCRIBER_CAP}) exceeded`);
    }
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  send(msg: KernelClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.socket?.readyState === WS_OPEN) {
      try {
        this.socket.send(data);
        return;
      } catch (err: unknown) {
        console.warn(
          "[kernel-socket] send failed, queueing:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (this.sendQueue.length >= SEND_QUEUE_CAP) {
      this.sendQueue.shift();
      console.warn(`[kernel-socket] send queue full (${SEND_QUEUE_CAP}); dropping oldest message`);
    }
    this.sendQueue.push(data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch (err: unknown) {
        console.warn(
          "[kernel-socket] close on dispose failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.setState("offline");
    this.handlers.clear();
    this.stateHandlers.clear();
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_FRAME_CHARS) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err: unknown) {
      console.warn(
        "[kernel-socket] dropping unparseable frame:",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    const msg = parseKernelServerMessage(parsed);
    if (!msg) return;
    for (const handler of [...this.handlers]) {
      try {
        handler(msg);
      } catch (err: unknown) {
        console.warn(
          "[kernel-socket] subscriber failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private handleConnectionLoss(): void {
    if (this.disposed) return;
    this.consecutiveFailures++;
    this.setState(this.consecutiveFailures >= OFFLINE_AFTER_FAILURES ? "offline" : "reconnecting");
    const delay = this.backoffDelay(this.attempt);
    this.attempt++;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
    // Jitter factor in [0.5, 1.0]
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  private drainQueue(): void {
    while (this.sendQueue.length > 0 && this.socket?.readyState === WS_OPEN) {
      const data = this.sendQueue.shift()!;
      try {
        this.socket.send(data);
      } catch (err: unknown) {
        console.warn(
          "[kernel-socket] drain send failed, requeueing:",
          err instanceof Error ? err.message : err,
        );
        this.sendQueue.unshift(data);
        return;
      }
    }
  }

  private setState(state: KernelConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of [...this.stateHandlers]) {
      try {
        handler(state);
      } catch (err: unknown) {
        console.warn(
          "[kernel-socket] state subscriber failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
