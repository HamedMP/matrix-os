/**
 * Provider-side speech ports for the chunked voice media adapter.
 *
 * The adapter owns session semantics (capture, VAD, queueing, safe events);
 * a `VoiceSpeechPorts` pair owns exactly two provider calls: file-style
 * transcription of one canonical WAV, and streaming synthesis of one
 * canonical text segment. Provider frames, credentials, endpoints, and raw
 * error text never cross this boundary — failures travel only as the
 * classified `VoiceSpeechPortError` kinds below.
 *
 * Implementations: `direct-openai-ports.ts` (development escape hatch) and
 * `speech/voice-session-ports.ts` (managed Platform Speech transcription).
 */
import {
  VoiceOutputAudioFormatSchema,
  type VoiceOutputAudioFormat,
} from "@matrix-os/contracts/voice-session";

/** Classified port failure kinds — mapped to safe event codes by the adapter. */
export type VoiceSpeechPortFailureKind =
  | "timeout"
  | "connection"
  | "unavailable"
  | "aborted";

/**
 * The only error a speech port may surface. `kind` classifies the failure;
 * provider names, endpoints, status codes, and error text stay inside the
 * port implementation and are never emitted upstream.
 */
export class VoiceSpeechPortError extends Error {
  constructor(readonly kind: VoiceSpeechPortFailureKind) {
    super(kind);
    this.name = "VoiceSpeechPortError";
  }
}

export interface VoiceTranscriptionRequest {
  /** Canonical WAV (PCM s16le) of one finalized capture turn. */
  wav: Buffer;
  /** Optional BCP-47-ish hints; ports forward only when supported/bounded. */
  languageHints?: readonly string[];
  /** Per-operation abort tied to the session lifecycle (close/supersede). */
  signal: AbortSignal;
}

export interface VoiceSynthesisRequest {
  /** Canonical text of exactly one response segment. */
  text: string;
  /** Per-operation abort tied to cancel/interrupt/close. */
  signal: AbortSignal;
}

export type VoiceTranscriptionPort = (
  request: VoiceTranscriptionRequest,
) => Promise<{ text: string }>;

export type VoiceSynthesisPort = (
  request: VoiceSynthesisRequest,
) => AsyncIterable<Buffer>;

export interface VoiceSpeechPorts {
  transcribe: VoiceTranscriptionPort;
  /**
   * Required. An adapter that hears but never speaks is never registered —
   * registration policy refuses a transcribe-only pair so capability stays
   * truthful (`not_configured`) instead of admitting a one-way session.
   */
  synthesize: VoiceSynthesisPort;
  /**
   * Declared decode format of synthesis chunks. Required whenever it differs
   * from the negotiated capture format (e.g. 24kHz TTS vs 16kHz capture);
   * when absent the adapter assumes the legacy 24kHz s16le mono timing base.
   * PCM codecs only — `startMs`/`durationMs`/`generatedDurationMs` are
   * byte-derived, so compressed output needs provider-supplied durations.
   */
  outputAudio?: VoiceOutputAudioFormat;
}

/** Byte-derived milliseconds for PCM output streams (see invariant above). */
export function voiceOutputBytesPerMs(output: VoiceOutputAudioFormat | undefined): number {
  if (!output || (output.codec !== "pcm_s16le" && output.codec !== "pcm_f32le")) {
    // Legacy base: 24kHz s16le mono (24_000 * 2 / 1_000).
    return 48;
  }
  return (output.sampleRateHz * output.channels * (output.codec === "pcm_f32le" ? 4 : 2)) / 1_000;
}

/** Registration-time validation for a declared output format. */
export function parseVoiceOutputAudio(value: unknown): VoiceOutputAudioFormat | undefined {
  if (value === undefined) return undefined;
  return VoiceOutputAudioFormatSchema.parse(value);
}

const LANGUAGE_HINT = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_LANGUAGE_HINTS = 8;
const MAX_LANGUAGE_HINT_CHARS = 35;

/** Bounded, sanitized language hints — drops malformed entries rather than failing. */
export function sanitizeLanguageHints(
  hints: readonly string[] | undefined,
): string[] | undefined {
  if (!hints || hints.length === 0) return undefined;
  const clean = hints
    .filter((hint): hint is string => typeof hint === "string")
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0 && hint.length <= MAX_LANGUAGE_HINT_CHARS && LANGUAGE_HINT.test(hint))
    .slice(0, MAX_LANGUAGE_HINTS);
  return clean.length > 0 ? clean : undefined;
}
