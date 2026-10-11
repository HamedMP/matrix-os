/**
 * /api/brain routes: register a project's git source, run one bounded sync, list receipts, answer brain_why, extract
 * and list claims. `:projectId` is a project id or slug. Every handler goes through the shared route guard
 * (feature-route-kit.ts: no-store header, request principal, service on, project ref shape) and its error mapper; a
 * store error keeps its git meaning here (BRAIN_STORE_ERROR_API_CODES). No middleware is registered for "*", so
 * nothing leaks to the other routers mounted under /api/brain.
 */
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../collaboration/route-support.js";
import type { RequestPrincipal } from "../../request-principal.js";
import {
  BRAIN_CLAIM_KINDS, BRAIN_CLAIM_LIST_CURSOR_MAX_CHARS, BRAIN_CLAIM_LIST_DEFAULT_LIMIT, BRAIN_CLAIM_LIST_MAX_LIMIT,
} from "../claims/types.js";
import { BrainStoreError } from "../types.js";
import { normalizeBrainWhyPath } from "../why.js";
import { BRAIN_EXTRACT_BODY_MAX_BYTES } from "./claims-types.js";
import { brainBodyLimit, brainProjectRoute, readBrainBody, type BrainProjectHandler } from "./feature-route-kit.js";
import {
  BRAIN_GIT_SOURCE_BODY_MAX_BYTES, BRAIN_RECEIPTS_DEFAULT_LIMIT, BRAIN_RECEIPTS_MAX_LIMIT, BRAIN_STORE_ERROR_API_CODES,
  BRAIN_SYNC_BODY_MAX_BYTES, BRAIN_WEB_BASE_MAX_CHARS, BRAIN_WHY_CURSOR_MAX_CHARS, BRAIN_WHY_DEFAULT_LIMIT,
  BRAIN_WHY_MAX_LIMIT, BRAIN_WHY_PATH_INPUT_MAX_CHARS, BrainApiError, type BrainProjectService,
} from "./types.js";

export interface BrainRoutesDeps {
  /** Null when the owner database is unavailable: every route answers 503. */
  readonly service: BrainProjectService | null;
  readonly getPrincipal: (c: Context) => RequestPrincipal;
}

const GitSourceBodySchema = z.object({
  webBase: z.string().min(1).max(BRAIN_WEB_BASE_MAX_CHARS).optional(),
}).strict();

const SyncBodySchema = z.object({}).strict();

const ReceiptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BRAIN_RECEIPTS_MAX_LIMIT).default(BRAIN_RECEIPTS_DEFAULT_LIMIT),
}).strict();

const WhyQuerySchema = z.object({
  path: z.string().min(1).max(BRAIN_WHY_PATH_INPUT_MAX_CHARS).refine((value) => normalizeBrainWhyPath(value) !== null),
  limit: z.coerce.number().int().min(1).max(BRAIN_WHY_MAX_LIMIT).default(BRAIN_WHY_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(BRAIN_WHY_CURSOR_MAX_CHARS).optional(),
  detail: z.enum(["brief", "full"]).default("brief"),
}).strict();

const ExtractBodySchema = z.object({ extractor: z.enum(["rules", "model"]).default("rules") }).strict();

const ClaimsQuerySchema = z.object({
  kind: z.enum(BRAIN_CLAIM_KINDS).optional(),
  path: WhyQuerySchema.shape.path.optional(),
  limit: z.coerce.number().int().min(1).max(BRAIN_CLAIM_LIST_MAX_LIMIT).default(BRAIN_CLAIM_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(BRAIN_CLAIM_LIST_CURSOR_MAX_CHARS).optional(),
}).strict();

export function createBrainRoutes(deps: BrainRoutesDeps): Hono {
  const app = new Hono();
  const guard = brainProjectRoute<BrainProjectService>(deps, "brain-api");

  /** The shared guard; a store error is a git-source answer on these routes, never a feature code. */
  function route(handler: BrainProjectHandler<BrainProjectService>) {
    return guard(async (c, ownerId, service, projectRef) => {
      try {
        return await handler(c, ownerId, service, projectRef);
      } catch (error: unknown) {
        if (!(error instanceof BrainStoreError)) throw error;
        throw new BrainApiError(BRAIN_STORE_ERROR_API_CODES[error.code], { cause: error });
      }
    });
  }

  app.post("/projects/:projectId/git-source", brainBodyLimit(BRAIN_GIT_SOURCE_BODY_MAX_BYTES), route(async (c, ownerId, service, projectRef) => {
    const body = await readBrainBody(c, GitSourceBodySchema);
    const result = await service.registerGitSource(ownerId, projectRef, body);
    return c.json(result, result.created ? 201 : 200);
  }));

  app.post("/projects/:projectId/sync", brainBodyLimit(BRAIN_SYNC_BODY_MAX_BYTES), route(async (c, ownerId, service, projectRef) => {
    await readBrainBody(c, SyncBodySchema);
    return c.json(await service.sync(ownerId, projectRef), 200);
  }));

  app.get("/projects/:projectId/receipts", route(async (c, ownerId, service, projectRef) => {
    const query = ReceiptsQuerySchema.parse(exactQuery(c, ["limit"]));
    return c.json(await service.listReceipts(ownerId, projectRef, query.limit), 200);
  }));

  app.get("/projects/:projectId/why", route(async (c, ownerId, service, projectRef) => {
    const query = WhyQuerySchema.parse(exactQuery(c, ["path", "limit", "cursor", "detail"]));
    return c.json(await service.why(ownerId, projectRef, query), 200);
  }));

  app.post("/projects/:projectId/extract", brainBodyLimit(BRAIN_EXTRACT_BODY_MAX_BYTES), route(async (c, ownerId, service, projectRef) => {
    const body = await readBrainBody(c, ExtractBodySchema);
    return c.json(await service.extract(ownerId, projectRef, body), 200);
  }));

  app.get("/projects/:projectId/claims", route(async (c, ownerId, service, projectRef) => {
    const query = ClaimsQuerySchema.parse(exactQuery(c, ["kind", "path", "limit", "cursor"]));
    return c.json(await service.listClaims(ownerId, projectRef, query), 200);
  }));

  return app;
}
