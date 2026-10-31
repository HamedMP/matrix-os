import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { parseGitHubRemote, type GitHubRepository } from "./project-match.js";
import { isSafeHandoffPath } from "./secret-paths.js";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
// Fixed identity and dates make the snapshot commit a pure function of HEAD
// and the working tree, so a preview and its approved re-run agree.
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Matrix Handoff",
  GIT_AUTHOR_EMAIL: "handoff@matrix-os.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Matrix Handoff",
  GIT_COMMITTER_EMAIL: "handoff@matrix-os.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export class HandoffGitError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "HandoffGitError";
  }
}

export interface LocalRepository {
  root: string;
  name: string;
  branch: string;
  branchIsSynthetic: boolean;
  head: string;
  rootCommit: string;
  originUrl: string | null;
  github: GitHubRepository | null;
}

export interface WorkingTreeSnapshot {
  /** Commit whose tree is the safe working tree and whose parent is HEAD; null when clean. */
  commit: string | null;
  changedPaths: string[];
  withheldPaths: string[];
}

export interface HandoffBundle {
  path: string;
  bytes: number;
  sha256: string;
  thin: boolean;
  /** Commits carried by the bundle that the excluded remote refs do not contain. */
  commitCount: number;
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  return result.stdout;
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim();
  } catch (error: unknown) {
    // git exits 1, 2 (no such remote) or 128 for a missing ref or remote;
    // anything else (timeout, missing binary) is a real failure.
    if (error instanceof Error && "code" in error && [1, 2, 128].includes(error.code as number)) return null;
    throw error;
  }
}

export async function inspectRepository(cwd: string): Promise<LocalRepository> {
  const top = await optionalGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new HandoffGitError("Run matrix handoff inside a Git repository.", "not_a_repository");
  const root = await realpath(top);
  const head = await optionalGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head) throw new HandoffGitError("Commit at least once before handing off this repository.", "no_commits");
  const currentBranch = await optionalGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const roots = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n").filter(Boolean);
  const originUrl = await optionalGit(root, ["remote", "get-url", "origin"]);
  return {
    root,
    name: basename(root),
    branch: currentBranch || `handoff/${head.slice(0, 12)}`,
    branchIsSynthetic: !currentBranch,
    head,
    // Repositories with several roots (merged histories) use the oldest-listed
    // root so the identity stays stable across clones.
    rootCommit: roots.sort()[0] ?? head,
    originUrl: originUrl || null,
    github: originUrl ? parseGitHubRemote(originUrl) : null,
  };
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/**
 * Records the working tree as a commit on top of HEAD using a throwaway index,
 * so the user's index, files and refs stay untouched. Secret-looking paths keep
 * their HEAD content (or stay absent) and are reported as withheld.
 */
export async function snapshotWorkingTree(repo: LocalRepository, scratchDir: string): Promise<WorkingTreeSnapshot> {
  const env = { GIT_INDEX_FILE: join(scratchDir, "handoff.index") };
  await git(repo.root, ["read-tree", "HEAD"], env);
  await git(repo.root, ["add", "--all", "--", "."], env);
  const changed = nulList(await git(repo.root, ["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"], env));
  const withheld = changed.filter((path) => !isSafeHandoffPath(path));
  for (const path of withheld) {
    const inHead = (await optionalGit(repo.root, ["cat-file", "-e", `HEAD:${path}`])) !== null;
    if (inHead) await git(repo.root, ["reset", "--quiet", "HEAD", "--", path], env);
    else await git(repo.root, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", path], env);
  }
  const changedPaths = changed.filter((path) => isSafeHandoffPath(path));
  if (changedPaths.length === 0) return { commit: null, changedPaths, withheldPaths: withheld };
  const tree = (await git(repo.root, ["write-tree"], env)).trim();
  const commit = (await git(
    repo.root,
    ["commit-tree", tree, "-p", repo.head, "-m", "matrix handoff: uncommitted work"],
    SNAPSHOT_IDENTITY,
  )).trim();
  return { commit, changedPaths, withheldPaths: withheld };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function handoffRefs(uploadId: string): { head: string; snapshot: string } {
  return { head: `refs/matrix-handoff/${uploadId}/head`, snapshot: `refs/matrix-handoff/${uploadId}/snapshot` };
}

/**
 * Writes a git bundle carrying HEAD (and the snapshot) under
 * refs/matrix-handoff/<uploadId>/*. A thin bundle omits commits already
 * present on origin; it returns null when there is nothing left to carry.
 */
export async function createHandoffBundle(input: {
  repo: LocalRepository;
  snapshot: WorkingTreeSnapshot;
  uploadId: string;
  outputDir: string;
  thin: boolean;
}): Promise<HandoffBundle | null> {
  const { repo, snapshot, uploadId } = input;
  const refs = handoffRefs(uploadId);
  const path = join(input.outputDir, "handoff.bundle");
  await git(repo.root, ["update-ref", refs.head, repo.head]);
  if (snapshot.commit) await git(repo.root, ["update-ref", refs.snapshot, snapshot.commit]);
  try {
    const tips = snapshot.commit ? [refs.head, refs.snapshot] : [refs.head];
    const hasRemoteRefs = input.thin && (await optionalGit(repo.root, ["for-each-ref", "--count=1", "refs/remotes/origin/"])) !== "";
    const exclusions = hasRemoteRefs ? ["--not", "--remotes=origin"] : [];
    const commitCount = Number((await git(repo.root, ["rev-list", "--count", ...tips, ...exclusions])).trim());
    if (commitCount === 0) return null;
    await git(repo.root, ["bundle", "create", "--quiet", path, ...tips, ...exclusions]);
    const info = await stat(path);
    return { path, bytes: info.size, sha256: await sha256File(path), thin: hasRemoteRefs, commitCount };
  } finally {
    await git(repo.root, ["update-ref", "-d", refs.head]);
    if (snapshot.commit) await git(repo.root, ["update-ref", "-d", refs.snapshot]);
  }
}

/** Commits on HEAD that origin does not have yet, for the preview. */
export async function countUnpushedCommits(repo: LocalRepository): Promise<number> {
  const hasRemoteRefs = (await optionalGit(repo.root, ["for-each-ref", "--count=1", "refs/remotes/origin/"])) !== "";
  if (!hasRemoteRefs) return Number((await git(repo.root, ["rev-list", "--count", "HEAD"])).trim());
  return Number((await git(repo.root, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])).trim());
}

export async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-handoff-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
