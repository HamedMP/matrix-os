import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findTsxLoader } from "../../src/lib/find-tsx-loader.mjs";

describe("findTsxLoader", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("finds tsx at the immediate level", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tsx-test-"));
    const loaderPath = join(tempDir, "node_modules", "tsx", "dist", "loader.mjs");
    await mkdir(join(tempDir, "node_modules", "tsx", "dist"), { recursive: true });
    await writeFile(loaderPath, "// stub");

    expect(findTsxLoader(tempDir)).toBe(loaderPath);
  });

  it("finds tsx 2 levels up (pnpm hoisting)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tsx-test-"));
    const loaderPath = join(tempDir, "node_modules", "tsx", "dist", "loader.mjs");
    await mkdir(join(tempDir, "node_modules", "tsx", "dist"), { recursive: true });
    await writeFile(loaderPath, "// stub");

    const nested = join(tempDir, "packages", "sync-client");
    await mkdir(nested, { recursive: true });

    expect(findTsxLoader(nested)).toBe(loaderPath);
  });

  it("returns null when tsx is not found within 6 levels", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tsx-test-"));
    const deep = join(tempDir, "a", "b", "c", "d", "e", "f", "g");
    await mkdir(deep, { recursive: true });

    expect(findTsxLoader(deep)).toBeNull();
  });

  it("handles root directory without infinite loop", () => {
    expect(findTsxLoader("/")).toBeNull();
  });
});
