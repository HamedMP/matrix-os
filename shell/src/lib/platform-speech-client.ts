import {
  SpeechCancellationResponseSchema,
  SpeechCapabilitiesResponseSchema,
  SpeechRequestIdSchema,
  SpeechSafeErrorResponseSchema,
  SpeechTranscriptionResponseSchema,
  type SpeechCancellationResponse,
  type SpeechCapabilitiesResponse,
  type SpeechTranscriptionResponse,
} from "@matrix-os/contracts";
import { getGatewayUrl } from "./gateway";

const MAX_RESPONSE_BYTES = 256 * 1024;
const CAPABILITY_TIMEOUT_MS = 10_000;
const TRANSCRIPTION_TIMEOUT_MS = 70_000;

type BrowserSpeechErrorCode =
  | "unauthorized"
  | "unavailable"
  | "invalid_request"
  | "invalid_media"
  | "request_conflict"
  | "not_found"
  | "rate_limited"
  | "allowance_exhausted"
  | "timeout"
  | "transcription_failed"
  | "cancelled";

export class BrowserSpeechClientError extends Error {
  constructor(
    readonly code: BrowserSpeechErrorCode,
    readonly safeMessage: string,
  ) {
    super("Speech request failed safely");
    this.name = "BrowserSpeechClientError";
  }
}

export interface BrowserSpeechClient {
  capabilities(signal?: AbortSignal): Promise<SpeechCapabilitiesResponse>;
  transcribe(input: {
    requestId: string;
    recording: Blob;
    signal: AbortSignal;
  }): Promise<SpeechTranscriptionResponse>;
  cancel(requestId: string, signal?: AbortSignal): Promise<SpeechCancellationResponse>;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
  }
  if (!response.body) throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
      }
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
  } catch (error: unknown) {
    if (error instanceof BrowserSpeechClientError) throw error;
    throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
  }
}

export function createBrowserSpeechClient(options: {
  baseUrl?: string;
  fetcher?: typeof fetch;
  makeTimeoutSignal?: (ms: number) => AbortSignal;
} = {}): BrowserSpeechClient {
  const fetcher = options.fetcher ?? fetch;
  const makeTimeoutSignal = options.makeTimeoutSignal ?? AbortSignal.timeout;
  const baseUrl = (options.baseUrl ?? getGatewayUrl()).replace(/\/$/, "");

  async function request<T>(input: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    body?: BodyInit;
    signal?: AbortSignal;
    timeoutMs: number;
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } };
  }): Promise<T> {
    const timeout = makeTimeoutSignal(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}/api/speech${input.path}`, {
        method: input.method,
        body: input.body,
        signal,
        cache: "no-store",
        credentials: "include",
        headers: { accept: "application/json" },
      });
    } catch (error: unknown) {
      if (error instanceof BrowserSpeechClientError) throw error;
      throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
    }
    const payload = await boundedJson(response);
    if (response.ok) {
      const parsed = input.schema.safeParse(payload);
      if (parsed.success) return parsed.data;
      throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
    }
    const parsed = SpeechSafeErrorResponseSchema.safeParse(payload);
    if (!parsed.success) throw new BrowserSpeechClientError("unavailable", "Speech is unavailable");
    throw new BrowserSpeechClientError(parsed.data.error.code, parsed.data.error.message);
  }

  return {
    capabilities(signal) {
      return request({
        path: "/capabilities",
        method: "GET",
        signal,
        timeoutMs: CAPABILITY_TIMEOUT_MS,
        schema: SpeechCapabilitiesResponseSchema,
      });
    },
    transcribe(input) {
      const requestId = SpeechRequestIdSchema.parse(input.requestId);
      const form = new FormData();
      form.set("requestId", requestId);
      form.set("recording", input.recording, "recording.wav");
      return request({
        path: "/transcriptions",
        method: "POST",
        body: form,
        signal: input.signal,
        timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
        schema: SpeechTranscriptionResponseSchema,
      });
    },
    cancel(requestId, signal) {
      return request({
        path: `/transcriptions/${encodeURIComponent(SpeechRequestIdSchema.parse(requestId))}`,
        method: "DELETE",
        body: "",
        signal,
        timeoutMs: CAPABILITY_TIMEOUT_MS,
        schema: SpeechCancellationResponseSchema,
      });
    },
  };
}
