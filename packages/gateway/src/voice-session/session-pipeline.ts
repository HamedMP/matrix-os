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

export class VoiceSessionPipeline {
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

  onCaptureStart(frame: Extract<VoiceClientFrame, { type: "capture.start" }>): void {
    const s = this.session;
    if (s.state !== "listening" || s.activeCaptureTurnId !== null) {
      this.runtime.countStale("capture_start_in_state");
      return;
    }
    if (s.turns.has(frame.turnId)) {
      this.runtime.countStale("duplicate_turn");
      return;
    }
    const evictable = (turn: VoiceTurnRecord) => turn.phase === "empty" || turn.phase === "rejected";
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
      runId: null,
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
    try {
      await this.host.runControl.cancelAction({
        chatId: this.session.chatId,
        actionId: frame.actionId,
        principalId: this.session.principalId,
      });
    } catch (error: unknown) {
      this.host.log("voice.run_control.action_cancel_failed", {
        sessionId: this.session.sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
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
        const segment = ledger.segments.find((entry) => entry.segmentId === event.segmentId);
        if (!segment) {
          this.runtime.countStale("audio_for_unknown_segment");
          return;
        }
        segment.durationMs = event.durationMs;
        ledger.deliveredThroughMs += event.durationMs;
        this.runtime.emit({
          type: "response.audio",
          responseId: ledger.responseId,
          segmentId: event.segmentId,
          startMs: event.startMs,
          data: event.data,
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
        ledger.generationEnded = true;
        this.runtime.emit({
          type: "response.audio_end",
          responseId: ledger.responseId,
          generatedDurationMs: event.generatedDurationMs,
        });
        await this.runtime.maybeCompleteDelivery(ledger);
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
    if (!turn || turn.phase === "admitted" || turn.phase === "rejected") {
      this.runtime.countStale("final_for_terminal_turn");
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
      // Empty or truncated finals are never executed; the turn stays editable.
      turn.phase = "empty";
      this.host.log("voice.turn.empty_final", { sessionId: s.sessionId, turnId: turn.turnId });
      return;
    }
    if (s.finalityToTurn.size >= MAX_FINALITY_ENTRIES) {
      s.finalityToTurn.delete(s.finalityToTurn.keys().next().value!);
    }
    s.finalityToTurn.set(event.finalityId, turn.turnId);
    turn.finalityId = event.finalityId;
    turn.finalText = event.text;
    const result = await this.host.admission.admitFinalTranscript({
      clientRequestId: turn.requestId,
      finalityId: event.finalityId,
      localOrder: turn.localOrder,
      baseRevision: turn.baseRevision,
      transcript: event.text,
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
      turn.phase = "rejected";
      this.runtime.emitError("chat_unavailable", true);
      return;
    }
    s.lastKnownChatRevision = Math.max(s.lastKnownChatRevision, result.revision);
    if ((result.outcome === "sent" || result.outcome === "steered"
      || result.outcome === "already_accepted" || result.outcome === "queued")
      && !result.canonicalTurnId) {
      // Port contract violation: admitted outcomes must carry canonical identity.
      turn.phase = "rejected";
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
        if (result.runId && s.runIds.size < this.host.maxRunIds) s.runIds.add(result.runId);
        this.runtime.emit({
          type: "transcript.final",
          turnId: turn.turnId,
          finalityId: event.finalityId,
          canonicalTurnId: result.canonicalTurnId!,
          localOrder: turn.localOrder,
          text: event.text,
        });
        this.runtime.setState("thinking");
        return;
      }
      case "queued": {
        turn.phase = "admitted";
        turn.canonicalTurnId = result.canonicalTurnId ?? null;
        this.runtime.emit({
          type: "transcript.final",
          turnId: turn.turnId,
          finalityId: event.finalityId,
          canonicalTurnId: result.canonicalTurnId!,
          localOrder: turn.localOrder,
          text: event.text,
        });
        return;
      }
      default: {
        turn.phase = "rejected";
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
        if (turn.canonicalTurnId === event.canonicalTurnId && turn.runId === null) {
          turn.runId = event.runId;
          if (s.runIds.size < this.host.maxRunIds) s.runIds.add(event.runId);
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
      case "run.terminal":
        s.terminalRunIds.add(event.runId);
        if (!this.runtime.hasActiveRun()
          && (s.state === "thinking" || s.state === "using_tool")) {
          this.runtime.setState("listening");
        }
        return;
      default: {
        const exhaustive: never = event;
        this.runtime.countStale(`canonical_${(exhaustive as { type?: string }).type ?? "event"}`);
      }
    }
  }

  private async onAssistantText(
    event: Extract<VoiceCanonicalChatEvent, { type: "assistant.text" }>,
  ): Promise<void> {
    const s = this.session;
    let ledger = this.findLedgerForRun(event.runId);
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
        generationEnded: false,
        terminalRecorded: false,
      };
      s.responses.set(ledger.responseId, ledger);
      // Pending delivery must exist before the first playback-eligible audio.
      await this.runtime.recordPendingDelivery(ledger);
      this.runtime.emit({ type: "response.started", responseId: ledger.responseId, runId: event.runId });
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
    };
    ledger.segments.push(segment);
    s.adapter?.synthesize({ responseId: ledger.responseId, segment: { ...segment }, text: event.text });
  }

  private findLedgerForRun(runId: string): VoiceResponseLedger | undefined {
    for (const ledger of this.session.responses.values()) {
      if (ledger.runId === runId) return ledger;
    }
    return undefined;
  }
}
