/**
 * Company Brain git source adapter: shared types, limits and error classes.
 * The contract between reader.ts / parse.ts (bounded git I/O, pure parsers),
 * permalinks.ts / documents.ts / specs.ts / batches.ts (pure mapping), sync.ts
 * (orchestration) and the tests. Store limits that already exist are imported
 * from ../index.js by the adapter modules; the GIT_* ref limits mirror the
 * brain_document_refs limits and a test asserts they never exceed them.
 */
import type { BrainRepository } from "../repository.js";
import type { BrainScopeKey, BrainSyncCounts, BrainSyncReceipt } from "../types.js";

// Source identity and provenance.

/** `brain_sources.kind` for every git source. */
export const GIT_SOURCE_KIND = "git";
/** First element of every document identity tuple; bump only with a migration plan. */
export const GIT_DOCUMENT_ID_VERSION = "brain_git_v1";

export type GitProvenance = "git_pr" | "git_commit" | "git_spec";
export const GIT_PROVENANCE = {
  pullRequest: "git_pr", commit: "git_commit", spec: "git_spec",
} as const satisfies Record<string, GitProvenance>;

// The git binary and how it is invoked.

/** --diff-merges=first-parent needs 2.31; GIT_CONFIG_GLOBAL needs 2.32. */
export const GIT_MIN_VERSION = { major: 2, minor: 32 } as const;

/**
 * Prepended by reader.ts to every git argv (the runner receives the full argv
 * after the binary name). Repo-local config can still be read, so every
 * setting that could run a program, page, sign, rewrite history or touch the
 * network is pinned here; diff-producing commands also pass --no-ext-diff and
 * --no-textconv.
 */
export const GIT_GLOBAL_ARGS: readonly string[] = [
  "--no-pager", "--no-replace-objects", "--literal-pathspecs", "--no-optional-locks",
  "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
  "-c", "log.showSignature=false", "-c", "log.showRoot=true", "-c", "log.mailmap=false",
  "-c", "diff.renames=false", "-c", "i18n.logOutputEncoding=UTF-8", "-c", "color.ui=false",
  "-c", "protocol.allow=never",
];

/**
 * The child environment: HOME, the absolute PATH entries of the gateway and
 * these overrides; no inherited GIT_* variable passes. GIT_ALLOW_PROTOCOL
 * blocks every transport even where a repo-local `protocol.<name>.allow`
 * overrides `protocol.allow=never`, lazy fetches on git < 2.45 included.
 */
export const GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat", PAGER: "cat", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "none",
  GIT_ATTR_NOSYSTEM: "1", GIT_ADVICE: "0",
};

export type GitObjectFormat = "sha1" | "sha256";
export const GIT_SHA_PATTERN: Readonly<Record<GitObjectFormat, RegExp>> = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };
/** Commit-document titles fall back to `Commit <first 12 hex>`. */
export const GIT_SHORT_SHA_LENGTH = 12;

// Output bounds per git call (bytes of stdout unless noted).

export const GIT_STDERR_MAX_BYTES = 4_096;
/** version, rev-parse, symbolic-ref, config, merge-base, rev-list --count / --skip. */
export const GIT_SMALL_OUTPUT_MAX_BYTES = 64 * 1024;
/** One window's metadata log (`%B` included). Overflow falls back to per-commit reads. */
export const GIT_LOG_MAX_BYTES = 16 * 1024 * 1024;
/** One window's --name-status log. Overflow falls back to per-commit reads. */
export const GIT_NAME_STATUS_MAX_BYTES = 16 * 1024 * 1024;
/** Per-commit fallback for one message; read with overflow "truncate". */
export const GIT_COMMIT_MESSAGE_MAX_BYTES = 256 * 1024;
/** Per-commit fallback for one commit's paths; read with overflow "truncate". */
export const GIT_COMMIT_PATHS_MAX_BYTES = 1024 * 1024;
/** One `ls-tree` of at most GIT_MAX_SPEC_FILES_PER_WINDOW exact paths (one entry each). */
export const GIT_LS_TREE_MAX_BYTES = 1024 * 1024;
export const GIT_REMOTE_URL_MAX_CHARS = 2_048;
export const GIT_AUTHOR_NAME_MAX_CHARS = 200;

// Run, window and batch limits. Callers may lower (never raise past the
// ceiling) any of these per call; sync.ts clamps to [1, ceiling].

