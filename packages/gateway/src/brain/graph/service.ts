/**
 * Graph service: owner-scoped reads (timeline, entities, person merge suggestions, one entity, neighbourhood), person
 * alias changes and one bounded refresh. Every input is parsed by a strict zod schema (a bad one is invalid_request); the project is resolved
 * through BrainProjectResolver. Reads never refresh and run read-only with a statement deadline; at most two refreshes
 * run at once (service, index and hook passes together; erases never wait). Holds no timers, caches or connections.
 */
import { z } from "zod/v4";
import { BRAIN_PROJECT_SCOPE_PREFIX, BrainApiError } from "../api/types.js";
import { brainCallCap, withBrainRead } from "../bounded.js";
import {
  BRAIN_DERIVED_REFRESH_DEFAULTS, BRAIN_ENTITY_KINDS, BRAIN_ENTITY_REF_MAX_CHARS, BRAIN_FEATURE_CURSOR_MAX_CHARS,
  BRAIN_GRAPH_LIMITS, BRAIN_LINK_TYPES, type BrainDerivedIndex, type BrainGraphFeature, type BrainGraphService,
  type BrainGraphServiceDeps,
} from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import { updateGraphAlias } from "./aliases.js";
import { parseQueryDate } from "./ids.js";
import { listMergeSuggestions, MergeSuggestionsQuerySchema } from "./merge-suggestions.js";
import { graphNeighbourhood } from "./neighbourhood.js";
import { getGraphEntity, listGraphEntities } from "./reads.js";
import { createBrainGraphIndex } from "./refresh.js";
import { withGraphLock } from "./store.js";
import { graphTimeline } from "./timeline.js";
import type { BrainGraphTables } from "./types.js";

const LinkTypes = z.array(z.enum(BRAIN_LINK_TYPES)).min(1).max(BRAIN_LINK_TYPES.length);
const Cursor = z.string().min(1).max(BRAIN_FEATURE_CURSOR_MAX_CHARS);
const Entity = z.string().min(1).max(BRAIN_ENTITY_REF_MAX_CHARS);
const QueryDate = z.string().min(1).max(40);

const TimelineQuerySchema = z.object({
  entity: Entity, linkTypes: LinkTypes.optional(), from: QueryDate.optional(), to: QueryDate.optional(),
  limit: z.number().int().min(1).max(BRAIN_GRAPH_LIMITS.timelineMax).default(BRAIN_GRAPH_LIMITS.timelineDefault),
  cursor: Cursor.optional(),
}).strict();

const EntitiesQuerySchema = z.object({
  kind: z.enum(BRAIN_ENTITY_KINDS).optional(),
  q: z.string().trim().min(1).max(BRAIN_GRAPH_LIMITS.entityQueryMaxChars).optional(),
  limit: z.number().int().min(1).max(BRAIN_GRAPH_LIMITS.entitiesMax).default(BRAIN_GRAPH_LIMITS.entitiesDefault),
  cursor: Cursor.optional(),
}).strict();

const LinksQuerySchema = z.object({
  hops: z.union([z.literal(1), z.literal(2)]).default(1), types: LinkTypes.optional(),
  direction: z.enum(["out", "in", "both"]).default("both"),
  limit: z.number().int().min(1).max(BRAIN_GRAPH_LIMITS.neighbourhoodLinksMax)
    .default(BRAIN_GRAPH_LIMITS.linksPageDefault),
  cursor: Cursor.optional(),
}).strict();

const AliasInputSchema = z.object({ action: z.enum(["merge", "split", "unmerge"]), aliasKey: Entity }).strict();

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BrainApiError("invalid_request", { cause: parsed.error });
  return parsed.data;
}

export function createBrainGraph(deps: BrainGraphServiceDeps): BrainGraphFeature {
  const db = deps.repository.kysely.withTables<BrainGraphTables>();
  const now = deps.now ?? (() => new Date());
  const derived = createBrainGraphIndex({ db, now, projectName: async (scope) => {
    if (!scope.scopeId.startsWith(BRAIN_PROJECT_SCOPE_PREFIX)) return null;
    return (await deps.resolver.resolve(scope.ownerId, scope.scopeId.slice(BRAIN_PROJECT_SCOPE_PREFIX.length))).name;
  } });
  const refreshCap = brainCallCap("graph refresh");
  const index: BrainDerivedIndex = {
    name: derived.name, freshness: derived.freshness,
    refresh: (scope, limits, signal) => refreshCap(() => derived.refresh(scope, limits, signal)),
    handle: (event, signal) => (event.type === "scope_erased" ? derived.handle(event, signal)
      : refreshCap(() => derived.handle(event, signal))),
  };

  async function scopeOf(ownerId: string, projectRef: string): Promise<BrainScopeKey> {
    return (await deps.resolver.resolve(ownerId, projectRef)).scope;
  }

  const service: BrainGraphService = {
    async timeline(ownerId, projectRef, query) {
      const parsed = parse(TimelineQuerySchema, query);
      const range = { from: parseQueryDate(parsed.from), to: parseQueryDate(parsed.to) };
      const scope = await scopeOf(ownerId, projectRef);
      const freshness = await index.freshness(scope);
      return withBrainRead(db, (trx) => graphTimeline(trx, scope, { ...parsed, ...range }, freshness));
    },

    async listEntities(ownerId, projectRef, query) {
      const parsed = parse(EntitiesQuerySchema, query);
      const scope = await scopeOf(ownerId, projectRef);
      return withBrainRead(db, (trx) => listGraphEntities(trx, scope, parsed));
    },

    async mergeSuggestions(ownerId, projectRef, query) {
      const parsed = parse(MergeSuggestionsQuerySchema, query);
      const scope = await scopeOf(ownerId, projectRef);
      return withBrainRead(db, (trx) => listMergeSuggestions(trx, scope, parsed));
    },

    async getEntity(ownerId, projectRef, entityId) {
      const entity = parse(Entity, entityId);
      const scope = await scopeOf(ownerId, projectRef);
      return withBrainRead(db, (trx) => getGraphEntity(trx, scope, entity));
    },

    async links(ownerId, projectRef, entityId, query) {
      const entity = parse(Entity, entityId);
      const parsed = parse(LinksQuerySchema, query);
      const scope = await scopeOf(ownerId, projectRef);
      return withBrainRead(db, (trx) => graphNeighbourhood(trx, scope, entity, parsed));
    },

    async updateAlias(ownerId, projectRef, entityId, input) {
      const entity = parse(Entity, entityId);
      const parsed = parse(AliasInputSchema, input);
      const scope = await scopeOf(ownerId, projectRef);
      const rootId = await withGraphLock(db, scope, (trx) => updateGraphAlias(trx, scope, entity, parsed, now()));
      return withBrainRead(db, (trx) => getGraphEntity(trx, scope, rootId));
    },

    async refresh(ownerId, projectRef) {
      const scope = await scopeOf(ownerId, projectRef);
      return refreshCap(async () => {
        const signal = AbortSignal.timeout(BRAIN_DERIVED_REFRESH_DEFAULTS.budgetMs + 10_000);
        const result = await derived.refresh(scope, BRAIN_DERIVED_REFRESH_DEFAULTS, signal);
        return { index: "graph" as const, ...result, freshness: await index.freshness(scope) };
      });
    },
  };
  return { service, index };
}
