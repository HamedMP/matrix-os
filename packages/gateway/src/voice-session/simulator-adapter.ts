import type {
  VoiceSimulatorAction,
  VoiceSimulatorJournalEntry,
  VoiceSimulatorResult,
  VoiceSimulatorScenario,
} from "./simulator-types.js";
import { assertValidVoiceSimulatorScenario } from "./simulator-validation.js";

export type {
  VoiceSimulatorAction,
  VoiceSimulatorJournalEntry,
  VoiceSimulatorResult,
  VoiceSimulatorScenario,
} from "./simulator-types.js";
export {
  assertValidVoiceSimulatorScenario,
  VOICE_SIMULATOR_LIMITS,
} from "./simulator-validation.js";

type Details = Readonly<Record<string, string | number | boolean | null>>;

type MutableResources = {
  capture: boolean;
  playbackSegments: number;
  transport: boolean;
  timers: number;
  queuedAudioMs: number;
};

type RunState = {
  sessionState: string;
  epoch: number;
  terminal: boolean;
  journal: VoiceSimulatorJournalEntry[];
  resources: MutableResources;
  finalityIds: string[];
  queuedSegmentKeys: string[];
  playedSegmentKeys: string[];
  interruptedResponseIds: string[];
};

function segmentKey(responseId: string, segmentId: string): string {
  return `${responseId}\u0000${segmentId}`;
}

