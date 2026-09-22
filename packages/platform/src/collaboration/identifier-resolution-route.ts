import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationActorIdSchema,
  CollaborationInvitationIdentifierRequestSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { createBoundedRateLimiter } from "../request-admission.js";
import { CollaborationIdentifierResolutionError } from "./identifier-resolver.js";

const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
const ParticipantProjectionSchema = z.object({
  actorId: CollaborationActorIdSchema,
  displayName: z.string().trim().min(1).max(120),
}).strict();

export interface InvitationIdentifierResolutionRouteOptions {
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveInvitationIdentifier(identifier: string, organizationId: string): Promise<{ actorId: string; displayName: string } | null>;
}

export function registerInvitationIdentifierResolutionRoute(
  app: Hono,
  options: InvitationIdentifierResolutionRouteOptions,
): void {
  const rateLimiter = createBoundedRateLimiter(10);

  app.post(
    "/internal/collaboration/participants/resolve",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
    async (c) => {
      const runtime = await authenticateRuntime(c.req.header(), options.authenticateRuntime);
      if (!runtime) return safeJson(c, "Unauthorized", 401);
      if (!rateLimiter.check(runtime.ownerId)) {
        return safeJson(c, "Invitation target unavailable", 429);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) {
          console.warn(
            "[platform-collaboration] invitation identifier parse failed",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
        return safeJson(c, "Invalid request", 422);
      }
      const input = CollaborationInvitationIdentifierRequestSchema.safeParse(body);
      if (!input.success) return safeJson(c, "Invalid request", 422);

      try {
        const participant = await options.resolveInvitationIdentifier(input.data.identifier, input.data.organizationId);
        const parsed = ParticipantProjectionSchema.safeParse(participant);
        if (!parsed.success) return safeJson(c, "Invitation target unavailable", 404);
        c.header("Cache-Control", "private, no-store");
        return c.json(parsed.data);
      } catch (error: unknown) {
        if (error instanceof CollaborationIdentifierResolutionError && error.code === "unresolved") {
          return safeJson(c, "Invitation target unavailable", 404);
        }
        console.warn(
          "[platform-collaboration] invitation identity resolution failed",
          error instanceof Error ? error.name : "UnknownError",
        );
        return safeJson(c, "Invitation target unavailable", 503);
      }
    },
  );
}

async function authenticateRuntime(
  headers: Record<string, string>,
  authenticate: InvitationIdentifierResolutionRouteOptions["authenticateRuntime"],
) {
  const runtimeId = RuntimeIdSchema.safeParse(headers["x-matrix-runtime-id"]);
  const authorization = headers.authorization;
  const bearer = BearerTokenSchema.safeParse(
    authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined,
  );
  if (!runtimeId.success || !bearer.success) return null;
  try {
    return await authenticate({ runtimeId: runtimeId.data, bearerToken: bearer.data });
  } catch (error: unknown) {
    console.warn(
      "[platform-collaboration] runtime authentication failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return null;
  }
}

function safeJson(
  c: import("hono").Context,
  error: string,
  status: 401 | 404 | 413 | 422 | 429 | 503,
) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
