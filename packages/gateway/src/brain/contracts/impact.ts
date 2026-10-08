/**
 * Company Brain feature contract, part 7: the impact brief of a branch or base..head range in a project checkout.
 * Git is read with the git adapter's runner and containment (openGitRepository, defaultGitRunner, GIT_GLOBAL_ARGS);
 * commands the adapter lacks (name-status diff, recursive ls-tree, blob reads by path) live in impact/ and use the
 * same runner, argv rules, timeouts and output bounds. Types and constants only.
 */
import type { BrainClaimKind } from "../claims/types.js";
import type { GitRunner } from "../git/types.js";
import type { BrainRepository } from "../repository.js";
import type { BrainCiteView, BrainProjectResolver } from "./common.js";

export const BRAIN_IMPACT_LIMITS = {
  changedFilesMax: 500,
  /** Files whose imports are scanned (TS/JS sources at head), and bytes per file and per request. */
  scannedFilesMax: 5_000, fileReadMaxBytes: 262_144, readBytesPerRequest: 32 * 1024 * 1024,
  /** depthDefault 2: depth-2 files fill the dependents slots depth-1 files leave; depth=1 lists direct importers only. */
  dependentsMax: 300, depthDefault: 2, depthMax: 2,
  /** Earlier PRs per changed file and files reported with earlier PRs. */
  priorPerFile: 3, filesWithPriorMax: 50,
  claimsPerKindMax: 50, specsMax: 20, untestedMax: 100,
  gitTimeoutMs: 15_000, runBudgetMs: 20_000,
  /** GitHub comment bodies stop at 65,536 characters; the formatter stays under this. */
  commentMaxChars: 60_000,
} as const;
/** base / head: a short branch name (GIT_BRANCH_NAME_PATTERN) or a full or 7..40 hex abbreviated commit sha. */
export const BRAIN_IMPACT_REV_MAX_CHARS = 200;

/** head: required. base: default the default branch (origin/HEAD, main, master). The diff is merge-base(base, head)..head. */
export interface BrainImpactQuery {
  readonly head: string; readonly base?: string; readonly depth?: 1 | 2;
}

export type BrainImpactChangeStatus = "added" | "modified" | "deleted" | "renamed" | "type_changed";

export interface BrainImpactChangedFile {
  readonly path: string; readonly status: BrainImpactChangeStatus; readonly previousPath: string | null;
  readonly isTest: boolean;
}

/**
 * A file that imports a changed file, directly (depth 1) or through one more file (depth 2). Approximate: static
 * import / export-from / require / dynamic import with a string literal; relative paths, index files, .js -> .ts /
 * .tsx mapping and workspace package names from package.json "name" and "exports". Ranked by depth, then by how many
 * files of the ring before it imports (changed files at depth 1, depth-1 files at depth 2), then by path. via: the
 * first changed file in path order (depth 1) or the best-ranked depth-1 file.
 */
export interface BrainImpactDependent {
  readonly path: string; readonly depth: 1 | 2; readonly via: string;
}

/** Importing files found per depth before the dependents cap; depth2 is null when the query asked for depth 1. */
export interface BrainImpactDependentTotals { readonly depth1: number; readonly depth2: number | null }

export interface BrainImpactPrior { readonly path: string; readonly items: readonly BrainCiteView[] }

/** A current invariant or decision claim of a document whose path refs touch a changed file. */
export interface BrainImpactClaim {
  readonly claimId: string; readonly kind: Extract<BrainClaimKind, "invariant" | "decision">;
  readonly label: string | null; readonly statement: string; readonly quote: string;
  readonly paths: readonly string[]; readonly cite: BrainCiteView;
}

/** A changed non-test source file with no changed test in its folder, its package's tests/ or a matching name. */
export interface BrainImpactUntested { readonly path: string }

/** cite: the spec's newest git_spec document, null when the brain has none yet. */
export interface BrainImpactSpec {
  readonly spec: string; readonly changedPaths: readonly string[]; readonly cite: BrainCiteView | null;
}

/**
 * Every list cut at its cap says so: prior_capped (earlier pull requests not looked up for every changed file, or more
 * files have them than are listed), claims_capped (more invariants or decisions, or more changed paths per claim),
 * untested_capped and specs_capped (more folders, or more changed paths per folder).
 */
export type BrainImpactNotice =
  | "changed_files_capped" | "dependents_capped" | "scan_capped" | "read_budget_exhausted" | "run_budget_exhausted"
  | "prior_capped" | "claims_capped" | "untested_capped" | "specs_capped" | "no_git_source" | "brain_behind_head";

/** approximate: always true for dependents; stated so every consumer shows it. */
export interface BrainImpactView {
  readonly base: { readonly ref: string; readonly sha: string };
  readonly head: { readonly ref: string; readonly sha: string };
  readonly mergeBase: string;
  readonly changedFiles: readonly BrainImpactChangedFile[]; readonly changedTotal: number;
  readonly dependents: readonly BrainImpactDependent[]; readonly dependentTotals: BrainImpactDependentTotals;
  readonly approximate: true;
  readonly prior: readonly BrainImpactPrior[];
  readonly invariants: readonly BrainImpactClaim[]; readonly decisions: readonly BrainImpactClaim[];
  readonly untested: readonly BrainImpactUntested[];
  readonly specs: readonly BrainImpactSpec[];
  readonly notices: readonly BrainImpactNotice[];
}

/** GET /impact/comment answers { markdown }: the formatter output, never posted anywhere by the gateway. */
export interface BrainImpactCommentView { readonly markdown: string; readonly truncated: boolean }

/** Pure; Markdown under commentMaxChars, every claim and PR line linked to its permalink when it has one. */
export type BrainImpactCommentFormatter = (view: BrainImpactView) => BrainImpactCommentView;

export interface BrainImpactServiceDeps {
  readonly repository: BrainRepository; readonly resolver: BrainProjectResolver;
  /** Default: git/reader.ts defaultGitRunner. */
  readonly runner?: GitRunner;
  readonly now?: () => number;
}

/**
 * Read-only: no fetch, no checkout, no working tree; local objects only. Errors: project_not_found,
 * checkout_unavailable, git_ref_not_found, invalid_request.
 */
export interface BrainImpactService {
  impact(ownerId: string, projectRef: string, query: BrainImpactQuery): Promise<BrainImpactView>;
  comment(ownerId: string, projectRef: string, query: BrainImpactQuery): Promise<BrainImpactCommentView>;
}
