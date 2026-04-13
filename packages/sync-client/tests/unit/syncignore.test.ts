import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_PATTERNS,
  loadSyncIgnore,
  isIgnored,
  parseSyncIgnore,
  type SyncIgnorePatterns,
} from "../../src/lib/syncignore.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-syncignore-test");

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("DEFAULT_PATTERNS", () => {
  it("includes all spec-mandated defaults", () => {
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
  it("parses patterns from string content", () => {
    const content = "*.log\ntemp/\n";
    const result = parseSyncIgnore(content);

    expect(result.patterns).toContain("*.log");
    expect(result.patterns).toContain("temp/");
  });

  it("ignores empty lines", () => {
    const content = "*.log\n\n\ntemp/\n";
    const result = parseSyncIgnore(content);

    expect(result.patterns).toHaveLength(DEFAULT_PATTERNS.length + 2);
  });

  it("ignores comment lines starting with #", () => {
    const content = "# this is a comment\n*.log\n# another comment\n";
    const result = parseSyncIgnore(content);

    const nonDefault = result.patterns.filter(
      (p) => !DEFAULT_PATTERNS.includes(p),
    );
    expect(nonDefault).toEqual(["*.log"]);
  });

  it("trims whitespace from patterns", () => {
    const content = "  *.log  \n  temp/  \n";
    const result = parseSyncIgnore(content);

    expect(result.patterns).toContain("*.log");
    expect(result.patterns).toContain("temp/");
  });

  it("includes default patterns alongside custom ones", () => {
    const content = "custom-dir/\n";
    const result = parseSyncIgnore(content);

    expect(result.patterns).toContain("node_modules/");
    expect(result.patterns).toContain("custom-dir/");
  });

  it("handles negation patterns with !", () => {
    const content = "*.log\n!important.log\n";
    const result = parseSyncIgnore(content);

    expect(result.negations).toContain("important.log");
  });

  it("deduplicates patterns already in defaults", () => {
    const content = "node_modules/\ncustom/\n";
    const result = parseSyncIgnore(content);

    const nodeModulesCount = result.patterns.filter(
      (p) => p === "node_modules/",
    ).length;
    expect(nodeModulesCount).toBe(1);
  });
});

describe("isIgnored", () => {
  let defaultPatterns: SyncIgnorePatterns;

  beforeAll(() => {
    defaultPatterns = parseSyncIgnore("");
  });

  it("ignores node_modules/ directory", () => {
    expect(isIgnored("node_modules/package.json", defaultPatterns)).toBe(true);
    expect(isIgnored("node_modules", defaultPatterns)).toBe(true);
  });

  it("ignores nested node_modules/", () => {
    expect(
      isIgnored("packages/gateway/node_modules/ws/index.js", defaultPatterns),
    ).toBe(true);
  });

  it("ignores .next/ directory", () => {
    expect(isIgnored(".next/cache/data.json", defaultPatterns)).toBe(true);
  });

  it("ignores .git/ directory", () => {
    expect(isIgnored(".git/HEAD", defaultPatterns)).toBe(true);
  });

  it("ignores .DS_Store files", () => {
    expect(isIgnored(".DS_Store", defaultPatterns)).toBe(true);
    expect(isIgnored("subfolder/.DS_Store", defaultPatterns)).toBe(true);
  });

  it("ignores Thumbs.db files", () => {
    expect(isIgnored("Thumbs.db", defaultPatterns)).toBe(true);
    expect(isIgnored("images/Thumbs.db", defaultPatterns)).toBe(true);
  });

  it("ignores *.sqlite files", () => {
    expect(isIgnored("data/app.sqlite", defaultPatterns)).toBe(true);
  });

  it("ignores *.db files", () => {
    expect(isIgnored("data/cache.db", defaultPatterns)).toBe(true);
  });

  it("ignores system/logs/ directory", () => {
    expect(isIgnored("system/logs/sync.log", defaultPatterns)).toBe(true);
  });

  it("ignores system/matrix.db* patterns", () => {
    expect(isIgnored("system/matrix.db", defaultPatterns)).toBe(true);
    expect(isIgnored("system/matrix.db-wal", defaultPatterns)).toBe(true);
    expect(isIgnored("system/matrix.db-shm", defaultPatterns)).toBe(true);
  });

  it("ignores .trash/ directory", () => {
    expect(isIgnored(".trash/deleted-file.txt", defaultPatterns)).toBe(true);
  });

  it("ignores dist/ directory", () => {
    expect(isIgnored("dist/index.js", defaultPatterns)).toBe(true);
  });

  it("ignores build/ directory", () => {
    expect(isIgnored("build/output.css", defaultPatterns)).toBe(true);
  });

  it("ignores .cache/ directory", () => {
    expect(isIgnored(".cache/data.json", defaultPatterns)).toBe(true);
  });

  it("ignores .venv/ directory", () => {
    expect(isIgnored(".venv/bin/python", defaultPatterns)).toBe(true);
  });

  it("ignores __pycache__/ directory", () => {
    expect(isIgnored("__pycache__/module.pyc", defaultPatterns)).toBe(true);
  });

  it("does NOT ignore normal files", () => {
    expect(isIgnored("src/index.ts", defaultPatterns)).toBe(false);
    expect(isIgnored("README.md", defaultPatterns)).toBe(false);
    expect(isIgnored("apps/calculator/index.html", defaultPatterns)).toBe(false);
  });

  it("respects negation patterns", () => {
    const patterns = parseSyncIgnore("*.log\n!important.log\n");

    expect(isIgnored("debug.log", patterns)).toBe(true);
    expect(isIgnored("important.log", patterns)).toBe(false);
  });

  it("handles custom directory patterns", () => {
    const patterns = parseSyncIgnore("vendor/\n");

    expect(isIgnored("vendor/lib/thing.js", patterns)).toBe(true);
    expect(isIgnored("src/vendor-utils.ts", patterns)).toBe(false);
  });

  it("handles custom glob patterns", () => {
    const patterns = parseSyncIgnore("*.tmp\n*.bak\n");

    expect(isIgnored("file.tmp", patterns)).toBe(true);
    expect(isIgnored("nested/dir/file.bak", patterns)).toBe(true);
    expect(isIgnored("file.txt", patterns)).toBe(false);
  });
});

describe("loadSyncIgnore", () => {
  it("returns defaults when .syncignore file does not exist", async () => {
    const nonexistentDir = join(TEST_DIR, "no-such-dir");
    await mkdir(nonexistentDir, { recursive: true });
    const patterns = await loadSyncIgnore(nonexistentDir);

    expect(patterns.patterns.length).toBeGreaterThanOrEqual(
      DEFAULT_PATTERNS.length,
    );
    for (const p of DEFAULT_PATTERNS) {
      expect(patterns.patterns).toContain(p);
    }
  });

  it("loads and merges custom patterns from .syncignore file", async () => {
    const subDir = join(TEST_DIR, "with-syncignore");
    await mkdir(subDir, { recursive: true });
    const syncignorePath = join(subDir, ".syncignore");
    await writeFile(syncignorePath, "custom-dir/\n*.backup\n");

    const patterns = await loadSyncIgnore(subDir);

    expect(patterns.patterns).toContain("custom-dir/");
    expect(patterns.patterns).toContain("*.backup");
    expect(patterns.patterns).toContain("node_modules/");
  });

  it("handles .syncignore with only comments and empty lines", async () => {
    const subDir = join(TEST_DIR, "comments-only");
    await mkdir(subDir, { recursive: true });
    const syncignorePath = join(subDir, ".syncignore");
    await writeFile(syncignorePath, "# just a comment\n\n# another\n");

    const patterns = await loadSyncIgnore(subDir);

    expect(patterns.patterns.length).toBe(DEFAULT_PATTERNS.length);
  });
});
