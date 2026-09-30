/**
 * Relayed-WebSocket transport for a voice session.
 *
 * The socket is reached with a single-use `?ticket=` credential minted by the
 * session REST routes (never a generic bearer token). Outbound frames carry a
 * monotonic per-epoch `sequence`; a `session.resumed` frame or an explicit
 * reconnect adopts the server epoch and restarts sequencing. Inbound frames
 * are schema-validated and dropped+counted when malformed rather than trusted.
 */
import {
  VOICE_SESSION_CONTRACT_VERSION,
  VOICE_SESSION_LIMITS,
  VoiceClientFrameSchema,
  VoiceEpochSchema,
  VoiceServerFrameSchema,
  VoiceSessionIdSchema,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from "@matrix-os/contracts/voice-session";

const MAX_FRAME_CHARS = 256 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTBOUND_QUEUE = 256;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_BINARY_HEADER_BYTES = 64;
const SOCKET_OPEN = 1;

/** Minimal structural socket so tests (and non-DOM runtimes) inject fakes. */
export interface VoiceTransportSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  onopen: ((event: any) => void) | null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  onclose: ((event: any) => void) | null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  onmessage: ((event: any) => void) | null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  onerror: ((event: any) => void) | null;
}

/** Client frame payloads with the transport-stamped envelope removed. */
export type VoiceClientFrameBody = VoiceClientFrame extends infer Frame
  ? Frame extends { type: string }
    ? Omit<Frame, "contractVersion" | "sessionId" | "epoch" | "sequence">
    : never
  : never;

export type VoiceTransportLostReason = "closed" | "heartbeat_timeout" | "connect_failed";

export interface VoiceTransportEvents {
  onFrame(frame: VoiceServerFrame): void;
  onOpen?(): void;
  onConnectionLost?(info: { code: number | null; reconnectable: boolean; reason: VoiceTransportLostReason }): void;
  onBackpressure?(droppedOutbound: number): void;
  onInvalidFrame?(direction: "inbound" | "outbound"): void;
}

export interface VoiceTransportStats {
  sentFrames: number;
  droppedOutbound: number;
  invalidInbound: number;
  invalidOutbound: number;
  binaryInbound: number;
}

interface VoiceTransportOptions {
  sessionId: string;
  webSocketFactory?: (url: string) => VoiceTransportSocket;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxOutboundQueue?: number;
  maxBufferedBytes?: number;
  maxFrameChars?: number;
  binaryAudio?: boolean;
  decodeBinaryFrame?: (data: ArrayBuffer) => unknown;
  now?: () => number;
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  events: VoiceTransportEvents;
}

function warn(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.name : "UnknownError");
}

function isReconnectableClose(code: number | null): boolean {
  if (code === null) return true;
  // Policy rejections and terminal application closes are not retryable.
  if (code === 1_002 || code === 1_008) return false;
  if (code >= 4_400 && code < 4_500) return false;
  return true;
}

/**
 * One outbound queue entry. Frames are validated at send-entry but stay
 * UNSTAMPED until the actual socket write: a frame queued while CONNECTING
 * must take its sequence after `client.ready`, so the wire order is always a
 * strictly increasing sequence within an epoch.
 */
type OutboundPending =
  | { kind: "json"; frame: VoiceClientFrame }
  | { kind: "binary"; data: ArrayBuffer | ArrayBufferView };

export class VoiceTransport {
  private socket: VoiceTransportSocket | null = null;
  private epoch = 1;
  private sequence = 0;
  private pending: OutboundPending[] = [];
  private heartbeatTimer: unknown;
  private lastInboundAt = 0;
  private open = false;
  private disposed = false;
  /** True only during the onOpen dispatch: hello frames jump the CONNECTING queue. */
  private priorityWrites = false;
  private readonly stats = { sentFrames: 0, droppedOutbound: 0, invalidInbound: 0, invalidOutbound: 0, binaryInbound: 0 };

