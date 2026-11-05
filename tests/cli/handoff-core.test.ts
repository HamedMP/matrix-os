import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHandoffBundle,
  inspectRepository,
  snapshotWorkingTree,
  withScratchDir,
} from "../../packages/sync-client/src/cli/handoff/git-local.js";
import {
  fallbackProjectSlug,
  findMatchingProject,
  isSafeBranchName,
  parseGitHubRemote,
  remoteBranchName,
  sanitizeRemoteUrl,
  sideBranchName,
  type MatrixProject,
} from "../../packages/sync-client/src/cli/handoff/project-match.js";
import { isSafeHandoffPath } from "../../packages/sync-client/src/cli/handoff/secret-paths.js";

import { git } from "./handoff-test-git.js";

describe("parseGitHubRemote", () => {
  it.each([
    ["https://github.com/HamedMP/matrix-os", { owner: "HamedMP", repo: "matrix-os" }],
    ["https://github.com/HamedMP/matrix-os.git", { owner: "HamedMP", repo: "matrix-os" }],
    ["https://token@github.com/HamedMP/matrix-os.git/", { owner: "HamedMP", repo: "matrix-os" }],
    ["git@github.com:HamedMP/matrix-os.git", { owner: "HamedMP", repo: "matrix-os" }],
    ["ssh://git@github.com/HamedMP/matrix-os", { owner: "HamedMP", repo: "matrix-os" }],
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected);
  });

  it.each([
    "https://gitlab.com/a/b",
    "git@gitlab.com:a/b.git",
    "https://github.com/onlyowner",
    "https://github.com/a/b/c",
    "file:///tmp/repo",
    "not a url",
  ])("rejects %s", (remote) => {
    expect(parseGitHubRemote(remote)).toBeNull();
  });
});

describe("project matching", () => {
  const base = { name: "x", kind: "github", localPath: "/home/m/projects/x/repo" };
  const projects: MatrixProject[] = [
    { ...base, id: "proj_archived", slug: "matrix-os-old", github: { owner: "hamedmp", repo: "MATRIX-OS" }, archivedAt: "2026-01-01" },
    { ...base, id: "proj_gh", slug: "matrix-os", github: { owner: "hamedmp", repo: "MATRIX-OS" } },
    { ...base, id: "proj_remote", slug: "other", remote: "git@github.com:acme/tool.git" },
    { ...base, id: "proj_folder", slug: "notes-abc1234", kind: "folder" },
  ];

  it("matches GitHub owner/repo case-insensitively and skips archived projects", () => {
    expect(findMatchingProject(projects, { github: { owner: "HamedMP", repo: "matrix-os" }, fallbackSlug: "none" })?.id).toBe("proj_gh");
  });

  it("matches a project whose remote field points at the same repository", () => {
    expect(findMatchingProject(projects, { github: { owner: "acme", repo: "tool" }, fallbackSlug: "none" })?.id).toBe("proj_remote");
  });

  it("falls back to the root-commit slug for repositories without GitHub identity", () => {
    expect(findMatchingProject(projects, { github: null, fallbackSlug: "notes-abc1234" })?.id).toBe("proj_folder");
    expect(findMatchingProject(projects, { github: null, fallbackSlug: "missing-0000000" })).toBeNull();
  });

  it("derives stable, valid slugs and branch names", () => {
    expect(fallbackProjectSlug("My Notes!", "ABCDEF1234567")).toBe("my-notes-abcdef1");
    expect(remoteBranchName("feat/ok", "a".repeat(40))).toBe("feat/ok");
    expect(remoteBranchName("feat/ünïcode", "b".repeat(40))).toBe(`handoff/${"b".repeat(12)}`);
    expect(sideBranchName("feat/ok", "202610141200")).toBe("handoff/feat/ok-202610141200");
    expect(sideBranchName("handoff/abc", "202610141200")).toBe("handoff/abc-202610141200");
    for (const bad of ["-x", "a..b", "a/.hidden", "x.lock", "a//b", "trailing/", "dot.", "sp ace"]) {
      expect(isSafeBranchName(bad), bad).toBe(false);
    }
  });
});

describe("sanitizeRemoteUrl", () => {
  it.each([
    ["https://user:ghp_secret@github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://oauth2:glpat-secret@gitlab.com/team/repo.git?x=1#y", "https://gitlab.com/team/repo.git"],
    ["https://token@gitlab.com/team/repo.git", "https://gitlab.com/team/repo.git"],
    ["ssh://git@gitlab.com/team/repo.git", "ssh://git@gitlab.com/team/repo.git"],
    ["ssh://git:secret@gitlab.com/team/repo.git", "ssh://gitlab.com/team/repo.git"],
    ["git@gitlab.com:team/repo.git", "git@gitlab.com:team/repo.git"],
  ])("cleans %s", (input, expected) => {
    expect(sanitizeRemoteUrl(input)).toBe(expected);
  });

  it.each([null, "/srv/git/repo.git", "file:///srv/git/repo.git", "../sibling", "ext::sh -c evil"])("drops %s", (input) => {
    expect(sanitizeRemoteUrl(input)).toBeNull();
  });
});

describe("isSafeHandoffPath", () => {
  it.each([".env", "apps/web/.env.local", "certs/server.pem", "id_ed25519", ".npmrc", "node_modules/a/index.js", "../escape"])(
    "withholds %s",
    (path) => expect(isSafeHandoffPath(path)).toBe(false),
  );
  it.each(["src/index.ts", "README.md", "docs/env.md", "config/settings.json"])("keeps %s", (path) => {
    expect(isSafeHandoffPath(path)).toBe(true);
  });
});

