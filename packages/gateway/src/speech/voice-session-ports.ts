/**
 * Narrow Platform-Speech-facing ports for canonical voice sessions.
 *
 * The provisioned runtime-bound Platform Speech client is the ONLY
 * production speech authority (speech/DOMAIN.md): transcription is funded,
 * metered, and policy-gated platform-side, and the gateway never holds a
 * provider key. This module re-derives that client from the same validated
 * runtime config as `gateway-runtime.ts` and wraps managed transcription and
 * synthesis as provider-neutral ports for the chunked voice adapter.
 */
import { randomUUID } from "node:crypto";
import { VOICE_SESSION_LIMITS } from "@matrix-os/contracts/voice-session";
import { SpeechCapabilitiesResponseSchema } from "@matrix-os/contracts";
import {
  VoiceSpeechPortError,
  sanitizeLanguageHints,
  type VoiceTranscriptionPort,
  type VoiceSynthesisPort,
} from "../voice-session/speech-ports.js";
import {
  PlatformSpeechClientError,
  createPlatformSpeechClient,
  loadPlatformSpeechRuntimeConfig,
  type PlatformSpeechClient,
} from "./platform-client.js";

/**
 * Re-derive the provisioned Platform Speech client for voice sessions.
 * Returns undefined when `MATRIX_PLATFORM_SPEECH_ENABLED` is off; throws the
 * same `PlatformSpeechRuntimeConfigError` as the speech runtime on partial
 * misconfiguration (deterministic — the runtime parses the same env first).
 */
export function createVoiceSessionPlatformSpeechClient(
  env: NodeJS.ProcessEnv,
): PlatformSpeechClient | undefined {
  const config = loadPlatformSpeechRuntimeConfig(env);
  return config ? createPlatformSpeechClient(config) : undefined;
}

/** `SpeechRequestIdSchema`-conforming id: sp_<13-digit-ts>_<16-64 safe>. */
function speechRequestId(now: () => number): string {
  return `sp_${now()}_${randomUUID().replaceAll("-", "")}`;
}

/**
 * Managed transcription port: canonical WAV → platform `transcribe` with
 * `sourceKind: "dictation"` and a conforming per-call request id. Failures
 * collapse to classified `VoiceSpeechPortError` kinds — platform codes and
 * messages never propagate to voice adapter events.
 */
export function createManagedVoiceTranscriptionPort(options: {
  client: Pick<PlatformSpeechClient, "transcribe">;
  /** Test seam for deterministic request ids. */
  now?: () => number;
}): VoiceTranscriptionPort {
  const now = options.now ?? Date.now;
  return async (request) => {
    const languageHints = sanitizeLanguageHints(request.languageHints);
    let result;
    try {
      result = await options.client.transcribe({
        requestId: speechRequestId(now),
        sourceKind: "dictation",
        audio: Uint8Array.from(request.wav),
        mediaType: "audio/wav",
        ...(languageHints ? { languageHints } : {}),
        signal: request.signal,
      });
    } catch (error: unknown) {
      if (error instanceof VoiceSpeechPortError) throw error;
      if (request.signal.aborted) throw new VoiceSpeechPortError("aborted");
      if (error instanceof PlatformSpeechClientError) {
        throw new VoiceSpeechPortError(error.code === "timeout" ? "timeout" : "unavailable");
      }
      throw new VoiceSpeechPortError("connection");
    }
    if (result.outcome !== "transcript") return { text: "" };
    let text = result.text.trim();
    if ([...text].length > VOICE_SESSION_LIMITS.maxTranscriptChars) {
      text = [...text].slice(0, VOICE_SESSION_LIMITS.maxTranscriptChars).join("");
    }
    return { text };
  };
}

