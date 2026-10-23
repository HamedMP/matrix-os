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
import type { PlatformSpeechDraftClient } from "@matrix-os/ui/speech";
import { File, Paths, UploadType } from "expo-file-system";

import { gatewayRequestUrl } from "@/lib/requests/answers";
import { createRequestTimeout } from "@/lib/requests/http";

import type { SpeechRecording } from "./capture";

// The gateway's answers are a few hundred bytes; a transcript is at most 128 KB.
const MAX_RESPONSE_CHARS = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
// A two-minute recording on a phone connection, then the transcription itself.
const TRANSCRIPTION_TIMEOUT_MS = 70_000;

export type SpeechErrorCode =
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

// The same words the web app uses for each answer.
const SAFE_MESSAGES: Record<SpeechErrorCode, string> = {
  unauthorized: "Unauthorized",
  unavailable: "Speech is unavailable",
  invalid_request: "Invalid speech request",
  invalid_media: "This recording cannot be transcribed",
  request_conflict: "This speech request was already used",
  not_found: "Speech request not found",
  rate_limited: "Try speech again later",
  allowance_exhausted: "Speech allowance is unavailable",
  timeout: "Transcription timed out",
  transcription_failed: "Transcription failed",
  cancelled: "Transcription was cancelled",
};

/** A speech request that did not work, with words that are safe to show. */
export class SpeechRequestError extends Error {
  readonly safeMessage: string;

  constructor(readonly code: SpeechErrorCode) {
    super("Speech request failed");
    this.name = "SpeechRequestError";
    this.safeMessage = SAFE_MESSAGES[code];
  }
}

export interface SpeechGatewaySession {
  token: string;
  gatewayUrl: string;
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function cancelled(): Error {
  const error = new Error("Speech request cancelled");
  error.name = "AbortError";
  return error;
}

/** One signal for the caller's and the timeout's, whichever comes first. */
function linkSignals(caller: AbortSignal | undefined, timeoutMs: number) {
  const timeout = createRequestTimeout(timeoutMs);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (caller?.aborted || timeout.signal.aborted) controller.abort();
  caller?.addEventListener("abort", abort, { once: true });
  timeout.signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      caller?.removeEventListener("abort", abort);
      timeout.signal.removeEventListener("abort", abort);
      timeout.cancel();
    },
  };
}

function parseBody(body: string): unknown {
  if (body.length > MAX_RESPONSE_CHARS) throw new SpeechRequestError("unavailable");
  try {
    return JSON.parse(body);
  } catch (error: unknown) {
    // Not JSON: a proxy's error page, never something to show.
    console.warn("[speech] answer was not JSON", error instanceof Error ? error.name : "UnknownError");
    throw new SpeechRequestError("unavailable");
  }
}

/** The body of an answer that went through, as the schema says it must be. */
function readAnswer<T>(body: string, schema: Schema<T>): T {
  const parsed = schema.safeParse(parseBody(body));
  if (parsed.success) return parsed.data;
  throw new SpeechRequestError("unavailable");
}

/** A refusal, in the gateway's own safe words when it gave them. */
function refusal(body: string): SpeechRequestError {
  const parsed = SpeechSafeErrorResponseSchema.safeParse(parseBody(body));
  return new SpeechRequestError(parsed.success ? parsed.data.error.code : "unavailable");
}

function failure(error: unknown, signal: AbortSignal | undefined, label: string): Error {
  if (error instanceof SpeechRequestError) return error;
  if (signal?.aborted) return cancelled();
  console.warn(`[speech] ${label} failed`, error instanceof Error ? error.name : "UnknownError");
  return new SpeechRequestError("unavailable");
}

function removeRecordingFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch (error: unknown) {
    // The system clears its cache in time; the transcript still counts.
    console.warn("[speech] recording file cleanup failed", error instanceof Error ? error.name : "UnknownError");
  }
}

/**
 * Dictation through the speech routes of the computer's gateway, which pass it
 * to Matrix's speech service. The phone never picks a provider or holds a
 * provider key; it sends the signed-in account's token, as every other request
 * to the computer does.
 */
export function createGatewaySpeechClient(
  session: () => Promise<SpeechGatewaySession | null>,
): PlatformSpeechDraftClient<SpeechRecording> {
  async function openSession(path: string, signal: AbortSignal | undefined) {
    const current = await session();
    if (signal?.aborted) throw cancelled();
    const url = current ? gatewayRequestUrl(current.gatewayUrl, `/api/speech${path}`) : null;
    if (!current || !url) throw new SpeechRequestError("unavailable");
    return { url, token: current.token };
  }

  async function requestJson<T>(input: {
    path: string;
    method: "GET" | "DELETE";
    schema: Schema<T>;
    signal?: AbortSignal;
    label: string;
  }): Promise<T> {
    try {
      const { url, token } = await openSession(input.path, input.signal);
      const linked = linkSignals(input.signal, REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: input.method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          // The gateway applies its body limit to DELETE too.
          ...(input.method === "DELETE" ? { body: "" } : {}),
          signal: linked.signal,
        });
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) throw new SpeechRequestError("unavailable");
        if (!response.ok) throw refusal(await response.text());
        return readAnswer(await response.text(), input.schema);
      } finally {
        linked.release();
      }
    } catch (error: unknown) {
      throw failure(error, input.signal, input.label);
    }
  }

  return {
    capabilities: (signal?: AbortSignal): Promise<SpeechCapabilitiesResponse> => requestJson({
      path: "/capabilities",
      method: "GET",
      schema: SpeechCapabilitiesResponseSchema,
      signal,
      label: "capability check",
    }),

    async transcribe({ requestId, recording, signal }): Promise<SpeechTranscriptionResponse> {
      let file: File | null = null;
      try {
        const id = SpeechRequestIdSchema.safeParse(requestId);
        if (!id.success) throw new SpeechRequestError("invalid_request");
        const { url, token } = await openSession("/transcriptions", signal);
        // The upload sends a file, so the recording is on the phone, in its
        // cache, only for as long as it is being sent.
        file = new File(Paths.cache, `speech-${id.data}.wav`);
        file.create({ overwrite: false });
        file.write(recording.bytes);
        const linked = linkSignals(signal, TRANSCRIPTION_TIMEOUT_MS);
        try {
          const result = await file.upload(url, {
            httpMethod: "POST",
            uploadType: UploadType.MULTIPART,
            fieldName: "recording",
            mimeType: "audio/wav",
            parameters: { requestId: id.data },
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            // Tied to the app being open, like the draft it fills.
            sessionType: "foreground",
            signal: linked.signal,
          });
          if (result.status < 200 || result.status >= 300) throw refusal(result.body);
          const transcription = readAnswer(result.body, SpeechTranscriptionResponseSchema);
          if (transcription.requestId !== id.data) throw new SpeechRequestError("unavailable");
          return transcription;
        } finally {
          linked.release();
        }
      } catch (error: unknown) {
        throw failure(error, signal, "transcription");
      } finally {
        if (file) removeRecordingFile(file);
        recording.bytes.fill(0);
      }
    },

    cancel: (requestId: string, signal?: AbortSignal): Promise<SpeechCancellationResponse> => {
      const id = SpeechRequestIdSchema.safeParse(requestId);
      if (!id.success) return Promise.reject(new SpeechRequestError("invalid_request"));
      return requestJson({
        path: `/transcriptions/${encodeURIComponent(id.data)}`,
        method: "DELETE",
        schema: SpeechCancellationResponseSchema,
        signal,
        label: "cancellation",
      });
    },
  };
}
