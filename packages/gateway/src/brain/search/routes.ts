/**
 * GET /projects/:projectId/search and POST /projects/:projectId/search/refresh, mounted under /api/brain. The shared
 * guard and error mapper (api/feature-route-kit.ts), then exactQuery and a strict schema; the only client text is the
 * fixed code message.
 */
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../collaboration/route-support.js";
import { brainBodyLimit, brainProjectRoute, readBrainBody } from "../api/feature-route-kit.js";
import {
  BRAIN_REFRESH_BODY_MAX_BYTES, BRAIN_ROUTES, type BrainFeatureRoutesDeps, type BrainSearchQuery,
  type BrainSearchService,
} from "../contracts.js";
import { BrainSearchQuerySchema } from "./query.js";

const SEARCH_QUERY_KEYS = BRAIN_ROUTES.find((route) => route.path === "/projects/:projectId/search")!.query;
const LIST_INPUT_MAX_CHARS = 256;
/** "a,b" as ["a", "b"]; a longer value stays a string, which the list schema refuses. */
const list = (value: string | undefined) =>
  (value !== undefined && value.length <= LIST_INPUT_MAX_CHARS ? value.split(",") : value);

/** The query string through the service's strict schema: lists split, `limit` a number, `source` as `sourceId`. */
function searchQuery(c: Context): BrainSearchQuery {
  const { source, types, kinds, claimKinds, limit, ...rest } = exactQuery(c, SEARCH_QUERY_KEYS);
  return BrainSearchQuerySchema.parse({ ...rest, sourceId: source, types: list(types), kinds: list(kinds),
    claimKinds: list(claimKinds), limit: limit === undefined ? undefined : Number(limit) });
}

const RefreshBodySchema = z.object({}).strict();

export function createBrainSearchRoutes(deps: BrainFeatureRoutesDeps<BrainSearchService>): Hono {
  const app = new Hono();
  const route = brainProjectRoute(deps, "brain-search");

  app.get("/projects/:projectId/search", route(async (c, ownerId, service, projectRef) => {
    return c.json(await service.search(ownerId, projectRef, searchQuery(c)), 200);
  }));

  app.post("/projects/:projectId/search/refresh", brainBodyLimit(BRAIN_REFRESH_BODY_MAX_BYTES),
    route(async (c, ownerId, service, projectRef) => {
      await readBrainBody(c, RefreshBodySchema);
      return c.json(await service.refresh(ownerId, projectRef), 200);
    }));

  return app;
}
