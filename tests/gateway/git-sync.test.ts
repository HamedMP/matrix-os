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

describe("T221: AutoSync", () => {
  let homePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    homePath = tmpGitRepo();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("skips ignored paths (activity.log, logs/)", () => {
    const auto = createAutoSync(createGitSync(homePath), { debounceMs: 30_000 });
    expect(auto.shouldSync("system/activity.log")).toBe(false);
    expect(auto.shouldSync("system/logs/2026-02-13.jsonl")).toBe(false);
    expect(auto.shouldSync("system/state.md")).toBe(true);
    expect(auto.shouldSync("apps/todo/index.html")).toBe(true);
    auto.stop();
  });

  it("debounces multiple changes into one commit", async () => {
    const sync = createGitSync(homePath);
    const commitSpy = vi.spyOn(sync, "commit").mockResolvedValue({ success: true, message: "ok" });
    vi.spyOn(sync, "status").mockResolvedValue({ clean: true, ahead: 0, behind: 0, branch: "main", hasRemote: false });
    const auto = createAutoSync(sync, { debounceMs: 5_000 });

    auto.onChange("system/state.md");
    auto.onChange("apps/todo/index.html");
    auto.onChange("system/user.md");

    expect(commitSpy).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(6_000);

    expect(commitSpy).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it("resets debounce timer on new changes", async () => {
    const sync = createGitSync(homePath);
    const commitSpy = vi.spyOn(sync, "commit").mockResolvedValue({ success: true, message: "ok" });
    vi.spyOn(sync, "status").mockResolvedValue({ clean: true, ahead: 0, behind: 0, branch: "main", hasRemote: false });
    const auto = createAutoSync(sync, { debounceMs: 5_000 });

    auto.onChange("system/state.md");
    await vi.advanceTimersByTimeAsync(3_000);

    // New change resets the timer
    auto.onChange("apps/new.html");
    await vi.advanceTimersByTimeAsync(3_000);

    // Still hasn't fired (only 3s since last change)
    expect(commitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it("stop() clears pending timer", async () => {
    const sync = createGitSync(homePath);
    const commitSpy = vi.spyOn(sync, "commit");
    const auto = createAutoSync(sync, { debounceMs: 5_000 });

    auto.onChange("system/state.md");
    auto.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(commitSpy).not.toHaveBeenCalled();
  });
});
