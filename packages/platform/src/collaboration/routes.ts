import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationActorIdSchema,
  CollaborationConnectionTicketRequestSchema,
  CollaborationDiscoveryItemSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationDirectoryEventSchema,
  CollaborationPageRequestSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { registerInvitationIdentifierResolutionRoute } from "./identifier-resolution-route.js";
import type { CollaborationProofSigner } from "./proof.js";
import { parseCollaborationProxyRoute, type CollaborationProxy } from "./proxy.js";
import { parseRelayRoute, type CollaborationRelay } from "./relay.js";

const DIRECT_SESSION_HEADER = "x-matrix-collaboration-session";
import {
  PlatformCollaborationRepositoryError,
  type CollaborationDirectoryEntry,
  type PlatformCollaborationRepository,
} from "./repository.js";
import {
  CollaborationWebSocketError,
  type CollaborationWebSocketAuthorizer,
} from "./websocket.js";

const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
const DiscoveryCursorSchema = z.discriminatedUnion("version", [
  z.object({
    version: z.literal(1), actorId: CollaborationActorIdSchema, status: z.enum(["invited", "accepted"]),
    updatedAt: z.iso.datetime(), scopeId: z.uuid(),
  }).strict(),
  z.object({
    version: z.literal(2), actorId: CollaborationActorIdSchema, status: z.enum(["invited", "accepted"]),
    phase: z.enum(["indexed", "pending"]),
    after: z.object({ updatedAt: z.iso.datetime(), scopeId: z.uuid() }).strict().optional(),
  }).strict(),
]);
type DiscoveryPageCursor = { phase: "indexed" | "pending"; after?: { updatedAt: string; scopeId: string } };

type RouteContext = Context;

