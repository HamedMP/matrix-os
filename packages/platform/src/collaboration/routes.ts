import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationActorIdSchema,
  CollaborationDiscoveryItemSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationDirectoryEventSchema,
  CollaborationOrganizationIdSchema,
  CollaborationPageRequestSchema,
  CollaborativeAppLaunchRequestSchema,
  CollaborativeAppLaunchResponseSchema,
  CollaborativeAppParticipantSchema,
  CollaborationAppAssetPathSchema,
  CollaborativeAppDirectoryItemSchema,
  CollaborativeAppDirectoryResponseSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { registerInvitationIdentifierResolutionRoute } from "./identifier-resolution-route.js";
import { parseRelayRoute, type CollaborationRelay } from "./relay.js";
import {
  CollaborativeAppLaunchError,
  type CollaborativeAppLaunchSessions,
} from "./app-launch-sessions.js";
import { cancelCollaborativeAppResponseReader } from "./app-launch-upstream.js";

const DIRECT_SESSION_HEADER = "x-matrix-collaboration-session";
const RETIRED_CONNECTION_TICKET_PATH = /^\/api\/collaboration\/scopes\/[^/]+\/connection-tickets$/;
import {
  PlatformCollaborationRepositoryError,
  type CollaborationDirectoryEntry,
  type PlatformCollaborationRepository,
} from "./repository.js";

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
const AppDiscoveryCursorSchema = z.object({
  version: z.literal(1),
  actorId: CollaborationActorIdSchema,
  after: z.object({ updatedAt: z.iso.datetime(), scopeId: z.uuid() }).strict(),
}).strict();
type DiscoveryPageCursor = { phase: "indexed" | "pending"; after?: { updatedAt: string; scopeId: string } };

type RouteContext = Context;

