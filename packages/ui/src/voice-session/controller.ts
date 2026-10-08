"use client";

import { useSyncExternalStore } from "react";
import {
  VOICE_SESSION_LIMITS,
  VoiceEpochSchema,
  VoicePlaybackAckSchema,
  VoiceServerFrameSchema,
  VoiceSessionIdSchema,
  VoiceTurnModeSchema,
  type SafeVoiceError,
  type VoiceSessionState,
  type VoiceTurnMode,
  type VoiceVisibleState,
} from "@matrix-os/contracts/voice-session";

export interface VoiceSessionViewState {
  state: VoiceVisibleState;
  epoch: number;
  sequence: number;
  muted: boolean;
  turnMode: VoiceTurnMode;
  pushToTalkActive: boolean;
  toolLabel: string | null;
  provisionalTranscript: {
    turnId: string;
    revision: number;
    text: string;
  } | null;
  error: SafeVoiceError | null;
}

export type VoiceSessionCommand =
  | { type: "session.pause" }
  | { type: "session.resume" }
  | { type: "response.interrupt"; responseId: string; playedThroughMs: number }
  | { type: "capture.start"; mode: "push_to_talk" }
  | { type: "capture.stop" }
  | {
      type: "playback.segment_played";
      responseId: string;
      segmentId: string;
      deliveryRevision: number;
      playedThroughMs: number;
    }
  | { type: "session.end" }
  | { type: "session.retry" }
  | { type: "continue_in_chat" };

const MAX_LISTENERS = 32;
const MAX_TRANSCRIPT_LENGTH = 500;
const MAX_OPERATION_LABEL_CHARS = VOICE_SESSION_LIMITS.maxOperationLabelChars;

const LIFECYCLE_PROJECTION: Record<VoiceSessionState, VoiceVisibleState> = {
  requesting_permission: "connecting",
  connecting: "connecting",
  listening: "listening",
  thinking: "thinking",
  using_tool: "using_tool",
  speaking: "speaking",
  paused: "paused",
  reconnecting: "reconnecting",
  restoring: "reconnecting",
  failed: "failed",
  ending: "ended",
  ended: "ended",
};

function truncateCodePoints(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

const TERMINAL_OPERATION_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "outcome_unknown",
]);

function clearEphemeral(state: VoiceSessionViewState): VoiceSessionViewState {
  return {
    ...state,
    muted: true,
    pushToTalkActive: false,
    toolLabel: null,
    provisionalTranscript: null,
  };
}

interface ActiveResponsePlayback {
  responseId: string;
  pendingSegmentIds: Set<string>;
  playedThroughMs: number;
  generationEnded: boolean;
}

export class VoiceSessionController {
  private snapshot: VoiceSessionViewState;
  private readonly listeners = new Set<() => void>();
  private readonly sessionId: string;
  private readonly onCommand?: (command: VoiceSessionCommand) => void;
  private activeResponse: ActiveResponsePlayback | null = null;
  private userPaused = false;
  private disposed = false;

  constructor(options: {
    initialEpoch: number;
    sessionId?: string;
    initialTurnMode?: "hands_free" | "push_to_talk";
    onCommand?: (command: VoiceSessionCommand) => void;
  }) {
    if (!VoiceEpochSchema.safeParse(options.initialEpoch).success) {
      throw new TypeError("initialEpoch must be a positive safe integer");
    }
    const sessionId = options.sessionId ?? "vs_client";
    if (!VoiceSessionIdSchema.safeParse(sessionId).success) {
      throw new TypeError("sessionId must be a valid voice session identifier");
    }
    const initialTurnMode = options.initialTurnMode ?? "hands_free";
    if (!VoiceTurnModeSchema.safeParse(initialTurnMode).success) {
      throw new TypeError("initialTurnMode must be a supported voice turn mode");
    }
    this.sessionId = sessionId;
    this.onCommand = options.onCommand;
    this.snapshot = {
      state: "connecting",
      epoch: options.initialEpoch,
      sequence: -1,
      muted: false,
      turnMode: initialTurnMode,
      pushToTalkActive: false,
      toolLabel: null,
      provisionalTranscript: null,
      error: null,
    };
  }

