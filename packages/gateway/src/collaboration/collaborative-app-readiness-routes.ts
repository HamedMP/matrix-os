import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborativeAppReadinessSchema,
  CollaborativeAppShareSchema,
  CollaborationIdSchema,
  CollaborationOrganizationIdSchema,
  CollaborationRevisionSchema,
  type CollaborativeAppShare,
  type CollaborativeAppBuildRef,
  type CollaborativeAppManifestDeclaration,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";

import {
  hasVerifiedRuntimeBearer,
  isRequestPrincipalError,
  mapRequestPrincipalError,
  MissingRequestPrincipalError,
  requireRequestPrincipal,
} from "../request-principal.js";
import { createRateLimiter, type RateLimiter } from "../security/rate-limiter.js";
import type { CollaborativeAppReadinessEvaluator } from "./collaborative-app-readiness.js";
import type {
  CollaborativeAppReadinessRecord,
  CollaborativeAppReadinessRepository,
} from "./collaborative-app-readiness-repository.js";
import { CollaborativeAppShareServiceError } from "./collaborative-app-share-service.js";
import { CollaborativeAppShareRepositoryError } from "./collaborative-app-share-repository.js";

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CheckRequestSchema = z.object({
  clientRequestId: z.uuid(),
  expectedRegistrationIncarnation: DigestSchema,
  organizationId: CollaborationOrganizationIdSchema,
}).strict();
const SharePreflightRequestSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  expectedReadinessRevision: CollaborationRevisionSchema,
  expectedBuildId: DigestSchema,
}).strict();
const ShareCreateRequestSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  clientRequestId: CollaborationIdSchema,
  expectedResourceRevision: CollaborationRevisionSchema,
  expectedReadinessRevision: CollaborationRevisionSchema,
  readinessId: CollaborationIdSchema,
  buildId: DigestSchema,
  confirmationToken: z.string().min(16).max(8_192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
}).strict();
const ShareStopRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedShareRevision: CollaborationRevisionSchema,
  expectedBindingRevision: CollaborationRevisionSchema,
}).strict();
const SharePreflightResponseSchema = z.discriminatedUnion("eligible", [
  z.object({
    eligible: z.literal(true),
    catalogId: CollaborationIdSchema,
    resourceRevision: CollaborationRevisionSchema,
    readinessId: CollaborationIdSchema,
    buildId: DigestSchema,
    confirmationToken: z.string().min(16).max(8_192),
    existingShare: CollaborativeAppShareSchema.optional(),
  }).strict(),
  z.object({
    eligible: z.literal(false),
    reason: z.enum(["not_ready", "readiness_stale", "organization_mismatch", "already_shared", "unavailable"]),
  }).strict(),
]);

class ReadinessRouteError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "conflict") {
    super("App readiness is unavailable");
    this.name = "ReadinessRouteError";
  }
}

export interface CurrentCollaborativeAppBuild {
  build: CollaborativeAppBuildRef;
  artifactRef: string;
  declaration?: CollaborativeAppManifestDeclaration | null;
}

export interface CollaborativeAppReadinessRouteDependencies {
  ownerId: string;
  repository: Pick<CollaborativeAppReadinessRepository, "getCurrent">;
  evaluator: Pick<CollaborativeAppReadinessEvaluator, "check">;
  resolveCurrentBuild(
    ownerId: string,
    appId: string,
    options: { ensureCatalog: boolean },
  ): Promise<CurrentCollaborativeAppBuild | null>;
  requireOrganizationMembership(actorId: string, organizationId: string): Promise<void>;
  rateLimiter?: RateLimiter;
  readRateLimiter?: RateLimiter;
  share?: {
    get(ownerId: string, appId: string): Promise<CollaborativeAppShare | null>;
    preflight(ownerId: string, appId: string, input: z.infer<typeof SharePreflightRequestSchema>): Promise<unknown>;
    create(ownerId: string, appId: string, input: z.infer<typeof ShareCreateRequestSchema>): Promise<CollaborativeAppShare>;
    stop(ownerId: string, appId: string, input: z.infer<typeof ShareStopRequestSchema>): Promise<CollaborativeAppShare>;
  };
}

function project(record: CollaborativeAppReadinessRecord) {
  return CollaborativeAppReadinessSchema.parse({
    readinessId: record.id,
    build: record.build,
    status: record.status,
    revision: String(record.revision),
    checks: record.gateResults,
    ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
    ...(record.invalidatedAt ? { invalidatedAt: record.invalidatedAt } : {}),
  });
}

function owner(context: Context, expectedOwnerId: string): string {
  const principal = requireRequestPrincipal(context, { isLocalDevelopment: false });
  if (principal.userId !== expectedOwnerId) throw new ReadinessRouteError("forbidden");
  return principal.userId;
}

function readinessOwner(context: Context, expectedOwnerId: string): string {
  const principal = owner(context, expectedOwnerId);
  if (!hasVerifiedRuntimeBearer(context)) throw new MissingRequestPrincipalError();
  return principal;
}

