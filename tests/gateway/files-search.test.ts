import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileSearch } from "../../packages/gateway/src/file-search.js";

describe("fileSearch", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-search-test-${Date.now()}`);
    mkdirSync(join(testDir, "agents", "skills"), { recursive: true });
    mkdirSync(join(testDir, "system"), { recursive: true });
    writeFileSync(join(testDir, "readme.md"), "# Welcome to Matrix OS");
    writeFileSync(
      join(testDir, "agents", "builder.md"),
      "# Builder Agent\nBuilds stuff",
    );
    writeFileSync(
      join(testDir, "agents", "skills", "study-timer.md"),
      "# Study Timer\nA skill for studying",
    );
    writeFileSync(
      join(testDir, "system", "config.json"),
      '{"telegram": {"token": "abc"}}',
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("searches file names", async () => {
    const result = await fileSearch(testDir, { q: "builder" });
    expect(result.results.length).toBeGreaterThan(0);
    const builderResult = result.results.find((r) => r.name === "builder.md");
    expect(builderResult).toBeDefined();
    expect(builderResult!.matches.some((m) => m.type === "name")).toBe(true);
  });

  it("searches file contents when content=true", async () => {
    const result = await fileSearch(testDir, {
      q: "Builder",
      content: true,
    });
    expect(result.results.length).toBeGreaterThan(0);
    const builderResult = result.results.find((r) => r.name === "builder.md");
    expect(builderResult).toBeDefined();
    expect(builderResult!.matches.some((m) => m.type === "content")).toBe(true);
  });

  it("skips system directory in content search", async () => {
    const result = await fileSearch(testDir, {
      q: "telegram",
      content: true,
    });
    expect(
      result.results.every((r) => !r.path.startsWith("system/")),
    ).toBe(true);
  });

  it("searches within a subdirectory", async () => {
    const result = await fileSearch(testDir, { q: "study", path: "agents" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.path.startsWith("agents/"))).toBe(
      true,
    );
  });

  it("respects limit", async () => {
    const result = await fileSearch(testDir, { q: ".md", limit: 1 });
    expect(result.results.length).toBeLessThanOrEqual(1);
    expect(result.truncated).toBe(true);
  });

  it("skips dotdirs like .git and .trash", async () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, ".git", "config"), "gitconfig");
    mkdirSync(join(testDir, ".trash"));
    writeFileSync(join(testDir, ".trash", "deleted.md"), "old");
    const result = await fileSearch(testDir, { q: "config", content: true });
    const paths = result.results.map((r) => r.path);
    expect(
      paths.every((p) => !p.startsWith(".git/") && !p.startsWith(".trash/")),
    ).toBe(true);
  });

  it("skips node_modules", async () => {
    mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(testDir, "node_modules", "pkg", "index.js"),
      "module.exports = {}",
    );
    const result = await fileSearch(testDir, { q: "module", content: true });
    expect(
      result.results.every((r) => !r.path.includes("node_modules")),
    ).toBe(true);
  });

  it("returns empty results for no match", async () => {
    const result = await fileSearch(testDir, {
      q: "nonexistent-xyz-12345",
    });
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("case insensitive name search", async () => {
    const result = await fileSearch(testDir, { q: "README" });
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("skips binary files in content search", async () => {
    writeFileSync(
      join(testDir, "photo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const result = await fileSearch(testDir, { q: "PNG", content: true });
    const pngResult = result.results.find((r) => r.name === "photo.png");
    if (pngResult) {
      expect(pngResult.matches.every((m) => m.type === "name")).toBe(true);
    }
  });

  it("skips large files in content search", async () => {
    const largeContent = "x".repeat(1024 * 1024 + 1);
    writeFileSync(join(testDir, "huge.txt"), largeContent);
    const result = await fileSearch(testDir, { q: "xxx", content: true });
    expect(
      result.results.find(
        (r) =>
          r.name === "huge.txt" &&
          r.matches.some((m) => m.type === "content"),
      ),
    ).toBeUndefined();
  });
});
