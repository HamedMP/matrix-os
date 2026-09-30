/**
 * Voice session pipeline — payload handlers for `VoiceSessionRuntime`.
 *
 * Covers the turn coordinator (capture frames → provisional relay →
 * once-only canonical admission), provider-adapter events (STT/VAD/
 * synthesis), canonical run events (operation.status relay, synthesis
 * queue), playback acknowledgements → delivery port, and interruption
 * bookkeeping. All handlers run inside the session's serialized mutation
 * queue so admission and ledger writes stay ordered.
 */
import type {
  SafeVoiceErrorCode,
  VoiceClientFrame,
  VoiceRecoveryAction,
  VoiceSessionState,
} from "@matrix-os/contracts/voice-session";
import type { VoiceAdapterEvent } from "./adapter.js";
import type { VoiceCanonicalChatEvent } from "./ports.js";
import {
  ACTIVE_SESSION_STATES,
  boundedInsert,
  enqueueSessionTask,
  type VoiceLedgerSegment,
  type VoiceResponseLedger,
  type VoiceSessionHost,
  type VoiceSessionRecord,
  type VoiceSessionRuntime,
  type VoiceStagedFinal,
  type VoiceTurnRecord,
} from "./session-runtime.js";

const TERMINAL_OPERATION_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "outcome_unknown",
]);

const MAX_FINALITY_ENTRIES = 512;
const MAX_SYNTHESIS_PHRASE_CHARS = 240;

interface PendingSynthesisPhrase {
  text: string;
  textStart: number;
  textEnd: number;
}

/** States where the client may open a capture turn (conversation is live). */
const CAPTURE_STATES: ReadonlySet<VoiceSessionState> = new Set([
  "listening",
  "thinking",
  "using_tool",
  "speaking",
]);

/**
 * Bounded wait for a hole in the admission order: a staged final waits this
 * long for the earlier-captured turn to produce its own final (or
 * terminalize) before the engine abandons the hole and admits in the order
 * the remaining finals actually arrived.
 */
export const STAGED_FINAL_MAX_WAIT_MS = 15_000;

export class VoiceSessionPipeline {
  private readonly pendingPhrases = new Map<string, PendingSynthesisPhrase>();

  constructor(
    private readonly session: VoiceSessionRecord,
    private readonly host: VoiceSessionHost,
    private readonly runtime: VoiceSessionRuntime,
  ) {}

  // ----------------------------------------------------------- client frames

