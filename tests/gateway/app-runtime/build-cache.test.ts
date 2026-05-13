import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
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

    it("matches top-level files for double-star globs and question wildcards", async () => {
      await mkdir(join(tmpDir, "src"), { recursive: true });
      await writeFile(join(tmpDir, "src", "index.ts"), "export const value = 1;");
      await writeFile(join(tmpDir, "src", "page1.ts"), "export const page = 1;");
      const before = await hashSources(tmpDir, ["src/**/*.ts", "src/page?.ts"]);
      await writeFile(join(tmpDir, "src", "index.ts"), "export const value = 2;");
      const after = await hashSources(tmpDir, ["src/**/*.ts", "src/page?.ts"]);
      expect(after).not.toBe(before);
    });

    it("recurses root-relative double-star globs", async () => {
      await mkdir(join(tmpDir, "pages"), { recursive: true });
      await writeFile(join(tmpDir, "pages", "index.ts"), "export const page = 1;");
      const before = await hashSources(tmpDir, ["**/*.ts"]);
      await writeFile(join(tmpDir, "pages", "index.ts"), "export const page = 2;");
      const after = await hashSources(tmpDir, ["**/*.ts"]);
      expect(after).not.toBe(before);
    });

    it("follows symlinked source directories", async () => {
      await mkdir(join(tmpDir, "real-src"), { recursive: true });
      await writeFile(join(tmpDir, "real-src", "index.ts"), "export const value = 1;");
      await symlink(join(tmpDir, "real-src"), join(tmpDir, "src"));
      const before = await hashSources(tmpDir, ["src/**"]);
      await writeFile(join(tmpDir, "real-src", "index.ts"), "export const value = 2;");
      const after = await hashSources(tmpDir, ["src/**"]);
      expect(after).not.toBe(before);
    });

    it("hashes symlinked source files matched by app source globs", async () => {
      await mkdir(join(tmpDir, "src"), { recursive: true });
      await writeFile(join(tmpDir, "shared.ts"), "export const value = 1;");
      await symlink(join(tmpDir, "shared.ts"), join(tmpDir, "src", "linked.ts"));
      const before = await hashSources(tmpDir, ["src/**/*.ts"]);
      await writeFile(join(tmpDir, "shared.ts"), "export const value = 2;");
      const after = await hashSources(tmpDir, ["src/**/*.ts"]);
      expect(after).not.toBe(before);
    });

    it("ignores dependency and output trees outside source glob roots", async () => {
      await mkdir(join(tmpDir, "src"), { recursive: true });
      await mkdir(join(tmpDir, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(tmpDir, "dist"), { recursive: true });
      await writeFile(join(tmpDir, "src", "index.ts"), "export const value = 1;");
      await writeFile(join(tmpDir, "node_modules", "pkg", "index.ts"), "ignored");
      await writeFile(join(tmpDir, "dist", "bundle.js"), "ignored");

      const before = await hashSources(tmpDir, ["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]);
      await writeFile(join(tmpDir, "node_modules", "pkg", "index.ts"), "ignored changed");
      await writeFile(join(tmpDir, "dist", "bundle.js"), "ignored changed");

      expect(await hashSources(tmpDir, ["src/**", "public/**", "*.config.*", "index.html", "matrix.json"])).toBe(before);
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
