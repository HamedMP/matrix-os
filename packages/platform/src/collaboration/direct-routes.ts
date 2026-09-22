/**
 * Direct-transport platform routes (S05 / T026).
 *
 * `POST /internal/collaboration/runtime-endpoints` lets an enrolled home
 * register itself (R auth) and returns the platform ticket verification
 * keys, a one-use control-stream upgrade ticket and the relay origin.
 * `POST /api/collaboration/connections` issues a signed connection ticket
 * to an authenticated organization member (U+O). Both apply `bodyLimit`
 * before buffering and answer with generic errors only.
 */
import { COLLABORATION_DIRECT_LIMITS, COLLABORATION_DIRECT_PROTOCOL_VERSION, CollaborationActorIdSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { CollaborationControlStream } from "./control-stream.js";
import { CollaborationRuntimeEndpointError, type CollaborationRuntimeEndpointRegistry } from "./runtime-endpoints.js";
import { CollaborationTicketIssuerError, type CollaborationTicketIssuer } from "./ticket-issuer.js";

const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
type ErrorStatus = 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 503;

export interface AuthenticatedRuntime {
  runtimeId: string;
  ownerId: string;
}

export function createPlatformCollaborationDirectRoutes(options: {
  endpoints: CollaborationRuntimeEndpointRegistry;
  /** Null when ticket signing is not configured: connection tickets fail closed. */
  issuer: CollaborationTicketIssuer | null;
  controlStream: CollaborationControlStream;
  relayOrigin: string;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<AuthenticatedRuntime | null>;
  /** The relay handle existing customer-VPS enrollment already knows for this runtime. */
  resolveRelayHandle(runtime: AuthenticatedRuntime): Promise<string | null>;
}): Hono {
  const app = new Hono();
  const jsonLimit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.httpJsonBytes, onError: (c) => safeJson(c, "Request too large", 413) });

  app.post("/internal/collaboration/runtime-endpoints", jsonLimit, async (c) => {
    const runtime = await requireRuntime(c, options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    const body = await readJson(c);
    if (body === undefined) return safeJson(c, "Invalid request", 422);
    try {
      const relayHandle = await options.resolveRelayHandle(runtime);
      if (!relayHandle) return safeJson(c, "Forbidden", 403);
      // The registration and the upgrade ticket it answers with are written together; a
      // ticket that cannot be recorded rolls the registration back rather than leaving a
      // committed generation behind a 503.
      const controlTicket = options.controlStream.prepareUpgradeTicket();
      const record = await options.endpoints.register({ authenticated: { ...runtime, relayHandle }, registration: body, controlTicket });
      c.header("Cache-Control", "no-store");
      return c.json({
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
        runtime: { runtimeId: record.runtimeId, authorityGeneration: record.authorityGeneration, registeredAt: record.registeredAt },
        platformSigningKeys: options.issuer?.publicKeys() ?? [],
        controlTicket: controlTicket.token,
        relay: { origin: options.relayOrigin },
      });
    } catch (error: unknown) {
      if (error instanceof CollaborationRuntimeEndpointError) {
        if (error.code === "upgrade_required") return safeJson(c, "upgrade_required", 426);
        if (error.code === "stale_generation") return safeJson(c, "Collaboration state changed", 409);
        if (error.code === "invalid_registration" || error.code === "direct_origin_rejected") return safeJson(c, "Invalid request", 422);
        return safeJson(c, "Forbidden", 403);
      }
      console.warn("[platform-collaboration] runtime registration failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });

  app.post("/api/collaboration/connections", jsonLimit, async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    if (!options.issuer) return safeJson(c, "Collaboration unavailable", 503);
    const body = await readJson(c);
    if (body === undefined) return safeJson(c, "Invalid request", 422);
    try {
      const issued = await options.issuer.issue({ actorId, request: body });
      c.header("Cache-Control", "no-store");
      return c.json(issued, 201);
    } catch (error: unknown) {
      if (error instanceof CollaborationTicketIssuerError) {
        if (error.code === "invalid_request") return safeJson(c, "Invalid request", 422);
        if (error.code === "not_found") return safeJson(c, "Collaboration resource not found", 404);
        if (error.code === "host_offline") return safeJson(c, "host_offline", 503);
        return safeJson(c, "Collaboration unavailable", 503);
      }
      console.warn("[platform-collaboration] ticket issue failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });

  return app;
}

async function requireRuntime(
  c: Context,
  authenticate: (input: { runtimeId: string; bearerToken: string }) => Promise<AuthenticatedRuntime | null>,
): Promise<AuthenticatedRuntime | null> {
  const runtimeId = RuntimeIdSchema.safeParse(c.req.header("x-matrix-runtime-id"));
  const authorization = c.req.header("authorization");
  const bearer = BearerTokenSchema.safeParse(authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined);
  if (!runtimeId.success || !bearer.success) return null;
  try {
    return await authenticate({ runtimeId: runtimeId.data, bearerToken: bearer.data });
  } catch (error: unknown) {
    console.warn("[platform-collaboration] runtime authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function resolveValidatedActor(c: Context, resolveActor: (c: Context) => Promise<string | null>): Promise<string | null> {
  try {
    const parsed = CollaborationActorIdSchema.safeParse(await resolveActor(c));
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    console.warn("[platform-collaboration] actor authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[platform-collaboration] request parsing failed", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

function safeJson(c: Context, error: string, status: ErrorStatus) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
