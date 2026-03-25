import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileStat } from "../../packages/gateway/src/file-ops.js";

describe("fileStat", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-stat-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "hello.md"), "# Hello World");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns metadata for a file", async () => {
    const stat = await fileStat(testDir, "hello.md");
    expect(stat).toMatchObject({
      name: "hello.md",
      path: "hello.md",
      type: "file",
      mime: "text/markdown",
    });
    expect(stat!.size).toBeGreaterThan(0);
    expect(stat!.modified).toBeDefined();
    expect(stat!.created).toBeDefined();
  });

  it("returns metadata for a directory", async () => {
    mkdirSync(join(testDir, "subdir"));
    const stat = await fileStat(testDir, "subdir");
    expect(stat).toMatchObject({
      name: "subdir",
      path: "subdir",
      type: "directory",
    });
    expect(stat!.modified).toBeDefined();
    expect(stat!.mime).toBeUndefined();
  });

  it("returns null for non-existent path", async () => {
    const stat = await fileStat(testDir, "nope.txt");
    expect(stat).toBeNull();
  });

  it("returns null for path traversal attempt", async () => {
    const stat = await fileStat(testDir, "../../../etc/passwd");
    expect(stat).toBeNull();
  });

  it("returns correct size", async () => {
    writeFileSync(join(testDir, "sized.txt"), "hello world");
    const stat = await fileStat(testDir, "sized.txt");
    expect(stat!.size).toBe(11);
  });

  it("returns nested file path correctly", async () => {
    mkdirSync(join(testDir, "deep", "dir"), { recursive: true });
    writeFileSync(join(testDir, "deep", "dir", "file.json"), "{}");
    const stat = await fileStat(testDir, "deep/dir/file.json");
    expect(stat).toMatchObject({
      name: "file.json",
      path: "deep/dir/file.json",
      type: "file",
      mime: "application/json",
    });
  });
});
