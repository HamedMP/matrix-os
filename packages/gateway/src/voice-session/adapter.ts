/**
 * Provider seam for native live voice. A provider (Gemini Live today, GPT
 * Realtime next) implements `VoiceMediaAdapter`; the session host owns auth,
 * limits and transport, and the companion port owns Chat history and tasks.
 * Provider-native frames never cross this port.
 */
import type { AudioFormat, SafeVoiceErrorCode, VoiceOutputAudioFormat, VoiceTurnMode } from "@matrix-os/contracts/voice-session";
import type { LiveCompanionPort } from "../live-companion/coordinator.js";
import type { ServerFramePayload, VoiceCanonicalChatEvent, VoiceMemoryMode } from "./ports.js";

export interface VoiceAdapterCapabilities {
  transportModes: Array<"relayed_websocket" | "direct_webrtc">;
  turnModes: VoiceTurnMode[];
  supportsInterruption: boolean;
  resume: "delivery_aware" | "rebuild_only" | "unsupported";
  sessionOnly: "enforced" | "unsupported";
  actionMode: "conversation_only" | "safe_reads" | "canonical_actions";
  actionCancellation: "none" | "run" | "tool";
  supportsInputSelection: boolean;
  supportsOutputSelection: boolean;
  outputAudio?: VoiceOutputAudioFormat;
  conversationMode?: "canonical_turn" | "native_live";
}

/** Events an adapter emits to the session host (provider -> client). */
export type VoiceAdapterEvent =
  | { type: "companion.frame"; frame: ServerFramePayload }
  | { type: "error"; code: SafeVoiceErrorCode; retryable: boolean; fatal: boolean };

/** Commands the session host issues to one provider session. */
export interface VoiceMediaSession {
  native?: { played(responseId: string, segmentId: string): void; onTask(event: VoiceCanonicalChatEvent): void };
  /** Begin/end capture for a turn. `null` releases capture resources. */
  setCapture(capture: { turnId: string; mode: VoiceTurnMode } | null): void;
  /** Bounded base64 audio for the active capture turn. */
  pushAudio(input: { turnId: string; timestampMs: number; data: string }): void;
  /** Stop audible output immediately at a playback boundary (barge-in). */
  interrupt(responseId: string, playedThroughMs: number): void;
  /** Release the provider session; idempotent. */
  close(): Promise<void> | void;
}

export interface VoiceAdapterSessionContext {
  live?: LiveCompanionPort;
  sessionId: string;
  chatId: string;
  principalId: string;
  turnMode: VoiceTurnMode;
  memoryMode: VoiceMemoryMode;
  locale?: string;
  audio?: AudioFormat;
  emit(event: VoiceAdapterEvent): void;
}

export interface VoiceMediaAdapter {
  readonly id: string;
  readonly capabilities: VoiceAdapterCapabilities;
  start(context: VoiceAdapterSessionContext): Promise<VoiceMediaSession> | VoiceMediaSession;
}
