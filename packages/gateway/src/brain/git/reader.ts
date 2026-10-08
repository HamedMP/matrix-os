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

/**
 * Opens a checkout strictly inside the Matrix home (never home itself, never
 * a subdirectory of a repository, never a git directory outside home or in
 * home's own `.git`), on git >= GIT_MIN_VERSION, not shallow.
 */
export async function openGitRepository(input: OpenGitRepositoryInput): Promise<GitRepository> {
  assertInputPath(input.repoPath);
  assertInputPath(input.homePath);
  const timeoutMs = gitTimeoutMs(input.limits.gitTimeoutMs);
  const bounds = await homeBounds(input.homePath);
  const realRepo = await realDirectory(input.repoPath);
  if (!isStrictlyInside(bounds.realHome, realRepo)) throw new GitSourceError("not_a_repository");
  const context: ReaderContext = { runner: input.runner, root: realRepo, timeoutMs };
  const version = parseGitVersion((await runGit(context, ["version"], SMALL)).stdout) ?? malformed();
  if (!isSupportedGitVersion(version)) throw new GitSourceError("git_version_unsupported");
  const info = await runGit(context, REPO_INFO_ARGS, { ...SMALL, okExits: [0, 128] });
  if (info.exitCode === 128) {
    logExit("not a repository", REPO_INFO_ARGS, info);
    throw new GitSourceError("not_a_repository");
  }
  const parsed = parseRevParseInfo(info.stdout);
  if ((await realDirectory(parsed.toplevel)) !== realRepo) throw new GitSourceError("not_a_repository");
  await assertGitDirectoriesAllowed(bounds, parsed);
  if (parsed.shallow) throw new GitSourceError("shallow_repository");
  return createRepository(context, version, parsed.objectFormat);
}

