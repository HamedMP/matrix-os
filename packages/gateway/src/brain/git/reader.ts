/**
 * Company Brain git adapter: bounded, read-only git I/O.
 *
 * `defaultGitRunner` runs `git` through execFile with an argv array (never a
 * shell), a scrubbed environment, a timeout, a maxBuffer and buffer output.
 * `openGitRepository` accepts only a checkout that is its own top level and
 * whose real path and git directories pass containment.ts, then returns a
 * GitRepository whose methods each run one bounded command (prefixed with
 * GIT_GLOBAL_ARGS) and parse it with parse.ts. Only local objects and refs
 * are read: no fetch, no working tree, never HEAD. Failures surface as
 * GitSourceError codes; stderr goes to server logs only, capped.
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertGitDirectoriesAllowed, assertInputPath, homeBounds, isStrictlyInside, realDirectory } from "./containment.js";
import {
  isIndexablePath,
  isSafeBranchName,
  isSupportedGitVersion,
  parseCommitMetadata,
  parseCount,
  parseGitVersion,
  parseLsTree,
  parseNameStatusLog,
  parseRevParseInfo,
  parseShaLines,
} from "./parse.js";
import {
  GIT_COMMIT_MESSAGE_MAX_BYTES,
  GIT_COMMIT_PATHS_MAX_BYTES,
  GIT_DEFAULT_BRANCH_FALLBACKS,
  GIT_ENV_OVERRIDES,
  GIT_GLOBAL_ARGS,
  GIT_LOG_MAX_BYTES,
  GIT_LS_TREE_MAX_BYTES,
  GIT_MAX_SPEC_FILES_PER_WINDOW,
  GIT_NAME_STATUS_MAX_BYTES,
  GIT_REMOTE_URL_MAX_CHARS,
  GIT_SHA_PATTERN,
  GIT_SMALL_OUTPUT_MAX_BYTES,
  GIT_SPEC_FILE_MAX_BYTES,
  GIT_STDERR_MAX_BYTES,
  GIT_SYNC_LIMIT_CEILINGS,
  GitRunnerError,
  GitSourceError,
  type GitCommitChanges,
  type GitCommitMetadata,
  type GitCommitRange,
  type GitCommitRecord,
  type GitObjectFormat,
  type GitReadCommitsOptions,
  type GitRepository,
  type GitResolvedTip,
  type GitRunResult,
  type GitRunner,
  type GitRunnerFailure,
  type GitSyncErrorCode,
  type GitTreeEntry,
  type GitVersion,
  type OpenGitRepositoryInput,
} from "./types.js";

const LOG_PREFIX = "[brain-git]";
const LOG_STDERR_MAX_CHARS = 500;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";
const FALLBACK_HOME = "/nonexistent";
const ORIGIN_REMOTE_PREFIX = "refs/remotes/origin/";
const METADATA_FORMAT = "--format=%H%x1f%P%x1f%cI%x1f%aI%x1f%an%x1f%B";
const NAME_STATUS_FLAGS: readonly string[] = [
  "--diff-merges=first-parent", "--root", "--no-renames", "--no-ext-diff", "--no-textconv",
  "--no-relative", "--no-color", "--no-show-signature", "-z", "--name-status", "--format=%H",
];
const RUNNER_FAILURE_CODES: Readonly<Record<GitRunnerFailure, GitSyncErrorCode>> = {
  timeout: "git_timeout", output_too_large: "git_output_too_large", spawn_failed: "git_unavailable",
};
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Only absolute PATH entries: the child starts in the repository, so an empty
 * or relative entry would find a `git` file committed at its root.
 */
function childPath(): string {
  const entries = (process.env.PATH ?? "").split(":").filter((entry) => entry !== "" && isAbsolute(entry));
  return entries.length > 0 ? entries.join(":") : FALLBACK_PATH;
}

function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: childPath(), HOME: process.env.HOME ?? FALLBACK_HOME, ...GIT_ENV_OVERRIDES };
}

/** A non-zero exit resolves; only timeout, overflow ("fail") and spawn failures reject. */
export const defaultGitRunner: GitRunner = (args, options) => new Promise<GitRunResult>((resolve, reject) => {
  execFile("git", [...args], {
    cwd: options.cwd, env: gitChildEnv(), timeout: options.timeoutMs, maxBuffer: options.maxBuffer,
    encoding: "buffer", windowsHide: true,
  }, (error, stdout, stderr) => {
    const stderrText = stderrDecoder.decode(stderr.subarray(0, GIT_STDERR_MAX_BYTES));
    if (error === null) {
      resolve({ exitCode: 0, stdout, stderr: stderrText, truncated: false });
    } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      if (options.overflow === "truncate") {
        resolve({ exitCode: null, stdout: stdout.subarray(0, options.maxBuffer), stderr: stderrText, truncated: true });
      } else {
        reject(new GitRunnerError("output_too_large", { cause: error }));
      }
    } else if (error.killed === true) {
      reject(new GitRunnerError("timeout", { cause: error }));
    } else if (typeof error.code === "number") {
      resolve({ exitCode: error.code, stdout, stderr: stderrText, truncated: false });
    } else {
      reject(new GitRunnerError("spawn_failed", { cause: error }));
    }
  });
});

interface ReaderContext {
  readonly runner: GitRunner;
  readonly root: string;
  readonly timeoutMs: number;
}

interface GitCall {
  readonly maxBuffer: number;
  readonly overflow?: "fail" | "truncate";
  /** Exit codes that resolve; null is a truncated read. Default [0]. */
  readonly okExits?: readonly (number | null)[];
}

const SMALL: GitCall = { maxBuffer: GIT_SMALL_OUTPUT_MAX_BYTES };

async function runGit(context: ReaderContext, sub: readonly string[], call: GitCall): Promise<GitRunResult> {
  let result: GitRunResult;
  try {
    result = await context.runner([...GIT_GLOBAL_ARGS, ...sub], {
      cwd: context.root, timeoutMs: context.timeoutMs, maxBuffer: call.maxBuffer, overflow: call.overflow ?? "fail",
    });
  } catch (err: unknown) {
    if (!(err instanceof GitRunnerError)) throw err;
    console.warn(`${LOG_PREFIX} git runner failed`, { subcommand: sub[0], failure: err.failure });
    throw new GitSourceError(RUNNER_FAILURE_CODES[err.failure], { cause: err });
  }
  if (!(call.okExits ?? [0]).includes(result.exitCode)) {
    logExit("git command failed", sub, result);
    throw new GitSourceError("git_command_failed");
  }
  return result;
}

function logExit(message: string, sub: readonly string[], result: GitRunResult): void {
  console.warn(`${LOG_PREFIX} ${message}`, {
    subcommand: sub[0], exitCode: result.exitCode, stderr: result.stderr.slice(0, LOG_STDERR_MAX_CHARS),
  });
}

function malformed(): never {
  throw new GitSourceError("git_output_malformed");
}

/** A caller passed something the adapter itself should have validated. */
function callerBug(): never {
  throw new GitSourceError("internal_error");
}

function gitTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitSourceError("invalid_options");
  return Math.min(value, GIT_SYNC_LIMIT_CEILINGS.gitTimeoutMs);
}

const REPO_INFO_ARGS: readonly string[] = [
  "rev-parse", "--is-shallow-repository", "--show-object-format", "--show-toplevel",
  "--absolute-git-dir", "--path-format=absolute", "--git-common-dir",
];
