import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_PATTERNS,
  loadSyncIgnore,
  isIgnored,
  parseSyncIgnore,
} from "../../src/lib/syncignore.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-syncignore-test");

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("DEFAULT_PATTERNS", () => {
  it("includes node_modules/", () => {
    expect(DEFAULT_PATTERNS).toContain("node_modules/");
  });

  it("includes .next/", () => {
    expect(DEFAULT_PATTERNS).toContain(".next/");
  });

  it("includes .git/", () => {
    expect(DEFAULT_PATTERNS).toContain(".git/");
  });

  it("includes .DS_Store", () => {
    expect(DEFAULT_PATTERNS).toContain(".DS_Store");
  });

  it("includes all spec-defined defaults", () => {
    const expected = [
      "node_modules/",
      ".next/",
      ".venv/",
      "__pycache__/",
      "dist/",
      "build/",
      ".cache/",
      "*.sqlite",
      "*.db",
      "system/logs/",
      "system/matrix.db*",
      ".git/",
      ".trash/",
      ".DS_Store",
      "Thumbs.db",
    ];
    for (const pattern of expected) {
      expect(DEFAULT_PATTERNS).toContain(pattern);
    }
  });
});

describe("parseSyncIgnore", () => {
  it("ignores empty lines", () => {
    const patterns = parseSyncIgnore("foo\n\nbar\n");
    expect(patterns).toEqual(["foo", "bar"]);
  });

  it("ignores comment lines starting with #", () => {
    const patterns = parseSyncIgnore("# this is a comment\nfoo\n# another\nbar");
    expect(patterns).toEqual(["foo", "bar"]);
  });

  it("trims whitespace from lines", () => {
    const patterns = parseSyncIgnore("  foo  \n  bar  ");
    expect(patterns).toEqual(["foo", "bar"]);
  });

  it("preserves negation patterns (!)", () => {
    const patterns = parseSyncIgnore("*.log\n!important.log");
    expect(patterns).toEqual(["*.log", "!important.log"]);
  });
});

describe("isIgnored", () => {
  it("matches directory patterns (trailing slash) against paths inside that directory", () => {
    const patterns = ["node_modules/"];
    expect(isIgnored("node_modules/package/index.js", patterns)).toBe(true);
    expect(isIgnored("src/index.ts", patterns)).toBe(false);
  });

  it("matches the directory itself", () => {
    const patterns = ["node_modules/"];
    expect(isIgnored("node_modules", patterns)).toBe(true);
  });

  it("matches nested directory patterns", () => {
    const patterns = ["node_modules/"];
    expect(isIgnored("packages/gateway/node_modules/ws/index.js", patterns)).toBe(true);
  });

  it("matches file glob patterns", () => {
    const patterns = ["*.sqlite"];
    expect(isIgnored("data/my.sqlite", patterns)).toBe(true);
    expect(isIgnored("my.sqlite", patterns)).toBe(true);
    expect(isIgnored("my.json", patterns)).toBe(false);
  });

  it("matches wildcard in file name", () => {
    const patterns = ["system/matrix.db*"];
    expect(isIgnored("system/matrix.db", patterns)).toBe(true);
    expect(isIgnored("system/matrix.db-wal", patterns)).toBe(true);
    expect(isIgnored("system/other.db", patterns)).toBe(false);
  });

  it("matches exact file names anywhere in tree", () => {
    const patterns = [".DS_Store"];
    expect(isIgnored(".DS_Store", patterns)).toBe(true);
    expect(isIgnored("projects/myapp/.DS_Store", patterns)).toBe(true);
    expect(isIgnored("DS_Store", patterns)).toBe(false);
  });

  it("supports negation (!) to un-ignore files", () => {
    const patterns = ["*.log", "!important.log"];
    expect(isIgnored("debug.log", patterns)).toBe(true);
    expect(isIgnored("important.log", patterns)).toBe(false);
  });

  it("negation applies to nested paths too", () => {
    const patterns = ["*.log", "!important.log"];
    expect(isIgnored("logs/debug.log", patterns)).toBe(true);
    expect(isIgnored("logs/important.log", patterns)).toBe(false);
  });

  it("handles path-specific patterns with /", () => {
    const patterns = ["system/logs/"];
    expect(isIgnored("system/logs/app.log", patterns)).toBe(true);
    expect(isIgnored("other/logs/app.log", patterns)).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(isIgnored("anything.txt", [])).toBe(false);
  });
});

describe("loadSyncIgnore", () => {
  it("loads default patterns when no .syncignore file exists", async () => {
    const patterns = await loadSyncIgnore(join(TEST_DIR, "nonexistent-dir"));
    expect(patterns).toEqual(DEFAULT_PATTERNS);
  });

  it("merges custom patterns with defaults", async () => {
    await writeFile(join(TEST_DIR, ".syncignore"), "custom-dir/\n*.tmp\n");

    const patterns = await loadSyncIgnore(TEST_DIR);

    for (const def of DEFAULT_PATTERNS) {
      expect(patterns).toContain(def);
    }
    expect(patterns).toContain("custom-dir/");
    expect(patterns).toContain("*.tmp");
  });

  it("does not duplicate default patterns if user re-specifies them", async () => {
    await writeFile(join(TEST_DIR, ".syncignore"), "node_modules/\ncustom/\n");

    const patterns = await loadSyncIgnore(TEST_DIR);

    const nodeModulesCount = patterns.filter((p) => p === "node_modules/").length;
    expect(nodeModulesCount).toBe(1);
  });

  it("preserves negation patterns from user file", async () => {
    await writeFile(join(TEST_DIR, ".syncignore"), "!dist/\n");

    const patterns = await loadSyncIgnore(TEST_DIR);

    expect(patterns).toContain("!dist/");
  });
});
