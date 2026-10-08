/**
 * Company Brain HTTP API and agent tool contract: limits, project scope
 * recipe, response shapes, the service interface and the one error class the
 * routes map. why.ts, api/service.ts, api/routes.ts, api/agent-tools.ts and
 * the tests depend on this file; the kernel's brain_why tool mirrors the
 * BrainWhy* shapes structurally (packages/kernel/src/tools/brain-why.ts).
 */
import type { createProjectManager } from "../../project-manager.js";
import type { BrainClaimModelProvider } from "../claims/model/types.js";
import type { BrainExtractionLimits, BrainExtractionOptions, BrainExtractionResult } from "../claims/types.js";
import type {
  GitSyncErrorCode,
  GitSyncInfoCode,
  GitSyncLimits,
  GitSyncNextAction,
  GitSyncNotice,
  GitSyncOptions,
  GitSyncResult,
  GitSyncStatus,
} from "../git/types.js";
import type { BrainRepository } from "../repository.js";
import type {
  BrainScopeKey,
  BrainSourceStatus,
  BrainStoreErrorCode,
  BrainSyncCounts,
  BrainSyncReceiptStatus,
} from "../types.js";
import type { BrainClaimsQuery, BrainClaimsView, BrainExtractInput, BrainExtractView } from "./claims-types.js";

// Projects and scopes.

/** Same shape as project-manager.ts ProjectIdSchema. */
export const BRAIN_PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9_-]{1,128}$/;
/** Same shape as project-registry.ts PROJECT_SLUG_REGEX (the agent tool may pass a slug). */
export const BRAIN_PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Personal project scopes: `personal:project:<projectId>`, owned by the request principal. */
export const BRAIN_PROJECT_SCOPE_PREFIX = "personal:project:";
/** Opaque git source identity when no explicit https base is known: `project:<projectId>`. */
export const BRAIN_PROJECT_IDENTITY_PREFIX = "project:";

/** The brain scope of one Matrix project for its owner. The owner id never goes into scopeId. */
export function brainProjectScope(ownerId: string, projectId: string): BrainScopeKey {
  return { ownerId, scopeId: `${BRAIN_PROJECT_SCOPE_PREFIX}${projectId}` };
}

// Limits.

export const BRAIN_WHY_DEFAULT_LIMIT = 10;
export const BRAIN_WHY_MAX_LIMIT = 50;
/** `total` counts at most this many matching documents; `totalCapped` says there were more. */
export const BRAIN_WHY_TOTAL_CAP = 1_000;
export const BRAIN_WHY_CURSOR_MAX_CHARS = 256;
/** Raw `path` input before normalization; the normalized path must also be an indexable ref value (<= 512 bytes). */
export const BRAIN_WHY_PATH_INPUT_MAX_CHARS = 1_024;
/** UTF-16 units per Summary or Invariants excerpt. */
export const BRAIN_WHY_EXCERPT_MAX_CHARS = { brief: 480, full: 4_000 } as const;
export const BRAIN_WHY_SPECS_MAX = { brief: 4, full: 16 } as const;
export const BRAIN_WHY_MATCHED_PATHS_MAX = { brief: 3, full: 20 } as const;
/** Commit labels show this many hex characters (the git adapter's fallback titles use the same length). */
export const BRAIN_WHY_SHORT_SHA_LENGTH = 12;

export const BRAIN_RECEIPTS_DEFAULT_LIMIT = 10;
/** Equals BRAIN_RECEIPTS_PER_SOURCE: the store keeps no more. */
export const BRAIN_RECEIPTS_MAX_LIMIT = 50;
/** Sources read when looking for a project scope's git source (one is expected). */
export const BRAIN_SOURCES_SCAN_LIMIT = 100;
/** Equals BRAIN_SOURCE_EXTERNAL_REF_MAX_CHARS. */
export const BRAIN_WEB_BASE_MAX_CHARS = 512;

export const BRAIN_GIT_SOURCE_BODY_MAX_BYTES = 4 * 1024;
export const BRAIN_SYNC_BODY_MAX_BYTES = 1024;

/** One sync run per request, kept well under the 300 s Node request timeout; the client repeats on run_again. */
export const BRAIN_REQUEST_SYNC_LIMITS = {
  commitsPerRun: 500,
  runBudgetMs: 20_000,
} as const satisfies Partial<GitSyncLimits>;

// Git source and sync views.

