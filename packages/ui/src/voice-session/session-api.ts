/**
 * Typed REST client for the voice session routes
 * (specs/535-aoede-rewrite/contracts/voice-session-api.md).
 *
 * Every request is bounded (10s timeout, 256 KiB response cap) and every
 * failure is mapped to a SafeVoiceError: raw HTTP status text, provider
 * names, and server error bodies never leave this module.
 */
import { z } from "zod/v4";
import {
  CanonicalChatModelSelectionSchema,
  type CanonicalChatModelSelection,
} from "@matrix-os/contracts";
import {
  SafeVoiceErrorSchema,
  VOICE_SESSION_LIMITS,
  VoiceCanonicalChatIdSchema,
  VoiceCapabilitySchema,
  VoiceEpochSchema,
  VoiceSessionIdSchema,
  VoiceSessionStateSchema,
  VoiceTurnModeSchema,
  type SafeVoiceError,
  type SafeVoiceErrorCode,
  type VoiceCapability,
  type VoiceRecoveryAction,
} from "@matrix-os/contracts/voice-session";

export const VOICE_SESSION_API_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const boundedId = (max: number) => z.string().min(1).max(max).regex(SAFE_ID, "Invalid identifier");

export const VoiceSessionTransportGrantSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("relayed_websocket"),
    url: z.string().min(1).max(2_048),
    ticket: z.string().min(1).max(512),
    expiresAt: z.string().min(1).max(64),
    epoch: VoiceEpochSchema,
  }).strict(),
  z.object({
    kind: z.literal("direct_webrtc"),
    ephemeralCredential: z.string().min(1).max(4_096),
    expiresAt: z.string().min(1).max(64),
    epoch: VoiceEpochSchema,
    controlUrl: z.string().min(1).max(2_048),
    controlTicket: z.string().min(1).max(512),
  }).strict(),
]);

export const VoiceSessionResponseLimitsSchema = z.object({
  maxSessionSeconds: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxSessionSeconds),
  maxIdleSeconds: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxIdleSeconds),
  maxQueuedAudioMs: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxQueuedAudioMs),
}).strict();

const sessionResponseBase = {
  sessionId: VoiceSessionIdSchema,
  chatId: VoiceCanonicalChatIdSchema,
  limits: VoiceSessionResponseLimitsSchema,
};

export const CreateVoiceSessionResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...sessionResponseBase,
    outcome: z.enum(["created", "rotated_unconsumed"]),
    status: z.literal("connecting"),
    transport: VoiceSessionTransportGrantSchema,
  }).strict(),
  z.object({
    ...sessionResponseBase,
    outcome: z.literal("existing_consumed"),
    status: VoiceSessionStateSchema,
    reconnectRequired: z.literal(true),
  }).strict(),
]);

export const ReconnectVoiceSessionResponseSchema = z.object({
  ...sessionResponseBase,
  transport: VoiceSessionTransportGrantSchema,
}).strict();

export const CreateVoiceSessionRequestSchema = z.object({
  clientRequestId: boundedId(128),
  turnMode: VoiceTurnModeSchema,
  memoryMode: z.enum(["ordinary", "session_only"]),
  requestedTransport: z.enum(["relayed_websocket", "direct_webrtc"]).optional(),
  selection: CanonicalChatModelSelectionSchema,
  interactionMode: boundedId(80),
  permissionMode: boundedId(80),
  locale: z.string().min(2).max(35).optional(),
}).strict();

const VoiceSessionErrorBodySchema = z.object({
  error: SafeVoiceErrorSchema,
}).strict();

export type VoiceSessionTransportGrant = z.infer<typeof VoiceSessionTransportGrantSchema>;
export type VoiceSessionResponseLimits = z.infer<typeof VoiceSessionResponseLimitsSchema>;
export type CreateVoiceSessionRequest = z.infer<typeof CreateVoiceSessionRequestSchema>;
export type CreateVoiceSessionResponse = z.infer<typeof CreateVoiceSessionResponseSchema>;
export type CreateVoiceSessionGranted = Extract<CreateVoiceSessionResponse, { transport: VoiceSessionTransportGrant }>;
export type ReconnectVoiceSessionResponse = z.infer<typeof ReconnectVoiceSessionResponseSchema>;

const RECOVERY_BY_CODE: Record<SafeVoiceErrorCode, { recovery: VoiceRecoveryAction; retryable: boolean }> = {
  permission_denied: { recovery: "request_permission", retryable: true },
  input_unavailable: { recovery: "choose_input", retryable: true },
  output_unavailable: { recovery: "choose_output", retryable: true },
  connection_failed: { recovery: "retry_connection", retryable: true },
  connection_lost: { recovery: "retry_connection", retryable: true },
  provider_unavailable: { recovery: "retry_connection", retryable: true },
  session_limit_reached: { recovery: "start_new_session", retryable: false },
  usage_limit_reached: { recovery: "continue_in_chat", retryable: false },
  audio_backpressure: { recovery: "none", retryable: true },
  chat_unavailable: { recovery: "continue_in_chat", retryable: false },
  session_conflict: { recovery: "retry_connection", retryable: true },
  unsupported_surface: { recovery: "none", retryable: false },
  internal_failure: { recovery: "continue_in_chat", retryable: true },
};

