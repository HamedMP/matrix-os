import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationActorIdSchema,
  CollaborationDirectoryEventSchema,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  PlatformCollaborationRepositoryError,
  type PlatformCollaborationRepository,
} from "./repository.js";

const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);

export function createInternalCollaborationRoutes(options: {
  repository: PlatformCollaborationRepository;
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string } | null>;
}): Hono {
  const app = new Hono();
  const mutationLimit = bodyLimit({
    maxSize: COLLABORATION_HTTP_BODY_LIMIT,
    onError: (c) => safeJson(c, "Request too large", 413),
  });

  app.put("/internal/collaboration/directory", mutationLimit, async (c) => {
    const runtime = await requireRuntime(c.req.header(), options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[platform-collaboration] directory parse failed", error instanceof Error ? error.name : "UnknownError");
      }
      return safeJson(c, "Invalid request", 422);
    }
    const event = CollaborationDirectoryEventSchema.safeParse(body);
    if (!event.success) return safeJson(c, "Invalid request", 422);
    if (event.data.runtimeId !== runtime.runtimeId || event.data.ownerId !== runtime.ownerId) {
      return safeJson(c, "Forbidden", 403);
    }
    try {
      await options.repository.applyDirectoryEvent(event.data);
      c.header("Cache-Control", "no-store");
      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof PlatformCollaborationRepositoryError && error.code === "conflict") {
        return safeJson(c, "Collaboration state changed", 409);
      }
      console.warn("[platform-collaboration] directory update failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });

  app.get("/internal/collaboration/participants/:actorId", async (c) => {
    const runtime = await requireRuntime(c.req.header(), options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    const actorId = CollaborationActorIdSchema.safeParse(c.req.param("actorId"));
    if (!actorId.success) return safeJson(c, "Invalid request", 422);
    try {
      const participant = await options.resolveParticipant(actorId.data);
      const parsed = z.object({
        actorId: CollaborationActorIdSchema,
        displayName: z.string().trim().min(1).max(120),
      }).strict().safeParse(participant);
      if (!parsed.success || parsed.data.actorId !== actorId.data) {
        return safeJson(c, "Participant not found", 404);
      }
      c.header("Cache-Control", "private, no-store");
      return c.json(parsed.data);
    } catch (error: unknown) {
      console.warn("[platform-collaboration] participant lookup failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });

  return app;
}

async function requireRuntime(
  headers: Record<string, string>,
  authenticate: Parameters<typeof createInternalCollaborationRoutes>[0]["authenticateRuntime"],
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
    console.warn("[platform-collaboration] runtime authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

function safeJson(
  c: import("hono").Context,
  error: string,
  status: 401 | 403 | 404 | 409 | 413 | 422 | 503,
) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
