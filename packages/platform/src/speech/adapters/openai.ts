import { z } from "zod/v4";
import {
  SPEECH_MAX_SYNTHESIS_AUDIO_BYTES,
  SPEECH_MAX_TRANSCRIPT_CHARS,
  type SpeechMediaType,
} from "@matrix-os/contracts";

const TRANSCRIPTIONS_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const ModelSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const ResponseSchema = z.object({ text: z.string().max(SPEECH_MAX_TRANSCRIPT_CHARS) }).passthrough();

export type SpeechAdapterErrorCode =
  | "misconfigured"
  | "unsupported_options"
  | "cancelled"
  | "timeout"
  | "request_failed"
  | "invalid_response";

export class SpeechAdapterError extends Error {
  constructor(readonly code: SpeechAdapterErrorCode, message: string) {
    super(message);
    this.name = "SpeechAdapterError";
  }
}

export interface FileTranscriptionInput {
  audio: Uint8Array;
  mediaType: SpeechMediaType;
  languageHints?: readonly string[];
  signal: AbortSignal;
}

export interface FileTranscriptionAdapter {
  readonly id: string;
  transcribe(input: FileTranscriptionInput): Promise<{ text: string }>;
}

export interface SpeechSynthesisAdapter {
  readonly id: string;
  synthesize(input: { text: string; signal: AbortSignal }): Promise<Uint8Array>;
  /** Real incremental provider PCM, never a rechunked completed payload. */
  stream?(input: { text: string; signal: AbortSignal }): AsyncIterable<Uint8Array>;
}

/** Abort races also bound fake/custom readers that do not honor fetch's signal. */
async function readSpeechChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export function createOpenAiSpeechSynthesisAdapter(options: {
  apiKey: string;
  model: string;
  voice: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SpeechSynthesisAdapter {
  if (options.apiKey.trim().length < 16 || !ModelSchema.safeParse(options.model).success
    || !/^[A-Za-z0-9_-]{1,64}$/.test(options.voice)) {
    throw new SpeechAdapterError("misconfigured", "Speech synthesis adapter is misconfigured");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 65_000) {
    throw new SpeechAdapterError("misconfigured", "Speech adapter limits are invalid");
  }
  async function* stream(input: { text: string; signal: AbortSignal }): AsyncGenerator<Uint8Array> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const local = new AbortController();
    const signal = AbortSignal.any([input.signal, timeout, local.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false;
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(SPEECH_ENDPOINT, {
        method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        // `stream_format: "audio"` pins the raw-bytes chunked stream; an SSE
        // response would deliver event text this reader must not parse as PCM.
        body: JSON.stringify({ model: options.model, voice: options.voice, input: input.text, response_format: "pcm", stream_format: "audio" }),
        signal,
      });
      if (!response.ok || !response.body) {
        if (response.body) startBestEffortCleanup(() => response.body!.cancel());
        throw new SpeechAdapterError("request_failed", "Synthesis request failed");
      }
      reader = response.body.getReader();
      let total = 0;
      let carry: number | undefined;
      for (;;) {
        const next = await readSpeechChunk(reader, signal);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > SPEECH_MAX_SYNTHESIS_AUDIO_BYTES) throw new SpeechAdapterError("invalid_response", "Synthesis response exceeded its limit");
        let offset = 0;
        if (carry !== undefined && next.value.byteLength > 0) {
          yield new Uint8Array([carry, next.value[0]!]);
          carry = undefined;
          offset = 1;
        }
        const evenEnd = offset + Math.floor((next.value.byteLength - offset) / 2) * 2;
        for (; offset < evenEnd; offset += 65_536) {
          signal.throwIfAborted();
          yield next.value.slice(offset, Math.min(offset + 65_536, evenEnd));
        }
        if (evenEnd < next.value.byteLength) carry = next.value[evenEnd];
      }
      signal.throwIfAborted();
      if (total < 2 || carry !== undefined) throw new SpeechAdapterError("invalid_response", "Synthesis response was invalid");
      finished = true;
    } catch (error: unknown) {
      if (input.signal.aborted) throw new SpeechAdapterError("cancelled", "Synthesis was cancelled");
      if (timeout.aborted) throw new SpeechAdapterError("timeout", "Synthesis timed out");
      if (error instanceof SpeechAdapterError) throw error;
      throw new SpeechAdapterError("request_failed", "Synthesis request failed");
    } finally {
      local.abort();
      if (reader) {
        if (!finished) startBestEffortCleanup(() => reader!.cancel());
        reader.releaseLock();
      }
    }
  }
  return {
    id: "openai-speech", stream,
    async synthesize(input) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream(input)) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
  };
}