  constructor(private readonly options: VoiceTransportOptions) {
    if (!VoiceSessionIdSchema.safeParse(options.sessionId).success) {
      throw new TypeError("sessionId must be a valid voice session identifier");
    }
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get heartbeatIntervalMs(): number {
    return Math.max(250, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  private get heartbeatTimeoutMs(): number {
    return Math.max(this.heartbeatIntervalMs, this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
  }

  private get maxOutboundQueue(): number {
    return Math.max(1, Math.min(this.options.maxOutboundQueue ?? DEFAULT_MAX_OUTBOUND_QUEUE, 1_024));
  }

  private get maxBufferedBytes(): number {
    return Math.max(1_024, this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
  }

  private get maxFrameChars(): number {
    return Math.max(1_024, this.options.maxFrameChars ?? MAX_FRAME_CHARS);
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get connected(): boolean {
    return this.open;
  }

  snapshot(): VoiceTransportStats {
    return { ...this.stats };
  }

  /** Builds the ticket-bound socket URL; the ticket is single-use and path-bound. */
  static socketUrl(url: string, ticket: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      throw new TypeError("transport url must be an absolute URL");
    }
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    else if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new TypeError("transport url must use ws or wss");
    }
    parsed.searchParams.set("ticket", ticket);
    return parsed.href;
  }

  /** Opens (or replaces) the socket for the given epoch. Queued prior-epoch frames are dropped. */
  connect(input: { url: string; ticket: string; epoch: number }): void {
    if (this.disposed) return;
    if (!VoiceEpochSchema.safeParse(input.epoch).success) {
      throw new TypeError("epoch must be a positive safe integer");
    }
    const socketUrl = VoiceTransport.socketUrl(input.url, input.ticket);
    this.detachSocket(1_000, "epoch replaced");
    this.epoch = input.epoch;
    this.sequence = 0;
    this.pending = [];
    this.open = false;

    const factory = this.options.webSocketFactory
      ?? ((url: string) => new WebSocket(url) as unknown as VoiceTransportSocket);
    let socket: VoiceTransportSocket;
    try {
      socket = factory(socketUrl);
    } catch (error: unknown) {
      warn("[voice-session] socket construction failed:", error);
      this.options.events.onConnectionLost?.({ code: null, reconnectable: true, reason: "connect_failed" });
      return;
    }
    this.socket = socket;
    this.lastInboundAt = this.now;

    socket.onopen = () => {
      if (this.socket !== socket || this.disposed) return;
      this.open = true;
      this.lastInboundAt = this.now;
      this.startHeartbeat();
      // client.ready (emitted by onOpen) must reach the wire before frames
      // queued while CONNECTING: during the onOpen dispatch, sends jump the
      // pending queue and stamp sequence 1..k; queued frames stamp 2..N at
      // flush time, so the wire order stays strictly increasing.
      this.priorityWrites = true;
      try {
        this.options.events.onOpen?.();
      } finally {
        this.priorityWrites = false;
      }
      this.flushQueue(socket);
    };
    socket.onmessage = (event: { data: unknown }) => {
      if (this.socket !== socket || this.disposed) return;
      this.lastInboundAt = this.now;
      this.handleInbound(event?.data);
    };
    socket.onerror = () => {
      warn("[voice-session] socket error", undefined);
    };
    socket.onclose = (event: { code?: number }) => {
      // onclose only runs while the socket is still attached: expected closes
      // go through detachSocket(), which removes this handler first, so every
      // arrival here is an unexpected loss.
      if (this.socket === socket) {
        this.socket = null;
        this.open = false;
      }
      this.stopHeartbeat();
      if (this.disposed) return;
      const code = typeof event?.code === "number" ? event.code : null;
      this.options.events.onConnectionLost?.({
        code,
        reconnectable: isReconnectableClose(code),
        reason: "closed",
      });
    };
  }

  /**
   * Validates and queues a client frame body; returns false when the frame
   * cannot be accepted at all. The sequence is stamped at the actual socket
   * write so `client.ready` (emitted from `onOpen`) and any frames queued
   * while CONNECTING keep a strictly increasing wire order.
   */
  send(body: VoiceClientFrameBody): boolean {
    if (this.disposed) return false;
    // Preview the fully stamped frame for schema and size validation. The
    // wire sequence may be higher by flush time; only strict monotonicity and
    // the field-level schema matter, so the preview guarantees validity.
    const preview = {
      contractVersion: VOICE_SESSION_CONTRACT_VERSION,
      sessionId: this.options.sessionId,
      epoch: this.epoch,
      sequence: this.sequence + this.pending.length + 1,
      ...body,
    };
    const parsed = VoiceClientFrameSchema.safeParse(preview);
    if (!parsed.success) {
      this.rejectOutbound();
      return false;
    }
    if (JSON.stringify(preview).length > this.maxFrameChars) {
      this.rejectOutbound();
      return false;
    }
    this.writeOrQueue(parsed.data);
    return true;
  }

  /** Binary audio is only sent when negotiated through client.ready capabilities. */
  sendBinary(data: ArrayBuffer | ArrayBufferView): boolean {
    if (this.disposed || this.options.binaryAudio !== true) return false;
    if (data.byteLength <= 0 || data.byteLength > VOICE_SESSION_LIMITS.maxAudioFrameBytes + MAX_BINARY_HEADER_BYTES) {
      return false;
    }
    const socket = this.socket;
    if (this.canWriteNow(socket)) {
      // A binary frame occupies one sequence position; its stamped header is
      // producer-encoded so the transport only reserves the counter slot.
      this.sequence += 1;
      try {
        socket.send(data);
        this.stats.sentFrames += 1;
        return true;
      } catch (error: unknown) {
        warn("[voice-session] binary send failed:", error);
      }
    }
    this.pending.push({ kind: "binary", data });
    this.trimQueue();
    return true;
  }

  /** Cleanly ends this connection; no reconnect is signalled. */
  close(code = 1_000, reason = "client ended"): void {
    this.detachSocket(code, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachSocket(1_000, "disposed");
    this.pending = [];
  }

  /**
   * Direct writes only happen when nothing is queued (a queued frame must
   * never be overtaken on the wire), except inside the onOpen dispatch where
   * the hello must lead the CONNECTING backlog.
   */
  private canWriteNow(socket: VoiceTransportSocket | null): socket is VoiceTransportSocket {
    return socket !== null
      && socket === this.socket
      && this.open
      && (this.priorityWrites || this.pending.length === 0)
      && (socket.bufferedAmount ?? 0) <= this.maxBufferedBytes;
  }

  /** Stamps the next wire sequence onto a validated frame. */
  private stampWire(frame: VoiceClientFrame): string | null {
    const wire = { ...frame, epoch: this.epoch, sequence: this.sequence + 1 };
    const payload = JSON.stringify(wire);
    if (payload.length > this.maxFrameChars) {
      this.rejectOutbound();
      return null;
    }
    this.sequence += 1;
    return payload;
  }

  private writeOrQueue(frame: VoiceClientFrame): void {
    const socket = this.socket;
    if (this.canWriteNow(socket)) {
      const payload = this.stampWire(frame);
      if (payload === null) return;
      try {
        socket.send(payload);
        this.stats.sentFrames += 1;
        return;
      } catch (error: unknown) {
        warn("[voice-session] socket send failed:", error);
      }
    }
    this.pending.push({ kind: "json", frame });
    this.trimQueue();
  }

  private trimQueue(): void {
    while (this.pending.length > this.maxOutboundQueue) {
      this.pending.shift();
      this.stats.droppedOutbound += 1;
      this.options.events.onBackpressure?.(this.stats.droppedOutbound);
    }
  }

  private flushQueue(socket: VoiceTransportSocket): void {
    while (socket === this.socket && this.open && this.pending.length > 0) {
      if ((socket.bufferedAmount ?? 0) > this.maxBufferedBytes) return;
      const item = this.pending[0] as OutboundPending;
      if (item.kind === "json") {
        const payload = this.stampWire(item.frame);
        if (payload === null) {
          this.pending.shift();
          continue;
        }
        try {
          socket.send(payload);
          this.stats.sentFrames += 1;
          this.pending.shift();
        } catch (error: unknown) {
          warn("[voice-session] queued send failed:", error);
          return;
        }
      } else {
        this.sequence += 1;
        try {
          socket.send(item.data);
          this.stats.sentFrames += 1;
          this.pending.shift();
        } catch (error: unknown) {
          warn("[voice-session] queued binary send failed:", error);
          this.sequence -= 1;
          return;
        }
      }
    }
  }

  private handleInbound(data: unknown): void {
    if (typeof data === "string") {
      if (data.length > this.maxFrameChars) {
        this.rejectInbound();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        this.rejectInbound();
        return;
      }
      this.acceptFrame(value);
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      this.stats.binaryInbound += 1;
      const bytes = data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const decoder = this.options.decodeBinaryFrame;
      if (!decoder) {
        this.rejectInbound();
        return;
      }
      let decoded: unknown;
      try {
        decoded = decoder(bytes as ArrayBuffer);
      } catch (error: unknown) {
        warn("[voice-session] binary frame decode failed:", error);
        this.rejectInbound();
        return;
      }
      this.acceptFrame(decoded);
      return;
    }
    // Blob and other async payloads are not read; count and drop.
    this.rejectInbound();
  }

  private acceptFrame(value: unknown): void {
    const parsed = VoiceServerFrameSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== this.options.sessionId) {
      this.rejectInbound();
      return;
    }
    const frame = parsed.data;
    if (frame.type === "session.resumed" && frame.epoch > this.epoch) {
      // The server elected a new epoch: outbound sequencing restarts and any
      // frames still queued for the previous epoch are stale.
      this.epoch = frame.epoch;
      this.sequence = 0;
      this.pending = [];
    }
    this.options.events.onFrame(frame);
  }

  private rejectInbound(): void {
    this.stats.invalidInbound += 1;
    this.options.events.onInvalidFrame?.("inbound");
  }

  private rejectOutbound(): void {
    this.stats.invalidOutbound += 1;
    this.options.events.onInvalidFrame?.("outbound");
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const setIntervalFn = this.options.setIntervalFn
      ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms));
    this.heartbeatTimer = setIntervalFn(() => this.onHeartbeatTick(), this.heartbeatIntervalMs);
    (this.heartbeatTimer as { unref?: () => void } | null)?.unref?.();
  }

  private onHeartbeatTick(): void {
    if (this.disposed || !this.open) return;
    const socket = this.socket;
    if (!socket) return;
    if (this.now - this.lastInboundAt > this.heartbeatTimeoutMs) {
      // Silence past the ack window: treat the socket as dead even when no
      // close frame ever arrives (network partition).
      this.detachSocket(1_001, "heartbeat timeout");
      this.options.events.onConnectionLost?.({ code: null, reconnectable: true, reason: "heartbeat_timeout" });
      return;
    }
    this.flushQueue(socket);
    this.send({ type: "heartbeat", timestampMs: this.now });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    const clearIntervalFn = this.options.clearIntervalFn
      ?? ((timer: unknown) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>));
    clearIntervalFn(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** Removes handlers before close so a synchronous or late close event is never reported as a loss. */
  private detachSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.stopHeartbeat();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === SOCKET_OPEN || socket.readyState === 0) socket.close(code, reason);
    } catch (error: unknown) {
      warn("[voice-session] socket close failed:", error);
    }
  }
}