  async onClientReady(
    frame: Extract<VoiceClientFrame, { type: "client.ready" }>,
  ): Promise<void> {
    const s = this.session;
    s.audio = frame.audio;
    s.clientMedia = frame.capabilities;
    if (s.adapter) return;
    const adapter = this.host.adapters.get(s.adapterId);
    if (!adapter) {
      await this.runtime.fail("provider_unavailable", true);
      return;
    }
    try {
      s.adapter = await adapter.start({
        sessionId: s.sessionId,
        chatId: s.chatId,
        principalId: s.principalId,
        turnMode: s.turnMode,
        memoryMode: s.memoryMode,
        ...(s.locale !== undefined ? { locale: s.locale } : {}),
        audio: frame.audio,
        clientCapabilities: frame.capabilities,
        emit: (event) => this.onAdapterEvent(event),
      });
    } catch (error: unknown) {
      this.host.log("voice.adapter.start_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      await this.runtime.fail("provider_unavailable", true);
      return;
    }
    if (s.state === "connecting") this.runtime.setState("listening");
  }

  /**
   * A turn record is safe to evict once nothing in flight still needs it:
   * empty/rejected turns immediately; admitted turns once their canonical
   * run reached terminal AND no open delivery ledger still references that
   * run. Queued-but-unpromoted admissions (`runId` null) keep their slot —
   * `run.started` still needs their `qturn_`/`cturn_` identity to correlate.
   */
  private turnTrackingComplete(turn: VoiceTurnRecord): boolean {
    if (turn.phase === "empty" || turn.phase === "rejected") return true;
    if (turn.phase !== "admitted" || !turn.runTerminal || !turn.runId) return false;
    for (const ledger of this.session.responses.values()) {
      if (ledger.runId === turn.runId && ledger.state === "open") return false;
    }
    return true;
  }

  onCaptureStart(frame: Extract<VoiceClientFrame, { type: "capture.start" }>): void {
    const s = this.session;
    if (!CAPTURE_STATES.has(s.state) || s.activeCaptureTurnId !== null) {
      this.runtime.countStale("capture_start_in_state");
      return;
    }
    if (s.turns.has(frame.turnId)) {
      this.runtime.countStale("duplicate_turn");
      return;
    }
    const evictable = (turn: VoiceTurnRecord) => this.turnTrackingComplete(turn);
    if (!boundedInsert(s.turns, this.host.maxTurns, evictable)) {
      this.runtime.emitError("session_limit_reached", false);
      return;
    }
    // Admission snapshot: frozen policy + last known Chat revision; the
    // canonical admission authority refreshes revision at finalization.
    const turn: VoiceTurnRecord = {
      turnId: frame.turnId,
      localOrder: ++s.turnOrderCounter,
      requestId: this.host.createId("req"),
      phase: "capturing",
      mode: frame.mode,
      baseRevision: s.lastKnownChatRevision,
      provisionalRevision: -1,
      finalityId: null,
      finalText: null,
      canonicalTurnId: null,
      canonicalQueuedTurnId: null,
      runId: null,
      runTerminal: false,
      startedAtMs: this.host.clock.now(),
    };
    s.turns.set(turn.turnId, turn);
    s.activeCaptureTurnId = turn.turnId;
    s.queuedAudioMs = 0;
    s.adapter?.setCapture({ turnId: turn.turnId, mode: frame.mode });
  }

  onCaptureAudio(frame: Extract<VoiceClientFrame, { type: "capture.audio" }>): void {
    const s = this.session;
    const turn = s.turns.get(frame.turnId);
    if (!turn || turn.phase !== "capturing" || s.activeCaptureTurnId !== turn.turnId) {
      this.runtime.countStale("audio_for_inactive_turn");
      return;
    }
    s.adapter?.pushAudio({ turnId: turn.turnId, timestampMs: frame.timestampMs, data: frame.data });
    s.queuedAudioMs += s.audio?.frameDurationMs ?? 20;
    if (s.queuedAudioMs >= this.host.limits.maxQueuedAudioMs) {
      // Backpressure: pause capture explicitly; never grow the queue.
      this.runtime.stopCapture();
      turn.phase = "finalizing";
      this.runtime.emitError("audio_backpressure", true);
      this.runtime.setState("paused");
    }
  }

  onCaptureStop(frame: Extract<VoiceClientFrame, { type: "capture.stop" }>): void {
    const s = this.session;
    const turn = s.turns.get(frame.turnId);
    if (!turn || turn.phase !== "capturing") {
      this.runtime.countStale("stop_for_inactive_turn");
      return;
    }
    turn.phase = "finalizing";
    if (s.activeCaptureTurnId === turn.turnId) s.activeCaptureTurnId = null;
    s.queuedAudioMs = 0;
    s.adapter?.setCapture(null);
  }

  async onInterrupt(
    frame: Extract<VoiceClientFrame, { type: "response.interrupt" }>,
  ): Promise<void> {
    const s = this.session;
    const ledger = s.responses.get(frame.responseId);
    if (!ledger || ledger.state !== "open") {
      this.runtime.countStale("interrupt_for_terminal_response");
      return;
    }
    ledger.state = "interrupted";
    const effectiveThroughMs = Math.min(frame.playedThroughMs, ledger.deliveredThroughMs);
    s.adapter?.interrupt(ledger.responseId, effectiveThroughMs);
    // Barge-in must also stop the canonical run still producing the audio —
    // a local playback stop alone leaves it executing and streaming text.
    if (s.runIds.has(ledger.runId) && this.host.runControl) {
      try {
        await this.host.runControl.cancelRun({
          chatId: s.chatId,
          runId: ledger.runId,
          principalId: s.principalId,
          reason: "interruption",
        });
      } catch (error: unknown) {
        this.host.log("voice.run_control.cancel_failed", {
          sessionId: s.sessionId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    await this.runtime.recordTerminalDelivery(ledger, "interrupted", effectiveThroughMs);
    this.runtime.emit({
      type: "response.interrupted",
      responseId: ledger.responseId,
      effectiveThroughMs,
    });
    if (ACTIVE_SESSION_STATES.has(s.state)) this.runtime.setState("listening");
  }

  async onGenerationCancel(
    frame: Extract<VoiceClientFrame, { type: "generation.cancel" }>,
  ): Promise<void> {
    const s = this.session;
    const ledger = s.responses.get(frame.responseId);
    if (!ledger || ledger.state !== "open") {
      this.runtime.countStale("cancel_for_unknown_response");
      return;
    }
    ledger.state = "interrupted";
    s.adapter?.cancelResponse(ledger.responseId);
    if (s.runIds.has(ledger.runId) && this.host.runControl) {
      try {
        await this.host.runControl.cancelRun({
          chatId: s.chatId,
          runId: ledger.runId,
          principalId: s.principalId,
          reason: "user",
        });
      } catch (error: unknown) {
        this.host.log("voice.run_control.cancel_failed", {
          sessionId: s.sessionId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    await this.runtime.recordTerminalDelivery(ledger, "interrupted", ledger.playedThroughMs);
    this.runtime.emit({
      type: "response.interrupted",
      responseId: ledger.responseId,
      effectiveThroughMs: ledger.playedThroughMs,
    });
    if (ACTIVE_SESSION_STATES.has(s.state)) this.runtime.setState("listening");
  }

  async onActionCancel(
    frame: Extract<VoiceClientFrame, { type: "action.cancel" }>,
  ): Promise<void> {
    if (!this.host.runControl) {
      this.runtime.countStale("action_cancel_unsupported");
      return;
    }
    let outcome: "cancelled" | "unavailable" | "unknown";
    try {
      outcome = await this.host.runControl.cancelAction({
        chatId: this.session.chatId,
        actionId: frame.actionId,
        principalId: this.session.principalId,
      });
    } catch (error: unknown) {
      this.host.log("voice.run_control.action_cancel_failed", {
        sessionId: this.session.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      this.runtime.emitError("chat_unavailable", true);
      return;
    }
    // Never silently succeed: tell the client when nothing was cancelled.
    if (outcome === "unavailable") {
      this.runtime.emitError("unsupported_surface", false);
    } else if (outcome === "unknown") {
      this.runtime.emitError("session_conflict", false);
    }
  }

  async onSegmentPlayed(
    frame: Extract<VoiceClientFrame, { type: "playback.segment_played" }>,
  ): Promise<void> {
    const s = this.session;
    const ledger = s.responses.get(frame.responseId);
    if (!ledger || ledger.state !== "open") {
      this.runtime.countStale("ack_for_terminal_response");
      return;
    }
    const segment = ledger.segments.find((entry) => entry.segmentId === frame.segmentId);
    if (!segment || segment.played) {
      this.runtime.countStale("ack_for_unknown_segment");
      return;
    }
    const playedThroughMs = Math.min(frame.playedThroughMs, ledger.deliveredThroughMs);
    let ack;
    try {
      ack = await this.host.delivery.acknowledge({
        sessionId: s.sessionId,
        chatId: s.chatId,
        principalId: s.principalId,
        responseId: ledger.responseId,
        segmentId: segment.segmentId,
        transportEpoch: s.epoch,
        playedThroughMs,
        deliveryRevision: frame.deliveryRevision,
        effectiveTextEnd: segment.textEnd,
      });
    } catch (error: unknown) {
      this.host.log("voice.delivery.ack_failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return;
    }
    if (ack === "out_of_order") {
      // Acks must advance contiguously in manifest order; a skip-ack never
      // marks the segment played, so `complete` stays unreachable until the
      // predecessors acknowledge.
      this.runtime.countStale("ack_out_of_order");
      return;
    }
    if (ack === "ignored") {
      this.runtime.countStale("ack_ignored_by_ledger");
      return;
    }
    segment.played = true;
    ledger.deliveryRevision = ack.revision;
    ledger.playedThroughMs = Math.max(ledger.playedThroughMs, playedThroughMs);
    await this.runtime.maybeCompleteDelivery(ledger);
  }

  // ------------------------------------------------------------ media events

  onAdapterEvent(event: VoiceAdapterEvent): void {
    const s = this.session;
    if (s.state === "ending" || s.state === "ended") {
      this.runtime.countStale("adapter_terminal");
      return;
    }
    void enqueueSessionTask(s, () => this.dispatchAdapterEvent(event));
  }

  private async dispatchAdapterEvent(event: VoiceAdapterEvent): Promise<void> {
    const s = this.session;
    switch (event.type) {
      case "vad": {
        const turn = s.turns.get(event.turnId);
        if (!turn) {
          this.runtime.countStale("vad_for_unknown_turn");
          return;
        }
        if (event.action === "speech_end" && turn.phase === "capturing") {
          turn.phase = "finalizing";
          s.queuedAudioMs = 0;
        }
        return;
      }
      case "transcript.provisional": {
        const turn = s.turns.get(event.turnId);
        if (!turn || (turn.phase !== "capturing" && turn.phase !== "finalizing")) {
          this.runtime.countStale("provisional_for_inactive_turn");
          return;
        }
        if (event.revision <= turn.provisionalRevision) {
          this.runtime.countStale("provisional_regression");
          return;
        }
        turn.provisionalRevision = event.revision;
        this.runtime.emit({
          type: "transcript.provisional",
          turnId: turn.turnId,
          revision: event.revision,
          text: event.text,
        });
        return;
      }
      case "transcript.final":
        await this.onAdapterFinal(event);
        return;
      case "capture.completed": {
        const turn = s.turns.get(event.turnId);
        if (!turn || turn.phase === "admitted" || turn.phase === "rejected" || turn.phase === "empty") {
          this.runtime.countStale("completion_for_terminal_turn");
          return;
        }
        turn.phase = event.outcome === "empty" ? "empty" : "rejected";
        if (s.activeCaptureTurnId === turn.turnId) {
          s.activeCaptureTurnId = null;
          s.queuedAudioMs = 0;
          s.adapter?.setCapture(null);
        }
        this.runtime.emit({ type: "capture.completed", turnId: turn.turnId, outcome: event.outcome });
        await this.drainAdmissionQueue();
        return;
      }
      case "transcript.correction": {
        const turn = s.turns.get(event.turnId);
        // Corrections annotate an admitted final only; they never re-execute.
        if (!turn || turn.phase !== "admitted") {
          this.runtime.countStale("correction_for_unadmitted_turn");
          return;
        }
        this.runtime.emit({
          type: "transcript.correction",
          turnId: turn.turnId,
          finalityId: event.finalityId,
          revision: event.revision,
          text: event.text,
        });
        return;
      }
      case "synthesis.audio": {
        const ledger = s.responses.get(event.responseId);
        if (!ledger || ledger.state !== "open") {
          this.runtime.countStale("audio_for_terminal_response");
          return;
        }
        const durableSegmentId = event.durableSegmentId ?? event.segmentId;
        const segment = ledger.segments.find((entry) => entry.segmentId === durableSegmentId);
        if (!segment) {
          this.runtime.countStale("audio_for_unknown_segment");
          return;
        }
        segment.durationMs += event.durationMs;
        ledger.deliveredThroughMs += event.durationMs;
        // The durable delivered boundary caps every later ack. If it cannot
        // be persisted, this audio must not be relayed as durable output.
        const persisted = await this.runtime.recordDeliveredProgress(ledger);
        if (!persisted) {
          await this.failUndurableResponse(ledger);
          return;
        }
        this.runtime.emit({
          type: "response.audio",
          responseId: ledger.responseId,
          segmentId: event.segmentId,
          startMs: event.startMs,
          data: event.data,
          ...(event.format ? { format: event.format } : {}),
        });
        if (s.state === "thinking" || s.state === "using_tool") this.runtime.setState("speaking");
        return;
      }
      case "synthesis.end": {
        const ledger = s.responses.get(event.responseId);
        if (!ledger || ledger.state !== "open") {
          this.runtime.countStale("synthesis_end_for_terminal_response");
          return;
        }
        if (event.segmentId) {
          const segment = ledger.segments.find((entry) => entry.segmentId === event.segmentId);
          if (!segment) {
            this.runtime.countStale("synthesis_end_for_unknown_segment");
            return;
          }
          segment.synthesisEnded = true;
        } else {
          for (const segment of ledger.segments) segment.synthesisEnded = true;
        }
        this.runtime.emit({
          type: "response.audio_end",
          responseId: ledger.responseId,
          generatedDurationMs: event.generatedDurationMs,
        });
        await this.runtime.maybeCompleteDelivery(ledger);
        return;
      }
      case "synthesis.rejected": {
        const ledger = s.responses.get(event.responseId);
        if (!ledger || ledger.state !== "open") {
          this.runtime.countStale("synthesis_rejected_for_terminal_response");
          return;
        }
        this.runtime.emitError(event.code, event.retryable);
        await this.failRejectedSynthesis(ledger);
        return;
      }
      case "error":
        this.runtime.emitError(event.code, event.retryable);
        if (event.fatal) {
          void this.host.finish(s, "failed");
        }
        return;
      default: {
        const exhaustive: never = event;
        this.runtime.countStale(`adapter_${(exhaustive as { type?: string }).type ?? "event"}`);
      }
    }
  }

  private async onAdapterFinal(
    event: Extract<VoiceAdapterEvent, { type: "transcript.final" }>,
  ): Promise<void> {
    const s = this.session;
    if (s.finalityToTurn.has(event.finalityId)) {
      this.runtime.countStale("duplicate_finality");
      return;
    }
    const turn = s.turns.get(event.turnId);
    if (!turn || turn.phase === "admitted" || turn.phase === "rejected" || turn.phase === "empty") {
      this.runtime.countStale("final_for_terminal_turn");
      return;
    }
    if (turn.finalityId !== null || s.stagedFinals.has(turn.turnId)) {
      // One final per turn: the first provider final owns the slot.
      this.runtime.countStale("duplicate_turn_final");
      return;
    }
    // The provider finished this turn — release capture so the next turn can
    // start once the session returns to listening.
    if (s.activeCaptureTurnId === turn.turnId) {
      s.activeCaptureTurnId = null;
      s.queuedAudioMs = 0;
      s.adapter?.setCapture(null);
    }
    if (event.truncated === true || event.text.trim().length === 0) {
      // Empty or truncated finals are never executed; the turn terminalizes
      // without admission and releases any staged finals ordered behind it.
      turn.phase = "empty";
      this.host.log("voice.turn.empty_final", { sessionId: s.sessionId, turnId: turn.turnId });
      await this.drainAdmissionQueue();
      return;
    }
    if (s.finalityToTurn.size >= MAX_FINALITY_ENTRIES) {
      s.finalityToTurn.delete(s.finalityToTurn.keys().next().value!);
    }
    s.finalityToTurn.set(event.finalityId, turn.turnId);
    turn.finalityId = event.finalityId;
    turn.finalText = event.text;
    turn.phase = "finalizing";
    // Provider completion order must never override capture order: stage the
    // final and let the ordered drain admit it when the head frees up.
    if (s.stagedFinals.size >= this.host.maxTurns) {
      // Defensive bound — staged turns never evict, so this can only trip on
      // pathological re-ordering across a full turn table.
      turn.phase = "rejected";
      this.runtime.emitError("session_limit_reached", false);
      await this.drainAdmissionQueue();
      return;
    }
    s.stagedFinals.set(turn.turnId, {
      turnId: turn.turnId,
      finalityId: event.finalityId,
      text: event.text,
    });
    this.armStagingTimer();
    await this.drainAdmissionQueue();
  }

  /**
   * Admit staged finals strictly in capture `localOrder`. The head of the
   * order is the lowest order not yet resolved; empty/rejected/admitted and
   * evicted turns are skipped holes. A staged final at or below the head
   * admits immediately; finals above it keep waiting.
   */
  private async drainAdmissionQueue(): Promise<void> {
    const s = this.session;
    for (;;) {
      if (s.state === "ending" || s.state === "ended") break;
      this.skipResolvedOrders();
      let candidate: VoiceStagedFinal | undefined;
      let candidateOrder = Number.POSITIVE_INFINITY;
      const orphaned: string[] = [];
      for (const staged of s.stagedFinals.values()) {
        const turn = s.turns.get(staged.turnId);
        if (!turn) {
          // The owning turn was evicted/removed — the staged final is dead.
          orphaned.push(staged.turnId);
          continue;
        }
        if (turn.localOrder > s.nextAdmissionOrder) continue;
        if (turn.localOrder < candidateOrder) {
          candidate = staged;
          candidateOrder = turn.localOrder;
        }
      }
      for (const turnId of orphaned) s.stagedFinals.delete(turnId);
      if (!candidate) break;
      s.stagedFinals.delete(candidate.turnId);
      const turn = s.turns.get(candidate.turnId)!;
      await this.admitTurnFinal(turn, candidate);
    }
    this.syncStagingTimer();
  }

  /** Advance the admission head past resolved or missing turns. */
  private skipResolvedOrders(): void {
    const s = this.session;
    while (s.nextAdmissionOrder <= s.turnOrderCounter) {
      const turn = this.turnAtOrder(s.nextAdmissionOrder);
      // Missing = evicted terminal turn; resolved phases pass straight over.
      if (turn && turn.phase !== "admitted" && turn.phase !== "rejected" && turn.phase !== "empty") {
        break;
      }
      s.nextAdmissionOrder += 1;
    }
  }

  private turnAtOrder(order: number): VoiceTurnRecord | undefined {
    for (const turn of this.session.turns.values()) {
      if (turn.localOrder === order) return turn;
    }
    return undefined;
  }

  /** Arm the bounded hole wait while any staged final is held. */
  private armStagingTimer(): void {
    const s = this.session;
    if (s.timers.staging || s.stagedFinals.size === 0) return;
    s.timers.staging = this.host.clock.after(STAGED_FINAL_MAX_WAIT_MS, () => {
      s.timers.staging = null;
      void enqueueSessionTask(s, async () => {
        this.skipResolvedOrders();
        const head = this.turnAtOrder(s.nextAdmissionOrder);
        if (head && !s.stagedFinals.has(head.turnId)
          && (head.phase === "capturing" || head.phase === "finalizing")) {
          // The blocking turn never resolved inside the bounded wait —
          // abandon the hole; a late final for it still admits (its order is
          // already below the head by then).
          this.host.log("voice.turn.order_wait_expired", {
            sessionId: s.sessionId,
            turnId: head.turnId,
          });
          s.nextAdmissionOrder = head.localOrder + 1;
        }
        await this.drainAdmissionQueue();
      });
    });
  }

  private syncStagingTimer(): void {
    const s = this.session;
    if (s.stagedFinals.size > 0) {
      this.armStagingTimer();
      return;
    }
    s.timers.staging?.cancel();
    s.timers.staging = null;
  }

  /** Terminalize a non-admitted capture once so hands-free clients can rotate turn ids. */
  private completeFailedCapture(turn: VoiceTurnRecord): void {
    if (turn.phase === "admitted" || turn.phase === "rejected" || turn.phase === "empty") return;
    turn.phase = "rejected";
    const s = this.session;
    if (s.activeCaptureTurnId === turn.turnId) {
      s.activeCaptureTurnId = null;
      s.queuedAudioMs = 0;
      s.adapter?.setCapture(null);
    }
    this.runtime.emit({ type: "capture.completed", turnId: turn.turnId, outcome: "failed" });
  }

  /**
   * One ordered canonical admission for a resolved final. Hydrates the chat
   * revision lazily (once per session) so a stale frozen baseRevision cannot
   * reject the first voice turn on a Chat that already has history.
   */
  private async admitTurnFinal(turn: VoiceTurnRecord, final: VoiceStagedFinal): Promise<void> {
    const s = this.session;
    // The admission rides the freshest known revision, not the stale
    // capture-time snapshot; the canonical port additionally re-reads and
    // retries once on a revision conflict.
    turn.baseRevision = await this.runtime.hydrateChatRevision();
    const result = await this.host.admission.admitFinalTranscript({
      sessionId: s.sessionId,
      chatId: s.chatId,
      principalId: s.principalId,
      principalSource: s.principalSource,
      clientRequestId: turn.requestId,
      finalityId: final.finalityId,
      localOrder: turn.localOrder,
      baseRevision: turn.baseRevision,
      transcript: final.text,
      selection: s.selection,
      interactionMode: s.interactionMode,
      permissionMode: s.permissionMode,
      memoryMode: s.memoryMode,
    }).catch((error: unknown) => {
      this.host.log("voice.admission.failed", {
        sessionId: s.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    });
    if (s.state === "ending" || s.state === "ended") return;
    if (!result) {
      this.completeFailedCapture(turn);
      this.runtime.emitError("chat_unavailable", true);
      return;
    }
    s.lastKnownChatRevision = Math.max(s.lastKnownChatRevision, result.revision);
    const carriesIdentity = result.outcome === "queued"
      ? result.canonicalQueuedTurnId !== undefined
      : result.canonicalTurnId !== undefined;
    if ((result.outcome === "sent" || result.outcome === "steered"
      || result.outcome === "already_accepted" || result.outcome === "queued")
      && !carriesIdentity) {
      // Port contract violation: admitted outcomes must carry canonical identity.
      this.completeFailedCapture(turn);
      this.runtime.emitError("internal_failure", true);
      return;
    }
    switch (result.outcome) {
      case "sent":
      case "steered":
      case "already_accepted": {
        turn.phase = "admitted";
        turn.canonicalTurnId = result.canonicalTurnId ?? null;
        turn.runId = result.runId ?? null;
        if (result.runId) this.runtime.trackRun(result.runId);
        this.runtime.emit({
          type: "transcript.final",
          turnId: turn.turnId,
          finalityId: final.finalityId,
          canonicalTurnId: result.canonicalTurnId!,
          localOrder: turn.localOrder,
          text: final.text,
        });
        this.runtime.setState("thinking");
        return;
      }
      case "queued": {
        turn.phase = "admitted";
        turn.canonicalQueuedTurnId = result.canonicalQueuedTurnId ?? null;
        this.runtime.emit({
          type: "transcript.final",
          turnId: turn.turnId,
          finalityId: final.finalityId,
          canonicalQueuedTurnId: result.canonicalQueuedTurnId!,
          localOrder: turn.localOrder,
          text: final.text,
        });
        return;
      }
      default: {
        this.completeFailedCapture(turn);
        const error = result.error ?? {
          code: "chat_unavailable" as SafeVoiceErrorCode,
          retryable: true,
          recovery: "continue_in_chat" as VoiceRecoveryAction,
        };
        this.runtime.emit({
          type: "session.error",
          code: error.code,
          retryable: error.retryable,
          recovery: error.recovery,
        });
        if (s.state === "thinking") this.runtime.setState("listening");
      }
    }
  }

  // --------------------------------------------------------- canonical events

  onCanonicalEvent(event: VoiceCanonicalChatEvent): void {
    const s = this.session;
    if (s.state === "ending" || s.state === "ended") return;
    if (event.type === "run.started" && !s.runIds.has(event.runId)) {
      // Queued admissions only learn their run identity when canonical Chat
      // dispatches later — link by canonicalTurnId before the run filter.
      for (const turn of s.turns.values()) {
        if (turn.runId !== null) continue;
        const matches = turn.canonicalTurnId === event.canonicalTurnId
          || (event.canonicalQueuedTurnId !== undefined
            && turn.canonicalQueuedTurnId === event.canonicalQueuedTurnId);
        if (matches) {
          turn.runId = event.runId;
          turn.canonicalTurnId = event.canonicalTurnId;
          this.runtime.trackRun(event.runId);
          break;
        }
      }
    }
    if (!s.runIds.has(event.runId)) return;
    void enqueueSessionTask(s, () => this.dispatchCanonicalEvent(event));
  }

  private async dispatchCanonicalEvent(event: VoiceCanonicalChatEvent): Promise<void> {
    const s = this.session;
    switch (event.type) {
      case "run.started":
        if (!s.terminalRunIds.has(event.runId)) this.runtime.setState("thinking");
        return;
      case "operation.status":
        this.runtime.emit({
          type: "operation.status",
          runId: event.runId,
          label: event.label,
          state: event.state,
        });
        if (!TERMINAL_OPERATION_STATES.has(event.state)) {
          this.runtime.setState("using_tool");
        } else if (s.state === "using_tool") {
          this.runtime.setState("thinking");
        }
        return;
      case "assistant.text":
        await this.onAssistantText(event);
        return;
      case "run.terminal": {
        await this.flushPendingPhrase(event.runId);
        s.terminalRunIds.add(event.runId);
        for (const turn of s.turns.values()) {
          if (turn.runId === event.runId) turn.runTerminal = true;
        }
        for (const ledger of s.responses.values()) {
          if (ledger.runId !== event.runId || ledger.state !== "open") continue;
          ledger.runTerminal = true;
          await this.runtime.maybeCompleteDelivery(ledger);
        }
        // Terminal runs that no open ledger still needs are released so
        // correlation tracking stays bounded across a long session.
        this.runtime.releaseTerminalRun(event.runId);
        if (!this.runtime.hasActiveRun()
          && (s.state === "thinking" || s.state === "using_tool")) {
          this.runtime.setState("listening");
        }
        return;
      }
      default: {
        const exhaustive: never = event;
        this.runtime.countStale(`canonical_${(exhaustive as { type?: string }).type ?? "event"}`);
      }
    }
  }

  /**
   * A delivery write definitively failed — the durable row cannot cover this
   * response's audio, so it must not continue as tracked playback: stop
   * provider synthesis for it, tell the client the response ended
   * (interrupted + a safe error), and record the conservative terminal.
   */
  private async failUndurableResponse(ledger: VoiceResponseLedger): Promise<void> {
    const s = this.session;
    ledger.state = "interrupted";
    s.adapter?.cancelResponse(ledger.responseId);
    this.runtime.emitError("chat_unavailable", true);
    if (ledger.pendingRecorded) {
      // The client saw response.started — close it visibly. A response whose
      // pending row never committed was never announced; the error suffices.
      this.runtime.emit({
        type: "response.interrupted",
        responseId: ledger.responseId,
        effectiveThroughMs: ledger.playedThroughMs,
      });
    }
    await this.runtime.recordTerminalDelivery(ledger, "unknown", ledger.playedThroughMs);
    if (s.state === "speaking") this.runtime.setState("listening");
  }

  private async failRejectedSynthesis(ledger: VoiceResponseLedger): Promise<void> {
    const s = this.session;
    ledger.state = "interrupted";
    s.adapter?.cancelResponse(ledger.responseId);
    if (ledger.pendingRecorded) {
      this.runtime.emit({
        type: "response.interrupted",
        responseId: ledger.responseId,
        effectiveThroughMs: ledger.playedThroughMs,
      });
    }
    await this.runtime.recordTerminalDelivery(ledger, "unknown", ledger.playedThroughMs);
    if (s.state === "speaking") this.runtime.setState("listening");
  }

  private async onAssistantText(
    event: Extract<VoiceCanonicalChatEvent, { type: "assistant.text" }>,
  ): Promise<void> {
    const pending = this.pendingPhrases.get(event.runId);
    if (pending && pending.textEnd !== event.textStart) {
      await this.flushPendingPhrase(event.runId);
    }
    const current = this.pendingPhrases.get(event.runId);
    this.pendingPhrases.set(event.runId, current
      ? { text: current.text + event.text, textStart: current.textStart, textEnd: event.textEnd }
      : { text: event.text, textStart: event.textStart, textEnd: event.textEnd });
    const phrase = this.pendingPhrases.get(event.runId)!;
    while ([...phrase.text].length >= MAX_SYNTHESIS_PHRASE_CHARS) {
      const bounded = [...phrase.text].slice(0, MAX_SYNTHESIS_PHRASE_CHARS).join("");
      const candidate = Math.max(bounded.lastIndexOf(" "), bounded.lastIndexOf("\n"), bounded.lastIndexOf(","));
      const cut = candidate >= Math.floor(bounded.length / 2) ? candidate + 1 : bounded.length;
      const text = phrase.text.slice(0, cut);
      const textEnd = phrase.textStart + text.length;
      await this.synthesizePhrase(event.runId, { text, textStart: phrase.textStart, textEnd });
      phrase.text = phrase.text.slice(cut);
      phrase.textStart = textEnd;
      if (phrase.text.length === 0) {
        this.pendingPhrases.delete(event.runId);
        return;
      }
    }
    if (/[.!?;:]\s*$/u.test(phrase.text)) {
      await this.flushPendingPhrase(event.runId);
    }
  }

  private async flushPendingPhrase(runId: string): Promise<void> {
    const phrase = this.pendingPhrases.get(runId);
    if (!phrase) return;
    this.pendingPhrases.delete(runId);
    await this.synthesizePhrase(runId, phrase);
  }

  private async synthesizePhrase(runId: string, phrase: PendingSynthesisPhrase): Promise<void> {
    const event = { type: "assistant.text" as const, runId, ...phrase };
    const s = this.session;
    let ledger = this.findLedgerForRun(event.runId);
    let firstSegment = false;
    if (!ledger) {
      const evictable = (entry: VoiceResponseLedger) => entry.state !== "open";
      if (!boundedInsert(s.responses, this.host.maxResponses, evictable)) {
        this.runtime.emitError("session_limit_reached", false);
        return;
      }
      ledger = {
        responseId: this.host.createId("vresp"),
        runId: event.runId,
        state: "open",
        segments: [],
        deliveredThroughMs: 0,
        playedThroughMs: 0,
        deliveryRevision: 0,
        pendingRecorded: false,
        runTerminal: s.terminalRunIds.has(event.runId),
        terminalRecorded: false,
      };
      s.responses.set(ledger.responseId, ledger);
      firstSegment = true;
    }
    if (ledger.state !== "open" || ledger.segments.length >= this.host.limits.maxSegments) {
      this.runtime.countStale("segment_for_closed_response");
      return;
    }
    const segment: VoiceLedgerSegment = {
      segmentId: this.host.createId("vseg"),
      segmentIndex: ledger.segments.length,
      textStart: event.textStart,
      textEnd: event.textEnd,
      durationMs: 0,
      played: false,
      synthesisEnded: false,
    };
    ledger.segments.push(segment);
    // The durable manifest must cover every segment BEFORE the adapter is
    // asked to synthesize it — a row that cannot be written can never be
    // acked, so its audio must never be presented as durable voice output.
    const persisted = firstSegment
      ? await this.runtime.recordPendingDelivery(ledger)
      : await this.runtime.extendDeliveryManifest(ledger, segment);
    if (!persisted) {
      await this.failUndurableResponse(ledger);
      return;
    }
    if (firstSegment) {
      // The first playback-eligible segment exists once the pending row does.
      this.runtime.emit({ type: "response.started", responseId: ledger.responseId, runId: event.runId });
    }
    s.adapter?.synthesize({ responseId: ledger.responseId, segment: { ...segment }, text: event.text });
  }

  private findLedgerForRun(runId: string): VoiceResponseLedger | undefined {
    for (const ledger of this.session.responses.values()) {
      if (ledger.runId === runId) return ledger;
    }
    return undefined;
  }
}
