import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborativeAppReadinessSchema,
  CollaborationOrganizationIdSchema,
  type CollaborativeAppBuildRef,
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

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CheckRequestSchema = z.object({
  clientRequestId: z.uuid(),
  expectedRegistrationIncarnation: DigestSchema,
  organizationId: CollaborationOrganizationIdSchema,
}).strict();

class ReadinessRouteError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "conflict") {
    super("App readiness is unavailable");
    this.name = "ReadinessRouteError";
  }
}

export interface CurrentCollaborativeAppBuild {
  build: CollaborativeAppBuildRef;
  artifactRef: string;
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
  if (!hasVerifiedRuntimeBearer(context)) throw new MissingRequestPrincipalError();
  if (principal.userId !== expectedOwnerId) throw new ReadinessRouteError("forbidden");
  return principal.userId;
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
  const limit = bodyLimit({
    maxSize: COLLABORATION_HTTP_BODY_LIMIT,
    onError: (context) => context.json({ error: "Readiness request too large", code: "invalid_request" }, 413),
  });
  const path = "/api/collaboration/apps/:appId/readiness";

  routes.get(path, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = owner(context, dependencies.ownerId);
      const appId = AppIdSchema.parse(context.req.param("appId"));
      const current = await dependencies.resolveCurrentBuild(ownerId, appId, { ensureCatalog: false });
      if (!current) throw new ReadinessRouteError("not_found");
      const record = await dependencies.repository.getCurrent({ ownerId, catalogId: current.build.catalogId });
      return context.json(record && record.build.buildId === current.build.buildId ? project(record) : null);
    } catch (error: unknown) {
      return failure(context, error);
    }
  });

  routes.post(`${path}/check`, limit, async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const ownerId = owner(context, dependencies.ownerId);
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
      });
      return context.json(project(record));
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
}