export function createManagedVoiceSynthesisPort(options: {
  client: Pick<PlatformSpeechClient, "synthesizeStream">;
  now?: () => number;
}): VoiceSynthesisPort {
  if (typeof options.client.synthesizeStream !== "function") throw new TypeError("Managed voice requires a streaming synthesis client");
  const now = options.now ?? Date.now;
  return async function* (request) {
    let ended = false;
    try {
      for await (const frame of options.client.synthesizeStream({
        requestId: speechRequestId(now), text: request.text, signal: request.signal,
      })) {
        if (request.signal.aborted) throw new VoiceSpeechPortError("aborted");
        if (frame.type === "audio") yield Buffer.from(frame.data, "base64");
        else if (frame.type === "error") throw new VoiceSpeechPortError(frame.code === "timeout" ? "timeout" : "unavailable");
        else ended = true;
      }
      if (!ended) throw new VoiceSpeechPortError("connection");
    } catch (error: unknown) {
      if (request.signal.aborted) throw new VoiceSpeechPortError("aborted");
      if (error instanceof VoiceSpeechPortError) throw error;
      if (error instanceof PlatformSpeechClientError) throw new VoiceSpeechPortError(error.code === "timeout" ? "timeout" : "unavailable");
      throw new VoiceSpeechPortError("connection");
    }
  };
}

/**
 * Coarse readiness classification for the managed Platform-Speech path.
 * Only `"ready"` may admit voice work — every other state fails closed.
 */
export type ManagedVoiceReadinessState =
  /** Transcription ready AND synthesis ready AND synthesis streaming. */
  | "ready"
  /** A schema-valid capability response reported a leg unavailable, absent,
   * or completed-only (non-streaming) synthesis — an authoritative "not ready". */
  | "unready"
  /** The probe's own bounded wait elapsed without an answer. */
  | "timeout"
  /** Transport/protocol/other failure — readiness could not be determined. */
  | "unknown";

/**
 * Bounded capability probe returning the full readiness classification.
 * `timeoutMs` (default 10s) bounds the wait through a dedicated
 * `AbortSignal.timeout`; a caller-supplied `signal` additionally shortens it
 * but an externally aborted wait classifies `unknown`, never `timeout` —
 * only this probe's own budget expiry reports `timeout`. No key-presence
 * heuristic and no provider details escape.
 */
export async function classifyManagedVoiceSpeechReadiness(options: {
  client: Pick<PlatformSpeechClient, "capabilities">;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Whose synthesis the managed adapter actually uses. `"platform"` (default)
   * requires ready + streaming synthesis in the platform capability document;
   * `"external"` means a development-gated port owns synthesis, so the probe
   * only adjudicates the platform transcription leg it is authoritative for.
   */
  synthesisSource?: "platform" | "external";
  now?: () => number;
}): Promise<{ state: ManagedVoiceReadinessState; checkedAt: number }> {
  const now = options.now ?? Date.now;
  // Clamp here too — direct callers must get the same 1s–15s bound the
  // caching probe enforces, so an out-of-range override can never stall a
  // readiness decision past the advertised bound.
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 15_000);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const response = await Promise.race([options.client.capabilities(signal), aborted]);
    const result = SpeechCapabilitiesResponseSchema.safeParse(response);
    // A payload that is not a valid capability document is a protocol
    // failure, not an authoritative "not ready".
    if (!result.success) return { state: "unknown", checkedAt: now() };
    // Aoede streams segment audio: a ready-but-completed-only synthesis
    // (absent/false `streaming`) is not readiness for the managed voice path.
    // When synthesis is served by a development-gated port instead, the
    // platform document only describes the transcription leg.
    const synthesisReady = options.synthesisSource === "external"
      || (result.data.synthesis?.status === "ready" && result.data.synthesis.streaming === true);
    const ready = result.data.fileTranscription.status === "ready" && synthesisReady;
    return { state: ready ? "ready" : "unready", checkedAt: now() };
  } catch (error: unknown) {
    console.warn("[platform-speech] capability probe unavailable", error instanceof Error ? error.name : "UnknownError");
    return { state: timeout.aborted ? "timeout" : "unknown", checkedAt: now() };
  } finally { signal.removeEventListener("abort", onAbort); }
}

/** Coarse authoritative probe for server composition. No key-presence heuristic,
 * no cache of funded readiness, no provider details returned. Bound probes to 10s.
 */
export async function probeManagedVoiceSpeechReadiness(options: {
  client: Pick<PlatformSpeechClient, "capabilities">;
  signal?: AbortSignal;
}): Promise<{ ready: boolean }> {
  const { state } = await classifyManagedVoiceSpeechReadiness(options);
  return { ready: state === "ready" };
}
