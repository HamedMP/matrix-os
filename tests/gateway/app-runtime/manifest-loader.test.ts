import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, invalidateManifestCache } from "../../../packages/gateway/src/app-runtime/manifest-loader.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-manifest-"));
  invalidateManifestCache();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function validManifest(slug: string) {
  return JSON.stringify({
    name: "Notes",
    slug,
    version: "1.0.0",
    runtime: "vite",
    runtimeVersion: "^1.0.0",
    build: { command: "pnpm build", output: "dist" },
  });
}

describe("loadManifest", () => {
  it("loads and validates matrix.json from disk", async () => {
    const appDir = join(tmpDir, "notes");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), validManifest("notes"));

    const result = await loadManifest(tmpDir, "notes");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.slug).toBe("notes");
      expect(result.manifest.runtime).toBe("vite");
    }
  });

  it("returns ManifestError on missing file", async () => {
    const result = await loadManifest(tmpDir, "missing-app");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("returns ManifestError on invalid JSON", async () => {
    const appDir = join(tmpDir, "broken");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), "{ not valid json");

    const result = await loadManifest(tmpDir, "broken");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_manifest");
    }
  });

  it("rejects slug mismatch between dir name and manifest.slug", async () => {
    const appDir = join(tmpDir, "dir-name");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), validManifest("different-slug"));

    const result = await loadManifest(tmpDir, "dir-name");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("slug_mismatch");
    }
  });

  it("caches by mtime and returns cached manifest on second call", async () => {
    const appDir = join(tmpDir, "cached");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), validManifest("cached"));

    const r1 = await loadManifest(tmpDir, "cached");
    const r2 = await loadManifest(tmpDir, "cached");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.manifest).toBe(r2.manifest); // same reference = cache hit
    }
  });

  it("re-reads on mtime change", async () => {
    const appDir = join(tmpDir, "updated");
    await mkdir(appDir, { recursive: true });
    const manifestPath = join(appDir, "matrix.json");
    await writeFile(manifestPath, validManifest("updated"));

    const r1 = await loadManifest(tmpDir, "updated");
    expect(r1.ok).toBe(true);

    // Update the file with a new mtime
    const updatedManifest = JSON.stringify({
      name: "Updated Notes",
      slug: "updated",
      version: "2.0.0",
      runtime: "vite",
      runtimeVersion: "^1.0.0",
      build: { command: "pnpm build", output: "dist" },
    });
    await writeFile(manifestPath, updatedManifest);
    // Force a different mtime by touching the file into the future
    const future = new Date(Date.now() + 5000);
    await utimes(manifestPath, future, future);

    const r2 = await loadManifest(tmpDir, "updated");
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.manifest).not.toBe(r2.manifest); // different reference = cache miss
      expect(r2.manifest.version).toBe("2.0.0");
    }
  });

  it("invalidateManifestCache clears all cached entries", async () => {
    const appDir = join(tmpDir, "clearme");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "matrix.json"), validManifest("clearme"));

    const r1 = await loadManifest(tmpDir, "clearme");
    invalidateManifestCache();
    const r2 = await loadManifest(tmpDir, "clearme");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.manifest).not.toBe(r2.manifest); // different reference after invalidation
    }
  });

  it("evicts least recently used manifest entries when the cache reaches its cap", async () => {
    const firstDir = join(tmpDir, "app-0");
    await mkdir(firstDir, { recursive: true });
    await writeFile(join(firstDir, "matrix.json"), validManifest("app-0"));

    const first = await loadManifest(tmpDir, "app-0");
    expect(first.ok).toBe(true);

    for (let i = 1; i <= 256; i += 1) {
      const slug = `app-${i}`;
      const appDir = join(tmpDir, slug);
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, "matrix.json"), validManifest(slug));
      const result = await loadManifest(tmpDir, slug);
      expect(result.ok).toBe(true);
    }

    const reloaded = await loadManifest(tmpDir, "app-0");
    expect(reloaded.ok).toBe(true);
    if (first.ok && reloaded.ok) {
      expect(reloaded.manifest).not.toBe(first.manifest);
    }
  });
});
