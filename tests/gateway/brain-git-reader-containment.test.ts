/**
 * reader.ts trust boundary: a checkout opens only when its git directory,
 * common directory and object alternates stay inside the Matrix home and out
 * of home's own `.git`; the child environment never finds `git` through a
 * relative PATH entry and never lets repo-local config enable a transport.
 */
import { execFile } from "node:child_process";
import { access, chmod, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeBounds } from "../../packages/gateway/src/brain/git/containment.js";
import { defaultGitRunner, openGitRepository } from "../../packages/gateway/src/brain/git/reader.js";
import {
  GIT_ENV_OVERRIDES, GIT_GLOBAL_ARGS, GIT_SYNC_DEFAULT_LIMITS, GitSourceError,
} from "../../packages/gateway/src/brain/git/types.js";
import { createBrainGitFixture, type BrainGitFixture } from "./helpers/brain-git-fixture.js";

/** Raw git for setup outside the fixture (init); bounded like the fixture. */
function rawGit(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd, timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }, (error) => (error === null ? resolve() : reject(error)));
  });
}

function mkfifo(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("mkfifo", [path], { timeout: 10_000 }, (error) => (error === null ? resolve() : reject(error)));
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}

describe("openGitRepository containment", { timeout: 30_000 }, () => {
  let f: BrainGitFixture;
  let outside: BrainGitFixture;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    [f, outside] = await Promise.all([createBrainGitFixture(), createBrainGitFixture()]);
    await f.commit({ message: "Initial commit", files: { "README.md": "home project\n" } });
    await outside.commit({ message: "Private commit", files: { "secret.md": "outside home\n" } });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    warn.mockRestore();
    await Promise.all([f.destroy(), outside.destroy()]);
  });

  const open = (repoPath: string) => openGitRepository({
    repoPath, homePath: f.homePath, runner: defaultGitRunner, limits: GIT_SYNC_DEFAULT_LIMITS,
  });
  const expectRefused = async (repoPath: string): Promise<void> => {
    const error = await open(repoPath).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitSourceError);
    expect(error).toMatchObject({ code: "not_a_repository" });
  };
  const project = async (name: string): Promise<string> => {
    const path = join(f.homePath, "projects", name);
    await mkdir(path, { recursive: true });
    return path;
  };

  it("refuses a .git file or symlink that leads outside home", async () => {
    const viaFile = await project("via-file");
    await writeFile(join(viaFile, ".git"), `gitdir: ${join(outside.repoPath, ".git")}\n`);
    await expectRefused(viaFile);
    const viaLink = await project("via-link");
    await symlink(join(outside.repoPath, ".git"), join(viaLink, ".git"));
    await expectRefused(viaLink);
  });

  it("refuses a .git file or symlink that leads into home's own history", async () => {
    await rawGit(["init", "-q", f.homePath], f.homePath);
    const viaFile = await project("home-file");
    await writeFile(join(viaFile, ".git"), `gitdir: ${join(f.homePath, ".git")}\n`);
    await expectRefused(viaFile);
    const viaLink = await project("home-link");
    await symlink(join(f.homePath, ".git"), join(viaLink, ".git"));
    await expectRefused(viaLink);
    // The project itself still opens inside a versioned home.
    await expect(open(f.repoPath)).resolves.toMatchObject({ root: await realpath(f.repoPath) });
  });

  it("refuses a .git file or symlink that leads to home's separate git directory", async () => {
    const homeGit = join(f.homePath, ".home-git");
    await rawGit(["init", "-q", "--separate-git-dir", homeGit, f.homePath], f.homePath);
    const viaFile = await project("home-separate-file");
    await writeFile(join(viaFile, ".git"), `gitdir: ${homeGit}\n`);
    await expectRefused(viaFile);
    const viaLink = await project("home-separate-link");
    await symlink(homeGit, join(viaLink, ".git"));
    await expectRefused(viaLink);
    await expect(open(f.repoPath)).resolves.toMatchObject({ root: await realpath(f.repoPath) });
  });

  it("follows home's relative .git file, commondir and objects link to its history", async () => {
    const gits = join(f.homePath, ".gits");
    const shared = join(gits, "shared");
    await rawGit(["init", "-q", "--bare", shared], f.homePath);
    await rawGit(["--git-dir", shared, "config", "core.bare", "false"], f.homePath);
    const store = join(f.homePath, "stores", "objects");
    await mkdir(join(f.homePath, "stores"));
    await rename(join(shared, "objects"), store);
    await symlink(store, join(shared, "objects"));
    await mkdir(join(gits, "home"));
    await writeFile(join(gits, "home", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(gits, "home", "commondir"), "../shared\n");
    await writeFile(join(f.homePath, ".git"), "gitdir: .gits/home\r\n");
    expect((await homeBounds(f.homePath)).homeGitPaths).toEqual([join(f.homePath, ".git"), join(gits, "home"), shared, store]);

    const viaCommon = await project("home-common");
    await writeFile(join(viaCommon, ".git"), `gitdir: ${shared}\n`);
    await expectRefused(viaCommon);
    const viaObjects = await project("home-objects");
    await rawGit(["init", "-q", viaObjects], f.homePath);
    await rm(join(viaObjects, ".git", "objects"), { recursive: true });
    await symlink(store, join(viaObjects, ".git", "objects"));
    await expectRefused(viaObjects);
    await expect(open(f.repoPath)).resolves.toMatchObject({ root: await realpath(f.repoPath) });
  });

  it("opens a checkout whose separate git directory is elsewhere inside home", async () => {
    const checkout = await project("separate");
    await mkdir(join(f.homePath, "git-dirs"));
    await rawGit(["init", "-q", "--separate-git-dir", join(f.homePath, "git-dirs", "separate.git"), checkout], f.homePath);
    await expect(open(checkout)).resolves.toMatchObject({ root: await realpath(checkout) });
  });

  it("refuses an objects directory linked outside home or into home's own history, and allows one inside home", async () => {
    const linked = async (name: string, target: string): Promise<string> => {
      const checkout = await project(name);
      await rawGit(["init", "-q", checkout], f.homePath);
      await rm(join(checkout, ".git", "objects"), { recursive: true });
      await symlink(target, join(checkout, ".git", "objects"));
      return checkout;
    };
    await expectRefused(await linked("objects-outside", join(outside.repoPath, ".git", "objects")));
    await rawGit(["init", "-q", f.homePath], f.homePath);
    await expectRefused(await linked("objects-home", join(f.homePath, ".git", "objects")));
    const store = join(f.homePath, "object-stores", "shared");
    await rawGit(["init", "-q", "--bare", store], f.homePath);
    await expect(open(await linked("objects-inside", join(store, "objects")))).resolves.toMatchObject({ objectFormat: "sha1" });
  });

  it("refuses object alternates outside home or quoted, also when nested, and allows them inside home", async () => {
    const alternates = join(f.repoPath, ".git", "objects", "info", "alternates");
    await mkdir(join(f.repoPath, ".git", "objects", "info"), { recursive: true });
    for (const entry of [
      join(outside.repoPath, ".git", "objects"), "../../../../../../../../../../tmp", `"${join(f.homePath, "x")}"`,
      join(f.homePath, ".git-missing", "objects"),
    ]) {
      await writeFile(alternates, `# comment\n\n${entry}\n`);
      await expectRefused(f.repoPath);
    }
    const sibling = join(f.homePath, "projects", "sibling");
    await rawGit(["init", "-q", "--bare", sibling], f.homePath);
    await writeFile(alternates, `${join(sibling, "objects")}\n`);
    await expect(open(f.repoPath)).resolves.toMatchObject({ objectFormat: "sha1" });
    // An allowed alternate whose own alternates leave home is refused.
    await mkdir(join(sibling, "objects", "info"), { recursive: true });
    await writeFile(join(sibling, "objects", "info", "alternates"), `${join(outside.repoPath, ".git", "objects")}\n`);
    await expectRefused(f.repoPath);
  });

  it("refuses an alternate whose .. leaves home through a symlink", async () => {
    const info = join(f.repoPath, ".git", "objects", "info");
    await mkdir(info, { recursive: true });
    await mkdir(join(f.homePath, "links"));
    // Normalized, `links/escape/..` is the plain `links` folder; git walks the link to the outside objects.
    await symlink(join(outside.repoPath, ".git", "objects", "info"), join(f.homePath, "links", "escape"));
    for (const entry of [`${join(f.homePath, "links", "escape")}/..`, "../../../../../links/escape/.."]) {
      await writeFile(join(info, "alternates"), `${entry}\n`);
      await expectRefused(f.repoPath);
    }
  });

  it("refuses alternates it cannot bound or read: too large, too deep, too many, or not a file", async () => {
    const info = join(f.repoPath, ".git", "objects", "info");
    const alternates = join(info, "alternates");
    await mkdir(info, { recursive: true });
    await writeFile(alternates, `# ${"x".repeat(64 * 1024)}\n`);
    await expectRefused(f.repoPath);

    // Plain directories inside home chained through their own info/alternates, six levels deep.
    const chain = Array.from({ length: 7 }, (_, i) => join(f.homePath, "objects-chain", `level-${i}`));
    for (const [i, dir] of chain.entries()) {
      await mkdir(join(dir, "info"), { recursive: true });
      if (i + 1 < chain.length) await writeFile(join(dir, "info", "alternates"), `${chain[i + 1]}\n`);
    }
    await writeFile(alternates, `${chain[0]}\n`);
    await expectRefused(f.repoPath);
    await writeFile(alternates, `${chain[2]}\n`);
    await expect(open(f.repoPath)).resolves.toMatchObject({ objectFormat: "sha1" });
    await writeFile(alternates, `${chain[6]}\n`.repeat(65));
    await expectRefused(f.repoPath);

    await rm(alternates);
    await mkdir(alternates);
    await expectRefused(f.repoPath);
    await rm(info, { recursive: true });
    await writeFile(info, "not a directory\n");
    await expectRefused(f.repoPath);
  });

  it("refuses an alternates FIFO without waiting for a writer", { timeout: 10_000 }, async () => {
    const info = join(f.repoPath, ".git", "objects", "info");
    await mkdir(info, { recursive: true });
    await mkfifo(join(info, "alternates"));
    await expectRefused(f.repoPath);
  });
});

