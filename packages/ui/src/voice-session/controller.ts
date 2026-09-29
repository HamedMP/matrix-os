"use client";

import { useSyncExternalStore } from "react";
import {
  VOICE_SESSION_LIMITS,
  VoiceDurationMsSchema,
  VoiceEpochSchema,
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

export class VoiceSessionController {
  private snapshot: VoiceSessionViewState;
  private readonly listeners = new Set<() => void>();
  private readonly sessionId: string;
  private readonly onCommand?: (command: VoiceSessionCommand) => void;
  private responseId: string | null = null;
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
    const sequenceFloor = advancesEpoch ? -1 : this.snapshot.sequence;
    if (frame.sequence <= sequenceFloor) return false;

    let next: VoiceSessionViewState = this.snapshot;
    switch (frame.type) {
      case "session.state": {
        const lifecycle = LIFECYCLE_PROJECTION[frame.state];
        next = {
          ...this.snapshot,
          state: lifecycle,
          muted: lifecycle === "paused",
          error: lifecycle === "failed" ? this.snapshot.error : null,
        };
        if (lifecycle === "ended") {
          next = clearEphemeral(next);
          this.responseId = null;
        }
        break;
      }
      case "transcript.provisional": {
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
        this.responseId = frame.responseId;
        break;
      }
      case "response.interrupted":
      case "response.audio_end": {
        if (this.responseId === frame.responseId) this.responseId = null;
        break;
      }
      case "session.error": {
        next = {
          ...this.snapshot,
          state: "failed",
          error: { code: frame.code, recovery: frame.recovery, retryable: frame.retryable },
          pushToTalkActive: false,
        };
        break;
      }
      case "transport.going_away": {
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
      case "response.audio":
      case "heartbeat.ack":
        break;
      default:
        return false;
    }

    if (advancesEpoch) {
      this.responseId = frame.type === "response.started" ? this.responseId : null;
      next = {
        ...next,
        pushToTalkActive: false,
        toolLabel: frame.type === "operation.status" ? next.toolLabel : null,
        provisionalTranscript:
          frame.type === "transcript.provisional" ? next.provisionalTranscript : null,
      };
    }
    this.snapshot = { ...next, epoch: frame.epoch, sequence: frame.sequence };
    this.emit();
    return true;
  }

  pause(): void {
    if (!this.canCommand()) return;
    this.update({ ...this.snapshot, state: "paused", muted: true, pushToTalkActive: false });
    this.command({ type: "session.pause" });
  }

  resume(): void {
    if (!this.canCommand()) return;
    this.update({ ...this.snapshot, state: "listening", muted: false });
    this.command({ type: "session.resume" });
  }

  stopSpeaking(playedThroughMs = 0): void {
    if (!this.canCommand() || this.responseId === null) return;
    if (!VoiceDurationMsSchema.safeParse(playedThroughMs).success) return;
    this.command({ type: "response.interrupt", responseId: this.responseId, playedThroughMs });
    this.responseId = null;
  }

  beginPushToTalk(): void {
    if (!this.canCommand() || this.snapshot.pushToTalkActive) return;
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
    this.command({ type: "session.end" });
    this.responseId = null;
    this.update(clearEphemeral({ ...this.snapshot, state: "ended", error: null }));
  }

  retry(): void {
    if (this.disposed || this.snapshot.state !== "failed") return;
    this.update({ ...this.snapshot, state: "connecting", error: null, muted: false });
    this.command({ type: "session.retry" });
  }

  continueInChat(): void {
    if (this.disposed) return;
    this.command({ type: "continue_in_chat" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.responseId = null;
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
