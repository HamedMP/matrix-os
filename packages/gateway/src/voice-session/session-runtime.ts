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
import type { PrincipalSource } from "../request-principal.js";
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
  VoiceExecutionPolicy,
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
  canonicalQueuedTurnId: string | null;
  runId: string | null;
  /** True once the bound canonical run reached a terminal state. */
  runTerminal: boolean;
  startedAtMs: number;
}

export interface VoiceLedgerSegment extends VoiceResponseSegment {
  played: boolean;
  synthesisEnded: boolean;
}

/** A provider final held back so canonical admission stays in localOrder. */
export interface VoiceStagedFinal {
  turnId: string;
  finalityId: string;
  text: string;
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
  runTerminal: boolean;
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
  /** Auth-time principal provenance — canonical admission must not guess it. */
  principalSource: PrincipalSource;
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
  executionPolicy?: VoiceExecutionPolicy;
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
  /**
   * Finals held back because an earlier-captured turn still owns the
   * admission head (`nextAdmissionOrder`). Keyed by turnId; naturally bounded
   * by `maxTurns` since staged turns stay non-terminal and never evict.
   */
  stagedFinals: Map<string, VoiceStagedFinal>;
  /** Lowest capture order not yet admitted or terminalized without a final. */
  nextAdmissionOrder: number;
  responses: Map<string, VoiceResponseLedger>;
  runIds: Set<string>;
  terminalRunIds: Set<string>;
  turnOrderCounter: number;
  lastKnownChatRevision: number;
  /** True once the lazy canonical revision hydration ran for this session. */
  chatRevisionLoaded: boolean;
  transport: VoiceTransportBinding | null;
  chatSubscription: VoiceChatEventSubscription | null;
  timers: { idle: VoiceTimer | null; duration: VoiceTimer | null; staging: VoiceTimer | null };
  queuedAudioMs: number;
  activeCaptureTurnId: string | null;
  createdAtMs: number;
  lastActivityAtMs: number;
  endedAtMs: number | null;
  endKind: VoiceSessionEndKind | null;
  ending: Promise<void> | null;
  mutation: Promise<void>;
  pendingMutationTasks: number;
  pendingMutationBytes: number;
  mutationOverflowed: boolean;
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
  readonly maxPendingMutationTasks: number;
  readonly maxPendingMutationBytes: number;
  createId(prefix: string): string;
  log(event: string, fields: Record<string, unknown>): void;
  touch(session: VoiceSessionRecord): void;
  finish(session: VoiceSessionRecord, kind: VoiceSessionEndKind): Promise<void>;
  finishInternal(session: VoiceSessionRecord, kind: VoiceSessionEndKind): Promise<void>;
}

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ServerFramePayload = DistributiveOmit<VoiceServerFrame, keyof VoiceFrameCommon>;

/**
 * Serialize asynchronous session work with an explicit bounded backlog.
 * Lifecycle tasks may bypass admission so overflow can always enqueue one
 * terminal cleanup behind the mutation currently in flight.
 */
