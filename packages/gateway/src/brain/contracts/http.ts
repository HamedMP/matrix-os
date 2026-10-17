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

// View client. packages/ui/src/brain/brain-client.ts implements this over an injected HTTP transport; DTOs are
// mirrored there structurally (the UI package cannot import the gateway). Every method takes a project id.

export interface BrainShellApi {
  // Existing.
  registerGitSource(projectId: string, input: BrainRegisterGitSourceInput): Promise<BrainRegisterGitSourceResult>;
  syncGit(projectId: string): Promise<BrainSyncView>;
  gitReceipts(projectId: string, limit?: number): Promise<BrainReceiptsView>;
  why(projectId: string, query: BrainWhyQuery): Promise<BrainWhyResult>;
  extract(projectId: string, input: BrainExtractInput): Promise<BrainExtractView>;
  claims(projectId: string, query: Partial<BrainClaimsQuery>): Promise<BrainClaimsView>;
  // Search and graph.
  search(projectId: string, query: BrainSearchQuery): Promise<BrainSearchView>;
  refreshSearch(projectId: string): Promise<BrainRefreshView>;
  timeline(projectId: string, query: BrainTimelineQuery): Promise<BrainTimelineView>;
  entities(projectId: string, query: BrainEntitiesQuery): Promise<BrainEntitiesView>;
  mergeSuggestions(projectId: string, query: BrainMergeSuggestionsQuery): Promise<BrainMergeSuggestionsView>;
  entity(projectId: string, entityId: string): Promise<BrainEntityView>;
  entityLinks(projectId: string, entityId: string, query: BrainLinksQuery): Promise<BrainNeighbourhoodView>;
  updateAlias(projectId: string, entityId: string, input: BrainAliasInput): Promise<BrainEntityView>;
  refreshGraph(projectId: string): Promise<BrainRefreshView>;
  // Sources.
  sources(projectId: string): Promise<BrainSourcesView>;
  connectSource(projectId: string, input: BrainConnectSourceInput): Promise<BrainConnectSourceResult>;
  sourceOptions(projectId: string, kind: BrainConnectableSourceKind, query: BrainSourceOptionsQuery):
    Promise<BrainSourceOptionsView>;
  updateSource(projectId: string, sourceId: string, input: BrainUpdateSourceInput): Promise<BrainSourceView>;
  removeSource(projectId: string, sourceId: string, expectedRevision: number): Promise<BrainSourceView>;
  syncSource(projectId: string, sourceId: string): Promise<BrainSourceSyncView>;
  sourceReceipts(projectId: string, sourceId: string, limit?: number): Promise<BrainSourceReceiptsView>;
  // Brief and impact.
  brief(projectId: string, query: BrainBriefQuery): Promise<BrainBriefView>;
  generateBrief(projectId: string, input: BrainBriefGenerateInput): Promise<BrainBriefView>;
  conflicts(projectId: string, query: BrainConflictsQuery): Promise<BrainConflictsView>;
  stale(projectId: string, query: BrainStaleQuery): Promise<BrainStaleView>;
  impact(projectId: string, query: BrainImpactQuery): Promise<BrainImpactView>;
  // Background runs.
  startJob(projectId: string, input: BrainJobRequestInput): Promise<BrainJobEnqueueView>;
  job(projectId: string, jobId: string): Promise<BrainJobView>;
  jobs(projectId: string, limit?: number): Promise<BrainJobsListView>;
  /** Body {}. */
  cancelJob(projectId: string, jobId: string): Promise<BrainJobView>;
}

/**
 * The client maps a non-2xx response to one of these for the UI; `code` is read from `{ error: { code } }` and kept
 * only when it is a known BrainAnyErrorCode (else "unknown"); the server message is never shown verbatim.
 */
export type BrainShellErrorState =
  | { readonly kind: "unauthorized" } | { readonly kind: "offline" } | { readonly kind: "timeout" }
  | { readonly kind: "not_found"; readonly code: string } | { readonly kind: "unavailable" }
  | { readonly kind: "rejected"; readonly code: string };

// Shell view registration.

export const BRAIN_SHELL_VIEW = {
  path: "__brain__", title: "Company Brain", aliases: ["brain", "company-brain", "apps/brain/index.html"],
  defaultWidth: 1100, defaultHeight: 720, minWidth: 360, minHeight: 420,
} as const;
export const BRAIN_SHELL_SCREENS = [
  "ask", "today", "decisions", "commitments", "risks", "timeline", "sources",
] as const;
export type BrainShellScreen = (typeof BRAIN_SHELL_SCREENS)[number];

// Services bag: what startBrainServices (api/start.ts) returns once every feature is started; it calls
// startBrainProjectService for the core store.

export interface BrainServices {
  readonly project: BrainProjectService;
  readonly search: BrainSearchService | null;
  readonly graph: BrainGraphService | null;
  readonly sources: BrainSourcesService | null;
  readonly brief: BrainBriefService | null;
  readonly impact: BrainImpactService | null;
  /** Background runs (the /jobs routes); null when brain_jobs could not be bootstrapped. */
  readonly runs: BrainJobsService | null;
  readonly searchCapability: BrainSearchCapabilityView | null;
  readonly indexes: readonly BrainDerivedIndex[];
  readonly hooks: BrainChangeHooks;
  /** Timers started after the server listens: the run worker (stopped first), the daily brief, the index catch-up. */
  readonly jobs: readonly BrainBackgroundJob[];
}

/** Factory names each feature folder's index.ts exports (tests/gateway/brain-wiring.test.ts checks them). */
export const BRAIN_FEATURE_EXPORTS = {
  search: ["bootstrapBrainSearchDatabase", "createBrainSearch", "createBrainSearchRoutes"],
  graph: ["bootstrapBrainGraphDatabase", "createBrainGraph", "createBrainGraphRoutes"],
  github: ["bootstrapBrainGithubDatabase", "createBrainGithubSourceHandler", "createBrainIntegrationCaller"],
  matrix_sources: [
    "bootstrapBrainMatrixDatabase", "createBrainMatrixNotesHandler", "createBrainMatrixFilesHandler",
    "createBrainMatrixChatHandler",
  ],
  connectors: [
    "bootstrapBrainConnectorDatabase", "createBrainLinearHandler", "createBrainGoogleDriveHandler",
    "createBrainGoogleCalendarHandler", "createBrainSlackBridgeHandler", "runBrainSourceSync",
    "createBrainSourcesService", "createBrainSourcesRoutes",
  ],
  brief: ["bootstrapBrainBriefDatabase", "createBrainBrief", "createBrainBriefRoutes", "createBrainBriefScheduler"],
  impact: ["createBrainImpactService", "createBrainImpactRoutes", "formatBrainImpactComment"],
  agent_tools: ["createBrainAgentReadTools"],
  jobs: ["bootstrapBrainJobsDatabase", "createBrainJobWorker", "createBrainJobsService", "createBrainJobsRoutes"],
} as const satisfies Partial<Record<BrainFeature, readonly string[]>>;