function failure(context: Context, error: unknown) {
  if (error instanceof Error && error.name === "BodyLimitError") {
    return context.json({ error: "Readiness request too large", code: "invalid_request" }, 413);
  }
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "App readiness is unavailable");
    if (mapped.log) console.warn("[collaborative-app-readiness] principal unavailable", error.name);
    return context.json(mapped.body, mapped.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return context.json({ error: "Invalid readiness request", code: "invalid_request" }, 400);
  }
  if (error instanceof ReadinessRouteError) {
    switch (error.code) {
      case "forbidden": return context.json({ error: "Forbidden", code: "forbidden" }, 403);
      case "not_found": return context.json({ error: "App not found", code: "not_found" }, 404);
      case "conflict": return context.json({ error: "App changed; refresh and try again", code: "conflict" }, 409);
    }
  }
  if (error instanceof CollaborativeAppShareServiceError) {
    switch (error.code) {
      case "invalid": return context.json({ error: "Invalid share request", code: "invalid_request" }, 400);
      case "not_found": return context.json({ error: "App not found", code: "not_found" }, 404);
      case "conflict": return context.json({ error: "App changed; refresh and try again", code: "conflict" }, 409);
      case "unavailable": break;
    }
  }
  if (error instanceof CollaborativeAppShareRepositoryError) {
    switch (error.code) {
      case "invalid": return context.json({ error: "Invalid share request", code: "invalid_request" }, 400);
      case "not_found": return context.json({ error: "App not found", code: "not_found" }, 404);
      case "conflict": return context.json({ error: "App changed; refresh and try again", code: "conflict" }, 409);
      case "unavailable": break;
    }
  }
  console.warn("[collaborative-app-readiness] request failed", error instanceof Error ? error.name : "UnknownError");
  return context.json({ error: "App readiness is unavailable", code: "unavailable" }, 503);
}

export function registerCollaborativeAppReadinessRoutes(
  routes: Hono,
  dependencies: CollaborativeAppReadinessRouteDependencies,
): void {
  const limiter = dependencies.rateLimiter ?? createRateLimiter({
    maxAttempts: 10,
    windowMs: 60_000,
    lockoutMs: 60_000,
    maxKeys: 10_000,
  });
  const readLimiter = dependencies.readRateLimiter ?? createRateLimiter({
    maxAttempts: 30,
    windowMs: 60_000,
    lockoutMs: 60_000,
    maxKeys: 10_000,
  });
  const limit = bodyLimit({
    maxSize: COLLABORATION_HTTP_BODY_LIMIT,
    onError: (context) => context.json({ error: "Readiness request too large", code: "invalid_request" }, 413),
  });
  const path = "/api/collaboration/apps/:appId/readiness";

  routes.get(path, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = readinessOwner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      if (!readLimiter.check(ownerId)) return context.json({ error: "Too many readiness reads", code: "rate_limited" }, 429);
      const current = await dependencies.resolveCurrentBuild(ownerId, appId, { ensureCatalog: false });
      if (!current) throw new ReadinessRouteError("not_found");
      const record = await dependencies.repository.getCurrent({
        ownerId, catalogId: current.build.catalogId, buildId: current.build.buildId,
      });
      return context.json(record && record.build.buildId === current.build.buildId ? project(record) : null);
    } catch (error: unknown) {
      return failure(context, error);
    }
  });

  routes.get(`${path}/registration`, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = readinessOwner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      const current = await dependencies.resolveCurrentBuild(ownerId, appId, { ensureCatalog: false });
      if (!current) throw new ReadinessRouteError("not_found");
      return context.json({ registrationIncarnation: current.build.registrationIncarnation });
    } catch (error: unknown) {
      return failure(context, error);
    }
  });

  routes.post(`${path}/check`, limit, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = readinessOwner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      if (!limiter.check(ownerId)) return context.json({ error: "Too many readiness checks", code: "rate_limited" }, 429);
      const request = CheckRequestSchema.parse(await context.req.json());
      const current = await dependencies.resolveCurrentBuild(ownerId, appId, { ensureCatalog: true });
      if (!current) throw new ReadinessRouteError("not_found");
      if (current.build.registrationIncarnation !== request.expectedRegistrationIncarnation) {
        throw new ReadinessRouteError("conflict");
      }
      await dependencies.requireOrganizationMembership(ownerId, request.organizationId);
      const record = await dependencies.evaluator.check({
        ownerId,
        organizationId: request.organizationId,
        build: current.build,
        artifactRef: current.artifactRef,
        declaration: current.declaration ?? null,
      });
      return context.json(project(record));
    } catch (error: unknown) {
      return failure(context, error);
    }
  });

  if (!dependencies.share) return;
  const sharePath = "/api/collaboration/apps/:appId/share";
  routes.get(sharePath, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = owner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      const share = await dependencies.share!.get(ownerId, appId);
      return context.json(share === null ? null : CollaborativeAppShareSchema.parse(share));
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
  routes.post(`${sharePath}/preflight`, limit, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = owner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      if (!limiter.check(ownerId)) return context.json({ error: "Too many share requests", code: "rate_limited" }, 429);
      const request = SharePreflightRequestSchema.parse(await context.req.json());
      await dependencies.requireOrganizationMembership(ownerId, request.organizationId);
      return context.json(SharePreflightResponseSchema.parse(
        await dependencies.share!.preflight(ownerId, appId, request),
      ));
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
  routes.post(sharePath, limit, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = owner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      if (!limiter.check(ownerId)) return context.json({ error: "Too many share requests", code: "rate_limited" }, 429);
      const request = ShareCreateRequestSchema.parse(await context.req.json());
      await dependencies.requireOrganizationMembership(ownerId, request.organizationId);
      return context.json(CollaborativeAppShareSchema.parse(
        await dependencies.share!.create(ownerId, appId, request),
      ), 201);
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
  routes.delete(sharePath, limit, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = owner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      if (!limiter.check(ownerId)) return context.json({ error: "Too many share requests", code: "rate_limited" }, 429);
      const request = ShareStopRequestSchema.parse(await context.req.json());
      return context.json(CollaborativeAppShareSchema.parse(
        await dependencies.share!.stop(ownerId, appId, request),
      ));
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
}
