/**
 * Per-session voice runtime (Layer 4 engine internals).
 *
 * One `VoiceSessionRuntime` owns the current transport binding (epoch +
 * sequence fencing), outbound frame emission, lifecycle teardown, and the
 * delivery ledger IO. Payload work — turns, admission, provider events,
 * canonical events, segment acknowledgements — lives in the collaborator
 * `VoiceSessionPipeline` (session-pipeline.ts). The engine (`engine.ts`)
 * owns the registry, lifecycle timers, ticket issuance and shutdown and
 * drives this runtime through `VoiceSessionHost`.
 *
 * Frame semantics follow `@matrix-os/contracts/voice-session`: late frames
 * from prior epochs and non-monotonic/replayed sequences are ignored and
 * counted, never applied; only safe error codes cross to clients.
 */
import type {
  AudioFormat,
  ClientMediaCapabilities,
  SafeVoiceErrorCode,
  VoiceClientFrame,
  VoiceFrameCommon,
  VoiceResponseSegment,
  VoiceServerFrame,
  VoiceSessionLimits,
  VoiceSessionState,
  VoiceSessionStateReason,
  VoiceTurnMode,
} from "@matrix-os/contracts/voice-session";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import type {
  VoiceMediaAdapterRegistry,
  VoiceMediaSession,
} from "./adapter.js";
import { VOICE_ERROR_RECOVERY } from "./adapter.js";
import { VoiceSessionPipeline } from "./session-pipeline.js";
import type {
  VoiceAdmissionPort,
  VoiceCanonicalChatEvent,
  VoiceChatEventSubscription,
  VoiceClock,
  VoiceDeliveryPort,
  VoiceMemoryMode,
  VoiceRunControlPort,
  VoiceTimer,
} from "./ports.js";

export const ACTIVE_SESSION_STATES: ReadonlySet<VoiceSessionState> = new Set([
  "connecting",
  "listening",
  "thinking",
  "using_tool",
  "speaking",
  "paused",
  "reconnecting",
  "restoring",
]);

export type VoiceSessionEndKind =
  | "user"
  | "surface_closed"
  | "sign_out"
  | "shutdown"
  | "idle_limit"
  | "duration_limit"
  | "failed";

export interface VoiceTurnRecord {
  turnId: string;
  localOrder: number;
  /** Stable `req_…` admission identity generated once at capture.start. */
  requestId: string;
  phase: "capturing" | "finalizing" | "admitted" | "empty" | "rejected";
  mode: VoiceTurnMode;
  baseRevision: number;
  provisionalRevision: number;
  finalityId: string | null;
  finalText: string | null;
  canonicalTurnId: string | null;
  runId: string | null;
  startedAtMs: number;
}

export interface VoiceLedgerSegment extends VoiceResponseSegment {
  played: boolean;
}

export interface VoiceResponseLedger {
  responseId: string;
  runId: string;
  state: "open" | "interrupted" | "complete";
  segments: VoiceLedgerSegment[];
  /** Audio emitted by the adapter so far; acks may never exceed this. */
  deliveredThroughMs: number;
  /** Furthest whole-segment playback the client acknowledged. */
  playedThroughMs: number;
  deliveryRevision: number;
  pendingRecorded: boolean;
  generationEnded: boolean;
  terminalRecorded: boolean;
}

export interface VoiceTransportBinding {
  epoch: number;
  lastInboundSequence: number;
  nextOutboundSequence: number;
  closed: boolean;
  sink: {
    send(frame: VoiceServerFrame): void;
    close(code: number, reason: string): void;
  };
}

export interface VoiceSessionRecord {
  sessionId: string;
  chatId: string;
  principalId: string;
  clientRequestId: string;
  /** Semantic fingerprint of the create request (idempotent reuse check). */
  fingerprint: string;
  state: VoiceSessionState;
  /** State a replacement transport resumes into after `reconnecting`. */
  restorableState: VoiceSessionState;
  epoch: number;
  credentialGeneration: number;
  reconnectAttempts: number;
  leaseConsumed: boolean;
  turnMode: VoiceTurnMode;
  memoryMode: VoiceMemoryMode;
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
  locale?: string;
  requestedTransport?: "relayed_websocket" | "direct_webrtc";
  adapterId: string;
  adapter: VoiceMediaSession | null;
  audio?: AudioFormat;
  clientMedia?: ClientMediaCapabilities;
  inputDeviceId?: string;
  outputDeviceId?: string;
  turns: Map<string, VoiceTurnRecord>;
  finalityToTurn: Map<string, string>;
  responses: Map<string, VoiceResponseLedger>;
  runIds: Set<string>;
  terminalRunIds: Set<string>;
  turnOrderCounter: number;
  lastKnownChatRevision: number;
  transport: VoiceTransportBinding | null;
  chatSubscription: VoiceChatEventSubscription | null;
  timers: { idle: VoiceTimer | null; duration: VoiceTimer | null };
  queuedAudioMs: number;
  activeCaptureTurnId: string | null;
  createdAtMs: number;
  lastActivityAtMs: number;
  endedAtMs: number | null;
  endKind: VoiceSessionEndKind | null;
  ending: Promise<void> | null;
  mutation: Promise<void>;
  /** True while a queued mutation task owns the session (re-entrancy guard). */
  inTask: boolean;
  staleFrameCount: number;
  runtime: VoiceSessionRuntime;
}

