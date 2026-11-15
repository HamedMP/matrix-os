/**
 * Narrow types shared by the live voice host, the provider adapters and the
 * Chat companion port. None carry client-asserted state or raw provider
 * errors; failures use the safe vocabulary in `@matrix-os/contracts/voice-session`.
 */
import type {
  CanonicalOperationState,
  SafeVoiceErrorCode,
  VoiceFrameCommon,
  VoiceRecoveryAction,
  VoiceServerFrame,
} from "@matrix-os/contracts/voice-session";

export type VoiceMemoryMode = "ordinary" | "session_only";

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ServerFramePayload = DistributiveOmit<VoiceServerFrame, keyof VoiceFrameCommon>;

export type VoiceTurnAdmissionOutcome = "sent" | "queued" | "steered" | "already_accepted" | "rejected" | "failed";

export interface VoiceTurnAdmissionResult {
  outcome: VoiceTurnAdmissionOutcome;
  /** Canonical `cturn_` identity once admitted (sent/steered/already). */
  canonicalTurnId?: string;
  /** Canonical `qturn_` identity while the turn waits in the queue. */
  canonicalQueuedTurnId?: string;
  /** Canonical `run_` identity when the turn dispatched or steered a run. */
  runId?: string;
  /** Chat revision observed by the admission authority. */
  revision: number;
  /** Safe denial detail for rejected/failed outcomes. */
  error?: { code: SafeVoiceErrorCode; retryable: boolean; recovery: VoiceRecoveryAction };
}

/** Canonical run events a live call may surface as task status. */
export type VoiceCanonicalChatEvent =
  | { type: "run.started"; runId: string; canonicalTurnId: string; canonicalQueuedTurnId?: string }
  | { type: "operation.status"; runId: string; operationId?: string; label: string; state: CanonicalOperationState }
  | { type: "assistant.text"; runId: string; text: string; textStart: number; textEnd: number }
  | { type: "run.terminal"; runId: string; state: CanonicalOperationState };

export interface VoiceChatEventSubscription {
  close(): void;
}

/** Subscription to canonical Chat events for one Chat. */
export interface VoiceChatEventSource {
  subscribe(
    input: { chatId: string; principalId: string },
    listener: (event: VoiceCanonicalChatEvent) => void,
  ): VoiceChatEventSubscription;
}