export function voiceErrorForCode(code: SafeVoiceErrorCode): SafeVoiceError {
  const { recovery, retryable } = RECOVERY_BY_CODE[code];
  return { code, retryable, recovery };
}

function codeForHttpStatus(status: number): SafeVoiceErrorCode {
  if (status === 409) return "session_conflict";
  if (status === 429) return "session_limit_reached";
  if (status >= 500) return "provider_unavailable";
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 410) {
    return "chat_unavailable";
  }
  return "internal_failure";
}

export class VoiceSessionApiError extends Error {
  readonly safeError: SafeVoiceError;

  constructor(error: SafeVoiceError | SafeVoiceErrorCode) {
    const safe = typeof error === "string" ? voiceErrorForCode(error) : error;
    super(`Voice session request failed (${safe.code})`);
    this.name = "VoiceSessionApiError";
    this.safeError = safe;
  }

  get code(): SafeVoiceErrorCode {
    return this.safeError.code;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new VoiceSessionApiError("internal_failure");
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new VoiceSessionApiError("internal_failure");
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
    if (error instanceof VoiceSessionApiError) throw error;
    throw new VoiceSessionApiError("internal_failure");
  }
}

export interface VoiceSessionApi {
  getCapabilities(chatId: string, signal?: AbortSignal): Promise<VoiceCapability>;
  createSession(chatId: string, request: CreateVoiceSessionRequest, signal?: AbortSignal): Promise<CreateVoiceSessionResponse>;
  deleteSession(chatId: string, sessionId: string, signal?: AbortSignal): Promise<void>;
  reconnect(chatId: string, sessionId: string, signal?: AbortSignal): Promise<ReconnectVoiceSessionResponse>;
}

export function createVoiceSessionApi(options: {
  baseUrl: string;
  fetcher?: typeof fetch;
  makeTimeoutSignal?: (ms: number) => AbortSignal;
}): VoiceSessionApi {
  const fetcher = options.fetcher ?? fetch;
  const makeTimeoutSignal = options.makeTimeoutSignal ?? AbortSignal.timeout;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  const route = (path: string): string => `${baseUrl}${path}`;
  const chatPath = (chatId: string): string =>
    `/api/chats/${encodeURIComponent(VoiceCanonicalChatIdSchema.parse(chatId))}/voice`;
  const sessionPath = (chatId: string, sessionId: string): string =>
    `${chatPath(chatId)}/sessions/${encodeURIComponent(VoiceSessionIdSchema.parse(sessionId))}`;

  async function request<T>(input: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    schema?: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: unknown } };
  }): Promise<T> {
    const timeout = makeTimeoutSignal(VOICE_SESSION_API_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetcher(route(input.path), {
        method: input.method,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal,
        redirect: "error",
        cache: "no-store",
        credentials: "include",
        headers: input.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      });
    } catch (error: unknown) {
      if (error instanceof VoiceSessionApiError) throw error;
      throw new VoiceSessionApiError("connection_failed");
    }
    let payload: unknown;
    try {
      payload = await boundedJson(response);
    } catch (error: unknown) {
      // An unreadable error body still maps through the status table; an
      // unreadable success body is an internal failure.
      if (error instanceof VoiceSessionApiError && !response.ok) {
        throw new VoiceSessionApiError(codeForHttpStatus(response.status));
      }
      throw error;
    }
    if (response.ok) {
      if (!input.schema) return undefined as T;
      const parsed = input.schema.safeParse(payload);
      if (parsed.success) return parsed.data;
      throw new VoiceSessionApiError("internal_failure");
    }
    const errorBody = VoiceSessionErrorBodySchema.safeParse(payload);
    if (errorBody.success) throw new VoiceSessionApiError(errorBody.data.error);
    throw new VoiceSessionApiError(codeForHttpStatus(response.status));
  }

  return {
    getCapabilities(chatId, signal) {
      return request({ path: `${chatPath(chatId)}/capabilities`, method: "GET", signal, schema: VoiceCapabilitySchema });
    },
    createSession(chatId, body, signal) {
      return request({
        path: `${chatPath(chatId)}/sessions`,
        method: "POST",
        body: CreateVoiceSessionRequestSchema.parse(body),
        signal,
        schema: CreateVoiceSessionResponseSchema,
      });
    },
    async deleteSession(chatId, sessionId, signal) {
      await request({ path: sessionPath(chatId, sessionId), method: "DELETE", signal });
    },
    reconnect(chatId, sessionId, signal) {
      return request({
        path: `${sessionPath(chatId, sessionId)}/reconnect`,
        method: "POST",
        body: {},
        signal,
        schema: ReconnectVoiceSessionResponseSchema,
      });
    },
  };
}
