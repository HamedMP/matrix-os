// Executes the real Matrix-side handoff scripts against a temporary "Matrix
// home" so the shell logic is verified with real git, not string matching.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHandoffBundle,
  inspectRepository,
  snapshotWorkingTree,
  withScratchDir,
  type HandoffBundle,
  type LocalRepository,
  type WorkingTreeSnapshot,
} from "../../packages/sync-client/src/cli/handoff/git-local.js";
import {
  applySnapshotCommand,
  cleanupCommand,
  integrateCommand,
  parseScriptOutput,
  seedProjectCommand,
  type RemoteCommand,
} from "../../packages/sync-client/src/cli/handoff/remote-scripts.js";
import { assertGatewayRunBody, git, TEST_GIT_ENV as GIT_ENV } from "./handoff-test-git.js";

const exec = promisify(execFile);

let root: string;
let home: string;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `handoff-202610141200-${counter.toString(16).padStart(12, "0")}`;
}

async function runRemote(command: RemoteCommand): Promise<Record<string, string>> {
  assertGatewayRunBody(command);
  const [bin, ...args] = command.command;
  const { stdout } = await exec(bin!, args, { cwd: home, env: { ...process.env, ...GIT_ENV }, timeout: 60_000 });
  return parseScriptOutput(stdout);
}

async function stage(id: string, bundle: HandoffBundle | null): Promise<void> {
  const dir = join(home, "data", "matrix-handoff", id);
  await mkdir(dir, { recursive: true });
  if (bundle) await copyFile(bundle.path, join(dir, "bundle.part-0000"));
}

interface Prepared {
  id: string;
  repo: LocalRepository;
  snapshot: WorkingTreeSnapshot;
  bundle: HandoffBundle | null;
}

async function prepare(local: string, thin: boolean): Promise<Prepared> {
  const id = nextId();
  const repo = await inspectRepository(local);
  return await withScratchDir(async (scratch) => {
    const snapshot = await snapshotWorkingTree(repo, scratch);
    const bundle = await createHandoffBundle({ repo, snapshot, uploadId: id, outputDir: scratch, thin });
    await stage(id, bundle);
    return { id, repo, snapshot, bundle };
  });
}

function integrate(p: Prepared, repoPath: string, slug = "app") {
  return runRemote(integrateCommand({
    uploadId: p.id,
    bundleSha256: p.bundle?.sha256 ?? null,
    repoPath,
    slug,
    branch: p.repo.branch,
    sideBranch: `handoff/${p.repo.branch}-202610141200`,
    head: p.repo.head,
    snapshot: p.snapshot.commit,
  }));
}

