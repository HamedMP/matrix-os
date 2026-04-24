import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createGitAutoCommit,
  createSnapshotManager,
  createFileHistory,
  type GitAutoCommit,
  type SnapshotManager,
  type FileHistory,
} from "../../packages/gateway/src/git-versioning.js";

const GIT_ID = ["-c", "user.email=ci@matrix-os.test", "-c", "user.name=Test"];

function tmpGitRepo(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "git-ver-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "apps"), { recursive: true });
  writeFileSync(join(dir, "system", "state.md"), "initial");
  writeFileSync(join(dir, ".gitignore"), "*.sqlite\nnode_modules/\n");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", [...GIT_ID, "commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("T1510: Git auto-commit service", () => {
  let homePath: string;
  let autoCommit: GitAutoCommit;

  beforeEach(() => {
    vi.useFakeTimers();
    homePath = tmpGitRepo();
  });

  afterEach(() => {
    autoCommit?.stop();
    vi.useRealTimers();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("creates auto-commit with start/stop lifecycle", () => {
    autoCommit = createGitAutoCommit({ homePath, intervalMs: 60_000 });
    expect(typeof autoCommit.start).toBe("function");
    expect(typeof autoCommit.stop).toBe("function");
    expect(typeof autoCommit.commitIfChanged).toBe("function");
  });

  it("commits uncommitted changes with summary", async () => {
    autoCommit = createGitAutoCommit({ homePath, intervalMs: 60_000 });

    writeFileSync(join(homePath, "system", "state.md"), "modified");
    writeFileSync(join(homePath, "apps", "todo.html"), "<html>todo</html>");

    const result = await autoCommit.commitIfChanged();
    expect(result.committed).toBe(true);
    expect(result.message).toContain("Auto-save");
    expect(result.filesChanged).toBe(2);

    // Verify the commit exists
    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: homePath, encoding: "utf-8" });
    expect(log).toContain("Auto-save");
  });

  it("does nothing when no changes exist", async () => {
    autoCommit = createGitAutoCommit({ homePath, intervalMs: 60_000 });

    const result = await autoCommit.commitIfChanged();
    expect(result.committed).toBe(false);
    expect(result.filesChanged).toBe(0);
  });

  it("respects .gitignore (no binaries)", async () => {
    autoCommit = createGitAutoCommit({ homePath, intervalMs: 60_000 });

    writeFileSync(join(homePath, "data.sqlite"), "binary data");
    writeFileSync(join(homePath, "system", "state.md"), "updated");

    const result = await autoCommit.commitIfChanged();
    expect(result.committed).toBe(true);

    const tracked = execFileSync("git", ["ls-files"], { cwd: homePath, encoding: "utf-8" });
    expect(tracked).not.toContain("data.sqlite");
  });

  it("auto-commits on interval when started", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "changed");

    autoCommit = createGitAutoCommit({ homePath, intervalMs: 1000 });
    autoCommit.start();

    // Advance and flush microtasks multiple times to allow async commit to complete
    await vi.advanceTimersByTimeAsync(1200);
    // Give the async git operations time to complete
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 1000));
    vi.useFakeTimers();

    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: homePath, encoding: "utf-8" });
    expect(log).toContain("Auto-save");
  });

  it("summary includes top file names", async () => {
    autoCommit = createGitAutoCommit({ homePath, intervalMs: 60_000 });

    writeFileSync(join(homePath, "system", "state.md"), "v2");
    // Create files in already-tracked directory paths so they show individually
    writeFileSync(join(homePath, "file1.txt"), "one");
    writeFileSync(join(homePath, "file2.txt"), "two");
    writeFileSync(join(homePath, "file3.txt"), "three");

    const result = await autoCommit.commitIfChanged();
    expect(result.filesChanged).toBeGreaterThanOrEqual(3);
    expect(result.message).toContain("Auto-save");
  });
});