export function createPlatformCollaborationRoutes(options: {
  repository: PlatformCollaborationRepository;
  signer: CollaborationProofSigner;
  sockets: CollaborationWebSocketAuthorizer;
  proxy?: CollaborationProxy;
  /** S05: transparent relay for direct-protocol requests (session routes or requests carrying a direct session). */
  relay?: CollaborationRelay;
  resolveActor(c: RouteContext): Promise<string | null>;
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string } | null>;
  resolveInvitationIdentifier(identifier: string, organizationId: string): Promise<{ actorId: string; displayName: string } | null>;
  /**
   * S06 / T032: the actor's current organization ids from the membership projection, used only to list
   * organization-wide shares still pending for them. Absent means no organization inventory.
   */
  listOrganizationIds?(actorId: string): Promise<readonly string[]>;
  now?: () => Date;
}): Hono {
  const app = new Hono();

  app.on(
    ["POST", "PUT", "PATCH", "DELETE"],
    "/api/collaboration/*",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
  );
  app.use("/api/collaboration/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    // S05: direct-protocol traffic is relayed as opaque bytes; the home decides.
    const relayRoute = options.relay ? parseRelayRoute(c.req.method, c.req.path) : null;
    if (options.relay && relayRoute && (relayRoute.kind === "session" || c.req.header(DIRECT_SESSION_HEADER))) {
      const actorId = await resolveValidatedActor(c, options.resolveActor);
      if (!actorId) return safeJson(c, "Unauthorized", 401);
      const declared = Number(c.req.header("content-length") ?? 0);
      return options.relay.forward({
        actorId,
        method: c.req.method,
        path: c.req.path,
        query: new URL(c.req.url).search.slice(1),
        headers: c.req.raw.headers,
        body: c.req.method === "GET" ? null : c.req.raw.body,
        ...(Number.isFinite(declared) && declared > 0 ? { contentLength: declared } : {}),
      });
    }
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

  registerInvitationIdentifierResolutionRoute(app, options);

  return app;
}

async function listDiscovery(
  c: RouteContext,
  status: "invited" | "accepted",
  options: Parameters<typeof createPlatformCollaborationRoutes>[0],
) {
  const actorId = await resolveValidatedActor(c, options.resolveActor);
  if (!actorId) return safeJson(c, "Unauthorized", 401);
  const pageRequest = CollaborationPageRequestSchema.safeParse(exactDiscoveryQuery(c));
  if (!pageRequest.success) return safeJson(c, "Invalid request", 422);
  const cursor = pageRequest.data.cursor
    ? decodeDiscoveryCursor(pageRequest.data.cursor, actorId, status)
    : null;
  if (pageRequest.data.cursor && !cursor) return safeJson(c, "Invalid request", 422);
  try {
    const phase = cursor?.phase ?? "indexed";
    const page = phase === "indexed"
      ? await options.repository.listForActorPage(actorId, status, {
        limit: pageRequest.data.limit,
        ...(cursor?.after ? { after: cursor.after } : {}),
      })
      : { items: [] as Awaited<ReturnType<PlatformCollaborationRepository["listForActorPage"]>>["items"], nextCursor: undefined };
    // Metadata only: the client hydrates every item from the resource's home.
    const items: unknown[] = page.items.map((entry) => ({
      scopeId: entry.scopeId,
      runtimeId: entry.runtimeId,
      ownerId: entry.ownerId,
      kind: entry.kind,
      authorityGeneration: entry.authorityGeneration,
      status: entry.status,
      ...(entry.status === "invited" ? { invitationId: entry.invitationId } : {}),
      ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
    }));
    let nextCursor = page.nextCursor ? encodeDiscoveryCursor(actorId, status, "indexed", page.nextCursor) : undefined;
    if (status === "invited" && !page.nextCursor && options.listOrganizationIds) {
      const organizationIds = await options.listOrganizationIds(actorId);
      const remaining = pageRequest.data.limit - items.length;
      const pending = await options.repository.listOrganizationSharesForActorPage(actorId, organizationIds, {
        limit: Math.max(1, remaining),
        ...(phase === "pending" && cursor?.after ? { after: cursor.after } : {}),
      });
      if (remaining > 0) {
        for (const entry of pending.items) {
          items.push({
            scopeId: entry.scopeId, runtimeId: entry.runtimeId, ownerId: entry.ownerId, kind: entry.kind,
            authorityGeneration: entry.authorityGeneration, status: "organization_pending", organizationId: entry.organizationId,
          });
        }
      }
      if (pending.nextCursor || (remaining === 0 && pending.items.length > 0)) {
        nextCursor = encodeDiscoveryCursor(actorId, status, "pending", remaining === 0 ? undefined : pending.nextCursor);
      }
    }
    c.header("Cache-Control", "private, no-store");
    return c.json(CollaborationDiscoveryResponseSchema.parse({
      items: items.map((item) => CollaborationDiscoveryItemSchema.parse(item)),
      ...(nextCursor ? { nextCursor } : {}),
    }));
  } catch (error: unknown) {
    console.warn("[platform-collaboration] discovery listing failed", error instanceof Error ? error.name : "UnknownError");
    return safeJson(c, "Collaboration unavailable", 503);
  }
}

function exactDiscoveryQuery(c: RouteContext): Record<string, string> {
  const parameters = new URL(c.req.url).searchParams;
  const output: Record<string, string> = {};
  for (const key of parameters.keys()) {
    if (!["cursor", "limit"].includes(key) || key in output) return { invalid: "true" };
    output[key] = parameters.get(key)!;
  }
  return output;
}

function encodeDiscoveryCursor(
  actorId: string,
  status: "invited" | "accepted",
  phase: DiscoveryPageCursor["phase"],
  after?: DiscoveryPageCursor["after"],
): string {
  return Buffer.from(JSON.stringify({ version: 2, actorId, status, phase, ...(after ? { after } : {}) })).toString("base64url");
}

function decodeDiscoveryCursor(
  value: string,
  actorId: string,
  status: "invited" | "accepted",
): DiscoveryPageCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = DiscoveryCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown);
    if (!parsed.success || parsed.data.actorId !== actorId || parsed.data.status !== status) return null;
    if (parsed.data.version === 1) return { phase: "indexed", after: { updatedAt: parsed.data.updatedAt, scopeId: parsed.data.scopeId } };
    return { phase: parsed.data.phase, ...(parsed.data.after ? { after: parsed.data.after } : {}) };
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[platform-collaboration] cursor decode failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
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

const ParticipantProjectionSchema = z.object({
  actorId: CollaborationActorIdSchema,
  displayName: z.string().trim().min(1).max(120),
}).strict();
