import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashSources,
  hashLockfile,
  readBuildStamp,
  writeBuildStamp,
  isBuildStale,
} from "../../../packages/gateway/src/app-runtime/build-cache.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "matrix-os-build-cache-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("build-cache", () => {
  describe("hashSources", () => {
    it("produces deterministic output for same file set", async () => {
      await writeFile(join(tmpDir, "a.ts"), "const a = 1;");
      await writeFile(join(tmpDir, "b.ts"), "const b = 2;");
      const h1 = await hashSources(tmpDir, ["*.ts"]);
      const h2 = await hashSources(tmpDir, ["*.ts"]);
      expect(h1).toBe(h2);
      expect(typeof h1).toBe("string");
      expect(h1.length).toBeGreaterThan(0);
    });

    it("changes when file content changes", async () => {
      await writeFile(join(tmpDir, "a.ts"), "const a = 1;");
      const h1 = await hashSources(tmpDir, ["*.ts"]);
      await writeFile(join(tmpDir, "a.ts"), "const a = 2;");
      const h2 = await hashSources(tmpDir, ["*.ts"]);
      expect(h1).not.toBe(h2);
    });

    it("is insensitive to file order (sorted for determinism)", async () => {
      await writeFile(join(tmpDir, "z.ts"), "z");
      await writeFile(join(tmpDir, "a.ts"), "a");
      const h1 = await hashSources(tmpDir, ["*.ts"]);

      // create in different order
      const tmpDir2 = await mkdtemp(join(tmpdir(), "matrix-os-build-cache-"));
      await writeFile(join(tmpDir2, "a.ts"), "a");
      await writeFile(join(tmpDir2, "z.ts"), "z");
      const h2 = await hashSources(tmpDir2, ["*.ts"]);
      await rm(tmpDir2, { recursive: true, force: true });

      expect(h1).toBe(h2);
    });

    it("matches files in subdirectories with glob patterns", async () => {
      await mkdir(join(tmpDir, "src"), { recursive: true });
      await writeFile(join(tmpDir, "src", "index.ts"), "export {};");
      const h = await hashSources(tmpDir, ["src/**"]);
      expect(h.length).toBeGreaterThan(0);
    });

    it("returns empty hash when no files match", async () => {
      const h = await hashSources(tmpDir, ["*.nonexistent"]);
      expect(typeof h).toBe("string");
    });
  });

  describe("hashLockfile", () => {
    it("hashes pnpm-lock.yaml content", async () => {
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\npackages: {}");
      const h = await hashLockfile(tmpDir);
      expect(typeof h).toBe("string");
      expect(h.length).toBeGreaterThan(0);
    });

    it("returns empty string when lockfile is missing", async () => {
      const h = await hashLockfile(tmpDir);
      expect(h).toBe("");
    });

    it("changes when lockfile changes", async () => {
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
      const h1 = await hashLockfile(tmpDir);
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
      const h2 = await hashLockfile(tmpDir);
      expect(h1).not.toBe(h2);
    });
  });

  describe("readBuildStamp / writeBuildStamp", () => {
    it("round-trips a build stamp", async () => {
      const stamp = {
        sourceHash: "abc123",
        lockfileHash: "def456",
        builtAt: Date.now(),
        exitCode: 0,
      };
      await writeBuildStamp(tmpDir, stamp);
      const read = await readBuildStamp(tmpDir);
      expect(read).toEqual(stamp);
    });

    it("returns null when no stamp file exists", async () => {
      const read = await readBuildStamp(tmpDir);
      expect(read).toBeNull();
    });
  });

  describe("isBuildStale", () => {
    it("returns true when stamp is missing", async () => {
      expect(await isBuildStale(tmpDir, ["src/**"])).toBe(true);
    });

    it("returns false after writeBuildStamp with matching hashes", async () => {
      await writeFile(join(tmpDir, "src.ts"), "x");
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
      const sourceHash = await hashSources(tmpDir, ["*.ts"]);
      const lockfileHash = await hashLockfile(tmpDir);
      await writeBuildStamp(tmpDir, {
        sourceHash,
        lockfileHash,
        builtAt: Date.now(),
        exitCode: 0,
      });
      expect(await isBuildStale(tmpDir, ["*.ts"])).toBe(false);
    });

    it("returns true when lockfile changes after stamp written", async () => {
      await writeFile(join(tmpDir, "src.ts"), "x");
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
      const sourceHash = await hashSources(tmpDir, ["*.ts"]);
      const lockfileHash = await hashLockfile(tmpDir);
      await writeBuildStamp(tmpDir, {
        sourceHash,
        lockfileHash,
        builtAt: Date.now(),
        exitCode: 0,
      });
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
      expect(await isBuildStale(tmpDir, ["*.ts"])).toBe(true);
    });

    it("returns true when source file changes after stamp written", async () => {
      await writeFile(join(tmpDir, "src.ts"), "original");
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
      const sourceHash = await hashSources(tmpDir, ["*.ts"]);
      const lockfileHash = await hashLockfile(tmpDir);
      await writeBuildStamp(tmpDir, {
        sourceHash,
        lockfileHash,
        builtAt: Date.now(),
        exitCode: 0,
      });
      await writeFile(join(tmpDir, "src.ts"), "changed");
      expect(await isBuildStale(tmpDir, ["*.ts"])).toBe(true);
    });

    it("returns true when previous build failed (exitCode non-zero)", async () => {
      await writeFile(join(tmpDir, "src.ts"), "x");
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
      const sourceHash = await hashSources(tmpDir, ["*.ts"]);
      const lockfileHash = await hashLockfile(tmpDir);
      await writeBuildStamp(tmpDir, {
        sourceHash,
        lockfileHash,
        builtAt: Date.now(),
        exitCode: 1,
      });
      expect(await isBuildStale(tmpDir, ["*.ts"])).toBe(true);
    });
  });
});