export interface BrainGitSourceView {
  readonly sourceId: string;
  readonly label: string;
  /** An https web base, or `project:<projectId>` when the base comes from the origin remote on every run. */
  readonly externalRef: string;
  /** parseWebBase(externalRef)?.href, else null. */
  readonly webBase: string | null;
  readonly status: BrainSourceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrainRegisterGitSourceInput {
  /** Explicit canonical https base (parseWebBase); omitted: the project's GitHub page, else `project:<id>`. */
  readonly webBase?: string;
}

export interface BrainRegisterGitSourceResult {
  readonly source: BrainGitSourceView;
  readonly created: boolean;
}

export interface BrainReceiptView {
  readonly receiptId: string;
  readonly status: BrainSyncReceiptStatus;
  readonly counts: BrainSyncCounts;
  readonly nextAction: string;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface BrainReceiptsView {
  readonly source: BrainGitSourceView | null;
  readonly receipts: readonly BrainReceiptView[];
}

/** One bounded syncGitSource run. Cursors, rejected ids and paths are not echoed. */
export interface BrainSyncView {
  readonly status: GitSyncStatus;
  readonly errorCode: GitSyncErrorCode | GitSyncInfoCode | null;
  readonly nextAction: GitSyncNextAction;
  readonly caughtUp: boolean;
  readonly commitsProcessed: number;
  readonly commitsRemaining: number;
  readonly counts: BrainSyncCounts;
  readonly notices: readonly GitSyncNotice[];
  readonly receipt: BrainReceiptView | null;
}

// brain_why.

export type BrainWhyDetail = "brief" | "full";
/** No trailing "/": the path itself or anything under it. Trailing "/": only under it. */
export type BrainWhyMatch = "file_or_folder" | "folder";
/** From provenance: git_pr, git_commit, git_spec. */
export type BrainWhyKind = "pr" | "commit" | "spec";
/**
 * How a pull request item got its number. explicit: a forge merge message
 * (`Merge pull request #N from ...`, `See merge request ...!N`). inferred: the
 * ` (#N)` subject suffix of a squash or titled merge, which the git adapter
 * treats as a heuristic. none: commit and spec items.
 */
export type BrainWhyLink = "explicit" | "inferred" | "none";

export interface BrainWhyExcerpt {
  /** The heading as written ("Summary", "Validation and invariants"); null for the lead-paragraph fallback. */
  readonly heading: string | null;
  /** Verbatim section text without the heading line or surrounding blank lines, cut to the detail bound. */
  readonly text: string;
  readonly truncated: boolean;
}

export interface BrainWhyItem {
  readonly documentId: string;
  readonly kind: BrainWhyKind;
  /** The shared cite label (brain/cite.ts): `#12`, `!12` (GitLab), a short sha, or a spec's first spec ref. */
  readonly label: string;
  /** Pull or merge request number; null for commit and spec items. */
  readonly number: number | null;
  /** Full commit sha from the document footer; null for spec items. */
  readonly sha: string | null;
  readonly title: string;
  /** ISO-8601 committer date (source_updated_at). */
  readonly date: string;
  /** Canonical https link, or "" when the document has none. */
  readonly permalink: string;
  readonly link: BrainWhyLink;
  readonly summary: BrainWhyExcerpt | null;
  readonly invariants: BrainWhyExcerpt | null;
  /** Spec directories the document references, at most BRAIN_WHY_SPECS_MAX[detail]. */
  readonly specs: readonly string[];
  /** Path refs that matched the query, at most BRAIN_WHY_MATCHED_PATHS_MAX[detail]. */
  readonly matchedPaths: readonly string[];
  /** Every matching path ref of the document (at most 200, the per-document ref cap). */
  readonly matchedPathCount: number;
}

export interface BrainWhyQuery {
  /** Repo-relative file or folder; one trailing "/" means folder only. */
  readonly path: string;
  readonly limit?: number;
  /** Opaque, from a previous page. */
  readonly cursor?: string | null;
  readonly detail?: BrainWhyDetail;
}

/** Newest first by committer date, then document id. */
export interface BrainWhyPage {
  /** Normalized: no trailing "/". */
  readonly path: string;
  readonly match: BrainWhyMatch;
  readonly detail: BrainWhyDetail;
  readonly total: number;
  readonly totalCapped: boolean;
  readonly items: readonly BrainWhyItem[];
  readonly nextCursor: string | null;
}

export interface BrainWhyLastSync {
  readonly status: BrainSyncReceiptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly nextAction: string;
  readonly errorCode: string | null;
}

export interface BrainWhySourceState {
  readonly sourceId: string;
  readonly webBase: string | null;
  /** The newest receipt; null when the source was never synced. */
  readonly lastSync: BrainWhyLastSync | null;
}

export interface BrainWhyResult extends BrainWhyPage {
  /** Null when the project has no git source yet (items is then empty). */
  readonly source: BrainWhySourceState | null;
}

// Service.

export type BrainProjectLookup = Pick<
  ReturnType<typeof createProjectManager>,
  "getProjectById" | "getProject" | "resolveProjectWorkingDirectory"
>;

export type BrainGitSync = (options: GitSyncOptions) => Promise<GitSyncResult>;

export interface BrainProjectServiceDeps {
  readonly repository: BrainRepository;
  readonly projects: BrainProjectLookup;
  /** Resolved Matrix home; the same value the project manager was built with. */
  readonly homePath: string;
  /** Default: syncGitSource. */
  readonly sync?: BrainGitSync;
  /** Default: BRAIN_REQUEST_SYNC_LIMITS. */
  readonly syncLimits?: Partial<GitSyncLimits>;
  /** Default: runBrainExtraction. */
  readonly extract?: (options: BrainExtractionOptions) => Promise<BrainExtractionResult>;
  /** Default: BRAIN_REQUEST_EXTRACTION_LIMITS (rules runs; a model run takes its limits from claimModels). */
  readonly extractionLimits?: Partial<BrainExtractionLimits>;
  /** Default: none (model extraction is 409); startBrainProjectService supplies the Anthropic provider. */
  readonly claimModels?: BrainClaimModelProvider;
  /**
   * Principals that may run the model extractor (the gateway owner, whose Anthropic key it uses); any other principal
   * gets extractor_not_configured and modelSpend null. Absent: every principal (startBrainServices always sets it).
   */
  readonly modelOwnerIds?: readonly string[];
  /**
   * The model spend cap per owner over 30 days (MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D) that GET .../claims
   * reports in modelSpend; absent: modelSpend is null. startBrainProjectService sets it with its default provider.
   */
  readonly modelSpendCapMicroUsd?: number;
}
