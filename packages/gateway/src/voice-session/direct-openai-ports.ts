/**
 * Direct OpenAI speech ports — a DEVELOPMENT-ONLY escape hatch.
 *
 * Registration policy (`adapter-registration.ts`) gates this factory behind
 * `MATRIX_VOICE_DIRECT_OPENAI=1` + `MATRIX_VOICE_OPENAI_API_KEY` +
 * `NODE_ENV !== "production"`. A production gateway never holds provider
 * keys: funding, policy, and metering live behind Platform Speech
 * (`speech/DOMAIN.md`), and no platform TTS endpoint exists yet — which is
 * why the managed adapter may reuse this factory's `synthesize` half under
 * the same dev gate while STT stays managed.
 *
 * Safety posture: bounded reads, `redirect: "error"`, deadline +
 * per-operation abort signals, and only classified `VoiceSpeechPortError`
 * kinds leave the port — no provider names, endpoints, or error text.
 */
import { z } from "zod/v4";
import type { VoiceOutputAudioFormat } from "@matrix-os/contracts/voice-session";
import {
  VoiceSpeechPortError,
  sanitizeLanguageHints,
  type VoiceSpeechPorts,
  type VoiceSynthesisRequest,
  type VoiceTranscriptionRequest,
} from "./speech-ports.js";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const TRANSCRIPTION_TIMEOUT_MS = 55_000;
const SPEECH_TIMEOUT_MS = 60_000;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 128 * 1024;
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const VOICE_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRANSCRIPT_CHARS = 8_000;

/**
 * `/v1/audio/speech` with `response_format: "pcm"` streams raw 24kHz mono
 * s16le — INDEPENDENT of the negotiated 16kHz capture format. It must be
 * declared, or playback decodes at the wrong rate (slow/low-pitched).
 */
const OPENAI_OUTPUT_AUDIO: VoiceOutputAudioFormat = {
  codec: "pcm_s16le",
  sampleRateHz: 24_000,
  channels: 1,
};

const TranscriptionResponseSchema = z
  .object({ text: z.string().max(MAX_TRANSCRIPT_CHARS) })
  .passthrough();

