import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalWorktree, inspectSource, projectSource } from "../../scripts/devstack/source-projection.mjs";

let fixture: string;
let worktree: string;
let destination: string;
let statePath: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: worktree, encoding: "utf8" });
}

async function put(path: string, contents: string, mode?: number) {
  const target = join(worktree, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { mode });
}

function project() {
  return projectSource({ worktree, destination, statePath });
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "matrix-devstack-projection-"));
  worktree = join(fixture, "worktree");
  destination = join(fixture, "projection");
  statePath = join(fixture, "manifest.json");
  await mkdir(worktree);
  git("init", "-q");
  git("config", "user.email", "projection-test@example.test");
  git("config", "user.name", "Projection Test");
});

afterEach(async () => rm(fixture, { force: true, recursive: true }));

describe("DevStack source projection", () => {
  it("reads the working tree, transfers eligible files and excludes local or generated data", async () => {
    await put(".gitignore", "ignored.txt\n");
    await put("packages/one.ts", "staged");
    await put("packages/skip.pem", "fake key");
    await put("shell/next-env.d.ts", "generated");
    await put(".env.local", "fake secret");
    await put("node_modules/pkg/index.js", "dependency");
    git("add", ".");
    await put("packages/one.ts", "working tree bytes");
    await put("shell/has spaces.ts", "untracked");
    await put("ignored.txt", "ignored");
    await put("bin/dev", "#!/bin/sh\n", 0o755);
    await symlink("../packages/one.ts", join(worktree, "shell", "safe-link"));
    await symlink("../.env.local", join(worktree, "shell", "secret-link"));
    await symlink("../outside", join(worktree, "external-link"));
    await writeFile(join(fixture, "outside"), "outside");
    const gitBefore = git("status", "--porcelain=v1", "-z");

    const summary = await inspectSource({ worktree });
    expect(summary.paths).toEqual([
      ".gitignore", "bin/dev", "packages/one.ts", "shell/has spaces.ts", "shell/safe-link",
    ]);
    expect(summary.excluded).toMatchObject({ sensitive: 2, generated: 2, unsafeLink: 2 });
    expect(await canonicalWorktree(join(worktree, "shell"))).toBe(summary.worktree);
    expect(await project()).toMatchObject({ files: 5, updated: 5, removed: 0 });
    expect(await readFile(join(destination, "packages/one.ts"), "utf8")).toBe("working tree bytes");
    expect(await readFile(join(destination, "shell/has spaces.ts"), "utf8")).toBe("untracked");
    expect(await readlink(join(destination, "shell/safe-link"))).toBe("../packages/one.ts");
    expect((await lstat(join(destination, "bin/dev"))).mode & 0o111).toBe(0o111);
    for (const path of [".git", ".env.local", "ignored.txt", "shell/next-env.d.ts", "shell/secret-link"]) {
      await expect(lstat(join(destination, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(git("status", "--porcelain=v1", "-z")).toBe(gitBefore);
    expect(await project()).toMatchObject({ files: 5, updated: 0, removed: 0 });
  });

  it("excludes hardlinks and links that would cross or disappear from the source boundary", async () => {
    await put("safe.ts", "source");
    await put("kept/only.pem", "excluded");
    await mkdir(join(fixture, "external", "sub"), { recursive: true });
    const externalFile = join(fixture, "external", "safe.ts");
    await writeFile(externalFile, "outside the worktree");
    await link(externalFile, join(worktree, "hardlink.ts"));
    await symlink(join(fixture, "external", "sub"), join(worktree, "escape"));
    await symlink("escape/../safe.ts", join(worktree, "masked-link"));
    await symlink("kept", join(worktree, "directory-link"));
    await expect(inspectSource({ worktree })).resolves.toMatchObject({
      paths: ["safe.ts"],
      excluded: { sensitive: 1, unsafeLink: 3, unsupported: 1 },
    });
  });

  it("applies file renames and deletions only to the managed projection", async () => {
    await put("folder/old.ts", "original");
    await put("remove.ts", "remove");
    git("add", ".");
    await project();
    await writeFile(join(destination, "runtime-state"), "preserve me");
    await mkdir(join(worktree, "new-folder"));
    await rename(join(worktree, "folder/old.ts"), join(worktree, "new-folder/new.ts"));
    await rm(join(worktree, "remove.ts"));
    await rm(join(worktree, "folder"), { recursive: true });

    expect(await project()).toMatchObject({ files: 1, updated: 1, removed: 2, excluded: { unsafeLink: 0 } });
    await expect(readFile(join(destination, "new-folder/new.ts"), "utf8")).resolves.toBe("original");
    await expect(lstat(join(destination, "folder/old.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(destination, "remove.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(destination, "runtime-state"), "utf8")).resolves.toBe("preserve me");
  });

  it("handles managed directory and file transitions in both directions", async () => {
    await put("source/child", "directory");
    git("add", ".");
    await project();
    await rm(join(worktree, "source"), { recursive: true });
    await put("source", "file");
    expect(await project()).toMatchObject({ files: 1, updated: 1, removed: 1 });
    await expect(readFile(join(destination, "source"), "utf8")).resolves.toBe("file");
    await rm(join(worktree, "source"));
    await put("source/child", "directory again");
    expect(await project()).toMatchObject({ files: 1, updated: 1, removed: 1 });
    await expect(readFile(join(destination, "source/child"), "utf8")).resolves.toBe("directory again");
  });

  it("retries an interrupted transition without deleting an unmanaged blocker", async () => {
    await put("source/child", "managed");
    git("add", ".");
    await project();
    const blocker = join(destination, "source", "runtime-state");
    await writeFile(blocker, "outside the projection");
    await rm(join(worktree, "source"), { recursive: true });
    await put("source", "new source file");
    await expect(project()).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(await readFile(blocker, "utf8")).toBe("outside the projection");
    await rm(blocker);

    await expect(project()).resolves.toMatchObject({ files: 1, updated: 1 });
    expect(await readFile(join(destination, "source"), "utf8")).toBe("new source file");
  });

  it("fails before touching unmanaged files or following destination symlink parents", async () => {
    await put("existing.ts", "projected");
    git("add", ".");
    await project();
    await writeFile(join(destination, "collision.ts"), "unmanaged");
    await put("collision.ts", "source");
    await expect(project()).rejects.toThrow(/unmanaged/i);
    await expect(readFile(join(destination, "collision.ts"), "utf8")).resolves.toBe("unmanaged");
    await rm(join(worktree, "collision.ts"));
    const outside = join(fixture, "outside");
    await mkdir(outside);
    await symlink(outside, join(destination, "foreign"));
    await put("foreign/escape.ts", "source");
    await expect(project()).rejects.toThrow(/unmanaged|symbolic link/i);
    await expect(lstat(join(outside, "escape.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can explicitly rematerialize managed files without touching local Git or unmanaged data", async () => {
    await put("app.ts", "staged");
    git("add", ".");
    await put("app.ts", "unstaged");
    await put("new.ts", "untracked");
    await project();
    await writeFile(join(destination, "runtime-state"), "keep");
    const before = await lstat(join(destination, "app.ts"));
    const gitBefore = git("status", "--porcelain=v1", "-z");
    await expect(projectSource({ worktree, destination, statePath, force: true }))
      .resolves.toMatchObject({ files: 2, updated: 2, removed: 0 });
    expect((await lstat(join(destination, "app.ts"))).ino).not.toBe(before.ino);
    expect(await readFile(join(destination, "app.ts"), "utf8")).toBe("unstaged");
    expect(await readFile(join(destination, "new.ts"), "utf8")).toBe("untracked");
    expect(await readFile(join(destination, "runtime-state"), "utf8")).toBe("keep");
    expect(git("status", "--porcelain=v1", "-z")).toBe(gitBefore);
  });

  it("does not adopt a nonempty initial root or allow overlapping roots", async () => {
    await put("code.ts", "projected");
    await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, "prior-state"), "preserved");
    await expect(project()).rejects.toThrow(/empty/i);
    await expect(projectSource({
      worktree, destination: join(worktree, "projection"), statePath,
    })).rejects.toThrow(/overlap/i);
    await expect(lstat(join(worktree, "projection"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ambiguous bidi paths before writing the projection", async () => {
    await put("packages/source\u202e.ts", "do not display or transfer");
    await expect(project()).rejects.toThrow(/unsupported DevStack source path/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
