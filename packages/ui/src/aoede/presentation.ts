import type { SafeVoiceErrorCode, VoiceCapability } from "@matrix-os/contracts/voice-session";

export type AoedeStatus =
  | "idle" | "permission" | "connecting" | "restoring" | "listening" | "thinking"
  | "using_tool" | "speaking" | "paused" | "reconnecting" | "ending" | "failed" | "ended";

export const AOEDE_STATUS_LABELS: Record<AoedeStatus, string> = {
  idle: "Ready", permission: "Waiting for microphone", connecting: "Connecting",
  restoring: "Restoring",
  listening: "Listening", thinking: "Thinking", using_tool: "Using tool",
  speaking: "Speaking", paused: "Paused", reconnecting: "Reconnecting",
  ending: "Ending", failed: "Failed", ended: "Ended",
};

export const AOEDE_CAPTION_LIMIT = 600;

/** Bound actual DOM content, not just the visible line count. Never split a surrogate pair. */
export function boundedAoedeText(text: string | undefined, limit = AOEDE_CAPTION_LIMIT): string {
  if (!text) return "";
  if (text.length <= limit) return text.trim();
  let head = text.slice(0, limit - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

const ERROR_COPY: Record<SafeVoiceErrorCode, string> = {
  permission_denied: "Microphone permission is needed. Allow access, then retry.",
  input_unavailable: "No microphone is available. Check your input device, then retry.",
  output_unavailable: "Audio output is unavailable. Check your output device, then retry.",
  connection_failed: "Voice could not connect. Check your connection, then retry.",
  connection_lost: "The voice connection was lost. Retry when your connection is ready.",
  provider_unavailable: "Voice is temporarily unavailable. Try again later.",
  session_limit_reached: "This voice session reached its limit. Start again to continue this conversation.",
  usage_limit_reached: "Voice usage is unavailable. Review your usage settings before trying again.",
  audio_backpressure: "Voice input paused to catch up. Resume when ready.",
  chat_unavailable: "This conversation is unavailable. Start a new conversation explicitly to continue.",
  session_conflict: "Another voice session is active. End that session before retrying.",
  unsupported_surface: "Voice is not supported on this surface.",
  internal_failure: "The request could not be completed. Check the current status, then try again.",
};

/** Never render server messages, unknown codes, or inherited object properties. */
export function aoedeErrorCopy(code: unknown): string {
  return typeof code === "string" && code.length <= 64 && Object.hasOwn(ERROR_COPY, code)
    ? ERROR_COPY[code as SafeVoiceErrorCode]
    : ERROR_COPY.internal_failure;
}

/** Allowlisted owner-facing directions; never render raw or inherited reason strings. */
const AOEDE_READINESS_DIRECTIONS: Record<string, string> = {
  policy_disabled: "Review voice policy in settings.",
  not_configured: "Configure speech and a model in settings.",
  limit_reached: "Review usage in settings before trying again.",
  surface_unsupported: "Use a supported surface.",
  provider_unavailable: "Try again later.",
};

export function aoedeReadinessCopy(capability?: VoiceCapability, status?: AoedeStatus): string {
  if (!capability) return status === "failed" ? "Voice readiness check failed. Retry to check again." : "Checking voice readiness";
  const base = capability.status === "available" ? "Voice ready"
    : capability.status === "degraded" ? "Voice available with limits"
    : "Voice unavailable";
  if (capability.status === "available") return base;
  const reason = capability.reason;
  const direction = typeof reason === "string" && reason.length <= 64 && Object.hasOwn(AOEDE_READINESS_DIRECTIONS, reason)
    ? AOEDE_READINESS_DIRECTIONS[reason]
    : "";
  return direction ? `${base}. ${direction}` : base;
}

export function aoedeActionCopy(capability?: VoiceCapability): string {
  if (!capability || capability.status === "unavailable") return "";
  switch (capability.actionMode) {
    case "conversation_only": return "Conversation only";
    case "safe_reads": return "Read-only app access";
    case "canonical_actions": return "App actions available";
    default: return "";
  }
}
