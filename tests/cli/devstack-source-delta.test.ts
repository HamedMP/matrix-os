import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDevstackSourceDelta } from "../../packages/platform/src/devstack-source-delta.js";
import { collectDevstackSourceDelta } from "../../packages/sync-client/src/cli/commands/devstack-source-delta.js";

const exec = promisify(execFile);
const encode = (value: string) => Buffer.from(value).toString("base64");
let root: string;
let base: string;

function git(...args: string[]) {
  return exec("git", ["-C", root, ...args], { timeout: 5_000 });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "matrix-devstack-delta-")));
  await git("init", "--quiet");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "edit.txt"), "original");
  await writeFile(join(root, "remove.txt"), "remove this");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o644 });
  await writeFile(join(root, "tracked.pem"), "old secret");
  await git("add", ".");
  await git("-c", "user.name=DevStack", "-c", "user.email=devstack@example.test", "commit", "--quiet", "-m", "base");
  base = (await git("rev-parse", "HEAD")).stdout.trim();
});
afterEach(async () => { await rm(root, { force: true, recursive: true }); });

describe("DevStack source delta", () => {
  it("captures current staged and unstaged bytes, executable changes, additions, and deletions", async () => {
    await writeFile(join(root, "edit.txt"), "staged");
    await git("add", "edit.txt");
    await writeFile(join(root, "edit.txt"), "working tree");
    await rename(join(root, "remove.txt"), join(root, "renamed source.txt"));
    await git("config", "core.fileMode", "false");
    await chmod(join(root, "run.sh"), 0o755);
    await writeFile(join(root, "staged addition.txt"), "new");
    await git("add", "staged addition.txt");
    const expected = {
      base,
      entries: [
        { path: "edit.txt", kind: "file", mode: 420, content: encode("working tree") },
        { path: "remove.txt", kind: "delete" },
        { path: "renamed source.txt", kind: "file", mode: 420, content: encode("remove this") },
        { path: "run.sh", kind: "file", mode: 493, content: encode("#!/bin/sh\n") },
        { path: "staged addition.txt", kind: "file", mode: 420, content: encode("new") },
      ],
    };
    const delta = await collectDevstackSourceDelta(root);
    expect(delta).toEqual(expected);
    expect(parseDevstackSourceDelta(JSON.parse(JSON.stringify(delta)))).toEqual(expected);
    await expect(collectDevstackSourceDelta(root)).resolves.toEqual(expected);
    expect((await git("show", ":edit.txt")).stdout).toBe("staged");
  });

  it("excludes Git, ignored, generated, and sensitive data including tracked files", async () => {
    await writeFile(join(root, ".env.local"), "not source");
    await mkdir(join(root, ".ſsh"));
    await writeFile(join(root, ".ſsh", "config"), "not source");
    await writeFile(join(root, ".git", "private-operator.log"), "not source");
    await writeFile(join(root, "ignored.txt"), "not source");
    await writeFile(join(root, "tracked.pem"), "not source");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "build.js"), "not source");
    await writeFile(join(root, "hello.txt"), "source");
    await expect(collectDevstackSourceDelta(root)).resolves.toEqual({
      base, entries: [{ path: "hello.txt", kind: "file", mode: 420, content: encode("source") }],
    });
  });

  it("rejects symlinks and replacements that collide with an existing file path", async () => {
    await symlink("edit.txt", join(root, "linked"));
    await expect(collectDevstackSourceDelta(root)).rejects.toThrow(/symbolic links/i);
    await unlink(join(root, "linked"));
    await unlink(join(root, "edit.txt"));
    await mkdir(join(root, "edit.txt"));
    await writeFile(join(root, "edit.txt", "child"), "nested");
    await expect(collectDevstackSourceDelta(root)).rejects.toThrow(/file and directory/i);
  });

  it("rejects a staged deletion of a baseline symlink", async () => {
    await symlink("edit.txt", join(root, "linked"));
    await git("add", "linked");
    await git("-c", "user.name=DevStack", "-c", "user.email=devstack@example.test", "commit", "--quiet", "-m", "link");
    await git("rm", "linked");
    await expect(collectDevstackSourceDelta(root)).rejects.toThrow(/symbolic links/i);
  });

  it("rejects an oversized delta before sending content", async () => {
    await writeFile(join(root, "large.bin"), Buffer.alloc(4 * 1024 * 1024));
    await expect(collectDevstackSourceDelta(root)).rejects.toThrow(/4 MiB/i);
  });

  it("rejects path names the Platform cannot apply", async () => {
    await writeFile(join(root, "source:invalid.txt"), "source");
    await expect(collectDevstackSourceDelta(root)).rejects.toThrow(/unsupported path/i);
  });

  it("rejects hidden index changes", async () => {
    await git("update-index", "--assume-unchanged", "edit.txt");
    await writeFile(join(root, "edit.txt"), "would be missed");
    await expect(collectDevstackSourceDelta(root)).rejects.toThrow(/no hidden paths/i);
  });

  it("treats a staged addition removed from the worktree as no change against HEAD", async () => {
    await writeFile(join(root, "staged.txt"), "no longer here");
    await git("add", "staged.txt");
    await unlink(join(root, "staged.txt"));
    await expect(collectDevstackSourceDelta(root)).resolves.toEqual({ base, entries: [] });
  });
});