function has(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function remember(values: string[], value: string, maximum: number): void {
  if (!has(values, value) && values.length < maximum) values.push(value);
}

function cleanup(state: RunState): void {
  state.resources.capture = false;
  state.resources.playbackSegments = 0;
  state.resources.transport = false;
  state.resources.timers = 0;
  state.resources.queuedAudioMs = 0;
}

function orderedTimeline(timeline: readonly VoiceSimulatorAction[]): VoiceSimulatorAction[] {
  return timeline
    .map((action, declarationIndex) => ({ action, declarationIndex }))
    .sort((left, right) => left.action.atMs - right.action.atMs || left.declarationIndex - right.declarationIndex)
    .map(item => item.action);
}

export class DeterministicVoiceSimulator {
  run(scenario: VoiceSimulatorScenario): VoiceSimulatorResult {
    assertValidVoiceSimulatorScenario(scenario);
    const identityLimit = Math.max(1, scenario.timeline.length);
    const state: RunState = {
      sessionState: "connecting",
      epoch: scenario.initialEpoch,
      terminal: false,
      journal: [],
      resources: { capture: false, playbackSegments: 0, transport: true, timers: 1, queuedAudioMs: 0 },
      finalityIds: [],
      queuedSegmentKeys: [],
      playedSegmentKeys: [],
      interruptedResponseIds: [],
    };

    for (const action of orderedTimeline(scenario.timeline)) {
      if (!state.terminal && action.atMs >= scenario.limits.maxDurationMs) {
        state.sessionState = "failed";
        state.terminal = true;
        cleanup(state);
        this.record(state, scenario.limits.maxDurationMs, "session.duration_limit", {
          errorCode: "session_limit_reached",
          limitMs: scenario.limits.maxDurationMs,
          recoverable: false,
        });
        break;
      }

      if (state.terminal) {
        const type = action.type === "end" ? "session.end_duplicate_ignored" : `${action.type}.terminal_ignored`;
        const details: Details = action.type === "end" ? { reason: action.reason } : { actionType: action.type };
        this.record(state, action.atMs, type, details);
        continue;
      }

      this.apply(state, action, scenario.limits.maxQueuedAudioMs, identityLimit);
    }

    return {
      journal: state.journal,
      resources: { ...state.resources },
      terminalState: state.sessionState,
    };
  }

  private record(state: RunState, atMs: number, type: string, details: Details): void {
    state.journal.push({
      atMs,
      sequence: state.journal.length + 1,
      type,
      sessionState: state.sessionState,
      epoch: state.epoch,
      details,
    });
  }

  private apply(state: RunState, action: VoiceSimulatorAction, maxQueuedAudioMs: number, identityLimit: number): void {
    if (action.type !== "transport" && action.epoch !== undefined && action.epoch !== state.epoch) {
      this.record(state, action.atMs, "event.stale_epoch_ignored", {
        actionType: action.type,
        eventEpoch: action.epoch,
        currentEpoch: state.epoch,
      });
      return;
    }
    switch (action.type) {
      case "permission":
        this.permission(state, action);
        return;
      case "capture":
        state.resources.capture = action.action === "start";
        if (action.action === "stop") state.resources.queuedAudioMs = 0;
        this.record(state, action.atMs, `capture.${action.action === "start" ? "started" : "stopped"}`, { turnId: action.turnId });
        return;
      case "vad":
        state.sessionState = action.action === "speech_end" ? "thinking" : "listening";
        this.record(state, action.atMs, `vad.${action.action}`, { turnId: action.turnId });
        return;
      case "transcript.provisional":
        this.record(state, action.atMs, action.type, {
          revision: action.revision,
          textLength: action.text.length,
          turnId: action.turnId,
        });
        return;
      case "transcript.final":
        if (has(state.finalityIds, action.finalityId)) {
          this.record(state, action.atMs, "transcript.final.duplicate_ignored", {
            finalityId: action.finalityId,
            localOrder: action.localOrder,
            textLength: action.text.length,
            turnId: action.turnId,
          });
          return;
        }
        remember(state.finalityIds, action.finalityId, identityLimit);
        state.sessionState = "thinking";
        this.record(state, action.atMs, action.type, {
          finalityId: action.finalityId,
          localOrder: action.localOrder,
          textLength: action.text.length,
          turnId: action.turnId,
        });
        return;
      case "generation":
        this.generation(state, action, identityLimit);
        return;
      case "synthesis.segment":
        this.synthesis(state, action, identityLimit);
        return;
      case "playback":
        this.playback(state, action, identityLimit);
        return;
      case "interrupt":
        remember(state.interruptedResponseIds, action.responseId, identityLimit);
        state.resources.playbackSegments = 0;
        state.sessionState = "listening";
        this.record(state, action.atMs, "response.interrupted", { responseId: action.responseId, source: action.source });
        return;
      case "transport":
        this.transport(state, action);
        return;
      case "backpressure":
        this.backpressure(state, action, maxQueuedAudioMs);
        return;
      case "quota":
        this.quota(state, action);
        return;
      case "device":
        this.device(state, action);
        return;
      case "end":
        state.sessionState = action.reason === "failure" ? "failed" : "ended";
        state.terminal = true;
        cleanup(state);
        this.record(state, action.atMs, action.reason === "failure" ? "session.failed" : "session.ended", { reason: action.reason });
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  private permission(state: RunState, action: Extract<VoiceSimulatorAction, { type: "permission" }>): void {
    if (action.outcome === "granted") {
      state.sessionState = "listening";
      this.record(state, action.atMs, "permission.granted", { outcome: action.outcome });
      return;
    }
    state.sessionState = "failed";
    state.terminal = true;
    cleanup(state);
    this.record(state, action.atMs, `permission.${action.outcome}`, {
      errorCode: action.outcome === "revoked" ? "permission_revoked" : "permission_denied",
      outcome: action.outcome,
      recoverable: true,
    });
  }

  private generation(state: RunState, action: Extract<VoiceSimulatorAction, { type: "generation" }>, identityLimit: number): void {
    if (action.action === "cancel") {
      remember(state.interruptedResponseIds, action.responseId, identityLimit);
      state.resources.playbackSegments = 0;
      state.sessionState = "listening";
    } else if (action.action === "start") {
      state.sessionState = "thinking";
    } else if (state.sessionState !== "speaking") {
      state.sessionState = "listening";
    }
    const suffix = action.action === "start" ? "started" : action.action === "cancel" ? "cancelled" : "completed";
    this.record(state, action.atMs, `generation.${suffix}`, { responseId: action.responseId });
  }

  private synthesis(state: RunState, action: Extract<VoiceSimulatorAction, { type: "synthesis.segment" }>, identityLimit: number): void {
    const key = segmentKey(action.responseId, action.segmentId);
    if (has(state.interruptedResponseIds, action.responseId)) {
      this.record(state, action.atMs, "synthesis.interrupted_ignored", { responseId: action.responseId, segmentId: action.segmentId });
      return;
    }
    if (has(state.queuedSegmentKeys, key)) {
      this.record(state, action.atMs, "synthesis.segment.duplicate_ignored", { responseId: action.responseId, segmentId: action.segmentId });
      return;
    }
    remember(state.queuedSegmentKeys, key, identityLimit);
    state.resources.playbackSegments += 1;
    this.record(state, action.atMs, action.type, {
      durationMs: action.durationMs,
      responseId: action.responseId,
      segmentId: action.segmentId,
      segmentIndex: action.segmentIndex,
    });
  }

  private playback(state: RunState, action: Extract<VoiceSimulatorAction, { type: "playback" }>, identityLimit: number): void {
    if (action.action === "start") {
      if (has(state.interruptedResponseIds, action.responseId)) {
        this.record(state, action.atMs, "playback.interrupted_ignored", { responseId: action.responseId });
        return;
      }
      state.sessionState = "speaking";
      this.record(state, action.atMs, "playback.started", { responseId: action.responseId });
      return;
    }
    if (action.action === "stop") {
      state.resources.playbackSegments = 0;
      state.sessionState = "listening";
      this.record(state, action.atMs, "playback.stopped", { responseId: action.responseId });
      return;
    }
    const segmentId = action.segmentId ?? "";
    const key = segmentKey(action.responseId, segmentId);
    if (has(state.interruptedResponseIds, action.responseId)) {
      this.record(state, action.atMs, "playback.interrupted_ignored", { responseId: action.responseId, segmentId });
      return;
    }
    if (has(state.playedSegmentKeys, key)) {
      this.record(state, action.atMs, "playback.segment_played.duplicate_ignored", { responseId: action.responseId, segmentId });
      return;
    }
    remember(state.playedSegmentKeys, key, identityLimit);
    if (has(state.queuedSegmentKeys, key)) state.resources.playbackSegments = Math.max(0, state.resources.playbackSegments - 1);
    this.record(state, action.atMs, "playback.segment_played", { responseId: action.responseId, segmentId });
  }

  private transport(state: RunState, action: Extract<VoiceSimulatorAction, { type: "transport" }>): void {
    const stale = action.action === "disconnect" ? action.epoch !== state.epoch : action.epoch <= state.epoch;
    if (stale) {
      this.record(state, action.atMs, "transport.stale_ignored", {
        action: action.action,
        currentEpoch: state.epoch,
        epoch: action.epoch,
      });
      return;
    }
    if (action.action === "disconnect") {
      state.resources.transport = false;
      state.resources.capture = false;
      state.sessionState = "reconnecting";
      this.record(state, action.atMs, "transport.disconnected", { epoch: action.epoch });
      return;
    }
    state.epoch = action.epoch;
    state.resources.transport = true;
    state.sessionState = "listening";
    this.record(state, action.atMs, "transport.reconnected", { epoch: action.epoch });
  }

  private backpressure(state: RunState, action: Extract<VoiceSimulatorAction, { type: "backpressure" }>, limitMs: number): void {
    state.resources.queuedAudioMs = Math.max(0, Math.min(action.queuedAudioMs, limitMs));
    if (action.queuedAudioMs >= limitMs) {
      state.resources.capture = false;
      state.sessionState = "paused";
      this.record(state, action.atMs, "backpressure.limit", {
        errorCode: "audio_backpressure",
        limitMs,
        queuedAudioMs: state.resources.queuedAudioMs,
        recoverable: true,
      });
      return;
    }
    this.record(state, action.atMs, "backpressure.updated", { queuedAudioMs: state.resources.queuedAudioMs });
  }

  private quota(state: RunState, action: Extract<VoiceSimulatorAction, { type: "quota" }>): void {
    const terminal = action.quota === "session";
    state.resources.capture = false;
    state.resources.queuedAudioMs = 0;
    state.sessionState = terminal ? "failed" : "paused";
    state.terminal = terminal;
    if (terminal) cleanup(state);
    this.record(state, action.atMs, "quota.reached", {
      errorCode: action.quota === "session" ? "session_limit_reached" : "usage_limit_reached",
      quota: action.quota,
      recoverable: true,
    });
  }

  private device(state: RunState, action: Extract<VoiceSimulatorAction, { type: "device" }>): void {
    if (action.action === "restored") {
      state.sessionState = "listening";
      this.record(state, action.atMs, "device.restored", { action: action.action });
      return;
    }
    state.sessionState = "paused";
    if (action.action === "input_lost") state.resources.capture = false;
    if (action.action === "output_lost") state.resources.playbackSegments = 0;
    this.record(state, action.atMs, `device.${action.action}`, {
      errorCode: action.action === "input_lost" ? "input_unavailable" : "output_unavailable",
      recoverable: true,
    });
  }
}
