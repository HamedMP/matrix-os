import {
  SpeechCapabilitiesResponseSchema,
  SpeechRequestIdSchema,
  SpeechSafeErrorResponseSchema,
  SpeechTranscriptionResponseSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PlatformSpeechClientError, type PlatformSpeechClient } from "./platform-client.js";

const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_RECORDING_BYTES + 64 * 1024;
const CANCELLATION_BODY_BYTES = 1_024;

const unavailableCapabilities = SpeechCapabilitiesResponseSchema.parse({
  contractVersion: 1,
  fileTranscription: {
    status: "unavailable",
    reason: "disabled",
    dictation: {
      enabled: false,
      maxBytes: MAX_RECORDING_BYTES,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav"],
      languageHints: false,
    },
    ownerAudio: { enabled: false },
  },
});

type SafeErrorCode =
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

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store, private");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
}

function safeError(code: SafeErrorCode) {
  const message = {
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
  }[code];
  return SpeechSafeErrorResponseSchema.parse({ error: { code, message } });
}

function clientError(c: Context, error: unknown) {
  if (error instanceof PlatformSpeechClientError) {
    const code = error.code === "invalid_response" ? "unavailable" : error.code;
    if (error.status === 400) return c.json(safeError(code), 400);
    if (error.status === 401) return c.json(safeError(code), 401);
    if (error.status === 402) return c.json(safeError(code), 402);
    if (error.status === 404) return c.json(safeError(code), 404);
    if (error.status === 409) return c.json(safeError(code), 409);
    if (error.status === 413) return c.json(safeError(code), 413);
    if (error.status === 422) return c.json(safeError(code), 422);
    if (error.status === 429) return c.json(safeError(code), 429);
    if (error.status === 502) return c.json(safeError(code), 502);
    if (error.status === 504) return c.json(safeError(code), 504);
    return c.json(safeError("unavailable"), 503);
  }
  console.warn("[gateway-speech] request failed", error instanceof Error ? error.name : "UnknownError");
  return c.json(safeError("unavailable"), 503);
}

function single(value: string | File | (string | File)[] | undefined) {
  return Array.isArray(value) ? undefined : value;
}

export function createSpeechGatewayRoutes(options: {
  client?: PlatformSpeechClient;
  getOwnerId(c: Context): string;
}): Hono {
  if (typeof options.getOwnerId !== "function") throw new Error("Speech route owner resolver is missing");
  const app = new Hono();
  app.use("*", async (c, next) => {
    noStore(c);
    return next();
  });

  function requireClient(c: Context): PlatformSpeechClient | undefined {
    if (!options.client) return undefined;
    let ownerId: string;
    try {
      ownerId = options.getOwnerId(c);
    } catch (error: unknown) {
      console.warn("[gateway-speech] owner resolution failed", error instanceof Error ? error.name : "UnknownError");
      return undefined;
    }
    return ownerId === options.client.ownerId ? options.client : undefined;
  }

  app.get("/capabilities", async (c) => {
    const client = requireClient(c);
    if (!client) {
      if (options.client) return c.json(safeError("not_found"), 404);
      return c.json(unavailableCapabilities, 200);
    }
    try {
      return c.json(SpeechCapabilitiesResponseSchema.parse(await client.capabilities(c.req.raw.signal)), 200);
    } catch (error: unknown) {
      return clientError(c, error);
    }
  });

  app.post("/transcriptions", bodyLimit({
    maxSize: MAX_MULTIPART_BYTES,
    onError: (c) => c.json(safeError("invalid_request"), 413),
  }), async (c) => {
    const client = requireClient(c);
    if (!client) return c.json(safeError(options.client ? "not_found" : "unavailable"), options.client ? 404 : 503);
    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch (error: unknown) {
      console.warn("[gateway-speech] multipart parse failed", error instanceof Error ? error.name : "UnknownError");
      return c.json(safeError("invalid_request"), 400);
    }
    if (Object.keys(body).some((key) => key !== "requestId" && key !== "recording")) {
      return c.json(safeError("invalid_request"), 400);
    }
    const requestId = SpeechRequestIdSchema.safeParse(single(body.requestId));
    const recording = single(body.recording);
    if (!requestId.success || !(recording instanceof File)) {
      return c.json(safeError("invalid_request"), 400);
    }
    if (recording.type !== "audio/wav" || recording.size < 44 || recording.size > MAX_RECORDING_BYTES) {
      return c.json(safeError("invalid_media"), 422);
    }
    try {
      const result = await client.transcribe({
        requestId: requestId.data,
        sourceKind: "dictation",
        audio: new Uint8Array(await recording.arrayBuffer()),
        mediaType: "audio/wav",
        signal: c.req.raw.signal,
      });
      return c.json(SpeechTranscriptionResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return clientError(c, error);
    }
  });

  app.get("/transcriptions/:requestId", async (c) => {
    const client = requireClient(c);
    if (!client) return c.json(safeError(options.client ? "not_found" : "unavailable"), options.client ? 404 : 503);
    const requestId = SpeechRequestIdSchema.safeParse(c.req.param("requestId"));
    if (!requestId.success) return c.json(safeError("invalid_request"), 400);
    try {
      const result = await client.status(requestId.data, c.req.raw.signal);
      return result ? c.json(result, 200) : c.json(safeError("not_found"), 404);
    } catch (error: unknown) {
      return clientError(c, error);
    }
  });

  app.delete("/transcriptions/:requestId", bodyLimit({
    maxSize: CANCELLATION_BODY_BYTES,
    onError: (c) => c.json(safeError("invalid_request"), 413),
  }), async (c) => {
    const client = requireClient(c);
    if (!client) return c.json(safeError(options.client ? "not_found" : "unavailable"), options.client ? 404 : 503);
    const requestId = SpeechRequestIdSchema.safeParse(c.req.param("requestId"));
    if (!requestId.success) return c.json(safeError("invalid_request"), 400);
    await c.req.arrayBuffer();
    try {
      return c.json(await client.cancel(requestId.data, c.req.raw.signal), 200);
    } catch (error: unknown) {
      return clientError(c, error);
    }
  });

  return app;
}