export function enqueueSessionTask(
  session: VoiceSessionRecord,
  task: () => Promise<void> | void,
  options: { bytes?: number; bypassLimit?: boolean; propagateError?: boolean } = {},
): Promise<void> {
  const bytes = options.bytes ?? 0;
  if (!options.bypassLimit
    && (session.pendingMutationTasks >= session.runtime.host.maxPendingMutationTasks
      || session.pendingMutationBytes + bytes > session.runtime.host.maxPendingMutationBytes)) {
    return session.runtime.handleMutationOverflow();
  }
  session.pendingMutationTasks += 1;
  session.pendingMutationBytes += bytes;
  const invoke = async (): Promise<void> => {
    try {
      await task();
    } finally {
      session.pendingMutationTasks -= 1;
      session.pendingMutationBytes -= bytes;
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
  return options.propagateError ? run : session.mutation;
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
  /** Capture starts admitted to the bounded mutation queue but not dispatched yet. */
  private readonly pendingCaptureStarts = new Set<string>();

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
      this.pendingCaptureStarts.clear();
    }
    s.transport = binding;
    if (s.state === "connecting") {
      this.emit({ type: "session.state", state: "connecting" });
    } else if (s.state === "reconnecting") {
      // Work may have finished while no transport was attached. Restore the
      // current run truth while preserving an explicit saved pause.
      const restored = this.resumeTarget();
      s.state = restored;
      this.emit({ type: "session.resumed", state: restored, reason: "restored" });
    } else {
      this.emit({ type: "session.state", state: s.state });
    }
    // A rotated epoch strands durable delivery rows on the dead epoch: every
    // later fenced write goes stale. Open ledgers adopt the fresh epoch on
    // the serialized queue so the adoption lands before adapter events that
    // arrive behind this attach.
    if (this.needsEpochAdoption()) {
      void enqueueSessionTask(s, () => this.adoptTransportEpoch());
    }
  }

  /** True when any open ledger has a durable row still fenced to an old epoch. */
  private needsEpochAdoption(): boolean {
    for (const ledger of this.session.responses.values()) {
      if (ledger.state === "open" && ledger.pendingRecorded) return true;
    }
    return false;
  }

  /**
   * Move every still-open delivery row of this Chat onto the freshly
   * committed transport epoch, then resync each open ledger's
   * `deliveryRevision` (adoption bumps row revisions). Best-effort: failures
   * are logged and the next attach retries; the port is idempotent.
   */
  async adoptTransportEpoch(): Promise<void> {
    const s = this.session;
    if (s.state === "ending" || s.state === "ended") return;
    try {
      await this.host.delivery.adoptTransportEpoch({
        sessionId: s.sessionId,
        chatId: s.chatId,
        principalId: s.principalId,
        transportEpoch: s.epoch,
      });
    } catch (error: unknown) {
      this.host.log("voice.delivery.epoch_adopt_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return;
    }
    for (const ledger of s.responses.values()) {
      if (ledger.state !== "open" || !ledger.pendingRecorded) continue;
      try {
        const record = await this.host.delivery.getDelivery({
          sessionId: s.sessionId,
          chatId: s.chatId,
          principalId: s.principalId,
          responseId: ledger.responseId,
        });
        if (record) ledger.deliveryRevision = record.revision;
      } catch (error: unknown) {
        this.host.log("voice.delivery.resync_failed", {
          sessionId: s.sessionId,
          responseId: ledger.responseId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }

  detachTransport(binding: VoiceTransportBinding): void {
    const s = this.session;
    if (s.transport !== binding) return;
    binding.closed = true;
    s.transport = null;
    this.pendingCaptureStarts.clear();
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
    this.pendingCaptureStarts.clear();
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

    if (frame.type === "capture.audio") {
      const turn = s.turns.get(frame.turnId);
      const activeCapture = s.activeCaptureTurnId === frame.turnId && turn?.phase === "capturing";
      const terminal = s.state === "ending" || s.state === "ended" || s.state === "failed";
      if (activeCapture && !terminal) {
        this.host.touch(s);
        this.pipeline.onCaptureAudio(frame);
        return Promise.resolve();
      }
      if (!this.pendingCaptureStarts.has(frame.turnId)) {
        this.countStale("audio_for_inactive_turn");
        return Promise.resolve();
      }
    }

    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    const audioMs = frame.type === "capture.audio" ? s.audio?.frameDurationMs ?? 20 : 0;
    if (audioMs && s.queuedAudioMs + audioMs > this.host.limits.maxQueuedAudioMs) {
      const turn = s.activeCaptureTurnId ? s.turns.get(s.activeCaptureTurnId) : undefined;
      if (turn?.phase === "capturing") turn.phase = "finalizing";
      this.stopCapture();
      this.emitError("audio_backpressure", true);
      this.setState("paused");
      return Promise.resolve();
    }
    s.queuedAudioMs += audioMs;
    if (frame.type === "capture.start") this.pendingCaptureStarts.add(frame.turnId);
    return enqueueSessionTask(s, () => {
      if (frame.type === "capture.start") this.pendingCaptureStarts.delete(frame.turnId);
      // Admission-time checks are insufficient: a reconnect/end can replace
      // this binding while the frame waits behind an asynchronous mutation.
      if (binding.closed || s.transport !== binding || frame.epoch !== s.epoch
        || frame.epoch !== binding.epoch || s.state === "ending"
        || s.state === "ended" || s.state === "failed") {
        this.countStale("binding_changed_before_dispatch");
        return;
      }
      return this.dispatch(frame);
    }, { bytes }).finally(() => { s.queuedAudioMs -= audioMs; });
  }

  /** Close admission immediately, then terminate in queue order exactly once. */
  handleMutationOverflow(): Promise<void> {
    const s = this.session;
    if (s.mutationOverflowed) return s.ending ?? s.mutation;
    s.mutationOverflowed = true;
    this.pendingCaptureStarts.clear();
    this.host.log("voice.session.mutation_overflow", {
      sessionId: s.sessionId,
      pendingTasks: s.pendingMutationTasks,
      pendingBytes: s.pendingMutationBytes,
    });
    this.emitError("session_limit_reached", false);
    this.closeTransportGracefully("Session backlog exceeded", false);
    return this.host.finish(s, "failed");
  }

  /** Current-state a replacement connection resumes into. */
  resumeTarget(): VoiceSessionState {
    const s = this.session;
    if (s.state === "paused" || (s.state === "reconnecting" && s.restorableState === "paused")) return "paused";
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
        if (s.state === "listening" || s.state === "thinking" || s.state === "using_tool" || s.state === "speaking") {
          this.stopCapture();
          this.setState("paused");
        } else {
          this.countStale("pause_in_state");
        }
        return;
      case "session.resume":
        if (s.state === "paused") this.setState("listening", true);
        else this.countStale("resume_in_state");
        return;
      case "session.end":
        await this.host.finishInternal(s, frame.reason);
        return;
      case "response.interrupt":
        await this.stopSpeaking(frame);
        return;
      case "generation.cancel":
        await this.cancelGeneration(frame);
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

  /** An audio terminal is not a canonical run terminal. A user can still
   * explicitly cancel generation after Stop speaking without implying rollback. */
  private async cancelGeneration(frame: Extract<VoiceClientFrame, { type: "generation.cancel" }>): Promise<void> {
    const s = this.session;
    const ledger = s.responses.get(frame.responseId);
    if (!ledger || ledger.state === "open") {
      await this.pipeline.onGenerationCancel(frame);
      return;
    }
    if (!s.runIds.has(ledger.runId) || s.terminalRunIds.has(ledger.runId) || !this.host.runControl) return;
    try {
      await this.host.runControl.cancelRun({ chatId: s.chatId, runId: ledger.runId,
        principalId: s.principalId, reason: "user" });
    } catch (error: unknown) {
      this.host.log("voice.run_control.cancel_failed", { sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError" });
      this.emitError("internal_failure", true);
    }
  }

  /** Explicit Stop speaking affects media/delivery only. Capture barge-in
   * continues to use the pipeline's canonical generation interruption path. */
  private async stopSpeaking(frame: Extract<VoiceClientFrame, { type: "response.interrupt" }>): Promise<void> {
    const s = this.session;
    const ledger = s.responses.get(frame.responseId);
    if (!ledger || ledger.state !== "open") {
      this.countStale("interrupt_for_terminal_response");
      return;
    }
    ledger.state = "interrupted";
    const effectiveThroughMs = Math.min(frame.playedThroughMs, ledger.deliveredThroughMs);
    s.adapter?.interrupt(ledger.responseId, effectiveThroughMs);
    await this.recordTerminalDelivery(ledger, "interrupted", effectiveThroughMs);
    this.emit({ type: "response.interrupted", responseId: ledger.responseId, effectiveThroughMs });
    if (ACTIVE_SESSION_STATES.has(s.state)) this.setState("listening");
  }

  // ------------------------------------------------------------- delivery io

  heardTextEnd(ledger: VoiceResponseLedger): number {
    let end = 0;
    for (const segment of ledger.segments) {
      if (segment.played) end = Math.max(end, segment.textEnd);
    }
    return end;
  }

  /**
   * Hydrate `lastKnownChatRevision` from canonical truth, once per session.
   * A baseRevision frozen at 0 would otherwise reject the first voice turn on
   * any Chat that already has history. Returns the freshest known revision.
   */
  async hydrateChatRevision(): Promise<number> {
    const s = this.session;
    if (!s.chatRevisionLoaded) {
      s.chatRevisionLoaded = true;
      if (this.host.admission.loadChatRevision) {
        try {
          const revision = await this.host.admission.loadChatRevision({
            chatId: s.chatId,
            principalId: s.principalId,
          });
          if (revision !== null) {
            s.lastKnownChatRevision = Math.max(s.lastKnownChatRevision, revision);
          }
        } catch (error: unknown) {
          // Unreadable canonical record — admission itself revalidates.
          this.host.log("voice.admission.revision_load_failed", {
            sessionId: s.sessionId,
            error: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
    }
    return s.lastKnownChatRevision;
  }

  /**
   * Persist the pending record (manifest = current ledger snapshot, which by
   * construction already holds the first segment). Returns false when the
   * write did not land — a row that cannot be written can never be acked, so
   * callers must fail the response rather than track phantom playback.
   */
  async recordPendingDelivery(ledger: VoiceResponseLedger): Promise<boolean> {
    const s = this.session;
    if (ledger.pendingRecorded) return true;
    try {
      const result = await this.host.delivery.recordPending({
        sessionId: s.sessionId,
        chatId: s.chatId,
        principalId: s.principalId,
        responseId: ledger.responseId,
        runId: ledger.runId,
        transportEpoch: s.epoch,
        segments: ledger.segments.map(({ played: _played, synthesisEnded: _synthesisEnded, ...segment }) => segment),
      });
      ledger.pendingRecorded = true;
      ledger.deliveryRevision = result.revision;
      return true;
    } catch (error: unknown) {
      // Missing pending leaves delivery unknown — never "fully heard".
      this.host.log("voice.delivery.pending_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return false;
    }
  }

  /**
   * Append one new segment to the durable manifest before its synthesis.
   * Returns false when the extension did not land (stale fence, terminal or
   * missing row, store failure) — playback must not continue untracked.
   */
  async extendDeliveryManifest(
    ledger: VoiceResponseLedger,
    segment: VoiceLedgerSegment,
  ): Promise<boolean> {
    const s = this.session;
    if (!ledger.pendingRecorded || ledger.state !== "open") return false;
    try {
      const result = await this.host.delivery.extendManifest({
        sessionId: s.sessionId,
        chatId: s.chatId,
        principalId: s.principalId,
        responseId: ledger.responseId,
        transportEpoch: s.epoch,
        deliveryRevision: ledger.deliveryRevision,
        appendSegments: [{
          segmentId: segment.segmentId,
          segmentIndex: segment.segmentIndex,
          textStart: segment.textStart,
          textEnd: segment.textEnd,
          durationMs: segment.durationMs,
        }],
      });
      if (result === "ignored") {
        this.host.log("voice.delivery.extend_ignored", {
          sessionId: s.sessionId,
          responseId: ledger.responseId,
        });
        return false;
      }
      ledger.deliveryRevision = result.revision;
      return true;
    } catch (error: unknown) {
      this.host.log("voice.delivery.extend_failed", {
        sessionId: s.sessionId,
        responseId: ledger.responseId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return false;
    }
  }

  /**
   * Persist the delivered-audio boundary. Returns false when the boundary
   * did not land — audio the durable record cannot bound must not be relayed
   * to the client, so callers fail the response instead.
   */
  async recordDeliveredProgress(ledger: VoiceResponseLedger): Promise<boolean> {
    const s = this.session;
    if (!ledger.pendingRecorded || ledger.state !== "open") return false;
    try {
      const result = await this.host.delivery.recordDelivered({
        sessionId: s.sessionId,
        chatId: s.chatId,
        principalId: s.principalId,
        responseId: ledger.responseId,
        transportEpoch: s.epoch,
        deliveredThroughMs: ledger.deliveredThroughMs,
        deliveryRevision: ledger.deliveryRevision,
        segments: ledger.segments.map(({ played: _played, synthesisEnded: _synthesisEnded, ...segment }) => segment),
      });
      if (result === "ignored") {
        this.host.log("voice.delivery.delivered_ignored", {
          sessionId: s.sessionId,
          responseId: ledger.responseId,
        });
        return false;
      }
      ledger.deliveryRevision = result.revision;
      return true;
    } catch (error: unknown) {
      this.host.log("voice.delivery.delivered_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return false;
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
        chatId: s.chatId,
        principalId: s.principalId,
        responseId: ledger.responseId,
        runId: ledger.runId,
        transportEpoch: s.epoch,
        reason,
        effectiveThroughMs,
        effectiveTextEnd: this.heardTextEnd(ledger),
        ...(ledger.pendingRecorded ? { deliveryRevision: ledger.deliveryRevision } : {}),
        segments: ledger.segments.map(({ played: _played, synthesisEnded: _synthesisEnded, ...segment }) => segment),
      });
    } catch (error: unknown) {
      this.host.log("voice.delivery.terminal_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    // A terminal ledger is the last thing needing its run's correlation.
    this.releaseTerminalRun(ledger.runId);
  }

  async maybeCompleteDelivery(ledger: VoiceResponseLedger): Promise<void> {
    const s = this.session;
    if (ledger.state !== "open" || !ledger.runTerminal) return;
    if (!ledger.segments.every((segment) => segment.synthesisEnded)) return;
    if (!ledger.segments.every((segment) => segment.played)) return;
    ledger.state = "complete";
    await this.recordTerminalDelivery(ledger, "complete", ledger.playedThroughMs);
    this.releaseTerminalRun(ledger.runId);
    if (s.state === "speaking") this.setState("listening");
  }

  /**
   * Correlate one canonical run with this session. Bounded by `maxRunIds`:
   * under pressure, terminal runs are released first (their ledger writes no
   * longer consult the set); terminal runs with open ledgers drop last —
   * their fenced delivery IO does not read `runIds` either. Returns false
   * when the cap still binds (the event is then dropped, never correlated).
   */
  trackRun(runId: string): boolean {
    const s = this.session;
    if (s.runIds.has(runId)) return true;
    if (s.runIds.size >= this.host.maxRunIds) {
      for (const terminal of [...s.terminalRunIds]) this.releaseTerminalRun(terminal);
    }
    if (s.runIds.size >= this.host.maxRunIds) {
      for (const terminal of s.terminalRunIds) {
        s.terminalRunIds.delete(terminal);
        s.runIds.delete(terminal);
      }
    }
    if (s.runIds.size >= this.host.maxRunIds) return false;
    s.runIds.add(runId);
    return true;
  }

  /**
   * Release run correlation once the run is terminal AND no open ledger
   * still references it. Terminal runs emit no further canonical events, so
   * the set entries are dead weight once their delivery pipeline finished.
   */
  releaseTerminalRun(runId: string): void {
    const s = this.session;
    if (!s.terminalRunIds.has(runId)) return;
    for (const ledger of s.responses.values()) {
      if (ledger.runId === runId && ledger.state === "open") return;
    }
    s.runIds.delete(runId);
    s.terminalRunIds.delete(runId);
  }

  // -------------------------------------------------------------- lifecycle

  stopCapture(): void {
    const s = this.session;
    if (s.activeCaptureTurnId !== null) {
      s.adapter?.setCapture(null);
      s.activeCaptureTurnId = null;
    }
  }

  setState(state: VoiceSessionState, explicitResume = false): void {
    const s = this.session;
    if (s.state === state || s.state === "ending" || s.state === "ended") return;
    // Only attachTransport commits the resumed lifecycle and epoch handshake.
    if (s.state === "reconnecting" && ACTIVE_SESSION_STATES.has(state)) return;
    // Canonical work continues while paused; it must not reopen capture.
    if (s.state === "paused" && ACTIVE_SESSION_STATES.has(state) && !explicitResume) return;
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
    await this.host.finishInternal(this.session, "failed");
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
