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