function createRepository(context: ReaderContext, version: GitVersion, objectFormat: GitObjectFormat): GitRepository {
  const shaPattern = GIT_SHA_PATTERN[objectFormat];
  const sha = (value: string): string => (typeof value === "string" && shaPattern.test(value) ? value : callerBug());
  const rangeArg = (range: GitCommitRange): string => (range.from === null ? sha(range.to) : `${sha(range.from)}..${sha(range.to)}`);
  const git = (sub: readonly string[], call: GitCall = SMALL): Promise<GitRunResult> => runGit(context, sub, call);

  async function resolveRef(ref: string): Promise<string | null> {
    const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
    const result = await git(args, { ...SMALL, okExits: [0, 1, 128] });
    if (result.exitCode !== 0) return null;
    const lines = parseShaLines(result.stdout, shaPattern);
    return lines.length === 1 ? lines[0] : malformed();
  }

  async function originHeadBranch(): Promise<string | null> {
    const result = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { ...SMALL, okExits: [0, 1, 128] });
    if (result.exitCode !== 0) return null;
    const target = textDecoder.decode(result.stdout).split("\n")[0].trim();
    if (!target.startsWith(ORIGIN_REMOTE_PREFIX)) return null;
    const branch = target.slice(ORIGIN_REMOTE_PREFIX.length);
    return isSafeBranchName(branch) ? branch : null;
  }

  async function tipCandidates(branch: string | null): Promise<string[]> {
    if (branch !== null) {
      if (!isSafeBranchName(branch)) throw new GitSourceError("invalid_options");
      return [`${ORIGIN_REMOTE_PREFIX}${branch}`, `refs/heads/${branch}`];
    }
    const candidates: string[] = [];
    const originHead = await originHeadBranch();
    if (originHead !== null) candidates.push(`${ORIGIN_REMOTE_PREFIX}${originHead}`);
    for (const fallback of GIT_DEFAULT_BRANCH_FALLBACKS) {
      for (const ref of [`${ORIGIN_REMOTE_PREFIX}${fallback}`, `refs/heads/${fallback}`]) {
        if (!candidates.includes(ref)) candidates.push(ref);
      }
    }
    return candidates;
  }

  /** The window log, or per-commit reads (overflow "truncate") when it is over its cap. */
  async function readPerWindowOrCommit<T extends { sha: string }>(
    windowArgs: readonly string[],
    windowMaxBuffer: number,
    shas: readonly string[],
    commitArgs: (commitSha: string) => readonly string[],
    commitMaxBuffer: number,
    parse: (stdout: Uint8Array, truncated: boolean) => T[],
  ): Promise<T[]> {
    try {
      return parse((await git(windowArgs, { maxBuffer: windowMaxBuffer })).stdout, false);
    } catch (err: unknown) {
      if (!(err instanceof GitSourceError) || err.code !== "git_output_too_large") throw err;
    }
    const records: T[] = [];
    for (const commitSha of shas) {
      const result = await git(commitArgs(commitSha), { maxBuffer: commitMaxBuffer, overflow: "truncate", okExits: [0, null] });
      const parsed = parse(result.stdout, result.truncated);
      if (parsed.length !== 1) malformed();
      records.push(parsed[0]);
    }
    return records;
  }

  return {
    root: context.root,
    objectFormat,
    shaPattern,
    version,

    async resolveTip(branch: string | null): Promise<GitResolvedTip> {
      for (const ref of await tipCandidates(branch)) {
        const resolved = await resolveRef(ref);
        if (resolved !== null) return { ref, sha: resolved };
      }
      throw new GitSourceError("branch_unavailable");
    },

    async readOriginUrl(): Promise<string | null> {
      const result = await git(["config", "--local", "--get", "remote.origin.url"], { ...SMALL, okExits: [0, 1] });
      if (result.exitCode !== 0) return null;
      const url = textDecoder.decode(result.stdout).split("\n")[0].trim();
      if (url === "" || url.length > GIT_REMOTE_URL_MAX_CHARS || URL_CONTROL_CHARS.test(url)) return null;
      return url;
    },

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
      const result = await git(["merge-base", "--is-ancestor", sha(ancestor), sha(descendant)], { ...SMALL, okExits: [0, 1, 128] });
      return result.exitCode === 0;
    },

    async countFirstParent(range: GitCommitRange): Promise<number> {
      return parseCount((await git(["rev-list", "--first-parent", "--count", rangeArg(range), "--"])).stdout);
    },

    async firstParentAt(range: GitCommitRange, skip: number): Promise<string> {
      if (!Number.isSafeInteger(skip) || skip < 0) callerBug();
      const args = ["rev-list", "--first-parent", `--skip=${skip}`, "--max-count=1", rangeArg(range), "--"];
      const lines = parseShaLines((await git(args)).stdout, shaPattern);
      return lines.length === 1 ? lines[0] : malformed();
    },

    async readCommits(range: GitCommitRange, options: GitReadCommitsOptions): Promise<readonly GitCommitRecord[]> {
      const ceiling = GIT_SYNC_LIMIT_CEILINGS.commitsPerWindow;
      const target = rangeArg(range);
      const windowArgs = ["rev-list", "--first-parent", `--max-count=${ceiling + 1}`, target, "--"];
      const shas = parseShaLines((await git(windowArgs)).stdout, shaPattern);
      if (shas.length > ceiling) malformed();
      if (shas.length === 0) return [];
      const metadata: GitCommitMetadata[] = await readPerWindowOrCommit(
        ["log", "--first-parent", "--no-color", "--no-show-signature", "-z", METADATA_FORMAT, target, "--"],
        GIT_LOG_MAX_BYTES,
        shas,
        (commitSha) => ["log", "-1", "--no-color", "--no-show-signature", "-z", METADATA_FORMAT, commitSha, "--"],
        GIT_COMMIT_MESSAGE_MAX_BYTES,
        (stdout, truncated) => parseCommitMetadata(stdout, { shaPattern, truncated }),
      );
      const changes: Array<{ sha: string; changes: GitCommitChanges }> = await readPerWindowOrCommit(
        ["log", "--first-parent", ...NAME_STATUS_FLAGS, target, "--"],
        GIT_NAME_STATUS_MAX_BYTES,
        shas,
        (commitSha) => ["log", "-1", ...NAME_STATUS_FLAGS, commitSha, "--"],
        GIT_COMMIT_PATHS_MAX_BYTES,
        (stdout, truncated) => parseNameStatusLog(stdout, { shaPattern, isSpecPath: options.isSpecPath, truncated }),
      );
      if (metadata.length !== shas.length || changes.length !== shas.length) malformed();
      const records = shas.map((commitSha, index): GitCommitRecord => {
        if (metadata[index].sha !== commitSha || changes[index].sha !== commitSha) malformed();
        return { ...metadata[index], changes: changes[index].changes };
      });
      return records.reverse();
    },

    async listTree(commit: string, paths: readonly string[]): Promise<readonly GitTreeEntry[]> {
      if (paths.length > GIT_MAX_SPEC_FILES_PER_WINDOW || !paths.every(isIndexablePath)) callerBug();
      if (paths.length === 0) return [];
      // Not recursive, and --literal-pathspecs is global: one entry per existing path, whatever it holds.
      const args = ["ls-tree", "-z", "-l", "--full-tree", sha(commit), "--", ...paths];
      return parseLsTree((await git(args, { maxBuffer: GIT_LS_TREE_MAX_BYTES })).stdout, shaPattern);
    },

    async readBlob(oid: string, size: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(size) || size < 0 || size > GIT_SPEC_FILE_MAX_BYTES) callerBug();
      let result: GitRunResult;
      try {
        result = await git(["cat-file", "blob", sha(oid)], { maxBuffer: size + 1 });
      } catch (err: unknown) {
        // More bytes than ls-tree reported is a length mismatch, not a large output.
        if (err instanceof GitSourceError && err.code === "git_output_too_large") {
          throw new GitSourceError("git_output_malformed", { cause: err });
        }
        throw err;
      }
      if (result.stdout.length !== size) malformed();
      return result.stdout;
    },
  };
}
