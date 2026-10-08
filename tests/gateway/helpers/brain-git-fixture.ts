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

export async function createBrainGitFixture(): Promise<BrainGitFixture> {
  const homePath = await realpath(await mkdtemp(join(tmpdir(), "brain-git-")));
  const repoPath = join(homePath, "projects", "widgets", "repo");
  const gitDir = join(repoPath, ".git");
  const baseArgs = [...IDENTITY_ARGS, "--git-dir", gitDir];
  const snapshots = new Map<string, ReadonlyMap<string, string>>();
  const parentsOf = new Map<string, readonly string[]>();
  const messages = new Map<string, string>();
  let counter = 0;

  await mkdir(repoPath, { recursive: true });
  await runGit([...IDENTITY_ARGS, "init", "-q", "-b", "main", repoPath], homePath, fixtureEnv(homePath));

  const run = (args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}, okExits?: readonly number[]) =>
    runGit([...baseArgs, ...args], homePath, fixtureEnv(homePath, extraEnv), okExits);
  const git = async (args: readonly string[], options: { env?: Record<string, string> } = {}) =>
    (await run(args, options.env)).stdout.trimEnd();

  const branchTip = async (branch: string): Promise<string | null> => {
    const outcome = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {}, [0, 1]);
    return outcome.code === 0 ? outcome.stdout.trim() : null;
  };
  const snapshotOf = (sha: string): ReadonlyMap<string, string> => {
    const snapshot = snapshots.get(sha);
    if (!snapshot) throw new Error(`fixture does not know commit ${sha}`);
    return snapshot;
  };
  const diffFiles = (from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): Record<string, string | null> => {
    const files: Record<string, string | null> = {};
    for (const path of new Set([...from.keys(), ...to.keys()])) {
      if (from.get(path) !== to.get(path)) files[path] = to.get(path) ?? null;
    }
    return files;
  };

  const writeTree = async (snapshot: ReadonlyMap<string, string>, n: number): Promise<string> => {
    const stage = join(homePath, `stage-${n}`);
    const indexEnv = { GIT_INDEX_FILE: join(homePath, `index-${n}`) };
    await mkdir(stage);
    try {
      for (const [path, content] of snapshot) {
        const file = join(stage, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
      await runGit([...IDENTITY_ARGS, "--git-dir", gitDir, "--work-tree", stage, "add", "-A", "-f"], stage,
        fixtureEnv(homePath, indexEnv));
      return (await run(["write-tree"], indexEnv)).stdout.trim();
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(indexEnv.GIT_INDEX_FILE, { force: true });
    }
  };

  const commit = async (input: FixtureCommitInput): Promise<string> => {
    const branch = input.branch ?? "main";
    const current = input.parents ? null : await branchTip(branch);
    const parents = input.parents ?? (current ? [current] : []);
    const next = new Map(parents.length > 0 ? snapshotOf(parents[0]!) : []);
    for (const [path, content] of Object.entries(input.files ?? {})) {
      assertFixturePath(path);
      if (content === null) next.delete(path);
      else next.set(path, content);
    }
    if (next.size > MAX_FIXTURE_FILES) throw new Error("fixture snapshot is too large");
    const n = counter++;
    const tree = await writeTree(next, n);
    const date = `${FIXTURE_EPOCH + 60 * n} +0000`;
    const messageFile = join(homePath, `message-${n}.txt`);
    await writeFile(messageFile, input.message.endsWith("\n") ? input.message : `${input.message}\n`);
    try {
      const outcome = await run(
        ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-F", messageFile],
        { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      );
      const sha = outcome.stdout.trim();
      await run(["update-ref", `refs/heads/${branch}`, sha]);
      snapshots.set(sha, next);
      parentsOf.set(sha, parents);
      messages.set(sha, input.message);
      return sha;
    } finally {
      await rm(messageFile, { force: true });
    }
  };

  const tip = async (branch = "main"): Promise<string> => {
    const sha = await branchTip(branch);
    if (sha === null) throw new Error(`fixture branch ${branch} does not exist`);
    return sha;
  };

  const setBranch = async (branch: string, sha: string): Promise<void> => {
    await run(["update-ref", `refs/heads/${branch}`, sha]);
  };

  await run(["remote", "add", "origin", FIXTURE_REMOTE_URL]);

  return {
    homePath,
    repoPath,
    git,
    commit,
    tip,
    setBranch,
    squashPr: (n, title, body, files) =>
      commit({ message: body ? `${title} (#${n})\n\n${body}` : `${title} (#${n})`, files }),
    async mergePr(input) {
      if (input.commits.length === 0) throw new Error("a fixture merge needs at least one branch commit");
      const mainTip = await tip("main");
      let side = mainTip;
      for (const branchCommit of input.commits) {
        side = await commit({ branch: `pr-${input.number}`, parents: [side], ...branchCommit });
      }
      const tail = input.body ? `\n\n${input.body}` : "";
      const message = input.titled
        ? `${input.title} (#${input.number})${tail}`
        : `Merge pull request #${input.number} from ${input.branch}\n\n${input.title}${tail}`;
      return commit({ message, parents: [mainTip, side], files: diffFiles(snapshotOf(mainTip), snapshotOf(side)) });
    },
    async revert(sha, branch = "main") {
      const parent = parentsOf.get(sha)?.[0];
      const before = parent ? snapshotOf(parent) : new Map<string, string>();
      return commit({
        branch,
        message: `Revert "${subjectOf(messages.get(sha) ?? "")}"\n\nThis reverts commit ${sha}.`,
        files: diffFiles(snapshotOf(sha), before),
      });
    },
    writeSpec: (dir, content, message) =>
      commit({ message: message ?? `docs: update ${dir} spec`, files: { [`specs/${dir}/spec.md`]: content } }),
    removeSpec: (dir, message) =>
      commit({ message: message ?? `docs: remove ${dir} spec`, files: { [`specs/${dir}/spec.md`]: null } }),
    async forcePush(branch, onto, commits) {
      await setBranch(branch, onto);
      const shas: string[] = [];
      for (const next of commits) shas.push(await commit({ ...next, branch }));
      return shas;
    },
    async setRemote(url) {
      if (url === null) await run(["config", "--local", "--unset-all", "remote.origin.url"], {}, [0, 5]);
      else await run(["config", "--local", "remote.origin.url", url]);
    },
    async setOriginHead(branch, sha) {
      await run(["update-ref", `refs/remotes/origin/${branch}`, sha]);
      await run(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
    },
    committedAt: (sha) => git(["log", "-1", "--no-color", "--format=%cI", sha, "--"]),
    destroy: () => rm(homePath, { recursive: true, force: true }),
  };
}

/**
 * The adapter's `log` calls: `window` is the first-parent window form (else
 * the per-commit `-1` form), `nameStatus` the paths log (else the metadata
 * log); an omitted option matches both.
 */
export function isGitLog(sub: readonly string[], kind: { window?: boolean; nameStatus?: boolean } = {}): boolean {
  if (sub[0] !== "log") return false;
  if (kind.window !== undefined && sub.includes("--first-parent") !== kind.window) return false;
  return kind.nameStatus === undefined || sub.includes("--name-status") === kind.nameStatus;
}

/** A runner that answers some subcommands itself; `undefined` delegates to `base`. */
export function fakeRunner(
  base: GitRunner,
  override: (sub: readonly string[]) => Promise<GitRunResult | undefined> | GitRunResult | undefined,
): GitRunner {
  return async (args, options) => {
    const answer = await override(args.slice(GIT_GLOBAL_ARGS.length));
    return answer ?? base(args, options);
  };
}

export function gitRunResult(stdout: string | Uint8Array, exitCode: number | null = 0, truncated = false): GitRunResult {
  return { exitCode, stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout, stderr: "", truncated };
}

// The base history of the sync tests, oldest first.

export const ALPHA_SPEC_V1 = "# Alpha\n\nAlpha spec v1.\n";
export const ALPHA_SPEC_V2 = "# Alpha\n\nAlpha spec v2.\n";
export const FEATURE_X_SPEC = "# Feature X\n\nX spec.\n";
export const SQUASH_1_BODY = "## Summary\n- Adds alpha.\n\n## Invariants\n- Alpha stays bounded.";
export const BETA_BODY = "* add beta\n* wire beta\n\n---------\n\nCo-authored-by: Pair Person <pair@example.com>";
export const UNIT_SEPARATOR_BODY = "before\u001fafter";
export const SPECIAL_PATH = "docs/caf\u00e9/na\u00efve file #1?.md";

/** A spec with `## ` headings, about 1.2 KB per section, for multi-part splits. */
export function bigSpecText(sections: number): string {
  const body = "Lorem ipsum dolor sit amet, alpha beta gamma. ".repeat(26);
  return ["# Big spec\n", ...Array.from({ length: sections }, (_, i) => `\n## Section ${i + 1}\n\n${body}\n`)].join("");
}

export interface BaseHistory {
  readonly root: string;
  readonly squash1: string;
  readonly tidy: string;
  readonly merge2: string;
  readonly merge3: string;
  readonly revert1: string;
  readonly empty4: string;
  readonly unitSeparator: string;
  readonly special: string;
  /** The 9 first-parent commits of main, oldest first. */
  readonly firstParent: readonly string[];
  readonly tip: string;
}

export async function buildBaseHistory(f: BrainGitFixture): Promise<BaseHistory> {
  const root = await f.commit({
    message: "Initial commit", files: { "README.md": "# Widgets\n", "specs/001-alpha/spec.md": ALPHA_SPEC_V1 },
  });
  const squash1 = await f.squashPr(1, "feat(brain): alpha", SQUASH_1_BODY, {
    "src/alpha.ts": "export const alpha = 1;\n", "specs/001-alpha/spec.md": ALPHA_SPEC_V2,
  });
  const tidy = await f.commit({ message: "chore: tidy", files: { "README.md": "# Widgets\n\nTidy.\n" } });
  const merge2 = await f.mergePr({
    number: 2, branch: "acme/feature-x", title: "Add feature X", commits: [
      { message: "feat: x part one", files: { "src/x.ts": "export const x = 1;\n" } },
      { message: "docs: x spec", files: { "specs/002-feature-x/spec.md": FEATURE_X_SPEC } },
    ],
  });
  const merge3 = await f.mergePr({
    number: 3, branch: "acme/beta", title: "feat: beta", titled: true, body: BETA_BODY,
    commits: [{ message: "feat: beta work", files: { "src/beta.ts": "export const beta = 1;\n" } }],
  });
  const revert1 = await f.revert(squash1);
  const empty4 = await f.squashPr(4, "chore: empty");
  const unitSeparator = await f.commit({
    message: `fix: keep unit separators\n\n${UNIT_SEPARATOR_BODY}`, files: { "notes/unit.txt": "unit\n" },
  });
  const special = await f.commit({ message: "docs: caf\u00e9 notes", files: { [SPECIAL_PATH]: "Notes.\n" } });
  const firstParent = [root, squash1, tidy, merge2, merge3, revert1, empty4, unitSeparator, special];
  return { root, squash1, tidy, merge2, merge3, revert1, empty4, unitSeparator, special, firstParent, tip: special };
}