export interface VoiceSessionHost {
  readonly limits: VoiceSessionLimits;
  readonly clock: VoiceClock;
  readonly admission: VoiceAdmissionPort;
  readonly delivery: VoiceDeliveryPort;
  readonly runControl?: VoiceRunControlPort;
  readonly adapters: VoiceMediaAdapterRegistry;
  readonly maxTurns: number;
  readonly maxResponses: number;
  readonly maxRunIds: number;
  createId(prefix: string): string;
  log(event: string, fields: Record<string, unknown>): void;
  touch(session: VoiceSessionRecord): void;
  finish(session: VoiceSessionRecord, kind: VoiceSessionEndKind): Promise<void>;
}

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ServerFramePayload = DistributiveOmit<VoiceServerFrame, keyof VoiceFrameCommon>;

/**
 * Serialize asynchronous session work: tasks run in arrival order. `inTask`
 * marks re-entrant sections so lifecycle teardown requested from inside the
 * queue executes inline instead of deadlocking behind itself.
 */
export function enqueueSessionTask(
  session: VoiceSessionRecord,
  task: () => Promise<void> | void,
): Promise<void> {
  const invoke = async (): Promise<void> => {
    session.inTask = true;
    try {
      await task();
    } finally {
      session.inTask = false;
    }
  };
  const run = session.mutation.then(invoke, invoke);
  session.mutation = run.then(
    () => undefined,
    (error: unknown) => {
      // Task failures are contained: log and keep the queue usable.
      session.runtime.noteTaskError(error);
    },
  );
  return session.mutation;
}

/** Evict-then-check bounded map admission. Returns false when still full. */
export function boundedInsert<K, V>(
  map: Map<K, V>,
  cap: number,
  evictable: (value: V, key: K) => boolean,
): boolean {
  if (map.size < cap) return true;
  for (const [key, value] of map) {
    if (evictable(value, key)) map.delete(key);
    if (map.size < cap) return true;
  }
  return false;
}

export class VoiceSessionRuntime {
  readonly pipeline: VoiceSessionPipeline;

  constructor(
    readonly session: VoiceSessionRecord,
    readonly host: VoiceSessionHost,
  ) {
    this.pipeline = new VoiceSessionPipeline(session, host, this);
  }