function apply(p: Prepared, repoPath: string, checkoutPath: string) {
  return runRemote(applySnapshotCommand({ uploadId: p.id, repoPath, checkoutPath, head: p.repo.head, snapshot: p.snapshot.commit }));
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "handoff-remote-")));
  home = join(root, "home");
  await mkdir(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** origin (bare) + a local clone + the Matrix project clone at ~/projects/app/repo. */
async function githubLikeSetup() {
  const origin = join(root, "origin.git");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  const local = join(root, "local");
  await git(root, "clone", "-q", origin, local);
  await writeFile(join(local, "app.ts"), "v1\n");
  await writeFile(join(local, "keep.ts"), "keep\n");
  await git(local, "add", ".");
  await git(local, "commit", "-q", "-m", "init");
  await git(local, "push", "-q", "origin", "HEAD:main");
  const matrixRepo = join(home, "projects", "app", "repo");
  await mkdir(join(home, "projects", "app"), { recursive: true });
  await git(root, "clone", "-q", origin, matrixRepo);
  return { origin, local, matrixRepo };
}

async function addManagedWorktree(matrixRepo: string, branch: string): Promise<string> {
  const path = join(home, "worktrees", "app", `wt_${branch.replace(/[^a-z0-9]/g, "")}0000000000`);
  await mkdir(join(home, "worktrees", "app"), { recursive: true });
  await git(matrixRepo, "worktree", "add", "-q", path, branch);
  return path;
}

describe("handoff remote scripts", () => {
  it("carries a new local branch with unpushed commits and uncommitted work into a fresh worktree", async () => {
    const { local, matrixRepo } = await githubLikeSetup();
    await git(local, "checkout", "-q", "-b", "feat/x");
    await writeFile(join(local, "app.ts"), "v2 committed\n");
    await git(local, "commit", "-qam", "unpushed");
    await writeFile(join(local, "app.ts"), "v3 uncommitted\n");
    await writeFile(join(local, "new.ts"), "untracked\n");
    await rm(join(local, "keep.ts"));
    await writeFile(join(local, ".env"), "SECRET=1\n");

    const p = await prepare(local, true);
    expect(p.bundle?.thin).toBe(true);
    const integrated = await integrate(p, matrixRepo);
    expect(integrated).toMatchObject({ result: "ok", branch: "feat/x", checkout: "" });

    const worktree = await addManagedWorktree(matrixRepo, "feat/x");
    expect(await apply(p, matrixRepo, worktree)).toMatchObject({ result: "ok" });
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("v3 uncommitted\n");
    expect(await readFile(join(worktree, "new.ts"), "utf8")).toBe("untracked\n");
    await expect(readFile(join(worktree, "keep.ts"))).rejects.toThrow();
    await expect(readFile(join(worktree, ".env"))).rejects.toThrow();
    expect(await git(worktree, "log", "-1", "--format=%s")).toBe("unpushed");

    await runRemote(cleanupCommand({ uploadId: p.id, repoPath: matrixRepo }));
    expect(await git(matrixRepo, "for-each-ref", "refs/matrix-handoff/")).toBe("");
    expect(await readdir(join(home, "data", "matrix-handoff"))).toEqual([]);
  });

  it("fast-forwards a clean existing worktree and lands dirty or diverged work on a side branch", async () => {
    const { local, matrixRepo } = await githubLikeSetup();
    await git(local, "checkout", "-q", "-b", "feat/y");
    await writeFile(join(local, "app.ts"), "first\n");
    await git(local, "commit", "-qam", "first");
    const first = await prepare(local, true);
    expect((await integrate(first, matrixRepo)).branch).toBe("feat/y");
    const worktree = await addManagedWorktree(matrixRepo, "feat/y");
    await runRemote(cleanupCommand({ uploadId: first.id, repoPath: matrixRepo }));

    // Second handoff: the clean Matrix worktree fast-forwards in place.
    await writeFile(join(local, "app.ts"), "second\n");
    await git(local, "commit", "-qam", "second");
    const second = await prepare(local, true);
    expect(await integrate(second, matrixRepo)).toMatchObject({ branch: "feat/y", checkout: worktree });
    expect(await git(worktree, "log", "-1", "--format=%s")).toBe("second");
    await runRemote(cleanupCommand({ uploadId: second.id, repoPath: matrixRepo }));

    // Someone edits the Matrix worktree; the third handoff must not clobber it.
    await writeFile(join(worktree, "app.ts"), "edited on matrix\n");
    await writeFile(join(local, "app.ts"), "third\n");
    await git(local, "commit", "-qam", "third");
    const third = await prepare(local, true);
    const dirty = await integrate(third, matrixRepo);
    expect(dirty.branch).toBe("handoff/feat/y-202610141200");
    expect(await readFile(join(worktree, "app.ts"), "utf8")).toBe("edited on matrix\n");
    await runRemote(cleanupCommand({ uploadId: third.id, repoPath: matrixRepo }));

    // A commit made on Matrix makes the branches diverge.
    await git(worktree, "commit", "-qam", "matrix commit");
    await git(local, "branch", "-q", "-D", "handoff/feat/y-202610141200").catch(() => "");
    await writeFile(join(local, "app.ts"), "fourth\n");
    await git(local, "commit", "-qam", "fourth");
    const fourth = await prepare(local, true);
    await git(matrixRepo, "branch", "-q", "-D", "handoff/feat/y-202610141200");
    expect((await integrate(fourth, matrixRepo)).branch).toBe("handoff/feat/y-202610141200");
    expect(await git(worktree, "log", "-1", "--format=%s")).toBe("matrix commit");
  });

  it("reports that a full bundle is needed when Matrix lacks the thin bundle's base", async () => {
    const { local } = await githubLikeSetup();
    // A Matrix repository with unrelated history cannot use the thin bundle.
    const unrelated = join(home, "projects", "app", "other");
    await mkdir(unrelated, { recursive: true });
    await git(unrelated, "init", "-q", "-b", "main");
    await writeFile(join(unrelated, "x"), "x\n");
    await git(unrelated, "add", ".");
    await git(unrelated, "commit", "-q", "-m", "unrelated");
    await git(local, "checkout", "-q", "-b", "feat/z");
    await writeFile(join(local, "app.ts"), "z\n");
    await git(local, "commit", "-qam", "z");
    const p = await prepare(local, true);
    expect(await integrate(p, unrelated)).toMatchObject({ result: "needs_full_bundle" });
  });

  it("seeds a new project from a full bundle for repositories Matrix cannot clone", async () => {
    const local = join(root, "notes");
    await mkdir(local);
    await git(local, "init", "-q", "-b", "main");
    await writeFile(join(local, "a.md"), "hello\n");
    await git(local, "add", ".");
    await git(local, "commit", "-q", "-m", "init");
    await writeFile(join(local, "a.md"), "hello wip\n");
    const p = await prepare(local, false);
    expect(p.bundle?.thin).toBe(false);

    const seeded = await runRemote(seedProjectCommand({
      uploadId: p.id,
      bundleSha256: p.bundle!.sha256,
      slug: "notes-abc1234",
      branch: "main",
      head: p.repo.head,
      originUrl: null,
    }));
    const projectPath = join(home, "projects", "notes-abc1234");
    expect(seeded).toMatchObject({ result: "ok", path: projectPath });
    const integrated = await integrate(p, projectPath, "notes-abc1234");
    expect(integrated).toMatchObject({ branch: "main", checkout: projectPath });
    expect(await apply(p, projectPath, projectPath)).toMatchObject({ result: "ok" });
    expect(await readFile(join(projectPath, "a.md"), "utf8")).toBe("hello wip\n");

    // Re-seeding must never overwrite an existing directory.
    expect((await runRemote(seedProjectCommand({
      uploadId: p.id, bundleSha256: p.bundle!.sha256, slug: "notes-abc1234", branch: "main", head: p.repo.head, originUrl: null,
    }))).result).toBe("destination_exists");
  });

  it("rejects a corrupt upload and paths outside the Matrix home", async () => {
    const { local, matrixRepo } = await githubLikeSetup();
    await git(local, "checkout", "-q", "-b", "feat/c");
    await writeFile(join(local, "app.ts"), "c\n");
    await git(local, "commit", "-qam", "c");
    const p = await prepare(local, true);
    await writeFile(join(home, "data", "matrix-handoff", p.id, "bundle.part-0000"), "garbage");
    expect((await integrate(p, matrixRepo)).result).toBe("bundle_corrupt");
    expect((await runRemote(integrateCommand({
      uploadId: nextId(), bundleSha256: null, repoPath: "/etc", slug: "app", branch: "x", sideBranch: "handoff/x-1", head: p.repo.head, snapshot: null,
    }))).result).toBe("invalid_path");
  });

  it("refuses to apply when the target checkout is dirty or moved", async () => {
    const { local, matrixRepo } = await githubLikeSetup();
    await writeFile(join(local, "app.ts"), "wip\n");
    const p = await prepare(local, true);
    expect(p.bundle).not.toBeNull(); // snapshot only
    await integrate(p, matrixRepo);
    await writeFile(join(matrixRepo, "app.ts"), "matrix edit\n");
    expect((await apply(p, matrixRepo, matrixRepo)).result).toBe("checkout_dirty");
  });

  it("validates every argument before building a command", () => {
    const head = "a".repeat(40);
    expect(() => integrateCommand({ uploadId: "bad", bundleSha256: null, repoPath: "/h/p", slug: "app", branch: "x", sideBranch: "handoff/x-1", head, snapshot: null })).toThrow();
    expect(() => integrateCommand({ uploadId: nextId(), bundleSha256: null, repoPath: "/h/../p", slug: "app", branch: "x", sideBranch: "handoff/x-1", head, snapshot: null })).toThrow();
    expect(() => integrateCommand({ uploadId: nextId(), bundleSha256: null, repoPath: "/h/p; rm -rf ~", slug: "app", branch: "x", sideBranch: "handoff/x-1", head, snapshot: null })).toThrow();
    expect(() => seedProjectCommand({ uploadId: nextId(), bundleSha256: "f".repeat(64), slug: "Bad Slug", branch: "x", head, originUrl: null })).toThrow();
    expect(() => applySnapshotCommand({ uploadId: nextId(), repoPath: "/h/p", checkoutPath: "/h/p", head: "nothex", snapshot: null })).toThrow();
    const command = cleanupCommand({ uploadId: nextId(), repoPath: null });
    expect(JSON.stringify(command).length).toBeLessThan(16_000);
  });
});
