/**
 * Impact brief: the git reads the git adapter does not have. Revision lookup of a branch or sha, merge-base and
 * its commit time, the name-status diff of merge-base..head, a recursive ls-tree and an import grep over the head
 * tree. Every call goes through the injectable runner with GIT_GLOBAL_ARGS, an argv array, a timeout and an output
 * bound. openGitRepository does the containment, version and shallow checks first. Local objects only: no fetch, no
 * working tree, never HEAD.
 */
import { isUtf8 } from "node:buffer";
import { isIndexablePath, isSafeBranchName, parseLsTree } from "../git/parse.js";
import { openGitRepository } from "../git/reader.js";
import {
  GIT_GLOBAL_ARGS, GIT_SMALL_OUTPUT_MAX_BYTES, GIT_SYNC_DEFAULT_LIMITS, GitRunnerError, GitSourceError,
  type GitRepository, type GitRunResult, type GitRunner, type GitRunnerFailure, type GitSyncErrorCode,
  type GitTreeEntry,
} from "../git/types.js";
import { BRAIN_IMPACT_LIMITS, type BrainImpactChangeStatus } from "../contracts.js";

const LOG_PREFIX = "[brain-impact]";
const DIFF_MAX_BYTES = 16 * 1024 * 1024;
const TREE_MAX_BYTES = 16 * 1024 * 1024;
const GREP_MAX_BYTES = 4 * 1024 * 1024;
/** A full or abbreviated sha as a request may name it. */
const SHA_INPUT = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/;
const DIFF_STATUS = /^([AMDTRC])(?:\d{1,3})?$/;
const STATUSES: Readonly<Record<string, BrainImpactChangeStatus>> = {
  A: "added", M: "modified", D: "deleted", T: "type_changed", R: "renamed", C: "added",
};
const RUNNER_FAILURE_CODES: Readonly<Record<GitRunnerFailure, GitSyncErrorCode>> = {
  timeout: "git_timeout", output_too_large: "git_output_too_large", spawn_failed: "git_unavailable",
};
/**
 * POSIX ERE for git grep -o: an import / export-from / require / dynamic import keyword, then a quoted string of at
 * most 255 characters (the portable repetition bound). Each match prints alone, so output stays small per match.
 */
export const IMPORT_GREP_PATTERN =
  "(^|[^A-Za-z0-9_$.])(from|import|require)[[:space:]]*\\(?[[:space:]]*['\"][^'\"]{1,255}['\"]";

const text = new TextDecoder("utf-8", { ignoreBOM: true });

export interface ImpactChange {
  readonly status: BrainImpactChangeStatus; readonly path: string; readonly previousPath: string | null;
}

/** files: indexable changes in git order; total counts every change line, kept or not. */
export interface ImpactDiff {
  readonly files: readonly ImpactChange[]; readonly total: number; readonly truncated: boolean;
}

export interface ImpactImportMatch { readonly path: string; readonly text: string }

export interface ImpactGit {
  readonly repo: GitRepository;
  /** Full sha of a branch (local, then origin, then a remote-tracking name) or a 7..64 hex sha; null when unknown. */
  resolveRev(rev: string): Promise<{ readonly ref: string; readonly sha: string } | null>;
  mergeBase(left: string, right: string): Promise<string | null>;
  /** Committer time of a commit, ISO-8601 in UTC (the time git documents carry as source_updated_at). */
  commitTime(commit: string): Promise<string>;
  diff(from: string, to: string): Promise<ImpactDiff>;
  listTree(commit: string): Promise<{ readonly entries: readonly GitTreeEntry[]; readonly truncated: boolean }>;
  grepImports(commit: string, paths: readonly string[]): Promise<{
    readonly matches: readonly ImpactImportMatch[]; readonly truncated: boolean;
  }>;
}

export interface OpenImpactGitInput { readonly repoPath: string; readonly homePath: string; readonly runner: GitRunner }

interface Call { readonly maxBuffer: number; readonly truncate?: boolean; readonly okExits: readonly (number | null)[] }

function malformed(): never {
  throw new GitSourceError("git_output_malformed");
}

/** Bytes up to and including the last NUL, so a truncated -z output never ends inside a record. */
function wholeRecords(stdout: Uint8Array, truncated: boolean): Uint8Array {
  return truncated ? stdout.subarray(0, stdout.lastIndexOf(0) + 1) : stdout;
}

function splitNul(stdout: Uint8Array): Uint8Array[] {
  const tokens: Uint8Array[] = [];
  let start = 0;
  for (let at = stdout.indexOf(0); at !== -1; at = stdout.indexOf(0, start)) {
    tokens.push(stdout.subarray(start, at));
    start = at + 1;
  }
  if (start !== stdout.length) malformed();
  return tokens;
}

function decodePath(bytes: Uint8Array): string | null {
  const path = isUtf8(bytes) ? text.decode(bytes) : null;
  return path !== null && isIndexablePath(path) ? path : null;
}

/** `git diff --name-status -z -M`: a status token, then one path, or two for a rename or copy. */
export function parseNameStatus(stdout: Uint8Array, truncated: boolean): ImpactDiff {
  const tokens = splitNul(wholeRecords(stdout, truncated));
  const files: ImpactChange[] = [];
  let total = 0;
  for (let index = 0; index < tokens.length;) {
    const match = DIFF_STATUS.exec(text.decode(tokens[index]!)) ?? malformed();
    const status = STATUSES[match[1]!]!;
    const count = match[1] === "R" || match[1] === "C" ? 2 : 1;
    if (index + count >= tokens.length) {
      if (truncated) break;
      malformed();
    }
    const paths = tokens.slice(index + 1, index + 1 + count).map(decodePath);
    index += 1 + count;
    total += 1;
    if (paths.some((path) => path === null)) continue;
    const path = paths[count - 1]!;
    files.push({ status, path, previousPath: count === 2 ? paths[0]! : null });
  }
  return { files, total, truncated };
}

