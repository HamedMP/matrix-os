import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createGitSync, createAutoSync, type GitSync, type AutoSync } from "../../packages/gateway/src/git-sync.js";

function tmpGitRepo(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "git-sync-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  writeFileSync(join(dir, "system", "state.md"), "initial");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function tmpBareRemote(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "git-remote-")));
  execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("T220: GitSync", () => {
  let homePath: string;
  let sync: GitSync;

  beforeEach(() => {
    homePath = tmpGitRepo();
    sync = createGitSync(homePath);
  });

  afterEach(() => {
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("status() returns clean state after init", async () => {
    const status = await sync.status();
    expect(status.clean).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("status() detects uncommitted changes", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "modified");
    const status = await sync.status();
    expect(status.clean).toBe(false);
  });

  it("commit() creates a commit with changed files", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "updated");
    const result = await sync.commit("test commit");
    expect(result.success).toBe(true);

    const status = await sync.status();
    expect(status.clean).toBe(true);
  });

  it("commit() returns success:false when nothing to commit", async () => {
    const result = await sync.commit("empty commit");
    expect(result.success).toBe(false);
  });

  it("addRemote() adds a git remote", async () => {
    const remote = tmpBareRemote();
    await sync.addRemote("origin", remote);
    const output = execFileSync("git", ["remote", "-v"], { cwd: homePath, encoding: "utf-8" });
    expect(output).toContain("origin");
    rmSync(remote, { recursive: true, force: true });
  });

  it("removeRemote() removes a git remote", async () => {
    const remote = tmpBareRemote();
    await sync.addRemote("backup", remote);
    await sync.removeRemote("backup");
    const output = execFileSync("git", ["remote", "-v"], { cwd: homePath, encoding: "utf-8" });
    expect(output).not.toContain("backup");
    rmSync(remote, { recursive: true, force: true });
  });

  it("push() pushes to remote", async () => {
    const remote = tmpBareRemote();
    await sync.addRemote("origin", remote);

    writeFileSync(join(homePath, "test.txt"), "hello");
    await sync.commit("add test file");
    const result = await sync.push("origin");
    expect(result.success).toBe(true);

    rmSync(remote, { recursive: true, force: true });
  });

  it("pull() pulls from remote", async () => {
    const remote = tmpBareRemote();
    // Set up: push from homePath, clone elsewhere, push a change, pull into homePath
    await sync.addRemote("origin", remote);
    await sync.push("origin");

    // Clone and make a change
    const clone = resolve(mkdtempSync(join(tmpdir(), "git-clone-")));
    execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
    writeFileSync(join(clone, "new-file.txt"), "from clone");
    execFileSync("git", ["add", "."], { cwd: clone, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "remote change"], { cwd: clone, stdio: "ignore" });
    execFileSync("git", ["push"], { cwd: clone, stdio: "ignore" });

    // Pull into original
    const result = await sync.pull("origin");
    expect(result.success).toBe(true);
    expect(existsSync(join(homePath, "new-file.txt"))).toBe(true);

    rmSync(remote, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  it("status() shows ahead/behind counts with remote", async () => {
    const remote = tmpBareRemote();
    await sync.addRemote("origin", remote);
    await sync.push("origin");

    // Make a local commit
    writeFileSync(join(homePath, "local.txt"), "local");
    await sync.commit("local change");

    const status = await sync.status();
    expect(status.ahead).toBe(1);

    rmSync(remote, { recursive: true, force: true });
  });

  it("commit() uses .gitignore patterns", async () => {
    writeFileSync(join(homePath, ".gitignore"), "*.sqlite\nsystem/logs/\n");
    writeFileSync(join(homePath, "data.sqlite"), "db");
    mkdirSync(join(homePath, "system", "logs"), { recursive: true });
    writeFileSync(join(homePath, "system", "logs", "today.jsonl"), "log");

    await sync.commit("add gitignore");

    // Verify ignored files are not tracked
    const tracked = execFileSync("git", ["ls-files"], { cwd: homePath, encoding: "utf-8" });
    expect(tracked).not.toContain("data.sqlite");
    expect(tracked).not.toContain("today.jsonl");
    expect(tracked).toContain(".gitignore");
  });
});