  noteTaskError(error: unknown): void {
    this.host.log("voice.session.task_error", {
      sessionId: this.session.sessionId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }

  countStale(kind: string): void {
    this.session.staleFrameCount += 1;
    this.host.log("voice.session.frame_ignored", {
      sessionId: this.session.sessionId,
      epoch: this.session.epoch,
      kind,
    });
  }

  // ---------------------------------------------------------------- transport

  attachTransport(binding: VoiceTransportBinding): void {
    const s = this.session;
    const prior = s.transport;
    if (prior && !prior.closed) {
      this.sendThrough(prior, {
        type: "transport.going_away",
        retryAfterMs: 0,
        reconnectAllowed: true,
      });
      prior.closed = true;
      prior.sink.close(1000, "Superseded");
    }
    s.transport = binding;
    if (s.state === "connecting") {
      this.emit({ type: "session.state", state: "connecting" });
      return;
    }
    if (s.state === "reconnecting") {
      const restored = s.restorableState;
      s.state = restored;
      this.emit({ type: "session.resumed", state: restored, reason: "restored" });
      return;
    }
    this.emit({ type: "session.state", state: s.state });
  }

  detachTransport(binding: VoiceTransportBinding): void {
    const s = this.session;
    if (s.transport !== binding) return;
    binding.closed = true;
    s.transport = null;
    this.stopCapture();
    if (ACTIVE_SESSION_STATES.has(s.state) && s.state !== "connecting" && s.state !== "reconnecting") {
      s.restorableState = this.resumeTarget();
      s.state = "reconnecting";
    }
  }

  /** Gracefully close the current transport (epoch rotation / going-away). */
  closeTransportGracefully(reason: string, reconnectAllowed: boolean): void {
    const s = this.session;
    const transport = s.transport;
    if (!transport || transport.closed) return;
    this.sendThrough(transport, {
      type: "transport.going_away",
      retryAfterMs: 0,
      reconnectAllowed,
    });
    transport.closed = true;
    transport.sink.close(1000, reason);
    s.transport = null;
    this.stopCapture();
  }

  /**
   * Fencing for one inbound frame on this transport binding. Returns the
   * queued-mutation promise so callers/tests can observe dispatch ordering.
   */
  receiveFrame(binding: VoiceTransportBinding, frame: VoiceClientFrame): Promise<void> {
    const s = this.session;
    if (binding.closed || s.transport !== binding) {
      this.countStale("detached_transport");
      return Promise.resolve();
    }
    if (frame.sessionId !== s.sessionId) {
      this.countStale("wrong_session");
      return Promise.resolve();
    }
    if (frame.epoch !== binding.epoch) {
      this.countStale("stale_epoch");
      return Promise.resolve();
    }
    if (frame.sequence <= binding.lastInboundSequence) {
      this.countStale("non_monotonic_sequence");
      return Promise.resolve();
    }
    binding.lastInboundSequence = frame.sequence;
    return enqueueSessionTask(s, () => this.dispatch(frame));
  }

  /** Current-state a replacement connection resumes into. */
  resumeTarget(): VoiceSessionState {
    const s = this.session;
    if (s.state === "paused") return "paused";
    if (this.hasActiveRun()) return "thinking";
    return "listening";
  }

  hasActiveRun(): boolean {
    for (const runId of this.session.runIds) {
      if (!this.session.terminalRunIds.has(runId)) return true;
    }
    return false;
  }

  // ----------------------------------------------------------- client frames

  private async dispatch(frame: VoiceClientFrame): Promise<void> {
    const s = this.session;
    if (s.state === "ending" || s.state === "ended") {
      this.countStale("terminal");
      return;
    }
    this.host.touch(s);
    switch (frame.type) {
      case "client.ready":
        await this.pipeline.onClientReady(frame);
        return;
      case "capture.start":
        this.pipeline.onCaptureStart(frame);
        return;
      case "capture.audio":
        this.pipeline.onCaptureAudio(frame);
        return;
      case "capture.stop":
        this.pipeline.onCaptureStop(frame);
        return;
      case "session.pause":
        if (s.state === "listening" || s.state === "thinking" || s.state === "speaking") {
          this.setState("paused");
        } else {
          this.countStale("pause_in_state");
        }
        return;
      case "session.resume":
        if (s.state === "paused") this.setState("listening");
        else this.countStale("resume_in_state");
        return;
      case "session.end":
        // Fire-and-forget inside the queue: engine.finish re-enters the
        // serialized mutation chain after this dispatch completes.
        void this.host.finish(s, frame.reason);
        return;
      case "response.interrupt":
        await this.pipeline.onInterrupt(frame);
        return;
      case "generation.cancel":
        await this.pipeline.onGenerationCancel(frame);
        return;
      case "action.cancel":
        await this.pipeline.onActionCancel(frame);
        return;
      case "playback.segment_played":
        await this.pipeline.onSegmentPlayed(frame);
        return;
      case "device.changed":
        s.inputDeviceId = frame.inputDeviceId ?? s.inputDeviceId;
        s.outputDeviceId = frame.outputDeviceId ?? s.outputDeviceId;
        return;
      case "heartbeat":
        this.emit({ type: "heartbeat.ack", timestampMs: frame.timestampMs });
        return;
      default: {
        const exhaustive: never = frame;
        this.countStale(`unknown_${(exhaustive as { type?: string }).type ?? "frame"}`);
      }
    }
  }

  // ------------------------------------------------------------- delivery io

  heardTextEnd(ledger: VoiceResponseLedger): number {
    let end = 0;
    for (const segment of ledger.segments) {
      if (segment.played) end = Math.max(end, segment.textEnd);
    }
    return end;
  }

  async recordPendingDelivery(ledger: VoiceResponseLedger): Promise<void> {
    const s = this.session;
    if (ledger.pendingRecorded) return;
    try {
      const result = await this.host.delivery.recordPending({
        sessionId: s.sessionId,
        responseId: ledger.responseId,
        runId: ledger.runId,
        transportEpoch: s.epoch,
        segments: ledger.segments.map(({ played: _played, ...segment }) => segment),
      });
      ledger.pendingRecorded = true;
      ledger.deliveryRevision = result.revision;
    } catch (error: unknown) {
      // Missing pending leaves delivery unknown — never "fully heard".
      this.host.log("voice.delivery.pending_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async recordTerminalDelivery(
    ledger: VoiceResponseLedger,
    reason: "complete" | "interrupted" | "ended" | "unknown",
    effectiveThroughMs: number,
  ): Promise<void> {
    const s = this.session;
    if (ledger.terminalRecorded) return;
    ledger.terminalRecorded = true;
    try {
      await this.host.delivery.recordTerminal({
        sessionId: s.sessionId,
        responseId: ledger.responseId,
        transportEpoch: s.epoch,
        reason,
        effectiveThroughMs,
        effectiveTextEnd: this.heardTextEnd(ledger),
      });
    } catch (error: unknown) {
      this.host.log("voice.delivery.terminal_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async maybeCompleteDelivery(ledger: VoiceResponseLedger): Promise<void> {
    const s = this.session;
    if (ledger.state !== "open" || !ledger.generationEnded) return;
    if (!ledger.segments.every((segment) => segment.played)) return;
    ledger.state = "complete";
    await this.recordTerminalDelivery(ledger, "complete", ledger.playedThroughMs);
    if (s.state === "speaking") this.setState("listening");
  }

  // -------------------------------------------------------------- lifecycle

  stopCapture(): void {
    const s = this.session;
    if (s.activeCaptureTurnId !== null) {
      s.adapter?.setCapture(null);
      s.activeCaptureTurnId = null;
    }
    s.queuedAudioMs = 0;
  }

  setState(state: VoiceSessionState): void {
    const s = this.session;
    if (s.state === state || s.state === "ending" || s.state === "ended") return;
    s.state = state;
    this.emit({ type: "session.state", state });
  }

  emitError(code: SafeVoiceErrorCode, retryable: boolean): void {
    this.emit({
      type: "session.error",
      code,
      retryable,
      recovery: VOICE_ERROR_RECOVERY[code] ?? "none",
    });
  }

  emit(fields: ServerFramePayload): void {
    const s = this.session;
    const transport = s.transport;
    if (!transport || transport.closed) return;
    this.sendThrough(transport, fields);
  }

  private sendThrough(transport: VoiceTransportBinding, fields: ServerFramePayload): void {
    if (transport.closed) return;
    const frame = {
      contractVersion: 1,
      sessionId: this.session.sessionId,
      epoch: transport.epoch,
      sequence: transport.nextOutboundSequence++,
      ...fields,
    } as VoiceServerFrame;
    try {
      transport.sink.send(frame);
    } catch (error: unknown) {
      transport.closed = true;
      this.host.log("voice.transport.send_failed", {
        sessionId: this.session.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      this.detachTransport(transport);
    }
  }

  /** Fail the session safely: safe error frame first, then terminal cleanup. */
  async fail(code: SafeVoiceErrorCode, retryable: boolean): Promise<void> {
    this.emitError(code, retryable);
    await this.host.finish(this.session, "failed");
  }

  /**
   * Terminal path — idempotent even when provider shutdown, transport close
   * and DELETE race. Emits the terminal state + going_away, closes the
   * transport, releases adapter/capture/subscription resources.
   */
  async end(kind: VoiceSessionEndKind): Promise<void> {
    const s = this.session;
    if (s.state === "ended" || s.state === "failed") return;
    const failed = kind === "failed" || kind === "idle_limit" || kind === "duration_limit";
    const reason: VoiceSessionStateReason | undefined = kind === "shutdown"
      ? "shutdown"
      : failed
        ? "limit_reached"
        : "user_requested";
    const terminalState: VoiceSessionState = failed ? "failed" : "ended";
    s.state = "ending";
    this.stopCapture();
    const transport = s.transport;
    if (transport && !transport.closed) {
      this.sendThrough(transport, { type: "session.state", state: terminalState, ...(reason ? { reason } : {}) });
      this.sendThrough(transport, {
        type: "transport.going_away",
        retryAfterMs: 0,
        reconnectAllowed: terminalState === "failed",
      });
      transport.closed = true;
      try {
        transport.sink.close(1000, terminalState === "failed" ? "Session failed" : "Session ended");
      } catch (error: unknown) {
        this.host.log("voice.transport.close_failed", {
          sessionId: s.sessionId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    s.transport = null;
    s.state = terminalState;
    s.endedAtMs = this.host.clock.now();
    s.endKind = kind;
    try {
      s.chatSubscription?.close();
    } catch (error: unknown) {
      this.host.log("voice.subscription.close_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    s.chatSubscription = null;
    try {
      await s.adapter?.close();
    } catch (error: unknown) {
      // Cleanup failure is logged; the session must still finish terminal.
      this.host.log("voice.adapter.close_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    s.adapter = null;
    // Any ledger still open is closed out conservatively: unknown for
    // crash/failure paths, ended for deliberate session end.
    const ledgerReason = kind === "failed" || kind === "shutdown" ? "unknown" : "ended";
    for (const ledger of s.responses.values()) {
      if (ledger.state === "open") {
        ledger.state = "interrupted";
        await this.recordTerminalDelivery(ledger, ledgerReason, ledger.playedThroughMs);
      }
    }
  }
}
