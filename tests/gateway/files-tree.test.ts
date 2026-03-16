import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listDirectory, clearGitStatusCache } from "../../packages/gateway/src/files-tree.js";
import { execFileSync } from "node:child_process";

const TEST_HOME = join(import.meta.dirname ?? __dirname, ".tmp-files-tree-test");

function setupTestDir() {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(join(TEST_HOME, "projects", "myapp", "src"), { recursive: true });
  writeFileSync(join(TEST_HOME, "projects", "myapp", "index.ts"), "export {}");
  writeFileSync(join(TEST_HOME, "projects", "myapp", "README.md"), "# App");
  writeFileSync(join(TEST_HOME, "projects", "myapp", "src", "main.ts"), "console.log('hi')");
  mkdirSync(join(TEST_HOME, "projects", "myapp", "tests"), { recursive: true });

  execFileSync("git", ["init"], { cwd: TEST_HOME });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: TEST_HOME });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: TEST_HOME });
  execFileSync("git", ["add", "."], { cwd: TEST_HOME });
  execFileSync("git", ["commit", "-m", "init"], { cwd: TEST_HOME });
}

describe("listDirectory", () => {
  beforeEach(() => {
    setupTestDir();
    clearGitStatusCache();
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("lists directory contents sorted: dirs first, then files", async () => {
    const result = await listDirectory(TEST_HOME, "projects/myapp");
    expect(result).not.toBeNull();

    const names = result!.map((e) => e.name);
    expect(names).toEqual(["src", "tests", "index.ts", "README.md"]);
  });

  it("returns correct types", async () => {
    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;

    const src = result.find((e) => e.name === "src");
    expect(src?.type).toBe("directory");

    const index = result.find((e) => e.name === "index.ts");
    expect(index?.type).toBe("file");
    expect(index?.size).toBeGreaterThan(0);
  });

  it("shows git status for modified files", async () => {
    writeFileSync(join(TEST_HOME, "projects", "myapp", "index.ts"), "export const x = 1");

    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;
    const index = result.find((e) => e.name === "index.ts");
    expect(index?.gitStatus).toBe("modified");
  });

  it("shows git status for untracked files", async () => {
    writeFileSync(join(TEST_HOME, "projects", "myapp", "newfile.ts"), "new");

    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;
    const newFile = result.find((e) => e.name === "newfile.ts");
    expect(newFile?.gitStatus).toBe("untracked");
  });

  it("shows changedCount for directories", async () => {
    writeFileSync(join(TEST_HOME, "projects", "myapp", "src", "main.ts"), "changed");
    writeFileSync(join(TEST_HOME, "projects", "myapp", "src", "extra.ts"), "new");

    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;
    const src = result.find((e) => e.name === "src");
    expect(src?.changedCount).toBeGreaterThanOrEqual(1);
  });

  it("directories have gitStatus null", async () => {
    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;
    const dirs = result.filter((e) => e.type === "directory");
    for (const dir of dirs) {
      expect(dir.gitStatus).toBeNull();
    }
  });

  it("returns null for path traversal attempts", async () => {
    expect(await listDirectory(TEST_HOME, "../../etc")).toBeNull();
  });

  it("returns null for nonexistent paths", async () => {
    expect(await listDirectory(TEST_HOME, "does/not/exist")).toBeNull();
  });

  it("hides dotfiles", async () => {
    writeFileSync(join(TEST_HOME, "projects", "myapp", ".hidden"), "secret");
    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;
    const hidden = result.find((e) => e.name === ".hidden");
    expect(hidden).toBeUndefined();
  });

  it("lists root directory", async () => {
    const result = await listDirectory(TEST_HOME, "");
    expect(result).not.toBeNull();
    const names = result!.map((e) => e.name);
    expect(names).toContain("projects");
  });

  it("clean files have null gitStatus", async () => {
    const result = (await listDirectory(TEST_HOME, "projects/myapp"))!;
    const readme = result.find((e) => e.name === "README.md");
    expect(readme?.gitStatus).toBeNull();
  });
});