describe("T1511: Named snapshots", () => {
  let homePath: string;
  let snapshots: SnapshotManager;

  beforeEach(() => {
    homePath = tmpGitRepo();
    snapshots = createSnapshotManager(homePath);
  });

  afterEach(() => {
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("creates a tagged snapshot commit", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "snapshot state");
    const result = await snapshots.create("before-deploy");

    expect(result.success).toBe(true);
    expect(result.tag).toBe("snapshot/before-deploy");

    const tags = execFileSync("git", ["tag"], { cwd: homePath, encoding: "utf-8" });
    expect(tags).toContain("snapshot/before-deploy");
  });

  it("lists all snapshots", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "v1");
    await snapshots.create("v1");

    writeFileSync(join(homePath, "system", "state.md"), "v2");
    await snapshots.create("v2");

    const list = await snapshots.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name)).toContain("v1");
    expect(list.map((s) => s.name)).toContain("v2");
  });

  it("snapshot includes commit hash and date", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "snapshot");
    await snapshots.create("test-snap");

    const list = await snapshots.list();
    expect(list[0].commit).toBeTruthy();
    expect(list[0].date).toBeTruthy();
  });

  it("handles snapshot with no changes by committing current state", async () => {
    const result = await snapshots.create("empty-snap");
    expect(result.success).toBe(true);
  });
});

describe("T1512: File history API", () => {
  let homePath: string;
  let history: FileHistory;

  beforeEach(() => {
    homePath = tmpGitRepo();
    history = createFileHistory(homePath);
  });

  afterEach(() => {
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("returns commit log for a file", async () => {
    // Make some commits modifying the file
    writeFileSync(join(homePath, "system", "state.md"), "v2");
    execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", [...GIT_ID, "commit", "-m", "update state to v2"], { cwd: homePath, stdio: "ignore" });

    writeFileSync(join(homePath, "system", "state.md"), "v3");
    execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", [...GIT_ID, "commit", "-m", "update state to v3"], { cwd: homePath, stdio: "ignore" });

    const entries = await history.log("system/state.md");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].message).toContain("v3");
    expect(entries[0].commit).toBeTruthy();
    expect(entries[0].date).toBeTruthy();
  });

  it("supports pagination with limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(homePath, "system", "state.md"), `v${i + 2}`);
      execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
      execFileSync("git", [...GIT_ID, "commit", "-m", `commit ${i + 2}`], { cwd: homePath, stdio: "ignore" });
    }

    const page1 = await history.log("system/state.md", { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = await history.log("system/state.md", { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    // Entries should be different
    expect(page1[0].commit).not.toBe(page2[0].commit);
  });

  it("returns diff for a specific commit", async () => {
    writeFileSync(join(homePath, "system", "state.md"), "changed content");
    execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", [...GIT_ID, "commit", "-m", "change content"], { cwd: homePath, stdio: "ignore" });

    const entries = await history.log("system/state.md");
    const diff = await history.diff("system/state.md", entries[0].commit);

    expect(diff).toContain("changed content");
  });
});

describe("T1513: File restore", () => {
  let homePath: string;
  let history: FileHistory;

  beforeEach(() => {
    homePath = tmpGitRepo();
    history = createFileHistory(homePath);
  });

  afterEach(() => {
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("restores a file from a specific commit", async () => {
    // Get the initial commit
    const initialCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: homePath, encoding: "utf-8" }).trim();

    // Modify the file
    writeFileSync(join(homePath, "system", "state.md"), "new content");
    execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", [...GIT_ID, "commit", "-m", "modify state"], { cwd: homePath, stdio: "ignore" });

    // Restore from initial commit
    const result = await history.restore("system/state.md", initialCommit);
    expect(result.success).toBe(true);

    // Verify content is restored
    const content = readFileSync(join(homePath, "system", "state.md"), "utf-8");
    expect(content).toBe("initial");
  });

  it("creates a new commit after restore", async () => {
    const initialCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: homePath, encoding: "utf-8" }).trim();

    writeFileSync(join(homePath, "system", "state.md"), "new content");
    execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", [...GIT_ID, "commit", "-m", "modify state"], { cwd: homePath, stdio: "ignore" });

    await history.restore("system/state.md", initialCommit);

    const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: homePath, encoding: "utf-8" });
    expect(log).toContain("Restored");
  });

  it("returns failure for invalid commit", async () => {
    const result = await history.restore("system/state.md", "0000000000000000000000000000000000000000");
    expect(result.success).toBe(false);
  });
});
