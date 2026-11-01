/**
 * Company Brain feature contract, part 10: background runs (spec 566). A run is one queued job of the brain's bounded
 * work (a sync, an extraction, a search or graph refresh, a brief) that the gateway's worker claims, leases and runs
 * step by step outside the request. brain/jobs/ implements it. Types and constants only.
 */

export const BRAIN_JOB_KINDS = ["sync", "extract", "search_refresh", "graph_refresh", "brief"] as const;
export type BrainJobKind = (typeof BRAIN_JOB_KINDS)[number];

export const BRAIN_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type BrainJobStatus = (typeof BRAIN_JOB_STATUSES)[number];

/** POST .../jobs bodies are at most this many bytes (bodyLimit on both POST routes). */
export const BRAIN_JOB_BODY_MAX_BYTES = 1_024;

/**
 * A run as stored and passed to its steps: sync without sourceId syncs the project's git source; the extractor and
 * the brief window are always set.
 */
export type BrainJobRequest =
  | { readonly kind: "sync"; readonly sourceId?: string }
  | { readonly kind: "extract"; readonly extractor: "rules" | "model" }
  | { readonly kind: "search_refresh" }
  | { readonly kind: "graph_refresh" }
  | { readonly kind: "brief"; readonly window: "day" | "week" };

/** What POST .../jobs accepts: extractor defaults to "rules", window to "day". */
export type BrainJobRequestInput =
  | { readonly kind: "sync"; readonly sourceId?: string }
  | { readonly kind: "extract"; readonly extractor?: "rules" | "model" }
  | { readonly kind: "search_refresh" }
  | { readonly kind: "graph_refresh" }
  | { readonly kind: "brief"; readonly window?: "day" | "week" };

/**
 * The last step's numbers and words, clipped before they are stored. Sync and extract runs carry `status`,
 * `errorCode` and `nextAction` of their last pass, and `caughtUp: false` when more is left to read.
 */
export type BrainJobSummary = Readonly<Record<string, string | number | boolean | null>>;

/** What clients see. The lease owner never leaves the gateway. Times are ISO-8601. */
export interface BrainJobView {
  readonly jobId: string; readonly projectId: string; readonly kind: BrainJobKind; readonly request: BrainJobRequest;
  readonly status: BrainJobStatus; readonly attempts: number; readonly steps: number;
  readonly cancelRequested: boolean; readonly errorCode: string | null; readonly result: BrainJobSummary | null;
  readonly createdAt: string; readonly startedAt: string | null; readonly heartbeatAt: string | null;
  readonly finishedAt: string | null; readonly updatedAt: string;
}

/** POST .../jobs answer (202): the new job, or the queued or running job that already holds the same slot. */
export interface BrainJobEnqueueView { readonly job: BrainJobView; readonly deduped: boolean }
/** GET .../jobs answer: newest first. */
export interface BrainJobsListView { readonly jobs: readonly BrainJobView[] }

/**
 * Owner-scoped runs of a project. Errors: project_not_found; job_not_found (also for another project's or owner's
 * job); job_kind_unavailable (no step for that kind on this gateway, or no worker runs that owner's jobs); jobs_full.
 */
export interface BrainJobsService {
  enqueue(ownerId: string, projectRef: string, request: BrainJobRequest): Promise<BrainJobEnqueueView>;
  get(ownerId: string, projectRef: string, jobId: string): Promise<BrainJobView>;
  list(ownerId: string, projectRef: string, limit: number): Promise<BrainJobsListView>;
  cancel(ownerId: string, projectRef: string, jobId: string): Promise<BrainJobView>;
}