function startBestEffortCleanup(cleanup: () => Promise<void>): void {
  try {
    void cleanup().catch((_error: unknown) => {
      console.warn("[speech-adapter] Response cleanup failed");
    });
  } catch (_error: unknown) {
    console.warn("[speech-adapter] Response cleanup failed");
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  abortFailure: () => SpeechAdapterError | undefined,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let value = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        startBestEffortCleanup(() => reader.cancel());
        throw new SpeechAdapterError("invalid_response", "Transcription response exceeded its limit");
      }
      value += decoder.decode(next.value, { stream: true });
    }
    value += decoder.decode();
    return value;
  } catch (error: unknown) {
    const abortError = abortFailure();
    if (abortError) throw abortError;
    if (error instanceof SpeechAdapterError) throw error;
    throw new SpeechAdapterError("invalid_response", "Transcription response was invalid");
  } finally {
    reader.releaseLock();
  }
}

export function createOpenAiFileTranscriptionAdapter(options: {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): FileTranscriptionAdapter {
  if (options.apiKey.trim().length < 16 || !ModelSchema.safeParse(options.model).success) {
    throw new SpeechAdapterError("misconfigured", "Speech adapter is misconfigured");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 65_000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 32
    || maxResponseBytes > 512 * 1024) {
    throw new SpeechAdapterError("misconfigured", "Speech adapter limits are invalid");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: "openai-file",
    async transcribe(input) {
      if (input.signal.aborted) {
        throw new SpeechAdapterError("cancelled", "Transcription was cancelled");
      }
      if (input.languageHints && input.languageHints.length > 0) {
        throw new SpeechAdapterError(
          "unsupported_options",
          "Language hints require a validated adapter contract",
        );
      }
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      let firstAbort: "cancelled" | "timeout" | undefined;
      const markCancelled = () => { firstAbort ??= "cancelled"; };
      const markTimedOut = () => { firstAbort ??= "timeout"; };
      input.signal.addEventListener("abort", markCancelled, { once: true });
      deadlineSignal.addEventListener("abort", markTimedOut, { once: true });
      if (input.signal.aborted) markCancelled();
      if (deadlineSignal.aborted) markTimedOut();
      const abortFailure = () => firstAbort === "cancelled"
        ? new SpeechAdapterError("cancelled", "Transcription was cancelled")
        : firstAbort === "timeout"
          ? new SpeechAdapterError("timeout", "Transcription timed out")
          : undefined;
      try {
        const form = new FormData();
        form.set("model", options.model);
        form.set("file", new Blob([Uint8Array.from(input.audio)], { type: input.mediaType }), "recording.wav");
        let response: Response;
        try {
          response = await fetchImpl(TRANSCRIPTIONS_ENDPOINT, {
            method: "POST",
            redirect: "error",
            headers: { authorization: `Bearer ${options.apiKey}` },
            body: form,
            signal: AbortSignal.any([input.signal, deadlineSignal]),
          });
        } catch (error: unknown) {
          const abortError = abortFailure();
          if (abortError) throw abortError;
          if (error instanceof SpeechAdapterError) throw error;
          throw new SpeechAdapterError("request_failed", "Transcription request failed");
        }
        if (!response.ok) {
          if (response.body) startBestEffortCleanup(() => response.body!.cancel());
          throw new SpeechAdapterError("request_failed", "Transcription request failed");
        }
        const body = await readBoundedText(response, maxResponseBytes, abortFailure);
        const completedBodyAbort = abortFailure();
        if (completedBodyAbort) throw completedBodyAbort;
        let decoded: unknown;
        try {
          decoded = JSON.parse(body);
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) {
            throw new SpeechAdapterError("invalid_response", "Transcription response was invalid");
          }
          throw new SpeechAdapterError("invalid_response", "Transcription response was invalid");
        }
        const parsed = ResponseSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new SpeechAdapterError("invalid_response", "Transcription response was invalid");
        }
        return { text: parsed.data.text.trim() };
      } finally {
        input.signal.removeEventListener("abort", markCancelled);
        deadlineSignal.removeEventListener("abort", markTimedOut);
      }
    },
  };
}
