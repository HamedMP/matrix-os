/**
 * Real git repositories for the Company Brain git adapter tests. Each fixture
 * is a temp "Matrix home" holding one repo at projects/widgets/repo, built
 * with plumbing only: a snapshot is written to a stage dir outside the repo,
 * `add -A` into a private index, `write-tree`, `commit-tree`, `update-ref`.
 * Identity and dates are fixed, so shas are deterministic. Git always runs
 * through execFile with an argv array, a scrubbed env, a timeout, a maxBuffer
 * and an explicit --git-dir; it never touches the matrix-os checkout and never
 * runs checkout, reset, merge, stash or clean.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GIT_GLOBAL_ARGS,
  type GitRunner,
  type GitRunResult,
} from "../../../packages/gateway/src/brain/git/types.js";

export const FIXTURE_REMOTE_URL = "https://github.com/acme/widgets.git";
export const FIXTURE_WEB_BASE = "https://github.com/acme/widgets";
export const FIXTURE_AUTHOR = "Fixture Author";
/** 2026-09-01T00:00:00Z; commit n is dated FIXTURE_EPOCH + 60 * n. */
export const FIXTURE_EPOCH = 1_788_220_800;

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FIXTURE_FILES = 1_000;
const IDENTITY_ARGS: readonly string[] = [
  "-c", `user.name=${FIXTURE_AUTHOR}`, "-c", "user.email=fixture@example.com",
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
];

export type FixtureFiles = Readonly<Record<string, string | null>>;

export interface FixtureCommitInput {
  readonly branch?: string;
  readonly message: string;
  readonly files?: FixtureFiles;
  /** Default: the current tip of `branch` (none for a new branch). The tree starts from parents[0]. */
  readonly parents?: readonly string[];
}

export interface FixtureMergeInput {
  readonly number: number;
  /** `owner/branch` shown in `Merge pull request #N from <branch>`. */
  readonly branch: string;
  readonly title: string;
  /** true: subject `<title> (#N)` with 2 parents (a titled merge). */
  readonly titled?: boolean;
  readonly body?: string;
  readonly commits: ReadonlyArray<{ readonly message: string; readonly files: FixtureFiles }>;
}

export interface BrainGitFixture {
  readonly homePath: string;
  readonly repoPath: string;
  git(args: readonly string[], options?: { env?: Record<string, string> }): Promise<string>;
  commit(input: FixtureCommitInput): Promise<string>;
  squashPr(n: number, title: string, body?: string, files?: FixtureFiles): Promise<string>;
  mergePr(input: FixtureMergeInput): Promise<string>;
  /** `Revert "<subject>"` on `branch` restoring every path the commit changed. */
  revert(sha: string, branch?: string): Promise<string>;
  writeSpec(dir: string, content: string, message?: string): Promise<string>;
  removeSpec(dir: string, message?: string): Promise<string>;
  /** Force-push simulation: move `branch` to `onto`, then commit on top; returns the new shas. */
  forcePush(branch: string, onto: string, commits: readonly FixtureCommitInput[]): Promise<string[]>;
  setRemote(url: string | null): Promise<void>;
  setOriginHead(branch: string, sha: string): Promise<void>;
  setBranch(branch: string, sha: string): Promise<void>;
  tip(branch?: string): Promise<string>;
  committedAt(sha: string): Promise<string>;
  destroy(): Promise<void>;
}

interface RunOutcome { readonly code: number; readonly stdout: string }

function fixtureEnv(home: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), LC_ALL: "C", LANG: "C", TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ADVICE: "0",
    ...extra,
  };
}

function runGit(
  args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, okExits: readonly number[] = [0],
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      if (code !== null && okExits.includes(code)) {
        resolve({ code, stdout });
        return;
      }
      const argv = args.slice(IDENTITY_ARGS.length).join(" ").slice(0, 300);
      reject(new Error(`fixture git ${argv} failed (exit ${String(code)}): ${stderr.slice(0, 500)}`, { cause: error }));
    });
  });
}

function assertFixturePath(path: string): void {
  const segments = path.split("/");
  if (path.length === 0 || path.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`fixture path is not a relative repo path: ${path}`);
  }
}

function subjectOf(message: string): string {
  return message.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}