export interface GitSyncLimits {
  /** First-parent commits applied per syncGitSource call; the rest wait for the next run. */
  readonly commitsPerRun: number;
  /** First-parent commits read and applied as one cursor step. */
  readonly commitsPerWindow: number;
  /** Upserts per applySyncBatch call (store hard cap: BRAIN_SYNC_BATCH_MAX_ITEMS). */
  readonly upsertsPerBatch: number;
  /** Refs across all upserts of one applySyncBatch call (store hard cap: 10_000). */
  readonly refsPerBatch: number;
  /** Timeout of every single git process. */
  readonly gitTimeoutMs: number;
  /** Wall-clock budget; checked before each window, a started window always finishes. */
  readonly runBudgetMs: number;
}

export const GIT_SYNC_DEFAULT_LIMITS: GitSyncLimits = {
  commitsPerRun: 1_000, commitsPerWindow: 50, upsertsPerBatch: 100,
  refsPerBatch: 5_000, gitTimeoutMs: 15_000, runBudgetMs: 120_000,
};

export const GIT_SYNC_LIMIT_CEILINGS: GitSyncLimits = {
  commitsPerRun: 10_000, commitsPerWindow: 100, upsertsPerBatch: 200,
  refsPerBatch: 10_000, gitTimeoutMs: 60_000, runBudgetMs: 600_000,
};

/** In-process syncs at once (one per source key); a Set with this cap guards re-entry. */
export const GIT_MAX_CONCURRENT_SYNCS = 16;
/** Rejected document ids echoed in GitSyncResult. */
export const GIT_MAX_REJECTED_IDS_IN_RESULT = 100;

// Document shaping.

/** Mirrors BRAIN_DOCUMENT_REFS_MAX. */
export const GIT_MAX_REFS_PER_DOCUMENT = 200;
/** Mirrors BRAIN_REF_VALUE_MAX_BYTES; longer paths are dropped and counted. */
export const GIT_REF_VALUE_MAX_BYTES = 512;
export const GIT_MAX_PR_REFS_PER_DOCUMENT = 8;
export const GIT_MAX_SPEC_REFS_PER_DOCUMENT = 16;
/** The parser keeps at most this many paths per commit and counts the rest. */
export const GIT_MAX_PATHS_PER_COMMIT = GIT_MAX_REFS_PER_DOCUMENT;
export const GIT_PR_NUMBER_MAX = 999_999_999;
/** Appended (inside the byte budget) wherever text was cut. */
export const GIT_TRUNCATION_MARKER =
  "\n\n[Truncated: the rest of this text is over the Company Brain document size limit.]";

// Spec files.

/** Each matching file is its own document set; a folder of spec folders (`specs`) is never a spec folder itself. */
export const GIT_DEFAULT_SPEC_GLOBS: readonly string[] = [
  "specs/*/spec.md", "specs/*/plan.md", "specs/*/research.md", "specs/*/data-model.md", "specs/*/quickstart.md",
  "specs/*.md",
];
export const GIT_MAX_SPEC_GLOBS = 8;
export const GIT_SPEC_GLOB_MAX_CHARS = 200;
/**
 * A literal first segment, then up to seven segments with at most one `*`
 * each (matching within the segment, so matching is linear in the path).
 * parse.ts `isValidSpecGlob` also rejects `.` and `..` segments.
 */
export const GIT_SPEC_GLOB_PATTERN =
  /^[A-Za-z0-9._-]+(?:\/(?:[A-Za-z0-9._-]+|[A-Za-z0-9._-]*\*[A-Za-z0-9._-]*)){0,7}$/;
export const GIT_MAX_SPEC_PARTS = 8;
/** Body bytes per spec part; leaves room for a 300-char title under 65_536. */
export const GIT_SPEC_PART_MAX_BYTES = 60_000;
/** Larger blobs are not read; they get one stub document. Fits GIT_MAX_SPEC_PARTS hard splits. */
export const GIT_SPEC_FILE_MAX_BYTES = 400_000;
/** Spec paths per window (sorted; the rest wait until touched again), and per `ls-tree` argv (about 256 KiB). */
export const GIT_MAX_SPEC_FILES_PER_WINDOW = 500;
/** The `# ` title line must start within this many bytes of the file. */
export const GIT_SPEC_TITLE_SCAN_BYTES = 4_096;

// Branches.

export const GIT_BRANCH_NAME_MAX_CHARS = 200;
/** A short branch name (`main`, `release/1.2`); never `HEAD`, never `refs/...`. */
export const GIT_BRANCH_NAME_PATTERN =
  /^(?![-/.])(?!HEAD$)(?!refs\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
/** Tried, in order, when no branch is configured and origin/HEAD is unset. */
export const GIT_DEFAULT_BRANCH_FALLBACKS: readonly string[] = ["main", "master"];
