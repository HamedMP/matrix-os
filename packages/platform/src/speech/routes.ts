import {
  SpeechCancellationResponseSchema,
  SpeechCapabilitiesResponseSchema,
  SpeechLanguageHintsSchema,
  SpeechRequestIdSchema,
  SpeechSafeErrorResponseSchema,
  SpeechSourceKindSchema,
  SpeechStatusResponseSchema,
  SpeechTranscriptionResponseSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { RuntimeSlotSchema } from "../customer-vps-schema.js";
import { getRunningUserMachineByHandle, type PlatformDB } from "../db.js";
import { buildPlatformRuntimeVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import { SpeechServiceError, type PlatformSpeechService } from "./service.js";

const MAX_DICTATION_BODY_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const CANCELLATION_BODY_BYTES = 1_024;
const HandleSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const RuntimeQuerySchema = z.object({ runtimeSlot: RuntimeSlotSchema }).strict();

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

function query(c: Context) {
  return RuntimeQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
}

async function runtimeIdentity(
  c: Context,
  options: { db: PlatformDB; platformSecret: string },
  runtimeSlot: string,
) {
  const handle = HandleSchema.safeParse(c.req.param("handle"));
  if (!handle.success) return undefined;
  const machine = await getRunningUserMachineByHandle(options.db, handle.data, runtimeSlot);
  if (!machine) return undefined;
  const authorization = c.req.header("authorization");
  const actual = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const expected = buildPlatformRuntimeVerificationToken({
    handle: handle.data,
    machineId: machine.machineId,
    runtimeSlot: machine.runtimeSlot,
  }, options.platformSecret);
  if (!timingSafeTokenEquals(actual, expected)) return undefined;
  return {
    ownerId: machine.clerkUserId,
    machineId: machine.machineId,
    runtimeSlot: machine.runtimeSlot,
  };
}

function serviceErrorResponse(c: Context, error: unknown) {
  if (error instanceof SpeechServiceError) {
    if (error.code === "invalid_request") return c.json(safeError("invalid_request"), 400);
    if (error.code === "invalid_media") return c.json(safeError("invalid_media"), 422);
    if (error.code === "request_conflict" || error.code === "result_not_replayable") {
      return c.json(safeError("request_conflict"), 409);
    }
    if (error.code === "rate_limited") return c.json(safeError("rate_limited"), 429);
    if (error.code === "allowance_exhausted") return c.json(safeError("allowance_exhausted"), 402);
    if (error.code === "timeout") return c.json(safeError("timeout"), 504);
    if (error.code === "transcription_failed") return c.json(safeError("transcription_failed"), 502);
    if (error.code === "cancelled") return c.json(safeError("cancelled"), 409);
    return c.json(safeError("unavailable"), 503);
  }
  console.warn("[platform-speech] request failed", error instanceof Error ? error.name : "UnknownError");
  return c.json(safeError("unavailable"), 503);
}

async function authenticate(
  c: Context,
  options: { db: PlatformDB; platformSecret: string },
) {
  const parsedQuery = query(c);
  if (!parsedQuery.success) return { response: c.json(safeError("invalid_request"), 400) } as const;
  try {
    const identity = await runtimeIdentity(c, options, parsedQuery.data.runtimeSlot);
    if (!identity) return { response: c.json(safeError("unauthorized"), 401) } as const;
    return { identity } as const;
  } catch (error: unknown) {
    console.warn("[platform-speech] runtime authentication failed", error instanceof Error ? error.name : "UnknownError");
    return { response: c.json(safeError("unavailable"), 503) } as const;
  }
}

function singleField(value: string | File | (string | File)[] | undefined): string | File | undefined {
  return Array.isArray(value) ? undefined : value;
}

export function createSpeechRuntimeRoutes(options: {
  db: PlatformDB;
  platformSecret: string;
  service: PlatformSpeechService;
}): Hono {
  if (!options.db || !options.service || options.platformSecret.length < 32) {
    throw new Error("Speech runtime routes are misconfigured");
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    noStore(c);
    return next();
  });

  app.get("/capabilities", async (c) => {
    const runtime = await authenticate(c, options);
    if ("response" in runtime) return runtime.response;
    return c.json(SpeechCapabilitiesResponseSchema.parse(options.service.capabilities()), 200);
  });

  app.post("/transcriptions", bodyLimit({
    maxSize: MAX_DICTATION_BODY_BYTES,
    onError: (c) => c.json(safeError("invalid_request"), 413),
  }), async (c) => {
    const runtime = await authenticate(c, options);
    if ("response" in runtime) return runtime.response;
    let fields: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      fields = await c.req.parseBody({ all: true });
    } catch (error: unknown) {
      console.warn("[platform-speech] multipart parse failed", error instanceof Error ? error.name : "UnknownError");
      return c.json(safeError("invalid_request"), 400);
    }
    const requestId = SpeechRequestIdSchema.safeParse(singleField(fields.requestId));
    const sourceKind = SpeechSourceKindSchema.safeParse(singleField(fields.sourceKind));
    const recording = singleField(fields.recording);
    const languageHintsRaw = singleField(fields.languageHints);
    let languageHints: readonly string[] | undefined;
    if (typeof languageHintsRaw === "string") {
      try {
        const parsed = SpeechLanguageHintsSchema.safeParse(JSON.parse(languageHintsRaw));
        if (!parsed.success) return c.json(safeError("invalid_request"), 400);
        languageHints = parsed.data;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) {
          console.warn("[platform-speech] language hint parse failed", error instanceof Error ? error.name : "UnknownError");
        }
        return c.json(safeError("invalid_request"), 400);
      }
    } else if (languageHintsRaw !== undefined) {
      return c.json(safeError("invalid_request"), 400);
    }
    if (!requestId.success || !sourceKind.success || !(recording instanceof File)) {
      return c.json(safeError("invalid_request"), 400);
    }
    if (recording.type !== "audio/wav" || recording.size < 44 || recording.size > MAX_DICTATION_BODY_BYTES) {
      return c.json(safeError("invalid_media"), 422);
    }
    try {
      const result = await options.service.transcribe({
        identity: runtime.identity,
        requestId: requestId.data,
        sourceKind: sourceKind.data,
        audio: new Uint8Array(await recording.arrayBuffer()),
        mediaType: "audio/wav",
        languageHints,
        signal: c.req.raw.signal,
      });
      return c.json(SpeechTranscriptionResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return serviceErrorResponse(c, error);
    }
  });

  app.get("/transcriptions/:requestId", async (c) => {
    const runtime = await authenticate(c, options);
    if ("response" in runtime) return runtime.response;
    const requestId = SpeechRequestIdSchema.safeParse(c.req.param("requestId"));
    if (!requestId.success) return c.json(safeError("invalid_request"), 400);
    try {
      const result = await options.service.status(runtime.identity, requestId.data);
      if (!result) return c.json(safeError("not_found"), 404);
      return c.json(SpeechStatusResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return serviceErrorResponse(c, error);
    }
  });

  app.delete("/transcriptions/:requestId", bodyLimit({
    maxSize: CANCELLATION_BODY_BYTES,
    onError: (c) => c.json(safeError("invalid_request"), 413),
  }), async (c) => {
    const runtime = await authenticate(c, options);
    if ("response" in runtime) return runtime.response;
    const requestId = SpeechRequestIdSchema.safeParse(c.req.param("requestId"));
    if (!requestId.success) return c.json(safeError("invalid_request"), 400);
    await c.req.text();
    try {
      const result = await options.service.cancel(runtime.identity, requestId.data);
      return c.json(SpeechCancellationResponseSchema.parse(result), 200);
    } catch (error: unknown) {
      return serviceErrorResponse(c, error);
    }
  });

  return app;
}
