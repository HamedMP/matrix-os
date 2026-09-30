/**
 * Shared types, defaults, and small helpers for the voice session client
 * composition. Kept dependency-light so both the client factory and its
 * extracted collaborators can import from here without cycles.
 */
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import type {
  AudioFormat,
  ClientMediaCapabilities,
  SafeVoiceError,
  SafeVoiceErrorCode,
  VoiceSessionState,
  VoiceTurnMode,
} from "@matrix-os/contracts/voice-session";
import type { VoiceSessionController, VoiceSessionViewState } from "./controller.js";
import type { VoiceMediaCallbacks, VoiceMediaSession } from "./media-session.js";
import type { VoiceTransportSocket } from "./transport.js";
import { voiceErrorForCode } from "./session-api.js";

export const DEFAULT_VOICE_AUDIO_FORMAT: AudioFormat = {
  codec: "pcm_s16le",
  sampleRateHz: 16_000,
  channels: 1,
  frameDurationMs: 20,
};

export type VoiceSessionClientPhase =
  | "idle"
  | "starting"
  | "active"
  | "reconnecting"
  | "awaiting_reconnect"
  | "failed"
  | "ended";

export interface VoiceSessionClientSnapshot {
  phase: VoiceSessionClientPhase;
  /** Fatal session-scoped error; mirrored into the controller when one exists. */
  error: SafeVoiceError | null;
  /** Non-fatal warning surfaced to the UI (e.g. audio_backpressure). */
  notice: SafeVoiceError | null;
  sessionId: string | null;
  chatId: string | null;
  /** Live status reported by an `existing_consumed` create response. */
  reconnectStatus: VoiceSessionState | null;
  voice: VoiceSessionViewState | null;
}

export interface VoiceSessionRequestDefaults {
  turnMode: VoiceTurnMode;
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
  memoryMode?: "ordinary" | "session_only";
  requestedTransport?: "relayed_websocket" | "direct_webrtc";
  locale?: string;
}

export interface VoiceSessionClientOptions {
  baseUrl: string;
  request: VoiceSessionRequestDefaults;
  audio?: AudioFormat;
  mediaCapabilities?: ClientMediaCapabilities;
  fetcher?: typeof fetch;
  makeTimeoutSignal?: (ms: number) => AbortSignal;
  webSocketFactory?: (url: string) => VoiceTransportSocket;
  mediaFactory?: (input: { audio: AudioFormat; callbacks: VoiceMediaCallbacks }) => VoiceMediaSession;
  onPermissionRationale?: () => void | Promise<void>;
  onContinueInChat?: () => void;
  createId?: (prefix: "vturn_" | "req_") => string;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxOutboundQueue?: number;
  maxReconnectAttempts?: number;
}

export interface VoiceSessionClient {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceSessionClientSnapshot;
  controller(): VoiceSessionController | null;
  startVoice(chatId: string): Promise<void>;
  /** Explicit reconnect: required after `existing_consumed`, also used by retry. */
  reconnect(): Promise<void>;
  retry(): void;
  /**
   * Explicitly retries remote-session DELETEs that exhausted their bounded
   * attempts (discoverable via the snapshot notice). Never automatic: each
   * failed key gets at most one fresh bounded cycle per 60s window.
   * Returns the number of retry cycles started.
   */
  retryCleanup(): number;
  continueInChat(): void;
  end(): Promise<void>;
  dispose(): void;
}

export interface VoiceSessionHook {
  client: VoiceSessionClient;
  snapshot: VoiceSessionClientSnapshot;
  controller: VoiceSessionController | null;
  startVoice(chatId: string): Promise<void>;
  reconnect(): Promise<void>;
  retry(): void;
  retryCleanup(): number;
  continueInChat(): void;
  end(): Promise<void>;
}

/** Logs without leaking provider details: only the error class name is emitted. */
export function voiceWarn(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.name : "UnknownError");
}

export function capabilityUnavailableError(reason: string | undefined): SafeVoiceError {
  switch (reason) {
    case "limit_reached":
      return voiceErrorForCode("session_limit_reached");
    case "policy_disabled":
    case "surface_unsupported":
      return voiceErrorForCode("unsupported_surface");
    default:
      return voiceErrorForCode("provider_unavailable");
  }
}

export const CONNECTION_LOST_FATAL: SafeVoiceError = {
  code: "connection_lost" satisfies SafeVoiceErrorCode,
  retryable: false,
  recovery: "continue_in_chat",
};
