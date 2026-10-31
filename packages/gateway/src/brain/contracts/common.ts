/**
 * Company Brain feature contract, part 1: ownership, shared vocabularies (source kinds, provenances, ref kinds,
 * citation kinds), the citation view, project resolution, route plumbing and the one error class every feature
 * throws. Types and constants only, plus that error class. Feature folders import from ../contracts.js and never
 * edit anything under contracts/.
 */
import type { Context } from "hono";
import type { RequestPrincipal } from "../../request-principal.js";
import type { BrainApiErrorCode, BrainApiErrorStatus } from "../api/types.js";
import type { BrainScopeKey, BrainStoreErrorCode } from "../types.js";

// Features and what they own.

export const BRAIN_FEATURES = [
  "search", "graph", "github", "matrix_sources", "connectors", "brief", "agent_tools", "app", "impact", "jobs",
] as const;
export type BrainFeature = (typeof BRAIN_FEATURES)[number];

/**
 * The only table name prefix each feature may create, write or drop. Core tables (brain_sources, brain_documents,
 * brain_document_revisions, brain_document_refs, brain_sync_cursors, brain_sync_receipts, brain_claims,
 * brain_extraction_state, brain_extraction_runs) are read-only to features: plain SELECTs through
 * `repository.kysely`, never a write, never a DDL statement (no index or trigger on a core table either). Background
 * runs (jobs) own exactly one table, `brain_jobs`, and no prefix.
 */
export const BRAIN_TABLE_PREFIXES = {
  search: "brain_search_", graph: "brain_graph_", github: "brain_github_", matrix_sources: "brain_matrix_",
  connectors: "brain_connector_", brief: "brain_brief_", impact: "brain_impact_",
} as const satisfies Partial<Record<BrainFeature, string>>;

/** Bootstrap advisory lock name per feature: pg_advisory_xact_lock(hashtext(current_schema()), hashtext(<name>)). */
export const BRAIN_FEATURE_SCHEMA_LOCKS = {
  search: "brain_search_schema", graph: "brain_graph_schema", github: "brain_github_schema",
  matrix_sources: "brain_matrix_schema", connectors: "brain_connector_schema", brief: "brain_brief_schema",
} as const satisfies Partial<Record<BrainFeature, string>>;

/**
 * Per-scope write lock of a feature's own tables: pg_advisory_xact_lock(hashtext(ownerId),
 * hashtext(`${prefix}${scopeId}`)). Never the core `brain:<scopeId>` key, so feature writes do not block syncs.
 */
export const BRAIN_FEATURE_SCOPE_LOCK_PREFIXES = {
  search: "brain-search:", graph: "brain-graph:", github: "brain-github:", matrix_sources: "brain-matrix:",
  connectors: "brain-connector:", brief: "brain-brief:",
} as const satisfies Partial<Record<BrainFeature, string>>;

// Source kinds (brain_sources.kind). `git` exists (spec 552); git sources keep their own routes.

export const BRAIN_SOURCE_KINDS = {
  git: "git", github: "github", matrixNotes: "matrix_notes", matrixFiles: "matrix_files", matrixChat: "matrix_chat",
  linear: "linear", googleDrive: "google_drive", googleCalendar: "google_calendar", slackBridge: "slack_bridge",
} as const;
export type BrainSourceKind = (typeof BRAIN_SOURCE_KINDS)[keyof typeof BRAIN_SOURCE_KINDS];
/** Kinds connected through POST /sources (every kind except git). */
export type BrainConnectableSourceKind = Exclude<BrainSourceKind, "git">;

export const BRAIN_SOURCE_KIND_OWNERS: Readonly<Record<BrainSourceKind, BrainFeature | "core">> = {
  git: "core", github: "github", matrix_notes: "matrix_sources", matrix_files: "matrix_sources",
  matrix_chat: "matrix_sources", linear: "connectors", google_drive: "connectors", google_calendar: "connectors",
  slack_bridge: "connectors",
};

/** At most this many live sources of one kind per project scope (git and github: exactly one). */
export const BRAIN_SOURCES_PER_KIND_MAX: Readonly<Record<BrainSourceKind, number>> = {
  git: 1, github: 1, matrix_notes: 1, matrix_files: 4, matrix_chat: 1, linear: 4, google_drive: 4,
  google_calendar: 4, slack_bridge: 1,
};

// Provenance (brain_documents.provenance): which adapter wrote a document and what it is.

