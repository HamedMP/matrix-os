import {
  SpeechCancellationResponseSchema,
  SpeechCapabilitiesResponseSchema,
  SpeechRequestIdSchema,
  SpeechSafeErrorResponseSchema,
  SpeechStatusResponseSchema,
  SpeechSynthesisRequestSchema,
  SpeechSynthesisResponseSchema,
  SpeechSynthesisStreamFrameSchema,
  SPEECH_SYNTHESIS_STREAM_MAX_AUDIO_BYTES,
  SPEECH_SYNTHESIS_STREAM_MAX_LINE_BYTES,
  type SpeechSynthesisStreamFrame,
  SpeechTranscriptionResponseSchema,
  type SpeechCancellationResponse,
  type SpeechCapabilitiesResponse,
  type SpeechMediaType,
  type SpeechSourceKind,
  type SpeechStatusResponse,
  type SpeechSynthesisResponse,
  type SpeechTranscriptionResponse,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const DEFAULT_TIMEOUT_MS = 65_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SYNTHESIS_RESPONSE_BYTES = 12 * 1024 * 1024;
const HandleSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const IdentitySchema = z.object({
  ownerId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  machineId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
}).strict();
const RuntimeTokenSchema = z.string().min(32).max(512).regex(/^[A-Za-z0-9._~+/=-]+$/);
type SafeError = z.infer<typeof SpeechSafeErrorResponseSchema>;
type SafeErrorCode = SafeError["error"]["code"];

export interface PlatformSpeechRuntimeConfig {
  baseUrl: string;
  runtimeAuthToken: string;
  identity: z.infer<typeof IdentitySchema>;
  requestOwnerId: string;
  requestTimeoutMs: number;
}

export interface PlatformSpeechClient {
  readonly ownerId: string;
  capabilities(signal?: AbortSignal): Promise<SpeechCapabilitiesResponse>;
  transcribe(input: {
    requestId: string;
    sourceKind: SpeechSourceKind;
    audio: Uint8Array;
    mediaType: SpeechMediaType;
    languageHints?: readonly string[];
    signal: AbortSignal;
  }): Promise<SpeechTranscriptionResponse>;
  synthesize(input: {
    requestId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<SpeechSynthesisResponse>;
  synthesizeStream(input: { requestId: string; text: string; signal: AbortSignal }): AsyncIterable<SpeechSynthesisStreamFrame>;
  status(requestId: string, signal?: AbortSignal): Promise<SpeechStatusResponse | undefined>;
  cancel(requestId: string, signal?: AbortSignal): Promise<SpeechCancellationResponse>;
}

export class PlatformSpeechRuntimeConfigError extends Error {
  constructor() {
    super("Platform speech runtime is misconfigured");
    this.name = "PlatformSpeechRuntimeConfigError";
  }
}

export class PlatformSpeechClientError extends Error {
  constructor(
    readonly code: SafeErrorCode | "invalid_response",
    readonly safeMessage: string,
    readonly status: number,
  ) {
    super("Platform speech request failed safely");
    this.name = "PlatformSpeechClientError";
  }
}

function parsePlatformOrigin(raw: string | undefined): URL {
  if (!raw || raw.length > 2_048 || !/^[A-Za-z0-9:/._~%\[\]-]+$/.test(raw)) {
    throw new PlatformSpeechRuntimeConfigError();
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new PlatformSpeechRuntimeConfigError();
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new PlatformSpeechRuntimeConfigError();
  }
  return url;
}

export function loadPlatformSpeechRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformSpeechRuntimeConfig | undefined {
  if (env.MATRIX_PLATFORM_SPEECH_ENABLED !== "true" && env.MATRIX_PLATFORM_SPEECH_ENABLED !== "1") {
    return undefined;
  }
  const platform = parsePlatformOrigin(env.MATRIX_PLATFORM_SPEECH_ORIGIN ?? env.PLATFORM_INTERNAL_URL);
  const handle = HandleSchema.safeParse(env.MATRIX_HANDLE);
  const identityOverrides = [
    env.MATRIX_PLATFORM_SPEECH_OWNER_ID,
    env.MATRIX_PLATFORM_SPEECH_MACHINE_ID,
    env.MATRIX_PLATFORM_SPEECH_RUNTIME_SLOT,
  ];
  const hasIdentityOverride = identityOverrides.some((value) => value !== undefined);
  if (hasIdentityOverride && identityOverrides.some((value) => value === undefined)) {
    throw new PlatformSpeechRuntimeConfigError();
  }
  if (hasIdentityOverride) {
    const previewSlot = env.MATRIX_RUNTIME_SLOT;
    if (env.MATRIX_PREVIEW_RUNTIME !== "true" || !previewSlot || !/^pr-[1-9][0-9]{0,8}$/.test(previewSlot)
      || identityOverrides[2] !== previewSlot || !platform.hostname.startsWith(`${previewSlot}---`)) {
      throw new PlatformSpeechRuntimeConfigError();
    }
  }
  const identity = IdentitySchema.safeParse({
    ownerId: hasIdentityOverride ? identityOverrides[0] : env.MATRIX_CLERK_USER_ID,
    machineId: hasIdentityOverride ? identityOverrides[1] : env.MATRIX_MACHINE_ID,
    runtimeSlot: hasIdentityOverride ? identityOverrides[2] : env.MATRIX_RUNTIME_SLOT,
  });
  const token = RuntimeTokenSchema.safeParse(env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN);
  const requestOwnerId = IdentitySchema.shape.ownerId.safeParse(
    env.MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID
      ?? (hasIdentityOverride ? identityOverrides[0] : env.MATRIX_CLERK_USER_ID),
  );
  if (env.MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID !== undefined
    && env.MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID !== env.MATRIX_CLERK_USER_ID) {
    throw new PlatformSpeechRuntimeConfigError();
  }
  const timeout = env.MATRIX_PLATFORM_SPEECH_TIMEOUT_MS === undefined
    ? DEFAULT_TIMEOUT_MS
    : Number(env.MATRIX_PLATFORM_SPEECH_TIMEOUT_MS);
  if (!handle.success || !identity.success || !requestOwnerId.success || !token.success
    || !Number.isSafeInteger(timeout) || timeout < 5_000 || timeout > 90_000) {
    throw new PlatformSpeechRuntimeConfigError();
  }
  return {
    baseUrl: new URL(
      `/internal/containers/${encodeURIComponent(handle.data)}/speech`,
      platform,
    ).toString().replace(/\/$/, ""),
    runtimeAuthToken: token.data,
    identity: identity.data,
    requestOwnerId: requestOwnerId.data,
    requestTimeoutMs: timeout,
  };
}

async function readWithSignal(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  if (!signal) return reader.read();
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

async function readBoundedJson(response: Response, maxBytes = MAX_RESPONSE_BYTES, signal?: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body) void response.body.cancel().catch((error: unknown) => console.warn("[platform-speech] response cleanup failed", error));
    throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
  }
  if (!response.body) throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const next = await readWithSignal(reader, signal);
      if (next.done) break;
      if (size + next.value.byteLength > maxBytes) {
        throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
      }
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
  } catch (error: unknown) {
    void reader.cancel().catch((error: unknown) => console.warn("[platform-speech] response cleanup failed", error));
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
  } catch (error: unknown) {
    if (error instanceof PlatformSpeechClientError) throw error;
    throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
  }
}

export function createPlatformSpeechClient(
  config: PlatformSpeechRuntimeConfig,
  dependencies: { fetchFn?: typeof fetch; makeTimeoutSignal?: (ms: number) => AbortSignal } = {},
): PlatformSpeechClient {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const makeTimeoutSignal = dependencies.makeTimeoutSignal ?? AbortSignal.timeout;

  function url(path: string): string {
    const target = new URL(`${config.baseUrl}${path}`);
    target.searchParams.set("runtimeSlot", config.identity.runtimeSlot);
    return target.toString();
  }

  async function request<T>(options: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    body?: BodyInit;
    signal?: AbortSignal;
    schema: z.ZodType<T>;
    notFound?: boolean;
    contentType?: string;
    maxResponseBytes?: number;
  }): Promise<T | undefined> {
    const timeout = makeTimeoutSignal(config.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchFn(url(options.path), {
        method: options.method,
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${config.runtimeAuthToken}`,
          accept: "application/json",
          ...(options.contentType ? { "content-type": options.contentType } : {}),
        },
        body: options.body,
      });
    } catch (error: unknown) {
      if (error instanceof PlatformSpeechClientError) throw error;
      throw new PlatformSpeechClientError("unavailable", "Speech is unavailable", 503);
    }
    let payload: unknown;
    try { payload = await readBoundedJson(response, options.maxResponseBytes, signal); }
    catch (error: unknown) {
      if (options.signal?.aborted) throw new PlatformSpeechClientError("cancelled", "Transcription was cancelled", 409);
      if (timeout.aborted) throw new PlatformSpeechClientError("timeout", "Transcription timed out", 504);
      if (error instanceof PlatformSpeechClientError) throw error;
      throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
    }
    if (response.ok) {
      const parsed = options.schema.safeParse(payload);
      if (!parsed.success) {
        throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
      }
      return parsed.data;
    }
    // The browser has already authenticated to its gateway. A 401 from the
    // platform is therefore a broken/expired runtime credential, not a browser
    // session error, and must not be reflected as user authentication state.
    if (response.status === 401) {
      throw new PlatformSpeechClientError("unavailable", "Speech is unavailable", 503);
    }
    if (options.notFound && response.status === 404) return undefined;
    const parsedError = SpeechSafeErrorResponseSchema.safeParse(payload);
    if (!parsedError.success) {
      throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
    }
    throw new PlatformSpeechClientError(
      parsedError.data.error.code,
      parsedError.data.error.message,
      response.status,
    );
  }

  return {
    ownerId: config.requestOwnerId,
    async capabilities(signal) {
      return (await request({ path: "/capabilities", method: "GET", signal, schema: SpeechCapabilitiesResponseSchema }))!;
    },
    async transcribe(input) {
      const requestId = SpeechRequestIdSchema.parse(input.requestId);
      const form = new FormData();
      form.set("requestId", requestId);
      form.set("sourceKind", input.sourceKind);
      form.set("recording", new Blob([Uint8Array.from(input.audio)], { type: input.mediaType }), "recording.wav");
      if (input.languageHints && input.languageHints.length > 0) {
        form.set("languageHints", JSON.stringify(input.languageHints));
      }
      return (await request({
        path: "/transcriptions",
        method: "POST",
        body: form,
        signal: input.signal,
        schema: SpeechTranscriptionResponseSchema,
      }))!;
    },
    async synthesize(input) {
      const body = SpeechSynthesisRequestSchema.parse({ requestId: input.requestId, text: input.text });
      return (await request({
        path: "/syntheses",
        method: "POST",
        body: JSON.stringify(body),
        contentType: "application/json",
        signal: input.signal,
        schema: SpeechSynthesisResponseSchema,
        maxResponseBytes: MAX_SYNTHESIS_RESPONSE_BYTES,
      }))!;
    },
    async *synthesizeStream(input) {
      const body = SpeechSynthesisRequestSchema.parse({ requestId: input.requestId, text: input.text });
      const timeout = makeTimeoutSignal(config.requestTimeoutMs);
      const local = new AbortController();
      const signal = AbortSignal.any([input.signal, timeout, local.signal]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let finished = false;
      const invalid = () => new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
      try {
        signal.throwIfAborted();
        const response = await fetchFn(url("/syntheses/stream"), {
          method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${config.runtimeAuthToken}`, accept: "application/x-ndjson", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const payload = await readBoundedJson(response, MAX_RESPONSE_BYTES, signal);
          const error = SpeechSafeErrorResponseSchema.safeParse(payload);
          if (response.status === 401) throw new PlatformSpeechClientError("unavailable", "Speech is unavailable", 503);
          if (!error.success) throw invalid();
          throw new PlatformSpeechClientError(error.data.error.code, error.data.error.message, response.status);
        }
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/x-ndjson") || !response.body) {
          if (response.body) void response.body.cancel().catch((error: unknown) => console.warn("[platform-speech] stream cleanup failed", error));
          throw invalid();
        }
        reader = response.body.getReader();
        const line = new Uint8Array(SPEECH_SYNTHESIS_STREAM_MAX_LINE_BYTES);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let lineSize = 0;
        let wireBytes = 0;
        let audioBytes = 0;
        let sequence = 0;
        let terminal: SpeechSynthesisStreamFrame | undefined;
        for (;;) {
          const next = await readWithSignal(reader, signal);
          if (next.done) break;
          wireBytes += next.value.byteLength;
          // Separate wire budget also bounds malicious tiny-frame overhead.
          if (wireBytes > 16 * 1024 * 1024) throw invalid();
          let offset = 0;
          while (offset < next.value.byteLength) {
            if (terminal) throw invalid();
            const newline = next.value.indexOf(10, offset);
            const end = newline === -1 ? next.value.byteLength : newline;
            const size = end - offset;
            if (lineSize + size > line.byteLength) throw invalid();
            line.set(next.value.subarray(offset, end), lineSize);
            lineSize += size;
            offset = newline === -1 ? end : end + 1;
            if (newline === -1) continue;
            const parsed = SpeechSynthesisStreamFrameSchema.safeParse(JSON.parse(decoder.decode(line.subarray(0, lineSize))));
            lineSize = 0;
            if (!parsed.success || parsed.data.sequence !== sequence++) throw invalid();
            const frame = parsed.data;
            if (frame.type === "audio") {
              audioBytes += Buffer.from(frame.data, "base64").byteLength;
              if (audioBytes > SPEECH_SYNTHESIS_STREAM_MAX_AUDIO_BYTES) throw invalid();
              yield frame;
              signal.throwIfAborted();
            } else {
              if (frame.type === "end" && frame.durationMs !== Math.ceil(audioBytes / 48)) throw invalid();
              terminal = frame;
            }
          }
        }
        if (lineSize !== 0 || !terminal) throw invalid();
        finished = true;
        yield terminal;
      } catch (error: unknown) {
        if (input.signal.aborted) throw new PlatformSpeechClientError("cancelled", "Transcription was cancelled", 409);
        if (timeout.aborted) throw new PlatformSpeechClientError("timeout", "Transcription timed out", 504);
        if (error instanceof PlatformSpeechClientError) throw error;
        if (error instanceof SyntaxError || error instanceof TypeError) throw invalid();
        throw new PlatformSpeechClientError("unavailable", "Speech is unavailable", 503);
      } finally {
        local.abort();
        if (reader) {
          if (!finished) void reader.cancel().catch((error: unknown) => console.warn("[platform-speech] stream cleanup failed", error));
          reader.releaseLock();
        }
      }
    },
    async status(requestId, signal) {
      return request({
        path: `/transcriptions/${encodeURIComponent(SpeechRequestIdSchema.parse(requestId))}`,
        method: "GET",
        signal,
        schema: SpeechStatusResponseSchema,
        notFound: true,
      });
    },
    async cancel(requestId, signal) {
      return (await request({
        path: `/transcriptions/${encodeURIComponent(SpeechRequestIdSchema.parse(requestId))}`,
        method: "DELETE",
        body: "",
        signal,
        schema: SpeechCancellationResponseSchema,
      }))!;
    },
  };
}