  getState = (): VoiceSessionViewState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    if (!this.listeners.has(listener) && this.listeners.size >= MAX_LISTENERS) {
      throw new RangeError(`Voice session supports at most ${MAX_LISTENERS} listeners`);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  receive(frameValue: unknown): boolean {
    if (this.disposed) return false;
    if (this.snapshot.state === "ended") return false;
    const parsed = VoiceServerFrameSchema.safeParse(frameValue);
    if (!parsed.success || parsed.data.sessionId !== this.sessionId) return false;
    const frame = parsed.data;
    if (frame.epoch < this.snapshot.epoch) return false;
    const advancesEpoch = frame.epoch > this.snapshot.epoch;
    // Only the explicit resume transition may advance the epoch; any other
    // higher-epoch frame is a forged or misrouted transport event.
    if (advancesEpoch && frame.type !== "session.resumed") return false;
    if (frame.type === "session.resumed" && !advancesEpoch) return false;
    const sequenceFloor = advancesEpoch ? -1 : this.snapshot.sequence;
    if (frame.sequence <= sequenceFloor) return false;

    let next: VoiceSessionViewState = this.snapshot;
    switch (frame.type) {
      case "session.resumed":
      case "session.state": {
        const projected = LIFECYCLE_PROJECTION[frame.state];
        const lifecycle = this.userPaused && ["listening", "thinking", "using_tool", "speaking"].includes(projected)
          ? "paused" : projected;
        next = {
          ...this.snapshot,
          state: lifecycle,
          muted: lifecycle === "paused",
          error: lifecycle === "failed" ? this.snapshot.error : null,
        };
        if (lifecycle === "ended") {
          next = clearEphemeral(next);
          this.activeResponse = null;
        }
        break;
      }
      case "transcript.provisional": {
        const provisional = this.snapshot.provisionalTranscript;
        if (provisional !== null
          && provisional.turnId === frame.turnId
          && frame.revision <= provisional.revision) {
          break;
        }
        next = {
          ...this.snapshot,
          provisionalTranscript: {
            turnId: frame.turnId,
            revision: frame.revision,
            text: truncateCodePoints(frame.text, MAX_TRANSCRIPT_LENGTH),
          },
        };
        break;
      }
      case "transcript.final": {
        next = {
          ...this.snapshot,
          provisionalTranscript:
            this.snapshot.provisionalTranscript?.turnId === frame.turnId
              ? null
              : this.snapshot.provisionalTranscript,
        };
        break;
      }
      case "capture.completed": {
        next = {
          ...this.snapshot,
          provisionalTranscript:
            this.snapshot.provisionalTranscript?.turnId === frame.turnId
              ? null
              : this.snapshot.provisionalTranscript,
        };
        break;
      }
      case "operation.status": {
        next = {
          ...this.snapshot,
          toolLabel: TERMINAL_OPERATION_STATES.has(frame.state)
            ? null
            : truncateCodePoints(frame.label, MAX_OPERATION_LABEL_CHARS),
        };
        break;
      }
      case "response.started": {
        this.activeResponse = {
          responseId: frame.responseId,
          pendingSegmentIds: new Set(),
          playedThroughMs: 0,
          generationEnded: false,
        };
        break;
      }
      case "response.audio": {
        const active = this.activeResponse;
        if (active !== null
          && active.responseId === frame.responseId
          && active.pendingSegmentIds.size < VOICE_SESSION_LIMITS.maxSegments) {
          active.pendingSegmentIds.add(frame.segmentId);
        }
        break;
      }
      case "response.audio_end": {
        const active = this.activeResponse;
        if (active !== null && active.responseId === frame.responseId) {
          // Generation finished; buffered playback may still be heard. Keep the
          // response identity until the queue drains or an interrupt lands.
          active.generationEnded = true;
          if (active.pendingSegmentIds.size === 0) this.activeResponse = null;
        }
        break;
      }
      case "response.interrupted": {
        if (this.activeResponse?.responseId === frame.responseId) this.activeResponse = null;
        break;
      }
      case "session.error": {
        this.activeResponse = null;
        next = {
          ...this.snapshot,
          state: "failed",
          error: { code: frame.code, recovery: frame.recovery, retryable: frame.retryable },
          pushToTalkActive: false,
        };
        break;
      }
      case "transport.going_away": {
        this.activeResponse = null;
        next = {
          ...this.snapshot,
          state: frame.reconnectAllowed ? "reconnecting" : "failed",
          pushToTalkActive: false,
          error: frame.reconnectAllowed
            ? null
            : { code: "connection_lost", recovery: "continue_in_chat", retryable: false },
        };
        break;
      }
      case "transcript.correction": {
        const provisional = this.snapshot.provisionalTranscript;
        if (provisional !== null
          && provisional.turnId === frame.turnId
          && frame.revision > provisional.revision) {
          next = {
            ...this.snapshot,
            provisionalTranscript: {
              turnId: provisional.turnId,
              revision: frame.revision,
              text: truncateCodePoints(frame.text, MAX_TRANSCRIPT_LENGTH),
            },
          };
        }
        break;
      }
      case "heartbeat.ack":
        break;
      default:
        return false;
    }

    if (advancesEpoch) {
      // session.resumed is the only frame that can reach this branch: a fresh
      // epoch invalidates every ephemeral playback and transcript projection.
      this.activeResponse = null;
      next = {
        ...next,
        pushToTalkActive: false,
        toolLabel: null,
        provisionalTranscript: null,
      };
    }
    this.snapshot = { ...next, epoch: frame.epoch, sequence: frame.sequence };
    this.emit();
    return true;
  }

  pause(): void {
    if (!this.canCommand()) return;
    this.userPaused = true;
    this.update({ ...this.snapshot, state: "paused", muted: true, pushToTalkActive: false });
    this.command({ type: "session.pause" });
  }

  resume(): void {
    if (!this.canCommand()) return;
    this.userPaused = false;
    this.update({ ...this.snapshot, state: "listening", muted: false });
    this.command({ type: "session.resume" });
  }

  acknowledgePlayback(ackValue: unknown): boolean {
    if (!this.canCommand()) return false;
    const active = this.activeResponse;
    const parsed = VoicePlaybackAckSchema.safeParse(ackValue);
    if (!parsed.success || active === null || parsed.data.responseId !== active.responseId) {
      return false;
    }
    const ack = parsed.data;
    // Only segments buffered for this response may advance the heard boundary:
    // unknown or already-acknowledged segments cannot inflate it.
    if (!active.pendingSegmentIds.has(ack.segmentId)) return false;
    this.command({ type: "playback.segment_played", ...ack });
    active.pendingSegmentIds.delete(ack.segmentId);
    active.playedThroughMs = Math.max(active.playedThroughMs, ack.playedThroughMs);
    if (active.generationEnded && active.pendingSegmentIds.size === 0) {
      this.activeResponse = null;
    }
    return true;
  }

  stopSpeaking(): void {
    const active = this.activeResponse;
    if (!this.canCommand() || active === null) return;
    this.command({
      type: "response.interrupt",
      responseId: active.responseId,
      playedThroughMs: active.playedThroughMs,
    });
    this.activeResponse = null;
  }

  beginPushToTalk(): void {
    if (!this.canCommand() || this.snapshot.state === "paused" || this.snapshot.pushToTalkActive) return;
    this.update({ ...this.snapshot, pushToTalkActive: true, muted: false });
    this.command({ type: "capture.start", mode: "push_to_talk" });
  }

  endPushToTalk(): void {
    if (!this.canCommand() || !this.snapshot.pushToTalkActive) return;
    this.update({ ...this.snapshot, pushToTalkActive: false });
    this.command({ type: "capture.stop" });
  }

  end(): void {
    if (!this.canCommand()) return;
    if (this.snapshot.pushToTalkActive) this.command({ type: "capture.stop" });
    this.command({ type: "session.end" });
    this.activeResponse = null;
    this.update(clearEphemeral({ ...this.snapshot, state: "ended", error: null }));
  }

  retry(): void {
    if (this.disposed || this.snapshot.state !== "failed") return;
    this.userPaused = false;
    this.update({ ...this.snapshot, state: "connecting", error: null, muted: false });
    this.command({ type: "session.retry" });
  }

  continueInChat(): void {
    if (this.disposed) return;
    this.command({ type: "continue_in_chat" });
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.snapshot.pushToTalkActive) this.command({ type: "capture.stop" });
    this.disposed = true;
    this.activeResponse = null;
    this.snapshot = clearEphemeral({ ...this.snapshot, state: "ended", error: null });
    this.listeners.clear();
  }

  private canCommand(): boolean {
    return !this.disposed && this.snapshot.state !== "ended";
  }

  private command(command: VoiceSessionCommand): void {
    this.onCommand?.(command);
  }

  private update(next: VoiceSessionViewState): void {
    this.snapshot = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function useVoiceSessionController(
  controller: VoiceSessionController,
): VoiceSessionViewState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