export const BRAIN_PROVENANCES = {
  gitPr: "git_pr", gitCommit: "git_commit", gitSpec: "git_spec",
  githubPr: "github_pr", githubReview: "github_review", githubReviewComment: "github_review_comment",
  githubIssue: "github_issue",
  matrixNote: "matrix_note", matrixFile: "matrix_file", matrixChat: "matrix_chat",
  linearIssue: "linear_issue", linearComment: "linear_comment", linearUpdate: "linear_update",
  googleDoc: "google_doc", calendarEvent: "calendar_event", slackThread: "slack_thread",
} as const;
export type BrainProvenance = (typeof BRAIN_PROVENANCES)[keyof typeof BRAIN_PROVENANCES];

/** Provenances a source kind may write; the sync runner refuses any other (document_invalid). */
export const BRAIN_SOURCE_KIND_PROVENANCES: Readonly<Record<BrainSourceKind, readonly BrainProvenance[]>> = {
  git: ["git_pr", "git_commit", "git_spec"],
  github: ["github_pr", "github_review", "github_review_comment", "github_issue"],
  matrix_notes: ["matrix_note"], matrix_files: ["matrix_file"], matrix_chat: ["matrix_chat"],
  linear: ["linear_issue", "linear_comment", "linear_update"], google_drive: ["google_doc"],
  google_calendar: ["calendar_event"], slack_bridge: ["slack_thread"],
};

/** First element of each kind's document id tuple: sha256(JSON.stringify([version, externalRef, ...tail])). */
export const BRAIN_DOCUMENT_ID_VERSIONS: Readonly<Record<BrainSourceKind, string>> = {
  git: "brain_git_v1", github: "brain_github_v1", matrix_notes: "brain_matrix_notes_v1",
  matrix_files: "brain_matrix_files_v1", matrix_chat: "brain_matrix_chat_v1", linear: "brain_linear_v1",
  google_drive: "brain_google_drive_v1", google_calendar: "brain_google_calendar_v1",
  slack_bridge: "brain_slack_bridge_v1",
};

// Citation kinds: the one display vocabulary every view, tool and screen uses for a document.

export const BRAIN_CITE_KINDS = [
  "pr", "commit", "spec", "review", "comment", "issue", "note", "file", "chat", "doc", "event", "update", "thread",
  "document",
] as const;
export type BrainCiteKind = (typeof BRAIN_CITE_KINDS)[number];

/** Unknown provenances (manual publication, future adapters) cite as "document". */
export const BRAIN_PROVENANCE_CITE_KINDS: Readonly<Record<BrainProvenance, BrainCiteKind>> = {
  git_pr: "pr", git_commit: "commit", git_spec: "spec", github_pr: "pr", github_review: "review",
  github_review_comment: "comment", github_issue: "issue", matrix_note: "note", matrix_file: "file",
  matrix_chat: "chat", linear_issue: "issue", linear_comment: "comment", linear_update: "update",
  google_doc: "doc", calendar_event: "event", slack_thread: "thread",
};

// Ref kinds (brain_document_refs.kind). path, pr and spec exist (git adapter); the rest are new. Every value is
// 1..512 utf8 bytes with no NUL (store rule). Adapters write a document's complete ref set on every upsert.

export const BRAIN_REF_KINDS = {
  /** Repo-relative path of the project's repository (git, github). Never a home path. */
  path: "path",
  /** Pull request number of the project's repository, decimal, no sign: "2078". */
  pr: "pr",
  /** Spec directory: "specs/551-company-brain-store". */
  spec: "spec",
  /** Short display handle, at most one per document: "#2078", "!12", "ENG-42". Cite labels use it. */
  handle: "handle",
  /** Issue key: tracker "ENG-42" (BRAIN_ISSUE_KEY_PATTERN) or a GitHub issue of the project repo "#123". */
  issue: "issue",
  /** Full lowercase commit sha a github_pr contains (40 or 64 hex); joins git_commit documents to the PR. */
  commit: "commit",
  /** Document id of the parent document (review -> PR, comment -> issue). */
  parent: "parent",
  /** Person keys (BRAIN_PERSON_KEY_PREFIXES), by role. */
  author: "author", reviewer: "reviewer", assignee: "assignee", attendee: "attendee", participant: "participant",
  /** Label or tag name, NFC, at most 100 characters. */
  label: "label",
  /** Lowercase state word (BRAIN_KIND_PATTERN): open, closed, merged, draft, done, canceled, confirmed... */
  status: "status",
  /** YYYY-MM-DD. */
  due: "due",
  /** ISO-8601 instant in UTC ("Z"), for events. */
  startsAt: "starts_at",
  /** Home-relative Matrix file path (matrix_files, matrix_notes). */
  file: "file",
  /** Matrix chat id (matrix_chat). */
  chat: "chat",
  /** Slack "<teamId>/<channelId>" (slack_bridge). */
  channel: "channel",
} as const;
export type BrainRefKind = (typeof BRAIN_REF_KINDS)[keyof typeof BRAIN_REF_KINDS];

