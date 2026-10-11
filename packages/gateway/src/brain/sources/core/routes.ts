/**
 * /api/brain/projects/:projectId/sources...: the seven /sources routes of BRAIN_ROUTES. Each answer starts with the
 * shared guard (no-store, request principal, brain on, project ref shape), then exactQuery and a strict zod/v4 schema
 * or a bounded JSON body. A path id that fails BRAIN_SOURCE_ID_PATTERN goes to the service as "", which resolves the
 * project before it looks at a source id, so a malformed, missing or foreign source answers the same source_not_found.
 * No app.use.
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { exactQuery } from "../../../collaboration/route-support.js";
import { brainBodyLimit, brainProjectRoute, readBrainBody } from "../../api/feature-route-kit.js";
import {
  BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_SOURCES_BODY_MAX_BYTES, BrainFeatureError, type BrainConnectableSourceKind,
  type BrainFeatureRoutesDeps, type BrainSourcesService,
} from "../../contracts.js";
import {
  BRAIN_KIND_PATTERN, BRAIN_MAX_REVISION, BRAIN_RECEIPTS_PER_SOURCE, BRAIN_SOURCE_ID_PATTERN,
  BRAIN_SOURCE_LABEL_MAX_CHARS,
} from "../../types.js";
import { isBrainConnectableSourceKind } from "./registry.js";
import { BRAIN_SOURCES_SERVICE_LIMITS } from "./service.js";

const OPTIONS_QUERY_MAX_CHARS = 256;

const kindSchema = z.string().min(1).max(32).regex(BRAIN_KIND_PATTERN);
/** Other path ids reach the service as "" (no source has it), after the project check like any unknown id. */
const sourceIdSchema = z.string().regex(BRAIN_SOURCE_ID_PATTERN);
const labelSchema = z.string().trim().min(1).max(BRAIN_SOURCE_LABEL_MAX_CHARS).regex(/^[^\p{Cc}]+$/u);
const revisionSchema = z.number().int().min(1).max(BRAIN_MAX_REVISION);
const decimal = (max: number) => z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().int().max(max));
/** Present and not undefined; the kind handler parses it. */
const configSchema = z.custom<unknown>((value) => value !== undefined);

const ConnectBodySchema = z.object({ kind: kindSchema, config: configSchema, label: labelSchema.optional() }).strict();
const UpdateBodySchema = z.object({
  expectedRevision: revisionSchema, status: z.enum(["active", "paused"]).optional(),
  config: configSchema.optional(), label: labelSchema.optional(),
}).strict().refine((body) => body.status !== undefined || body.config !== undefined || body.label !== undefined);
const EmptyBodySchema = z.object({}).strict();
const OptionsQuerySchema = z.object({
  kind: kindSchema, q: z.string().max(OPTIONS_QUERY_MAX_CHARS).optional(),
  cursor: z.string().min(1).max(BRAIN_FEATURE_CURSOR_MAX_CHARS).optional(),
}).strict();
const RemoveQuerySchema = z.object({ expectedRevision: decimal(BRAIN_MAX_REVISION) }).strict();
const ReceiptsQuerySchema = z.object({
  limit: decimal(BRAIN_RECEIPTS_PER_SOURCE).default(BRAIN_SOURCES_SERVICE_LIMITS.receiptsDefault),
}).strict();

/** git, unknown kinds and kinds outside the contract are not connectable here. */
function connectableKind(kind: string): BrainConnectableSourceKind {
  if (!isBrainConnectableSourceKind(kind)) throw new BrainFeatureError("source_kind_unsupported");
  return kind;
}

function sourceIdParam(value: string | undefined): string {
  const parsed = sourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : "";
}

export function createBrainSourcesRoutes(deps: BrainFeatureRoutesDeps<BrainSourcesService>): Hono {
  const app = new Hono();
  const route = brainProjectRoute(deps, "brain-sources");
  const base = "/projects/:projectId/sources";

  app.get(base, route(async (c, ownerId, service, projectRef) => {
    exactQuery(c, []);
    return c.json(await service.list(ownerId, projectRef), 200);
  }));

  app.post(base, brainBodyLimit(BRAIN_SOURCES_BODY_MAX_BYTES.connect), route(async (c, ownerId, service, projectRef) => {
    exactQuery(c, []);
    const body = await readBrainBody(c, ConnectBodySchema);
    const result = await service.connect(ownerId, projectRef, {
      kind: connectableKind(body.kind), config: body.config, ...(body.label === undefined ? {} : { label: body.label }),
    });
    return c.json(result, result.created ? 201 : 200);
  }));

  app.get(`${base}/options`, route(async (c, ownerId, service, projectRef) => {
    const query = OptionsQuerySchema.parse(exactQuery(c, ["kind", "q", "cursor"]));
    const kind = connectableKind(query.kind);
    const options = {
      ...(query.q === undefined ? {} : { q: query.q }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    };
    return c.json(await service.options(ownerId, projectRef, kind, options), 200);
  }));

  app.patch(`${base}/:sourceId`, brainBodyLimit(BRAIN_SOURCES_BODY_MAX_BYTES.update),
    route(async (c, ownerId, service, projectRef) => {
      exactQuery(c, []);
      const sourceId = sourceIdParam(c.req.param("sourceId"));
      const body = await readBrainBody(c, UpdateBodySchema);
      return c.json(await service.update(ownerId, projectRef, sourceId, {
        expectedRevision: body.expectedRevision,
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.config === undefined ? {} : { config: body.config }),
        ...(body.label === undefined ? {} : { label: body.label }),
      }), 200);
    }));

  app.delete(`${base}/:sourceId`, brainBodyLimit(BRAIN_SOURCES_BODY_MAX_BYTES.remove),
    route(async (c, ownerId, service, projectRef) => {
      const query = RemoveQuerySchema.parse(exactQuery(c, ["expectedRevision"]));
      const sourceId = sourceIdParam(c.req.param("sourceId"));
      await readBrainBody(c, EmptyBodySchema);
      return c.json(await service.remove(ownerId, projectRef, sourceId, query.expectedRevision), 200);
    }));

  app.post(`${base}/:sourceId/sync`, brainBodyLimit(BRAIN_SOURCES_BODY_MAX_BYTES.sync),
    route(async (c, ownerId, service, projectRef) => {
      exactQuery(c, []);
      const sourceId = sourceIdParam(c.req.param("sourceId"));
      await readBrainBody(c, EmptyBodySchema);
      return c.json(await service.sync(ownerId, projectRef, sourceId), 200);
    }));

  app.get(`${base}/:sourceId/receipts`, route(async (c, ownerId, service, projectRef) => {
    const query = ReceiptsQuerySchema.parse(exactQuery(c, ["limit"]));
    const sourceId = sourceIdParam(c.req.param("sourceId"));
    return c.json(await service.receipts(ownerId, projectRef, sourceId, query.limit), 200);
  }));

  return app;
}