/** git grep -z -n -o over `<sha>`: `<sha>:<path>\0<line>\0<match>\n` per match. */
export function parseImportGrep(stdout: Uint8Array, commit: string, truncated: boolean): ImpactImportMatch[] {
  let body = text.decode(stdout);
  if (truncated) body = body.slice(0, body.lastIndexOf("\n") + 1);
  const prefix = `${commit}:`;
  const matches: ImpactImportMatch[] = [];
  for (const record of body.split("\n")) {
    if (record === "") continue;
    const [head, line, match, extra] = record.split("\u0000");
    if (!head?.startsWith(prefix) || !/^\d{1,9}$/.test(line ?? "") || match === undefined || extra !== undefined) {
      malformed();
    }
    matches.push({ path: head.slice(prefix.length), text: match });
  }
  return matches;
}

export async function openImpactGit(input: OpenImpactGitInput): Promise<ImpactGit> {
  const limits = { ...GIT_SYNC_DEFAULT_LIMITS, gitTimeoutMs: BRAIN_IMPACT_LIMITS.gitTimeoutMs };
  const { repoPath, homePath, runner } = input;
  const repo = await openGitRepository({ repoPath, homePath, runner, limits });
  const sha = (value: string): string => (repo.shaPattern.test(value) ? value : malformed());

  async function git(sub: readonly string[], call: Call): Promise<GitRunResult> {
    let result: GitRunResult;
    try {
      result = await input.runner([...GIT_GLOBAL_ARGS, ...sub], {
        cwd: repo.root, timeoutMs: BRAIN_IMPACT_LIMITS.gitTimeoutMs, maxBuffer: call.maxBuffer,
        overflow: call.truncate === true ? "truncate" : "fail",
      });
    } catch (err: unknown) {
      if (!(err instanceof GitRunnerError)) throw err;
      console.warn(`${LOG_PREFIX} git runner failed`, { subcommand: sub[0], failure: err.failure });
      throw new GitSourceError(RUNNER_FAILURE_CODES[err.failure], { cause: err });
    }
    if (!call.okExits.includes(result.exitCode)) {
      console.warn(`${LOG_PREFIX} git command failed`, { subcommand: sub[0], exitCode: result.exitCode });
      throw new GitSourceError("git_command_failed");
    }
    return result;
  }

  async function verify(ref: string): Promise<string | null> {
    const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`];
    const result = await git(args, { maxBuffer: GIT_SMALL_OUTPUT_MAX_BYTES, okExits: [0, 1, 128] });
    return result.exitCode === 0 ? sha(text.decode(result.stdout).trim()) : null;
  }

  return {
    repo,

    async resolveRev(rev) {
      const candidates = SHA_INPUT.test(rev) ? [rev] : [];
      if (isSafeBranchName(rev)) {
        candidates.push(`refs/heads/${rev}`, `refs/remotes/origin/${rev}`, `refs/remotes/${rev}`);
      }
      for (const candidate of candidates) {
        const resolved = await verify(candidate);
        if (resolved !== null) return { ref: candidate, sha: resolved };
      }
      return null;
    },

    async mergeBase(left, right) {
      const args = ["merge-base", sha(left), sha(right)];
      const result = await git(args, { maxBuffer: GIT_SMALL_OUTPUT_MAX_BYTES, okExits: [0, 1] });
      return result.exitCode === 0 ? sha(text.decode(result.stdout).trim()) : null;
    },

    async commitTime(commit) {
      const args = ["log", "-1", "--no-walk", "--format=%cI", sha(commit), "--"];
      const result = await git(args, { maxBuffer: GIT_SMALL_OUTPUT_MAX_BYTES, okExits: [0] });
      const at = new Date(text.decode(result.stdout).trim());
      return Number.isNaN(at.getTime()) ? malformed() : at.toISOString();
    },

    async diff(from, to) {
      const args = [
        "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-M", "--name-status", "-z",
        sha(from), sha(to), "--",
      ];
      const result = await git(args, { maxBuffer: DIFF_MAX_BYTES, truncate: true, okExits: [0, null] });
      return parseNameStatus(result.stdout, result.truncated);
    },

    async listTree(commit) {
      const args = ["ls-tree", "-r", "-z", "-l", "--full-tree", sha(commit), "--"];
      const result = await git(args, { maxBuffer: TREE_MAX_BYTES, truncate: true, okExits: [0, null] });
      const entries = parseLsTree(wholeRecords(result.stdout, result.truncated), repo.shaPattern);
      return { entries, truncated: result.truncated };
    },

    async grepImports(commit, paths) {
      if (paths.length === 0) return { matches: [], truncated: false };
      const args = [
        "grep", "-I", "-z", "-n", "--no-column", "--no-color", "-o", "-E", "-e", IMPORT_GREP_PATTERN, sha(commit),
        "--", ...paths,
      ];
      const result = await git(args, { maxBuffer: GREP_MAX_BYTES, truncate: true, okExits: [0, 1, null] });
      return { matches: parseImportGrep(result.stdout, commit, result.truncated), truncated: result.truncated };
    },
  };
}