/** Person ref values: "<prefix>:<identity>", all lowercase except where noted; at most 256 characters. */
export const BRAIN_PERSON_KEY_PREFIXES = ["email", "github", "linear", "slack", "matrix", "name"] as const;
export type BrainPersonKeyPrefix = (typeof BRAIN_PERSON_KEY_PREFIXES)[number];
/**
 * email: trimmed, lowercased address. github: lowercased login. linear: user id. slack: "<teamId>/<userId>".
 * matrix: user id. name: NFC, whitespace runs collapsed to one space, trimmed, lowercased (fallback only).
 */
export const BRAIN_PERSON_KEY_PATTERN = /^(?:email|github|linear|slack|matrix|name):[^\s\p{Cc}][^\p{Cc}]{0,249}$/u;
export const BRAIN_ISSUE_KEY_PATTERN = /^(?:[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}|#[1-9][0-9]{0,8})$/;
export const BRAIN_PR_NUMBER_PATTERN = /^[1-9][0-9]{0,8}$/;
export const BRAIN_COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const BRAIN_HANDLE_MAX_CHARS = 64;
export const BRAIN_LABEL_REF_MAX_CHARS = 100;
/** Per-document caps per new ref kind (the store cap of 200 refs per document still applies to the total). */
export const BRAIN_REFS_PER_KIND_MAX = {
  handle: 1, issue: 16, commit: 100, parent: 1, author: 8, reviewer: 16, assignee: 8, attendee: 50,
  participant: 50, label: 20, status: 1, due: 1, starts_at: 1, file: 1, chat: 1, channel: 1,
} as const;

// Citations.

/**
 * The cite of one live document. label, decided in this order: git_pr and git_commit use the git footer
 * (parseBrainGitFooter in why.ts): "#N" or "!N" when it names a pull or merge request, else the first 12 hex of its
 * sha (a git_pr whose footer has no number too); "PR" / "commit" only when there is no footer. Then the document's
 * `handle` ref; then git_spec uses its first `spec` ref; else the title. Cut to BRAIN_CITE_LABEL_MAX_CHARS.
 * brain/cite.ts (brainCiteLabel, loadBrainCites) is the one implementation; brain_why uses it too.
 * permalink: canonical https link or "". date: ISO-8601 source_updated_at. revision: the live revision.
 */
export interface BrainCiteView {
  readonly documentId: string; readonly kind: BrainCiteKind; readonly provenance: string;
  readonly sourceId: string | null; readonly label: string; readonly title: string; readonly permalink: string;
  readonly date: string; readonly revision: number;
}
export const BRAIN_CITE_LABEL_MAX_CHARS = 120;

// Projects.

/** A project id or slug, as the agent tools and every route accept (`:projectId` takes either). */
export const BRAIN_PROJECT_REF_PATTERN = /^(?:proj_[A-Za-z0-9_-]{1,128}|[a-z0-9][a-z0-9-]{0,62})$/;

export interface BrainResolvedProject {
  readonly projectId: string; readonly slug: string; readonly name: string; readonly scope: BrainScopeKey;
}

/**
 * Owner-scoped project lookup shared by every feature service (api/project-resolver.ts, the same rules as
 * api/service.ts resolveProject).
 * resolve: missing, foreign, archived and malformed projects all throw BrainApiError("project_not_found"); a lookup
 * outage throws BrainApiError("brain_unavailable"). checkoutPath: absolute repo checkout inside homePath, or null.
 */
export interface BrainProjectResolver {
  readonly homePath: string;
  resolve(ownerId: string, projectRef: string): Promise<BrainResolvedProject>;
  checkoutPath(ownerId: string, project: BrainResolvedProject): Promise<string | null>;
}

// Paging and time.

/** Every feature cursor is opaque base64url JSON with a version field, at most this long; a bad one is invalid_request. */
export const BRAIN_FEATURE_CURSOR_MAX_CHARS = 512;
export interface BrainCursorPage<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
/** Query dates: "YYYY-MM-DD" (UTC midnight) or an ISO-8601 instant with an offset. Ranges are [from, to). */
export const BRAIN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export interface BrainTimeRange { readonly from: string | null; readonly to: string | null }
/** Lists of filter values travel as one comma-separated query value (exactQuery refuses repeated keys). */
export const BRAIN_QUERY_LIST_MAX_ITEMS = 8;

/** Bounded counters: `count` stops at `cap` and `capped` says there were more. */
export interface BrainCappedCount { readonly count: number; readonly capped: boolean }

// Routes.

/**
 * Every feature exports `createBrain<Feature>Routes(deps)`: a Hono app whose paths start with
 * `/projects/:projectId/`, mounted with `app.route("/api/brain", ...)`. Rules: never `app.use("*", ...)` (middleware
 * of a mounted app leaks to every /api/brain route); set `Cache-Control: private, no-store` per handler; principal
 * first, then service null -> brain_unavailable, then `:projectId` against BRAIN_PROJECT_REF_PATTERN (else
 * project_not_found); query through exactQuery + a strict zod/v4 schema; bodyLimit on every POST, PATCH and DELETE.
 */
export interface BrainFeatureRoutesDeps<TService> {
  /** Null when the brain is off (owner database unavailable or bootstrap deferred): every route answers 503. */
  readonly service: TService | null;
  readonly getPrincipal: (c: Context) => RequestPrincipal;
}

// Errors.

export type BrainFeatureErrorCode =
  | "source_not_found" | "source_conflict" | "source_not_connected" | "source_auth_failed" | "source_config_invalid"
  | "source_kind_unsupported" | "revision_conflict" | "entity_not_found" | "alias_conflict" | "git_ref_not_found"
  | "vector_search_unavailable" | "summary_not_configured" | "job_not_found" | "job_kind_unavailable" | "jobs_full";

/** The only client-facing text for feature errors; never a path, provider message or Postgres detail. */
export const BRAIN_FEATURE_ERRORS: {
  readonly [Code in BrainFeatureErrorCode]: { readonly status: BrainApiErrorStatus; readonly message: string };
} = {
  source_not_found: { status: 404, message: "Source not found" },
  source_conflict: { status: 409, message: "This project already has a different source of that kind" },
  source_not_connected: { status: 409, message: "Connect the account for this source in Settings first" },
  source_auth_failed: { status: 409, message: "The account for this source needs to be reconnected" },
  source_config_invalid: { status: 400, message: "Invalid source settings" },
  source_kind_unsupported: { status: 400, message: "This source kind is not available" },
  revision_conflict: { status: 409, message: "This changed since it was loaded; reload and try again" },
  entity_not_found: { status: 404, message: "Entity not found" },
  alias_conflict: { status: 409, message: "That alias belongs to another entity" },
  git_ref_not_found: { status: 404, message: "Branch or commit not found" },
  vector_search_unavailable: { status: 409, message: "Meaning search is not available" },
  summary_not_configured: { status: 409, message: "Brief summaries are turned off" },
  job_not_found: { status: 404, message: "Run not found" },
  job_kind_unavailable: { status: 409, message: "This kind of run is not available" },
  jobs_full: { status: 409, message: "Too many runs are waiting; try again later" },
};

/** Every code a /api/brain route can answer with; the body is always `{ error: { code, message } }`. */
export type BrainAnyErrorCode = BrainApiErrorCode | BrainFeatureErrorCode;
export interface BrainFeatureErrorBody {
  readonly error: { readonly code: BrainAnyErrorCode; readonly message: string };
}

/** Store errors inside feature services (BRAIN_STORE_ERROR_API_CODES is git-specific; features use this). */
export const BRAIN_FEATURE_STORE_ERROR_CODES: { readonly [Code in BrainStoreErrorCode]: BrainAnyErrorCode } = {
  invalid: "invalid_request", not_found: "source_not_found", forbidden: "revision_conflict",
  conflict: "revision_conflict", capacity: "brain_capacity",
};

/**
 * Thrown by feature services for feature codes (existing codes keep BrainApiError). Route mapping order: principal
 * errors, BodyLimitError -> body_too_large, BrainFeatureError, BrainApiError, BrainStoreError (via
 * BRAIN_FEATURE_STORE_ERROR_CODES), ZodError / SyntaxError -> invalid_request, anything else -> logged by name,
 * brain_unavailable. The message never varies; the code is the only detail that leaves the gateway.
 */
export class BrainFeatureError extends Error {
  constructor(readonly code: BrainFeatureErrorCode, options?: ErrorOptions) {
    super("Company brain request failed", options);
    this.name = "BrainFeatureError";
  }
}
