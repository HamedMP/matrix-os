import { z } from "zod/v4";
import type { SpeechMediaType } from "@matrix-os/contracts";

const TRANSCRIPTIONS_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_CHARS = 32_000;
const ModelSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const ResponseSchema = z.object({ text: z.string().max(MAX_TRANSCRIPT_CHARS) }).passthrough();

export type SpeechAdapterErrorCode =
  | "misconfigured"
  | "unsupported_options"
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

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
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
        await reader.cancel();
        throw new SpeechAdapterError("invalid_response", "Transcription response exceeded its limit");
      }
      value += decoder.decode(next.value, { stream: true });
    }
    value += decoder.decode();
    return value;
  } catch (error: unknown) {
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
      if (input.languageHints && input.languageHints.length > 0) {
        throw new SpeechAdapterError(
          "unsupported_options",
          "Language hints require a validated adapter contract",
        );
      }
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
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error: unknown) {
        if (error instanceof SpeechAdapterError) throw error;
        throw new SpeechAdapterError("request_failed", "Transcription request failed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SpeechAdapterError("request_failed", "Transcription request failed");
      }
      const body = await readBoundedText(response, maxResponseBytes);
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
    },
  };
}
