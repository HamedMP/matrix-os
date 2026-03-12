import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { generateTemplateManifest } from "../../packages/kernel/src/boot.js";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "matrixos-manifest-test-"));
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("generateTemplateManifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates correct SHA-256 hashes for known content", () => {
    mkdirSync(join(tmpDir, "system"), { recursive: true });
    writeFileSync(join(tmpDir, "system", "soul.md"), "I am the soul");
    writeFileSync(join(tmpDir, "hello.txt"), "hello world");

    const manifest = generateTemplateManifest(tmpDir);

    expect(manifest["system/soul.md"]).toBe(sha256("I am the soul"));
    expect(manifest["hello.txt"]).toBe(sha256("hello world"));
  });

  it("excludes .gitkeep files", () => {
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(join(tmpDir, "data", ".gitkeep"), "");
    writeFileSync(join(tmpDir, "data", "real.txt"), "content");

    const manifest = generateTemplateManifest(tmpDir);

    expect(manifest["data/.gitkeep"]).toBeUndefined();
    expect(manifest["data/real.txt"]).toBe(sha256("content"));
  });

  it("excludes .DS_Store files", () => {
    writeFileSync(join(tmpDir, ".DS_Store"), "");
    writeFileSync(join(tmpDir, "keep.txt"), "yes");

    const manifest = generateTemplateManifest(tmpDir);

    expect(manifest[".DS_Store"]).toBeUndefined();
    expect(manifest["keep.txt"]).toBeDefined();
  });

  it("excludes node_modules directories", () => {
    mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "pkg", "index.js"), "module.exports = {}");
    writeFileSync(join(tmpDir, "root.txt"), "root");

    const manifest = generateTemplateManifest(tmpDir);

    expect(Object.keys(manifest)).toEqual(["root.txt"]);
  });

  it("excludes .template-manifest.json itself", () => {
    writeFileSync(join(tmpDir, ".template-manifest.json"), "{}");
    writeFileSync(join(tmpDir, "real.txt"), "real");

    const manifest = generateTemplateManifest(tmpDir);

    expect(manifest[".template-manifest.json"]).toBeUndefined();
    expect(manifest["real.txt"]).toBeDefined();
  });

  it("handles empty directories gracefully", () => {
    mkdirSync(join(tmpDir, "empty"), { recursive: true });

    const manifest = generateTemplateManifest(tmpDir);

    expect(Object.keys(manifest)).toEqual([]);
  });

  it("handles nested paths correctly", () => {
    mkdirSync(join(tmpDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(tmpDir, "a", "b", "c", "deep.md"), "deep content");
    writeFileSync(join(tmpDir, "a", "top.md"), "top content");

    const manifest = generateTemplateManifest(tmpDir);

    expect(manifest["a/b/c/deep.md"]).toBe(sha256("deep content"));
    expect(manifest["a/top.md"]).toBe(sha256("top content"));
    expect(Object.keys(manifest).length).toBe(2);
  });

  it("returns an empty object for an empty directory", () => {
    const manifest = generateTemplateManifest(tmpDir);
    expect(manifest).toEqual({});
  });
});
