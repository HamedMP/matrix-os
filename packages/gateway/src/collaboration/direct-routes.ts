/**
 * Direct session routes on the home (S05 / T027).
 *
 * `POST /api/collaboration/direct-sessions` exchanges a platform-signed
 * ticket plus proof of possession for a session; `/:sessionId/renew` takes a
 * fresh ticket; `DELETE /:sessionId` closes a session the caller proves it
 * holds. Every mutating route applies `bodyLimit` before buffering. Errors
 * are generic and never distinguish unknown from unauthorized.
 */
import { COLLABORATION_DIRECT_LIMITS, CollaborationIdSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DirectAuthError } from "./direct-auth.js";
import type { DirectSessionService } from "./direct-sessions.js";
import type { OwnerRuntimeSessionService } from "./owner-runtime-sessions.js";
import { sha256Hex } from "./direct-crypto.js";

export const DIRECT_SESSION_HEADER = "x-matrix-collaboration-session";
export const DIRECT_REQUEST_HEADER = "x-matrix-collaboration-request";
const MAX_ENCODED_REQUEST = 8_192;

type ErrorStatus = 401 | 404 | 409 | 413 | 422 | 426 | 429 | 503;

export interface DirectRequestCredentials {
  sessionId: string;
  signature: unknown;
  proof: string;
}

/** Reads the session id and the base64url-encoded `{ signature, proof }` envelope; null when absent. */
export function readDirectCredentials(c: Context): DirectRequestCredentials | null {
  const sessionId = c.req.header(DIRECT_SESSION_HEADER);
  const encoded = c.req.header(DIRECT_REQUEST_HEADER);
  if (!sessionId && !encoded) return null;
  const parsedId = CollaborationIdSchema.safeParse(sessionId);
  if (!parsedId.success || !encoded || encoded.length > MAX_ENCODED_REQUEST || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new DirectAuthError("invalid_signature", "Direct request credentials are invalid");
  }
  let envelope: { signature?: unknown; proof?: unknown };
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { signature?: unknown; proof?: unknown };
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-direct-routes] credential parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new DirectAuthError("invalid_signature", "Direct request credentials are invalid");
  }
  if (!envelope || typeof envelope !== "object" || typeof envelope.proof !== "string" || !/^[A-Za-z0-9_-]{43,172}$/.test(envelope.proof)) {
    throw new DirectAuthError("invalid_signature", "Direct request credentials are invalid");
  }
  return { sessionId: parsedId.data, signature: envelope.signature, proof: envelope.proof };
}

export function directErrorResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof DirectAuthError)) return null;
  switch (error.code) {
    case "upgrade_required": return safeJson(c, "upgrade_required", 426);
    case "replayed": return safeJson(c, "Collaboration state changed", 409);
    case "limit": return safeJson(c, "Too many collaboration connections", 429);
    case "unavailable": return safeJson(c, "Collaboration unavailable", 503);
    default: return safeJson(c, "Collaboration request denied", 401);
  }
}

export function createDirectSessionRoutes(options: { sessions: DirectSessionService; ownerRuntimeSessions?: OwnerRuntimeSessionService }): Hono {
  const app = new Hono();
  const jsonLimit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.httpJsonBytes, onError: (c) => safeJson(c, "Request too large", 413) });

  app.post("/api/collaboration/direct-sessions", jsonLimit, async (c) => {
    const body = await readJson(c);
    if (body === undefined) return safeJson(c, "Invalid request", 422);
    try {
      const session = await options.sessions.create(body);
      c.header("Cache-Control", "no-store");
      return c.json(session, 201);
    } catch (error: unknown) {
      return directErrorResponse(c, error) ?? unexpected(c, "session create", error);
    }
  });

  app.post("/api/collaboration/owner-runtime/sessions", jsonLimit, async (c) => {
    const body = await readJson(c);
    if (body === undefined) return safeJson(c, "Invalid request", 422);
    if (!options.ownerRuntimeSessions) return safeJson(c, "Collaboration unavailable", 503);
    try {
      const session = await options.ownerRuntimeSessions.create(body);
      c.header("Cache-Control", "no-store");
      return c.json(session, 201);
    } catch (error: unknown) {
      return directErrorResponse(c, error) ?? unexpected(c, "owner runtime session create", error);
    }
  });

  app.post("/api/collaboration/direct-sessions/:sessionId/renew", jsonLimit, async (c) => {
    const sessionId = CollaborationIdSchema.safeParse(c.req.param("sessionId"));
    const body = await readJson(c);
    if (!sessionId.success || body === undefined) return safeJson(c, "Invalid request", 422);
    try {
      const session = await options.sessions.renew(sessionId.data, body);
      c.header("Cache-Control", "no-store");
      return c.json(session);
    } catch (error: unknown) {
      return directErrorResponse(c, error) ?? unexpected(c, "session renew", error);
    }
  });

  app.delete("/api/collaboration/direct-sessions/:sessionId", jsonLimit, async (c) => {
    const sessionId = CollaborationIdSchema.safeParse(c.req.param("sessionId"));
    if (!sessionId.success) return safeJson(c, "Invalid request", 422);
    try {
      const credentials = readDirectCredentials(c);
      if (!credentials || credentials.sessionId !== sessionId.data) throw new DirectAuthError("invalid_signature", "Session credentials are required");
      const body = new Uint8Array(await c.req.arrayBuffer());
      await options.sessions.authenticate({
        ...credentials,
        method: "DELETE",
        path: c.req.path,
        query: new URL(c.req.url).search.slice(1),
        body,
        conditionalHeadersDigest: sha256Hex(new Uint8Array()),
      });
      options.sessions.spendAuthenticatedAction(sessionId.data);
      options.sessions.close(sessionId.data);
      c.header("Cache-Control", "no-store");
      return c.body(null, 204);
    } catch (error: unknown) {
      return directErrorResponse(c, error) ?? unexpected(c, "session close", error);
    }
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-direct-routes] request parsing failed", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

function unexpected(c: Context, operation: string, error: unknown): Response {
  console.warn(`[collaboration-direct-routes] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Collaboration unavailable", 503);
}

function safeJson(c: Context, error: string, status: ErrorStatus): Response {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
