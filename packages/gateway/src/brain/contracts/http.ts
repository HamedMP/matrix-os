/**
 * Company Brain feature contract, part 9: every /api/brain route (method, path, owner, query keys, body bound), the
 * shell's API client shape, the shell view registration, and the services bag startBrainServices (api/start.ts)
 * returns. Types and constants only.
 */
import type { BrainClaimsQuery, BrainClaimsView, BrainExtractInput, BrainExtractView } from "../api/claims-types.js";
import type {
  BrainProjectService, BrainReceiptsView, BrainRegisterGitSourceInput, BrainRegisterGitSourceResult, BrainSyncView,
  BrainWhyQuery, BrainWhyResult,
} from "../api/types.js";
import type {
  BrainBriefGenerateInput, BrainBriefQuery, BrainBriefService, BrainBriefView, BrainConflictsQuery,
  BrainConflictsView, BrainStaleQuery, BrainStaleView,
} from "./brief.js";
import type { BrainConnectableSourceKind, BrainFeature } from "./common.js";
import type {
  BrainAliasInput, BrainEntitiesQuery, BrainEntitiesView, BrainEntityView, BrainGraphService, BrainLinksQuery,
  BrainMergeSuggestionsQuery, BrainMergeSuggestionsView, BrainNeighbourhoodView, BrainTimelineQuery, BrainTimelineView,
} from "./graph.js";
import type { BrainBackgroundJob, BrainChangeHooks, BrainDerivedIndex, BrainRefreshView } from "./hooks.js";
import type { BrainImpactCommentView, BrainImpactQuery, BrainImpactService, BrainImpactView } from "./impact.js";
import type {
  BrainJobEnqueueView, BrainJobRequestInput, BrainJobsListView, BrainJobsService, BrainJobView,
} from "./jobs.js";
import type { BrainSearchCapabilityView, BrainSearchQuery, BrainSearchService, BrainSearchView } from "./search.js";
import type {
  BrainConnectSourceInput, BrainConnectSourceResult, BrainSourceOptionsQuery, BrainSourceOptionsView,
  BrainSourceReceiptsView, BrainSourcesService, BrainSourcesView, BrainSourceSyncView, BrainSourceView,
  BrainUpdateSourceInput,
} from "./sources.js";

// Route table. Paths are relative to /api/brain; `:projectId` is a project id or slug on every route.

export type BrainRouteMethod = "GET" | "POST" | "PATCH" | "DELETE";
export interface BrainRouteSpec {
  readonly method: BrainRouteMethod; readonly path: string; readonly owner: BrainFeature | "core";
  /** Allowed query keys (exactQuery); any other key, or a repeated one, is invalid_request. */
  readonly query: readonly string[];
  /** bodyLimit maxSize for mutating routes; null for GET. */
  readonly bodyMaxBytes: number | null;
}

