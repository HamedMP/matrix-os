/**
 * /api/brain graph routes: timeline, entity list, person merge suggestions, one entity, its links, person alias
 * changes and one bounded refresh. Principal first, then service null -> brain_unavailable, then the project ref and entity id patterns;
 * exactQuery plus strict zod; bodyLimit on POST; `Cache-Control: private, no-store` on every answer. No app.use.
 */
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../collaboration/route-support.js";
import { brainBodyLimit, brainProjectRoute, readBrainBody } from "../api/feature-route-kit.js";
import {
  BRAIN_ENTITY_ID_PATTERN, BRAIN_ENTITY_KINDS, BRAIN_GRAPH_ALIAS_BODY_MAX_BYTES, BRAIN_LINK_TYPES,
  BRAIN_QUERY_LIST_MAX_ITEMS, BRAIN_REFRESH_BODY_MAX_BYTES, BrainFeatureError, type BrainFeatureRoutesDeps,
  type BrainGraphService,
} from "../contracts.js";

const text = z.string().max(1_024);
const count = z.string().regex(/^[0-9]{1,4}$/).transform(Number);
const linkTypes = text.transform((value) => value.split(","))
  .pipe(z.array(z.enum(BRAIN_LINK_TYPES)).min(1).max(BRAIN_QUERY_LIST_MAX_ITEMS));

const TimelineQuery = z.object({
  entity: text, linkTypes: linkTypes.optional(), from: text.optional(), to: text.optional(), limit: count.optional(),
  cursor: text.optional(),
}).strict();
const EntitiesQuery = z.object({
  kind: z.enum(BRAIN_ENTITY_KINDS).optional(), q: text.optional(), limit: count.optional(), cursor: text.optional(),
}).strict();
const LinksQuery = z.object({
  hops: z.enum(["1", "2"]).transform((value) => (value === "1" ? 1 : 2) as 1 | 2).optional(),
  types: linkTypes.optional(), direction: z.enum(["out", "in", "both"]).optional(), limit: count.optional(),
  cursor: text.optional(),
}).strict();
const MergeSuggestionsQuery = z.object({ limit: count.optional(), cursor: text.optional() }).strict();
const AliasBody = z.object({ action: z.enum(["merge", "split", "unmerge"]), aliasKey: text }).strict();
const EmptyBody = z.object({}).strict();

function entityParam(c: Context): string {
  const entityId = c.req.param("entityId");
  if (entityId === undefined || !BRAIN_ENTITY_ID_PATTERN.test(entityId)) {
    throw new BrainFeatureError("entity_not_found");
  }
  return entityId;
}

export function createBrainGraphRoutes(deps: BrainFeatureRoutesDeps<BrainGraphService>): Hono {
  const app = new Hono();
  const route = brainProjectRoute(deps, "brain-graph");

  app.get("/projects/:projectId/timeline", route(async (c, ownerId, service, projectRef) => {
    const query = TimelineQuery.parse(exactQuery(c, ["entity", "linkTypes", "from", "to", "limit", "cursor"]));
    return c.json(await service.timeline(ownerId, projectRef, query), 200);
  }));

  app.get("/projects/:projectId/entities", route(async (c, ownerId, service, projectRef) => {
    const query = EntitiesQuery.parse(exactQuery(c, ["kind", "q", "limit", "cursor"]));
    return c.json(await service.listEntities(ownerId, projectRef, query), 200);
  }));

  // Before entities/:entityId, which would take "merge-suggestions" as an entity id.
  app.get("/projects/:projectId/entities/merge-suggestions", route(async (c, ownerId, service, projectRef) => {
    const query = MergeSuggestionsQuery.parse(exactQuery(c, ["limit", "cursor"]));
    return c.json(await service.mergeSuggestions(ownerId, projectRef, query), 200);
  }));

  app.get("/projects/:projectId/entities/:entityId", route(async (c, ownerId, service, projectRef) => {
    exactQuery(c, []);
    return c.json(await service.getEntity(ownerId, projectRef, entityParam(c)), 200);
  }));

  app.get("/projects/:projectId/entities/:entityId/links", route(async (c, ownerId, service, projectRef) => {
    const query = LinksQuery.parse(exactQuery(c, ["hops", "types", "direction", "limit", "cursor"]));
    return c.json(await service.links(ownerId, projectRef, entityParam(c), query), 200);
  }));

  app.post("/projects/:projectId/entities/:entityId/aliases", brainBodyLimit(BRAIN_GRAPH_ALIAS_BODY_MAX_BYTES),
    route(async (c, ownerId, service, projectRef) => {
      exactQuery(c, []);
      const entityId = entityParam(c);
      const body = await readBrainBody(c, AliasBody);
      return c.json(await service.updateAlias(ownerId, projectRef, entityId, body), 200);
    }));

  app.post("/projects/:projectId/graph/refresh", brainBodyLimit(BRAIN_REFRESH_BODY_MAX_BYTES),
    route(async (c, ownerId, service, projectRef) => {
      exactQuery(c, []);
      await readBrainBody(c, EmptyBody);
      return c.json(await service.refresh(ownerId, projectRef), 200);
    }));

  return app;
}
