/**
 * Impact routes: GET /projects/:projectId/impact and GET /projects/:projectId/impact/comment (relative to /api/brain).
 * The shared guard and error mapper (api/feature-route-kit.ts), then exactQuery and a strict schema. No app-wide
 * middleware. Errors are fixed { error: { code, message } } bodies; anything unexpected is logged by name and is a 503.
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../collaboration/route-support.js";
import { brainProjectRoute } from "../api/feature-route-kit.js";
import type { BrainFeatureRoutesDeps, BrainImpactQuery, BrainImpactService } from "../contracts.js";
import { BrainImpactQuerySchema } from "./service.js";

const QUERY_KEYS = ["base", "head", "depth"];
const RouteQuerySchema = z.object({
  head: BrainImpactQuerySchema.shape.head,
  base: BrainImpactQuerySchema.shape.base,
  depth: z.enum(["1", "2"]).transform((value) => (value === "1" ? 1 : 2) as 1 | 2).optional(),
}).strict();

type Handler = (service: BrainImpactService, ownerId: string, projectRef: string, query: BrainImpactQuery) =>
  Promise<unknown>;

export function createBrainImpactRoutes(deps: BrainFeatureRoutesDeps<BrainImpactService>): Hono {
  const app = new Hono();
  const guard = brainProjectRoute(deps, "brain-impact");
  const route = (handler: Handler) => guard(async (c, ownerId, service, projectRef) =>
    c.json(await handler(service, ownerId, projectRef, RouteQuerySchema.parse(exactQuery(c, QUERY_KEYS))), 200));

  app.get("/projects/:projectId/impact", route((service, ownerId, projectRef, query) =>
    service.impact(ownerId, projectRef, query)));
  app.get("/projects/:projectId/impact/comment", route((service, ownerId, projectRef, query) =>
    service.comment(ownerId, projectRef, query)));
  return app;
}
