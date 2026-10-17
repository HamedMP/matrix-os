/**
 * /api/brain/projects/:projectId/{brief,conflicts,stale}: principal first, then the brain being on, then the project
 * ref shape, then exactQuery or a bounded JSON body through strict zod. No app.use: headers and body limits are per
 * route. Clients only ever see { error: { code, message } } with a fixed message.
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../collaboration/route-support.js";
import { brainBodyLimit, brainProjectRoute, readBrainBody } from "../api/feature-route-kit.js";
import {
  BRAIN_BRIEF_BODY_MAX_BYTES, BRAIN_CONFLICTS_DEFAULT_LIMIT, BRAIN_CONFLICTS_MAX_LIMIT, BRAIN_CONFLICT_RULES,
  BRAIN_DATE_PATTERN, BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_QUERY_LIST_MAX_ITEMS, BRAIN_STALE_KINDS,
  type BrainBriefService, type BrainFeatureRoutesDeps,
} from "../contracts.js";

const commaList = <T extends string>(values: readonly [T, ...T[]]) => z.string().min(1).max(256)
  .transform((value) => value.split(","))
  .pipe(z.array(z.enum(values)).min(1).max(BRAIN_QUERY_LIST_MAX_ITEMS)).optional();
const pageQuery = {
  limit: z.coerce.number().int().min(1).max(BRAIN_CONFLICTS_MAX_LIMIT).default(BRAIN_CONFLICTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(BRAIN_FEATURE_CURSOR_MAX_CHARS).optional(),
};
const date = z.string().regex(BRAIN_DATE_PATTERN).optional();
const window = z.enum(["day", "week"]).optional();
const BriefQuerySchema = z.object({ date, window }).strict();
const BriefBodySchema = z.object({ date, window, summary: z.boolean().optional() }).strict();
const ConflictsQuerySchema = z.object({ rules: commaList(BRAIN_CONFLICT_RULES), ...pageQuery }).strict();
const StaleQuerySchema = z.object({ kinds: commaList(BRAIN_STALE_KINDS), ...pageQuery }).strict();

export function createBrainBriefRoutes(deps: BrainFeatureRoutesDeps<BrainBriefService>): Hono {
  const app = new Hono();
  const route = brainProjectRoute(deps, "brain-brief");

  app.get("/projects/:projectId/brief", route(async (c, ownerId, service, projectRef) => {
    const query = BriefQuerySchema.parse(exactQuery(c, ["date", "window"]));
    return c.json(await service.getBrief(ownerId, projectRef, query), 200);
  }));

  app.post("/projects/:projectId/brief", brainBodyLimit(BRAIN_BRIEF_BODY_MAX_BYTES),
    route(async (c, ownerId, service, projectRef) => {
      exactQuery(c, []);
      return c.json(await service.generateBrief(ownerId, projectRef, await readBrainBody(c, BriefBodySchema)), 200);
    }));

  app.get("/projects/:projectId/conflicts", route(async (c, ownerId, service, projectRef) => {
    const query = ConflictsQuerySchema.parse(exactQuery(c, ["rules", "limit", "cursor"]));
    return c.json(await service.conflicts(ownerId, projectRef, query), 200);
  }));

  app.get("/projects/:projectId/stale", route(async (c, ownerId, service, projectRef) => {
    const query = StaleQuerySchema.parse(exactQuery(c, ["kinds", "limit", "cursor"]));
    return c.json(await service.stale(ownerId, projectRef, query), 200);
  }));

  return app;
}