export interface DirectOpenAiSpeechPortOptions {
  apiKey: string;
  /** File-transcription model, e.g. "gpt-4o-mini-transcribe" or "whisper-1". */
  transcriptionModel: string;
  /** Speech model, e.g. "gpt-4o-mini-tts". */
  speechModel: string;
  /** Speech voice, e.g. "alloy". */
  voice: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function logWarn(event: string, error: unknown): void {
  console.warn(`[voice-openai-ports] ${event}`, {
    error: error instanceof Error ? error.name : "UnknownError",
  });
}

/** Best-effort body cleanup — never awaited, never throws. */
function cancelBodyQuietly(cancel: () => Promise<void>): void {
  try {
    void cancel().catch((error: unknown) => logWarn("response_cleanup_failed", error));
  } catch (error: unknown) {
    logWarn("response_cleanup_failed", error);
  }
}

export function createDirectOpenAiSpeechPorts(
  options: DirectOpenAiSpeechPortOptions,
): VoiceSpeechPorts {
  if (!options || typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new TypeError("Direct OpenAI speech ports require an API key");
  }
  if (!MODEL_SLUG.test(options.transcriptionModel) || !MODEL_SLUG.test(options.speechModel)) {
    throw new TypeError("Direct OpenAI speech port model identifiers are invalid");
  }
  if (!VOICE_SLUG.test(options.voice)) {
    throw new TypeError("Direct OpenAI speech port voice identifier is invalid");
  }
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl ?? fetch;

  /**
   * One bounded POST: deadline + caller abort combined into the fetch signal,
   * redirect rejection, auth header, and a classifier distinguishing caller
   * aborts from timeouts and network failures.
   */
  async function post(
    url: string,
    init: { body: BodyInit; extraHeaders?: Record<string, string> },
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ response: Response; classify: () => VoiceSpeechPortError }> {
    const deadline = AbortSignal.timeout(timeoutMs);
    let abortedBy: "op" | "deadline" | undefined;
    const markOp = () => {
      abortedBy ??= "op";
    };
    const markDeadline = () => {
      abortedBy ??= "deadline";
    };
    signal.addEventListener("abort", markOp, { once: true });
    deadline.addEventListener("abort", markDeadline, { once: true });
    const classify = (): VoiceSpeechPortError => {
      if (abortedBy === "op" || signal.aborted) {
        return new VoiceSpeechPortError("aborted");
      }
      if (abortedBy === "deadline" || deadline.aborted) {
        return new VoiceSpeechPortError("timeout");
      }
      return new VoiceSpeechPortError("connection");
    };
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...init.extraHeaders,
        },
        body: init.body,
        signal: AbortSignal.any([deadline, signal]),
      });
      if (!response.ok) {
        if (response.body) {
          const body = response.body;
          cancelBodyQuietly(() => body.cancel());
        }
        throw new VoiceSpeechPortError("unavailable");
      }
      return { response, classify };
    } catch (error: unknown) {
      if (error instanceof VoiceSpeechPortError) throw error;
      if (abortedBy === "op" || signal.aborted) {
        throw new VoiceSpeechPortError("aborted");
      }
      if (abortedBy === "deadline" || deadline.aborted) {
        throw new VoiceSpeechPortError("timeout");
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new VoiceSpeechPortError("timeout");
      }
      throw classify();
    } finally {
      signal.removeEventListener("abort", markOp);
      deadline.removeEventListener("abort", markDeadline);
    }
  }

  async function readBoundedText(
    response: Response,
    maxBytes: number,
    classify: () => VoiceSpeechPortError,
  ): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    let value = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          cancelBodyQuietly(() => reader.cancel());
          throw new VoiceSpeechPortError("unavailable");
        }
        value += decoder.decode(next.value, { stream: true });
      }
      value += decoder.decode();
      return value;
    } catch (error: unknown) {
      if (error instanceof VoiceSpeechPortError) throw error;
      const failure = classify();
      // Mid-body aborts keep their classification; truncated/undecodable
      // bodies are provider-side failures, not connection losses.
      throw failure.kind === "connection" ? new VoiceSpeechPortError("unavailable") : failure;
    } finally {
      reader.releaseLock();
    }
  }

  async function transcribe(request: VoiceTranscriptionRequest): Promise<{ text: string }> {
    const form = new FormData();
    form.set("model", options.transcriptionModel);
    form.set("file", new Blob([new Uint8Array(request.wav)], { type: "audio/wav" }), "capture.wav");
    form.set("response_format", "json");
    // Hints are a managed-path affordance; the direct path stays identical to
    // pre-port behavior (provider auto-detects) unless a clean hint exists.
    const hint = sanitizeLanguageHints(request.languageHints)?.[0];
    if (hint && /^[a-zA-Z]{2,3}$/.test(hint)) {
      form.set("language", hint.toLowerCase());
    }
    const { response, classify } = await post(
      TRANSCRIPTIONS_URL,
      { body: form },
      TRANSCRIPTION_TIMEOUT_MS,
      request.signal,
    );
    const body = await readBoundedText(response, MAX_TRANSCRIPTION_RESPONSE_BYTES, classify);
    try {
      const parsed = TranscriptionResponseSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("invalid transcription body");
      return { text: parsed.data.text.trim() };
    } catch (error: unknown) {
      if (error instanceof VoiceSpeechPortError) throw error;
      throw new VoiceSpeechPortError("unavailable");
    }
  }

  async function* synthesize(request: VoiceSynthesisRequest): AsyncGenerator<Buffer, void, void> {
    const { response, classify } = await post(
      SPEECH_URL,
      {
        body: JSON.stringify({
          model: options.speechModel,
          voice: options.voice,
          input: request.text,
          response_format: "pcm",
        }),
        extraHeaders: { "content-type": "application/json" },
      },
      SPEECH_TIMEOUT_MS,
      request.signal,
    );
    if (!response.body) throw new VoiceSpeechPortError("unavailable");
    const reader = response.body.getReader();
    let finished = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          finished = true;
          break;
        }
        yield Buffer.from(next.value);
      }
    } catch (error: unknown) {
      if (error instanceof VoiceSpeechPortError) throw error;
      throw classify();
    } finally {
      // Early consumer exit (cap breach, cancel, close): release the body so
      // the connection drains instead of hanging on an unread stream.
      if (!finished) cancelBodyQuietly(() => reader.cancel());
      reader.releaseLock();
    }
  }

  return { transcribe, synthesize, outputAudio: OPENAI_OUTPUT_AUDIO };
}
