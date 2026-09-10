import {
  SpeechCancellationResponseSchema,
  SpeechCapabilitiesResponseSchema,
  SpeechRequestIdSchema,
  SpeechSafeErrorResponseSchema,
  SpeechStatusResponseSchema,
  SpeechTranscriptionResponseSchema,
  type SpeechCancellationResponse,
  type SpeechCapabilitiesResponse,
  type SpeechMediaType,
  type SpeechSourceKind,
  type SpeechStatusResponse,
  type SpeechTranscriptionResponse,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const DEFAULT_TIMEOUT_MS = 65_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
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
  const platform = parsePlatformOrigin(env.PLATFORM_INTERNAL_URL);
  const handle = HandleSchema.safeParse(env.MATRIX_HANDLE);
  const identity = IdentitySchema.safeParse({
    ownerId: env.MATRIX_CLERK_USER_ID,
    machineId: env.MATRIX_MACHINE_ID,
    runtimeSlot: env.MATRIX_RUNTIME_SLOT,
  });
  const token = RuntimeTokenSchema.safeParse(env.MATRIX_FUNDED_AI_RUNTIME_TOKEN);
  const timeout = env.MATRIX_PLATFORM_SPEECH_TIMEOUT_MS === undefined
    ? DEFAULT_TIMEOUT_MS
    : Number(env.MATRIX_PLATFORM_SPEECH_TIMEOUT_MS);
  if (!handle.success || !identity.success || !token.success
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
    requestTimeoutMs: timeout,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
  }
  if (!response.body) throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
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
        },
        body: options.body,
      });
    } catch (error: unknown) {
      if (error instanceof PlatformSpeechClientError) throw error;
      throw new PlatformSpeechClientError("unavailable", "Speech is unavailable", 503);
    }
    const payload = await readBoundedJson(response);
    if (response.ok) {
      const parsed = options.schema.safeParse(payload);
      if (!parsed.success) {
        throw new PlatformSpeechClientError("invalid_response", "Speech is unavailable", 503);
      }
      return parsed.data;
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
    ownerId: config.identity.ownerId,
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