export const BRAIN_ROUTES = [
  // Existing (specs 553, 554).
  { method: "POST", path: "/projects/:projectId/git-source", owner: "core", query: [], bodyMaxBytes: 4_096 },
  { method: "POST", path: "/projects/:projectId/sync", owner: "core", query: [], bodyMaxBytes: 1_024 },
  { method: "GET", path: "/projects/:projectId/receipts", owner: "core", query: ["limit"], bodyMaxBytes: null },
  { method: "GET", path: "/projects/:projectId/why", owner: "core", query: ["path", "limit", "cursor", "detail"], bodyMaxBytes: null },
  { method: "POST", path: "/projects/:projectId/extract", owner: "core", query: [], bodyMaxBytes: 1_024 },
  { method: "GET", path: "/projects/:projectId/claims", owner: "core", query: ["kind", "path", "limit", "cursor"], bodyMaxBytes: null },
  // Search (spec 556).
  {
    method: "GET", path: "/projects/:projectId/search", owner: "search",
    query: ["q", "types", "kinds", "claimKinds", "source", "from", "to", "path", "mode", "limit", "cursor"],
    bodyMaxBytes: null,
  },
  { method: "POST", path: "/projects/:projectId/search/refresh", owner: "search", query: [], bodyMaxBytes: 1_024 },
  // Graph (spec 557).
  {
    method: "GET", path: "/projects/:projectId/timeline", owner: "graph",
    query: ["entity", "linkTypes", "from", "to", "limit", "cursor"], bodyMaxBytes: null,
  },
  { method: "GET", path: "/projects/:projectId/entities", owner: "graph", query: ["kind", "q", "limit", "cursor"], bodyMaxBytes: null },
  {
    method: "GET", path: "/projects/:projectId/entities/merge-suggestions", owner: "graph", query: ["limit", "cursor"],
    bodyMaxBytes: null,
  },
  { method: "GET", path: "/projects/:projectId/entities/:entityId", owner: "graph", query: [], bodyMaxBytes: null },
  {
    method: "GET", path: "/projects/:projectId/entities/:entityId/links", owner: "graph",
    query: ["hops", "types", "direction", "limit", "cursor"], bodyMaxBytes: null,
  },
  { method: "POST", path: "/projects/:projectId/entities/:entityId/aliases", owner: "graph", query: [], bodyMaxBytes: 2_048 },
  { method: "POST", path: "/projects/:projectId/graph/refresh", owner: "graph", query: [], bodyMaxBytes: 1_024 },
  // Sources (specs 558-560; routes and runner in sources/core, owned by connectors).
  { method: "GET", path: "/projects/:projectId/sources", owner: "connectors", query: [], bodyMaxBytes: null },
  { method: "POST", path: "/projects/:projectId/sources", owner: "connectors", query: [], bodyMaxBytes: 16_384 },
  { method: "GET", path: "/projects/:projectId/sources/options", owner: "connectors", query: ["kind", "q", "cursor"], bodyMaxBytes: null },
  { method: "PATCH", path: "/projects/:projectId/sources/:sourceId", owner: "connectors", query: [], bodyMaxBytes: 16_384 },
  {
    method: "DELETE", path: "/projects/:projectId/sources/:sourceId", owner: "connectors",
    query: ["expectedRevision"], bodyMaxBytes: 1_024,
  },
  { method: "POST", path: "/projects/:projectId/sources/:sourceId/sync", owner: "connectors", query: [], bodyMaxBytes: 1_024 },
  { method: "GET", path: "/projects/:projectId/sources/:sourceId/receipts", owner: "connectors", query: ["limit"], bodyMaxBytes: null },
  // Brief (spec 561).
  { method: "GET", path: "/projects/:projectId/brief", owner: "brief", query: ["date", "window"], bodyMaxBytes: null },
  { method: "POST", path: "/projects/:projectId/brief", owner: "brief", query: [], bodyMaxBytes: 1_024 },
  { method: "GET", path: "/projects/:projectId/conflicts", owner: "brief", query: ["rules", "limit", "cursor"], bodyMaxBytes: null },
  { method: "GET", path: "/projects/:projectId/stale", owner: "brief", query: ["kinds", "limit", "cursor"], bodyMaxBytes: null },
  // Impact (spec 564).
  { method: "GET", path: "/projects/:projectId/impact", owner: "impact", query: ["base", "head", "depth"], bodyMaxBytes: null },
  { method: "GET", path: "/projects/:projectId/impact/comment", owner: "impact", query: ["base", "head", "depth"], bodyMaxBytes: null },
  // Background runs (spec 566).
  { method: "POST", path: "/projects/:projectId/jobs", owner: "jobs", query: [], bodyMaxBytes: 1_024 },
  { method: "GET", path: "/projects/:projectId/jobs", owner: "jobs", query: ["limit"], bodyMaxBytes: null },
  { method: "GET", path: "/projects/:projectId/jobs/:jobId", owner: "jobs", query: [], bodyMaxBytes: null },
  { method: "POST", path: "/projects/:projectId/jobs/:jobId/cancel", owner: "jobs", query: [], bodyMaxBytes: 1_024 },
] as const satisfies readonly BrainRouteSpec[];

/** Success statuses: 201 for POST /sources and POST /git-source when created, 200 for everything else. */
export const BRAIN_ROUTE_CREATED_PATHS = ["/projects/:projectId/sources", "/projects/:projectId/git-source"] as const;
/** 202: POST /jobs queues a run (or answers the one already queued for the same slot) and never runs it inline. */
export const BRAIN_ROUTE_ACCEPTED_PATHS = ["/projects/:projectId/jobs"] as const;
