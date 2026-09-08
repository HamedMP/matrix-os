import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationActorIdSchema,
  CollaborationConnectionTicketRequestSchema,
  CollaborationDirectoryEventSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { CollaborationProofSigner } from "./proof.js";
import { parseCollaborationProxyRoute, type CollaborationProxy } from "./proxy.js";
import {
  PlatformCollaborationRepositoryError,
  type CollaborationDirectoryEntry,
  type PlatformCollaborationRepository,
} from "./repository.js";
import {
  CollaborationWebSocketError,
  type CollaborationWebSocketAuthorizer,
} from "./websocket.js";

const MAX_HYDRATION_CONCURRENCY = 4;
const POLICY_LIFETIME_MS = 30_000;
const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
const MilestoneSchema = z.enum(["m1", "m2", "m3", "m4"]);

type RouteContext = Context;

export function createPlatformCollaborationRoutes(options: {
  repository: PlatformCollaborationRepository;
  signer: CollaborationProofSigner;
  sockets: CollaborationWebSocketAuthorizer;
  proxy?: CollaborationProxy;
  resolveActor(c: RouteContext): Promise<string | null>;
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string } | null>;
  hydrate(input: {
    actorId: string;
    entry: CollaborationDirectoryEntry;
  }): Promise<unknown>;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());

  app.on(
    ["POST", "PUT", "PATCH", "DELETE"],
    "/api/collaboration/*",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
  );
  app.use("/api/collaboration/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (!options.proxy || !parseCollaborationProxyRoute(c.req.method, c.req.path)) {
      await next();
      return;
    }
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    const body = new Uint8Array(await c.req.arrayBuffer());
    return options.proxy.forward({
      actorId,
      method: c.req.method,
      path: c.req.path,
      query: new URL(c.req.url).search.slice(1),
      body,
      headers: c.req.raw.headers,
    });
  });

  app.put(
    "/internal/collaboration/directory",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
    async (c) => {
      const runtime = await requireRuntime(c, options.authenticateRuntime);
      if (!runtime) return safeJson(c, "Unauthorized", 401);
      const event = await parseJson(c, CollaborationDirectoryEventSchema);
      if (!event) return safeJson(c, "Invalid request", 422);
      if (event.runtimeId !== runtime.runtimeId || event.ownerId !== runtime.ownerId) {
        return safeJson(c, "Forbidden", 403);
      }
      try {
        await options.repository.applyDirectoryEvent(event);
        c.header("Cache-Control", "no-store");
        return c.body(null, 204);
      } catch (error: unknown) {
        return repositoryFailure(c, "directory update", error);
      }
    },
  );

  app.get("/api/collaboration/inbox", async (c) => listDiscovery(c, "invited", options));
  app.get("/api/collaboration/shared", async (c) => listDiscovery(c, "accepted", options));

  app.post(
    "/api/collaboration/scopes/:scopeId/connection-tickets",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
    async (c) => {
      const actorId = await resolveValidatedActor(c, options.resolveActor);
      if (!actorId) return safeJson(c, "Unauthorized", 401);
      const scope = z.uuid().safeParse(c.req.param("scopeId"));
      const request = await parseJson(c, CollaborationConnectionTicketRequestSchema);
      if (!scope.success || !request) return safeJson(c, "Invalid request", 422);
      try {
        const ticket = await options.sockets.issueTicket({
          actorId,
          scopeId: scope.data,
          purpose: request.purpose,
          clientRequestId: request.clientRequestId,
        });
        c.header("Cache-Control", "no-store");
        return c.json(ticket, 201);
      } catch (error: unknown) {
        return socketFailure(c, "ticket issue", error);
      }
    },
  );

  app.get("/internal/collaboration/participants/:actorId", async (c) => {
    const runtime = await requireRuntime(c, options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    const actor = CollaborationActorIdSchema.safeParse(c.req.param("actorId"));
    if (!actor.success) return safeJson(c, "Invalid request", 422);
    try {
      const participant = await options.resolveParticipant(actor.data);
      const parsed = z.object({
        actorId: CollaborationActorIdSchema,
        displayName: z.string().trim().min(1).max(120),
      }).strict().safeParse(participant);
      if (!parsed.success || parsed.data.actorId !== actor.data) {
        return safeJson(c, "Participant not found", 404);
      }
      c.header("Cache-Control", "private, no-store");
      return c.json(parsed.data);
    } catch (error: unknown) {
      console.warn("[platform-collaboration] participant lookup failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });

  app.get("/internal/collaboration/policy", async (c) => {
    const runtime = await requireRuntime(c, options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    const milestone = MilestoneSchema.safeParse(c.req.query("milestone"));
    if (!milestone.success) return safeJson(c, "Invalid request", 422);
    try {
      const stored = await options.repository.getPolicy(milestone.data);
      const issuedAt = now();
      const signed = options.signer.signPolicy({
        milestone: stored.milestone,
        revision: String(stored.revision),
        mode: stored.mode,
        cohort: stored.cohort,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + POLICY_LIFETIME_MS).toISOString(),
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(signed);
    } catch (error: unknown) {
      return repositoryFailure(c, "policy lookup", error);
    }
  });

  return app;
}

async function listDiscovery(
  c: RouteContext,
  status: "invited" | "accepted",
  options: Parameters<typeof createPlatformCollaborationRoutes>[0],
) {
  const actorId = await resolveValidatedActor(c, options.resolveActor);
  if (!actorId) return safeJson(c, "Unauthorized", 401);
  try {
    const entries = (await options.repository.listForActor(actorId)).filter((entry) => entry.status === status);
    const resources = await mapLimited(entries, MAX_HYDRATION_CONCURRENCY, async (entry) => {
      try {
        return { entry, resource: await options.hydrate({ actorId, entry }) };
      } catch (error: unknown) {
        console.warn(
          "[platform-collaboration] discovery entry unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
        return null;
      }
    });
    c.header("Cache-Control", "private, no-store");
    return c.json({
      items: resources
        .filter((result): result is NonNullable<typeof result> => result !== null)
        .map(({ entry, resource }) => ({ ...entry, resource })),
    });
  } catch (error: unknown) {
    console.warn("[platform-collaboration] discovery hydration failed", error instanceof Error ? error.name : "UnknownError");
    return safeJson(c, "Collaboration unavailable", 503);
  }
}

async function requireRuntime(
  c: RouteContext,
  authenticate: Parameters<typeof createPlatformCollaborationRoutes>[0]["authenticateRuntime"],
) {
  const runtimeId = RuntimeIdSchema.safeParse(c.req.header("x-matrix-runtime-id"));
  const authorization = c.req.header("authorization");
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

async function resolveValidatedActor(
  c: RouteContext,
  resolveActor: Parameters<typeof createPlatformCollaborationRoutes>[0]["resolveActor"],
): Promise<string | null> {
  try {
    const parsed = CollaborationActorIdSchema.safeParse(await resolveActor(c));
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    console.warn("[platform-collaboration] actor authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function parseJson<T>(c: RouteContext, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[platform-collaboration] request parsing failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
}

async function mapLimited<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function repositoryFailure(c: RouteContext, operation: string, error: unknown) {
  if (error instanceof PlatformCollaborationRepositoryError && error.code === "conflict") {
    return safeJson(c, "Collaboration state changed", 409);
  }
  console.warn(`[platform-collaboration] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Collaboration unavailable", 503);
}

function socketFailure(c: RouteContext, operation: string, error: unknown) {
  if (error instanceof CollaborationWebSocketError) {
    if (error.code === "unavailable") return safeJson(c, "Collaboration unavailable", 404);
    if (error.code === "disabled") return safeJson(c, "Collaboration unavailable", 403);
    if (error.code === "invalid_ticket" || error.code === "invalid_route") {
      return safeJson(c, "Invalid request", 422);
    }
  }
  if (error instanceof PlatformCollaborationRepositoryError && error.code === "capacity") {
    return safeJson(c, "Too many pending connections", 429);
  }
  console.warn(`[platform-collaboration] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Collaboration unavailable", 503);
}

function safeJson(c: RouteContext, error: string, status: 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