export function createPlatformCollaborationRoutes(options: {
  repository: PlatformCollaborationRepository;
  /** S05: transparent relay for direct-protocol requests (session routes or requests carrying a direct session). */
  relay?: CollaborationRelay;
  launchSessions?: CollaborativeAppLaunchSessions;
  /**
   * Exact browser origins allowed to send cookie-authenticated relay mutations
   * (`MATRIX_COLLABORATION_ALLOWED_ORIGINS`). Absent or empty refuses every one.
   */
  allowedOrigins?: readonly string[];
  resolveActor(c: RouteContext): Promise<string | null>;
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string } | null>;
  resolveInvitationIdentifier(identifier: string, organizationId: string): Promise<{ actorId: string; displayName: string } | null>;
  /**
   * S06 / T032: candidate organization ids from saved membership rows. Every candidate is checked
   * against `isCurrentOrganizationMember` before it can contribute inventory.
   */
  listOrganizationIds?(actorId: string): Promise<readonly string[]>;
  /**
   * Fresh-membership authority for organization inventory. When absent, organization-wide
   * discovery fails closed even if saved membership rows still list an organization.
   */
  isCurrentOrganizationMember?(input: { organizationId: string; actorId: string }): Promise<boolean>;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const routeNow = () => (options.now ?? (() => new Date()))().getTime();
  const appDiscoveryLimit = new PerActorRateLimit({ maxActors: 10_000, maxAttempts: 120, windowMs: 60_000, now: routeNow });
  const appLaunchLimit = new PerActorRateLimit({ maxActors: 10_000, maxAttempts: 20, windowMs: 60_000, now: routeNow });

  app.on(
    ["POST", "PUT", "PATCH", "DELETE"],
    "/api/collaboration/*",
    bodyLimit({ maxSize: COLLABORATION_HTTP_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) }),
  );
  app.use("/api/collaboration/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (c.req.method === "POST" && RETIRED_CONNECTION_TICKET_PATH.test(c.req.path)) {
      return safeJson(c, "Collaboration route not found", 404);
    }
    // S05: direct-protocol traffic is relayed as opaque bytes; the home decides.
    const relayRoute = options.relay ? parseRelayRoute(c.req.method, c.req.path) : null;
    if (options.relay && relayRoute && (relayRoute.kind === "session" || c.req.header(DIRECT_SESSION_HEADER))) {
      const actorId = await resolveValidatedActor(c, options.resolveActor);
      if (!actorId) return relayUnauthenticated(c);
      if (!relayOriginAllowed(c, allowedOrigins)) return safeJson(c, "Forbidden", 403);
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
    await next();
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
        const applied = await options.repository.applyDirectoryEvent(event);
        if (applied && event.kind === "app" && event.app?.state !== "active") {
          await options.launchSessions?.revokeScope(event.scopeId);
        }
        c.header("Cache-Control", "no-store");
        return c.body(null, 204);
      } catch (error: unknown) {
        return repositoryFailure(c, "directory update", error);
      }
    },
  );

  app.get("/api/collaboration/inbox", async (c) => listDiscovery(c, "invited", options));
  app.get("/api/collaboration/shared", async (c) => listDiscovery(c, "accepted", options));
  app.get("/api/collaboration/shared-apps", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    if (!appDiscoveryLimit.allow(actorId)) return safeJson(c, "Too many collaboration requests", 429);
    const pageRequest = CollaborationPageRequestSchema.safeParse(exactDiscoveryQuery(c));
    if (!pageRequest.success) return safeJson(c, "Invalid request", 422);
    const after = pageRequest.data.cursor ? decodeAppDiscoveryCursor(pageRequest.data.cursor, actorId) : undefined;
    if (pageRequest.data.cursor && !after) return safeJson(c, "Invalid request", 422);
    try {
      const organizationIds = await listCurrentOrganizationIds(actorId, options);
      const page = await options.repository.listCurrentMembershipAppsForActorPage(actorId, organizationIds, {
        limit: pageRequest.data.limit,
        ...(after ? { after } : {}),
      });
      const items = await Promise.all(page.items.map(async (entry) => {
        const owner = await options.resolveParticipant(entry.ownerId);
        if (!owner) throw new Error("CollaborativeAppOwnerUnavailable");
        return {
          scopeId: entry.scopeId,
          runtimeId: entry.runtimeId,
          organizationId: entry.organizationId,
          authorityGeneration: entry.authorityGeneration,
          appId: entry.appId,
          catalogId: entry.catalogId,
          readinessId: entry.readinessId,
          registrationIncarnation: entry.registrationIncarnation,
          buildId: entry.buildId,
          shareRevision: String(entry.shareRevision),
          owner,
        };
      }));
      c.header("Cache-Control", "private, no-store");
      return c.json(CollaborativeAppDirectoryResponseSchema.parse({
        items,
        ...(page.nextCursor ? { nextCursor: encodeAppDiscoveryCursor(actorId, page.nextCursor) } : {}),
      }));
    } catch (error: unknown) {
      console.warn("[platform-collaboration] app discovery failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });
  app.get("/api/collaboration/shared-apps/:scopeId", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    if (!appDiscoveryLimit.allow(actorId)) return safeJson(c, "Too many collaboration requests", 429);
    const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
    if (!scopeId.success) return safeJson(c, "Invalid request", 422);
    try {
      const route = await options.repository.getDirectoryRoute(scopeId.data);
      const currentOrganizations = await listCurrentOrganizationIds(actorId, options);
      if (!route || route.kind !== "app" || route.audience !== "current_membership"
        || !route.organizationId || !currentOrganizations.includes(route.organizationId)
        || !route.app || route.app.state !== "active") return safeJson(c, "Collaboration resource not found", 404);
      const owner = await options.resolveParticipant(route.ownerId);
      if (!owner) return safeJson(c, "Collaboration unavailable", 503);
      c.header("Cache-Control", "private, no-store");
      return c.json(CollaborativeAppDirectoryItemSchema.parse({
        scopeId: route.scopeId,
        runtimeId: route.runtimeId,
        organizationId: route.organizationId,
        authorityGeneration: route.authorityGeneration,
        appId: route.app.appId,
        catalogId: route.app.catalogId,
        readinessId: route.app.readinessId,
        registrationIncarnation: route.app.registrationIncarnation,
        buildId: route.app.buildId,
        shareRevision: String(route.app.shareRevision),
        owner,
      }));
    } catch (error: unknown) {
      console.warn("[platform-collaboration] app lookup failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });
  app.post("/api/collaboration/shared-apps/:scopeId/launch", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    if (!appLaunchLimit.allow(actorId)) return safeJson(c, "Too many collaboration requests", 429);
    if (!options.launchSessions) return safeJson(c, "Collaboration unavailable", 503);
    const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
    const request = await parseJson(c, CollaborativeAppLaunchRequestSchema);
    if (!scopeId.success || !request) return safeJson(c, "Invalid request", 422);
    try {
      const admitted = await admitCollaborativeApp(options, actorId, scopeId.data);
      if (!admitted || admitted.app.shareRevision !== Number(request.expectedShareRevision)
        || admitted.app.buildId !== request.expectedBuildId) return safeJson(c, "Collaboration resource not found", 404);
      const owner = await options.resolveParticipant(admitted.ownerId);
      if (!owner) return safeJson(c, "Collaboration unavailable", 503);
      const launch = await options.launchSessions.create({
        actorId,
        clientRequestId: request.clientRequestId,
        scopeId: admitted.scopeId,
        organizationId: admitted.organizationId,
        runtimeId: admitted.runtimeId,
        authorityGeneration: admitted.authorityGeneration,
        appId: admitted.app.appId,
        catalogId: admitted.app.catalogId,
        buildId: admitted.app.buildId,
        shareRevision: admitted.app.shareRevision,
      });
      return c.json(CollaborativeAppLaunchResponseSchema.parse({
        target: {
          kind: "shared",
          scopeId: admitted.scopeId,
          organizationId: admitted.organizationId,
          appId: admitted.app.appId,
          catalogId: admitted.app.catalogId,
          buildId: admitted.app.buildId,
          name: admitted.app.appId,
          owner,
          shareRevision: String(admitted.app.shareRevision),
        },
        launchId: launch.launchId,
        entryUrl: `/api/collaboration/shared-apps/${admitted.scopeId}/runtime/${launch.launchId}/index.html`,
        expiresAt: launch.expiresAt,
      }), 201);
    } catch (error: unknown) {
      return launchFailure(c, error);
    }
  });
  app.get("/api/collaboration/shared-apps/:scopeId/runtime/:launchId/:assetPath{.+}", async (c) => {
    if (!options.launchSessions) return safeJson(c, "Collaboration unavailable", 503);
    const scopeId = z.uuid().safeParse(c.req.param("scopeId"));
    const launchId = z.uuid().safeParse(c.req.param("launchId"));
    const assetPath = CollaborationAppAssetPathSchema.safeParse(c.req.param("assetPath"));
    if (!scopeId.success || !launchId.success || !assetPath.success) return safeJson(c, "Invalid request", 422);
    const opaqueAssetRequest = c.req.header("origin") === "null" && assetPath.data !== "index.html";
    const authenticatedActorId = await resolveValidatedActor(c, options.resolveActor);
    try {
      const capability = !authenticatedActorId && opaqueAssetRequest
        ? await options.launchSessions.resolveAssetCapability(launchId.data, scopeId.data)
        : null;
      const actorId = authenticatedActorId ?? capability?.actorId ?? null;
      if (!actorId) return safeJson(c, "Unauthorized", 401);
      const admitted = await admitCollaborativeApp(options, actorId, scopeId.data);
      const launch = capability ?? await options.launchSessions.resolve(launchId.data, actorId, scopeId.data);
      if (!admitted) {
        await options.launchSessions.revokeActor(scopeId.data, actorId);
        return safeJson(c, "Collaboration resource not found", 404);
      }
      if (!launch || admitted.runtimeId !== launch.runtimeId
        || admitted.authorityGeneration !== launch.authorityGeneration
        || admitted.app.buildId !== launch.buildId || admitted.app.shareRevision !== launch.shareRevision
        || admitted.app.appId !== launch.appId || admitted.app.catalogId !== launch.catalogId) {
        return safeJson(c, "Collaboration resource not found", 404);
      }
      const response = await options.launchSessions.request({
        launchId: launchId.data,
        actorId,
        scopeId: scopeId.data,
        assetPath: assetPath.data,
        signal: c.req.raw.signal,
      });
      if (assetPath.data !== "index.html") return opaqueAssetRequest ? exposeOpaqueAsset(response) : response;
      const participant = await options.resolveParticipant(actorId);
      if (!participant) {
        await response.body?.cancel();
        return safeJson(c, "Collaboration unavailable", 503);
      }
      return await injectCollaborativeAppBootstrap(response, {
        ...participant,
        organizationId: admitted.organizationId,
        scopeId: admitted.scopeId,
        shareRevision: String(admitted.app.shareRevision),
        buildId: admitted.app.buildId,
      }, `/api/collaboration/shared-apps/${admitted.scopeId}/runtime/${launchId.data}/`);
    } catch (error: unknown) {
      return launchFailure(c, error);
    }
  });
  // The CLI receives an invitation ID as an argument. Resolve only its actor-indexed
  // scope pointer here; invitation content and acceptance stay on the owner's home.
  app.get("/api/collaboration/invitations/:invitationId/location", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    const invitationId = z.uuid().safeParse(c.req.param("invitationId"));
    if (!invitationId.success) return safeJson(c, "Invalid request", 422);
    try {
      const route = await options.repository.getInvitationRoute(actorId, invitationId.data);
      if (!route) return safeJson(c, "Invitation unavailable", 404);
      c.header("Cache-Control", "private, no-store");
      return c.json({ scopeId: route.scopeId });
    } catch (error: unknown) {
      console.warn("[platform-collaboration] invitation location failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Collaboration unavailable", 503);
    }
  });

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

function exposeOpaqueAsset(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "null");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
    // One entry the contract cannot represent (an `invited` row with neither an invitation nor a
    // grant pointer, such as a member grant indexed before grant pointers existed) must not take
    // down the actor's whole inbox: it is dropped and counted for operators, never sent half-formed.
    // A page that drops to nothing but has more behind it would read as "nothing shared", so the
    // next pages are scanned -- a bounded number of them.
    const valid: unknown[] = [];
    let dropped = 0;
    let current = cursor;
    let nextCursor: string | undefined;
    for (let scanned = 0; scanned < MAX_DISCOVERY_SCAN_PAGES; scanned += 1) {
      const page = await readDiscoveryPage(actorId, status, pageRequest.data.limit, current, options);
      for (const item of page.items) {
        const parsed = CollaborationDiscoveryItemSchema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
        else dropped += 1;
      }
      nextCursor = page.nextCursor;
      if (valid.length > 0 || !nextCursor) break;
      current = decodeDiscoveryCursor(nextCursor, actorId, status);
      if (!current) break;
    }
    if (dropped > 0) console.warn("[platform-collaboration] discovery items dropped", dropped);
    c.header("Cache-Control", "private, no-store");
    return c.json(CollaborationDiscoveryResponseSchema.parse({
      items: valid,
      ...(nextCursor ? { nextCursor } : {}),
    }));
  } catch (error: unknown) {
    console.warn("[platform-collaboration] discovery listing failed", error instanceof Error ? error.name : "UnknownError");
    return safeJson(c, "Collaboration unavailable", 503);
  }
}

/** Upper bound on pages one discovery request reads past entries that all had to be dropped. */
const MAX_DISCOVERY_SCAN_PAGES = 5;

/** One discovery page as unvalidated items, plus the encoded cursor for the page after it. */
async function readDiscoveryPage(
  actorId: string,
  status: "invited" | "accepted",
  limit: number,
  cursor: ReturnType<typeof decodeDiscoveryCursor>,
  options: Parameters<typeof createPlatformCollaborationRoutes>[0],
): Promise<{ items: unknown[]; nextCursor?: string }> {
  const phase = cursor?.phase ?? "indexed";
  const page = phase === "indexed"
    ? await options.repository.listForActorPage(actorId, status, {
      limit,
      ...(cursor?.after ? { after: cursor.after } : {}),
    })
    : { items: [] as Awaited<ReturnType<PlatformCollaborationRepository["listForActorPage"]>>["items"], nextCursor: undefined };
  // Metadata only: the client hydrates every item from the resource's home.
  const items: unknown[] = page.items.map((entry) => (
    // A pending grant addressed to this actor alone opens exactly like an organization-wide
    // one (accept the grant on the home), so it uses the same entry and every client --
    // including released ones, which parse the whole page strictly -- already handles it.
    entry.status === "invited" && entry.grantId && !entry.invitationId ? {
      scopeId: entry.scopeId,
      runtimeId: entry.runtimeId,
      ownerId: entry.ownerId,
      kind: entry.kind,
      authorityGeneration: entry.authorityGeneration,
      status: "organization_pending",
      organizationId: entry.organizationId,
      grantId: entry.grantId,
    } : {
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
    const organizationIds = await listCurrentOrganizationIds(actorId, options);
    const remaining = limit - items.length;
    const pending = await options.repository.listOrganizationSharesForActorPage(actorId, organizationIds, {
      limit: Math.max(1, remaining),
      ...(phase === "pending" && cursor?.after ? { after: cursor.after } : {}),
    });
    if (remaining > 0) {
      for (const entry of pending.items) {
        items.push({
          scopeId: entry.scopeId, runtimeId: entry.runtimeId, ownerId: entry.ownerId, kind: entry.kind,
          authorityGeneration: entry.authorityGeneration, status: "organization_pending", organizationId: entry.organizationId,
          grantId: entry.grantId,
        });
      }
    }
    if (pending.nextCursor || (remaining === 0 && pending.items.length > 0)) {
      nextCursor = encodeDiscoveryCursor(actorId, status, "pending", remaining === 0 ? undefined : pending.nextCursor);
    }
  }
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

const MAX_ORGANIZATION_DISCOVERY_CANDIDATES = 100;
const CURRENT_MEMBERSHIP_CHECK_CONCURRENCY = 8;

async function listCurrentOrganizationIds(
  actorId: string,
  options: Parameters<typeof createPlatformCollaborationRoutes>[0],
): Promise<string[]> {
  const listOrganizationIds = options.listOrganizationIds;
  const isCurrentOrganizationMember = options.isCurrentOrganizationMember;
  if (!listOrganizationIds || !isCurrentOrganizationMember) return [];
  const candidates = await listOrganizationIds(actorId);
  const organizationIds = [...new Set(candidates.flatMap((candidate) => {
    const parsed = CollaborationOrganizationIdSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  }))].slice(0, MAX_ORGANIZATION_DISCOVERY_CANDIDATES);
  const current: string[] = [];
  for (let index = 0; index < organizationIds.length; index += CURRENT_MEMBERSHIP_CHECK_CONCURRENCY) {
    const batch = organizationIds.slice(index, index + CURRENT_MEMBERSHIP_CHECK_CONCURRENCY);
    const memberships = await Promise.all(batch.map(async (organizationId) => ({
      organizationId,
      current: await isCurrentOrganizationMember({ organizationId, actorId }),
    })));
    current.push(...memberships.filter((membership) => membership.current).map((membership) => membership.organizationId));
  }
  return current;
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

function encodeAppDiscoveryCursor(actorId: string, after: { updatedAt: string; scopeId: string }): string {
  return Buffer.from(JSON.stringify({ version: 1, actorId, after })).toString("base64url");
}

function decodeAppDiscoveryCursor(value: string, actorId: string): { updatedAt: string; scopeId: string } | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = AppDiscoveryCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown);
    return parsed.success && parsed.data.actorId === actorId ? parsed.data.after : undefined;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[platform-collaboration] app cursor decode failed", error instanceof Error ? error.name : "UnknownError");
    }
    return undefined;
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

/**
 * A browser attaches the platform cookie on its own, so a relayed mutation that the cookie
 * authenticated must come from an allowlisted origin. The actor resolver reads the cookie only
 * when no `Bearer` authorization is present, and a cross-origin page cannot set one without a
 * preflight the platform never grants.
 */
function relayOriginAllowed(c: RouteContext, allowedOrigins: ReadonlySet<string>): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  if (c.req.header("authorization")?.startsWith("Bearer ")) return true;
  const origin = c.req.header("origin");
  return origin !== undefined && allowedOrigins.has(origin);
}

/**
 * The relay's own authentication failure. The relay forwards no `WWW-Authenticate` from a home,
 * so the challenge tells a client to sign in again rather than that a home ended its access.
 * It is exposed for the cross-origin Electron renderer, whose trusted core answers CORS.
 */
function relayUnauthenticated(c: RouteContext) {
  c.header("WWW-Authenticate", 'Bearer realm="matrix-os"');
  c.header("Access-Control-Expose-Headers", "WWW-Authenticate");
  return safeJson(c, "Unauthorized", 401);
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

async function admitCollaborativeApp(
  options: Parameters<typeof createPlatformCollaborationRoutes>[0],
  actorId: string,
  scopeId: string,
) {
  const route = await options.repository.getDirectoryRoute(scopeId);
  if (!route || route.kind !== "app" || route.audience !== "current_membership"
    || !route.organizationId || !route.app || route.app.state !== "active") return null;
  if (!options.isCurrentOrganizationMember) throw new Error("current organization membership unavailable");
  const currentMember = await options.isCurrentOrganizationMember({ organizationId: route.organizationId, actorId });
  return currentMember ? {
    ...route,
    organizationId: route.organizationId,
    app: route.app,
  } : null;
}

function launchFailure(c: RouteContext, error: unknown) {
  if (error instanceof CollaborativeAppLaunchError) {
    if (error.code === "invalid") return safeJson(c, "Invalid request", 422);
    if (error.code === "not_found" || error.code === "conflict") return safeJson(c, "Collaboration resource not found", 404);
    if (error.code === "limit") return safeJson(c, "Too many collaboration requests", 429);
    if (error.code === "host_offline") return safeJson(c, "Collaboration home is offline", 503);
  }
  console.warn("[platform-collaboration] app launch failed", error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Collaboration unavailable", 503);
}

const MAX_BOOTSTRAP_HTML_BYTES = 1024 * 1024;
// A direct request may need ticket issuance, session creation, one home call,
// and one full re-authentication retry. Each network leg is bounded to 10s.
const COLLABORATIVE_APP_BRIDGE_TIMEOUT_MS = 70_000;

class PerActorRateLimit {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly options: {
    maxActors: number;
    maxAttempts: number;
    windowMs: number;
    now: () => number;
  }) {}

  allow(actorId: string): boolean {
    const now = this.options.now();
    const cutoff = now - this.options.windowMs;
    for (const [actor, timestamps] of this.attempts) {
      const live = timestamps.filter((timestamp) => timestamp > cutoff);
      if (live.length === 0) this.attempts.delete(actor);
      else if (live.length !== timestamps.length) this.attempts.set(actor, live);
    }
    let timestamps = this.attempts.get(actorId) ?? [];
    if (!this.attempts.has(actorId) && this.attempts.size >= this.options.maxActors) {
      this.attempts.delete(this.attempts.keys().next().value!);
    }
    if (timestamps.length >= this.options.maxAttempts) return false;
    timestamps = [...timestamps, now];
    this.attempts.delete(actorId);
    this.attempts.set(actorId, timestamps);
    return true;
  }
}

async function injectCollaborativeAppBootstrap(
  response: Response,
  rawParticipant: unknown,
  basePath: string,
): Promise<Response> {
  if (!response.ok || response.headers.get("content-type")?.toLowerCase() !== "text/html; charset=utf-8" || !response.body) {
    await response.body?.cancel();
    throw new CollaborativeAppLaunchError("unavailable");
  }
  const participant = CollaborativeAppParticipantSchema.parse(rawParticipant);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BOOTSTRAP_HTML_BYTES) throw new CollaborativeAppLaunchError("unavailable");
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    await cancelCollaborativeAppResponseReader(reader);
    throw error;
  }
  const context = JSON.stringify(participant).replaceAll("<", "\\u003c");
  const bootstrap = `<base href="${basePath}"><script id="matrix-collaboration-context" type="application/json">${context}</script>${collaborativeAppBridgeBootstrap()}`;
  const source = Buffer.concat(chunks).toString("utf8");
  const html = source.includes("<head>") ? source.replace("<head>", `<head>${bootstrap}`) : `${bootstrap}${source}`;
  const headers = new Headers(response.headers);
  headers.set("content-length", String(Buffer.byteLength(html)));
  return new Response(html, { status: response.status, headers });
}

/** A capability-minimal iframe bridge: participant context plus scoped query/mutate only. */
function collaborativeAppBridgeBootstrap(): string {
  return `<script>(()=>{const c=JSON.parse(document.getElementById("matrix-collaboration-context").textContent);const p=new Map();const l=new Set();const ask=(type,action,expectedRevision)=>new Promise((resolve,reject)=>{if(p.size>=32){reject(new Error("Shared app unavailable"));return}const requestId=crypto.randomUUID();const timer=setTimeout(()=>{p.delete(requestId);reject(new Error("Shared app unavailable"))},${COLLABORATIVE_APP_BRIDGE_TIMEOUT_MS});p.set(requestId,{resolve,reject,timer});parent.postMessage({type,requestId,action,...(expectedRevision===undefined?{}:{expectedRevision})},"*")});addEventListener("message",event=>{if(event.source!==parent||event.origin!==location.origin)return;const m=event.data;if(m?.type==="matrix:shared-app:response"&&typeof m.requestId==="string"){const request=p.get(m.requestId);if(!request)return;p.delete(m.requestId);clearTimeout(request.timer);m.ok?request.resolve(m.result):request.reject(new Error(typeof m.message==="string"?m.message:"Shared app unavailable"));return}if(m?.type==="matrix:shared-app:changed")for(const listener of [...l])try{listener()}catch(error){console.warn("Matrix shared app change listener failed",error instanceof Error?error.name:"UnknownError")}});addEventListener("pagehide",()=>{for(const request of p.values()){clearTimeout(request.timer);request.reject(new Error("Shared app unavailable"))}p.clear();l.clear()},{once:true});window.MatrixOS=window.MatrixOS||{};window.MatrixOS.collaboration=Object.freeze({participant:Object.freeze(c),query:action=>ask("matrix:shared-app:query",action),mutate:(action,expectedRevision)=>ask("matrix:shared-app:mutate",action,expectedRevision),onChange:listener=>{if(typeof listener!=="function"||l.size>=32)return()=>{};l.add(listener);return()=>l.delete(listener)}});parent.postMessage({type:"matrix:shared-app:ready"},"*")})()</script>`;
}

function safeJson(c: RouteContext, error: string, status: 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}

const ParticipantProjectionSchema = z.object({
  actorId: CollaborationActorIdSchema,
  displayName: z.string().trim().min(1).max(120),
}).strict();