describe("git child environment", { timeout: 30_000 }, () => {
  let f: BrainGitFixture;
  let savedPath: string | undefined;

  beforeEach(async () => {
    f = await createBrainGitFixture();
    await f.commit({ message: "Initial commit", files: { "README.md": "readme\n" } });
    savedPath = process.env.PATH;
  });
  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await f.destroy();
  });

  it("never runs a git found through an empty or relative PATH entry", async () => {
    const planted = join(f.repoPath, "git");
    await writeFile(planted, "#!/bin/sh\nexit 3\n");
    await chmod(planted, 0o755);
    for (const path of [`:${savedPath ?? ""}`, `.:${savedPath ?? ""}`, `${savedPath ?? ""}:`]) {
      process.env.PATH = path;
      await expect(openGitRepository({
        repoPath: f.repoPath, homePath: f.homePath, runner: defaultGitRunner, limits: GIT_SYNC_DEFAULT_LIMITS,
      }), path).resolves.toMatchObject({ objectFormat: "sha1" });
    }
  });

  it("blocks every transport even when repo-local config allows one", async () => {
    expect(GIT_ENV_OVERRIDES.GIT_ALLOW_PROTOCOL).toBe("none");
    const marker = join(f.homePath, "transport-ran");
    await f.git(["config", "--local", "protocol.ext.allow", "always"]);
    await f.git(["config", "--local", "remote.origin.url", `ext::sh -c touch% ${marker}`]);
    const result = await defaultGitRunner([...GIT_GLOBAL_ARGS, "ls-remote", "origin"], {
      cwd: await realpath(f.repoPath), timeoutMs: 10_000, maxBuffer: 64 * 1024, overflow: "fail",
    });
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toContain("not allowed");
    expect(await exists(marker)).toBe(false);
  });
});