describe("local snapshot and bundle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "handoff-core-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeRepo(): Promise<string> {
    const repo = join(dir, "My Repo");
    await mkdir(repo);
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "app.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "gone.ts"), "remove me\n");
    await writeFile(join(repo, ".env"), "TRACKED=1\n");
    await writeFile(join(repo, ".gitignore"), "ignored.log\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
    return repo;
  }

  it("rejects directories that are not repositories or have no commits", async () => {
    await expect(inspectRepository(dir)).rejects.toMatchObject({ code: "not_a_repository" });
    const empty = join(dir, "empty");
    await mkdir(empty);
    await git(empty, "init", "-q");
    await expect(inspectRepository(empty)).rejects.toMatchObject({ code: "no_commits" });
  });

  it("inspects branch, root commit and GitHub origin", async () => {
    const repo = await makeRepo();
    await git(repo, "remote", "add", "origin", "git@github.com:Acme/Tool.git");
    const state = await inspectRepository(join(repo));
    expect(state).toMatchObject({ name: "My Repo", branch: "main", branchIsSynthetic: false, github: { owner: "Acme", repo: "Tool" } });
    expect(state.rootCommit).toBe(state.head);
    await git(repo, "checkout", "-q", "--detach");
    const detached = await inspectRepository(repo);
    expect(detached.branchIsSynthetic).toBe(true);
    expect(detached.branch).toBe(`handoff/${detached.head.slice(0, 12)}`);
  });

  it("snapshots safe working-tree changes without touching the user's index or files", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "app.ts"), "export const a = 2;\n");
    await git(repo, "add", "app.ts"); // staged change must survive untouched
    await writeFile(join(repo, "new.ts"), "export const b = 1;\n");
    await rm(join(repo, "gone.ts"));
    await writeFile(join(repo, ".env"), "TRACKED=SECRET\n");
    await writeFile(join(repo, ".env.local"), "LOCAL=SECRET\n");
    await writeFile(join(repo, "ignored.log"), "noise\n");
    const statusBefore = await git(repo, "status", "--porcelain");

    const state = await inspectRepository(repo);
    const snapshot = await withScratchDir((scratch) => snapshotWorkingTree(state, scratch));

    expect(snapshot.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(snapshot.changedPaths.sort()).toEqual(["app.ts", "gone.ts", "new.ts"]);
    expect(snapshot.withheldPaths.sort()).toEqual([".env", ".env.local"]);
    expect(await git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(await git(repo, "rev-parse", `${snapshot.commit}^`)).toBe(state.head);
    expect(await git(repo, "show", `${snapshot.commit}:app.ts`)).toBe("export const a = 2;");
    expect(await git(repo, "show", `${snapshot.commit}:.env`)).toBe("TRACKED=1");
    await expect(git(repo, "cat-file", "-e", `${snapshot.commit}:.env.local`)).rejects.toThrow();
    await expect(git(repo, "cat-file", "-e", `${snapshot.commit}:gone.ts`)).rejects.toThrow();
    await expect(git(repo, "cat-file", "-e", `${snapshot.commit}:ignored.log`)).rejects.toThrow();
  });

  it("returns no snapshot for a clean tree and bundles HEAD without leaving refs behind", async () => {
    const repo = await makeRepo();
    const state = await inspectRepository(repo);
    await withScratchDir(async (scratch) => {
      const snapshot = await snapshotWorkingTree(state, scratch);
      expect(snapshot.commit).toBeNull();
      const bundle = await createHandoffBundle({ repo: state, snapshot, uploadId: "handoff-202610141200-aaaaaaaaaaaa", outputDir: scratch, thin: true });
      expect(bundle).toMatchObject({ thin: false, commitCount: 1 });
      expect(bundle!.sha256).toMatch(/^[a-f0-9]{64}$/);
      const heads = await git(repo, "bundle", "list-heads", bundle!.path);
      expect(heads).toContain("refs/matrix-handoff/handoff-202610141200-aaaaaaaaaaaa/head");
      expect(await git(repo, "for-each-ref", "refs/matrix-handoff/")).toBe("");
      expect((await readFile(bundle!.path)).length).toBe(bundle!.bytes);
    });
  });

  it("omits commits origin already has, and returns null when nothing is left", async () => {
    const origin = join(dir, "origin.git");
    await git(dir, "init", "-q", "--bare", "-b", "main", origin);
    const repo = await makeRepo();
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-q", "origin", "main");
    let state = await inspectRepository(repo);
    await withScratchDir(async (scratch) => {
      const clean = await snapshotWorkingTree(state, scratch);
      expect(await createHandoffBundle({ repo: state, snapshot: clean, uploadId: "handoff-202610141200-bbbbbbbbbbbb", outputDir: scratch, thin: true })).toBeNull();
    });
    await writeFile(join(repo, "app.ts"), "export const a = 3;\n");
    await git(repo, "commit", "-qam", "unpushed");
    await writeFile(join(repo, "wip.ts"), "wip\n");
    state = await inspectRepository(repo);
    await withScratchDir(async (scratch) => {
      const snapshot = await snapshotWorkingTree(state, scratch);
      const bundle = await createHandoffBundle({ repo: state, snapshot, uploadId: "handoff-202610141200-cccccccccccc", outputDir: scratch, thin: true });
      expect(bundle).toMatchObject({ thin: true, commitCount: 2 });
      await git(repo, "bundle", "verify", "-q", bundle!.path);
      const stranger = join(dir, "stranger");
      await mkdir(stranger);
      await git(stranger, "init", "-q");
      await expect(git(stranger, "bundle", "verify", "-q", bundle!.path)).rejects.toThrow();
    });
  });
});
