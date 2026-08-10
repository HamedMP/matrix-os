import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCopy, fileDuplicate } from "../../packages/gateway/src/file-ops.js";

describe("fileCopy safety", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-copy-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("copies a file", async () => {
    writeFileSync(join(testDir, "original.md"), "content");
    const result = await fileCopy(testDir, "original.md", "copy.md");
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(testDir, "copy.md"), "utf8")).toBe("content");
    expect(readFileSync(join(testDir, "original.md"), "utf8")).toBe("content");
  });

  it("copies a directory recursively", async () => {
    mkdirSync(join(testDir, "dir"));
    writeFileSync(join(testDir, "dir", "a.txt"), "a");
    writeFileSync(join(testDir, "dir", "b.txt"), "b");
    const result = await fileCopy(testDir, "dir", "dir-copy");
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(testDir, "dir-copy", "a.txt"), "utf8")).toBe("a");
    expect(readFileSync(join(testDir, "dir-copy", "b.txt"), "utf8")).toBe("b");
  });

  it("returns error if source not found", async () => {
    expect(await fileCopy(testDir, "nope.md", "copy.md")).toEqual({
      ok: false,
      error: "Source not found",
      status: 404,
    });
  });

  it("rejects copies into symlinked parent directories", async () => {
    const outsideDir = join(tmpdir(), `file-copy-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(testDir, "linked"), "dir");
    writeFileSync(join(testDir, "original.md"), "content");
    const result = await fileCopy(testDir, "original.md", "linked/copy.md");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(outsideDir, "copy.md"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("lets only one concurrent copy claimant create a destination", async () => {
    writeFileSync(join(testDir, "first.md"), "first");
    writeFileSync(join(testDir, "second.md"), "second");
    const results = await Promise.all([
      fileCopy(testDir, "first.md", "claimed.md"),
      fileCopy(testDir, "second.md", "claimed.md"),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(1);
    expect(["first", "second"]).toContain(readFileSync(join(testDir, "claimed.md"), "utf8"));
  });

  it.each(["system", "agents"])(
    "preserves legacy copying from protected read-only source %s",
    async (protectedRoot) => {
      mkdirSync(join(testDir, protectedRoot));
      writeFileSync(join(testDir, protectedRoot, "settings.json"), "settings");
      const result = await fileCopy(testDir, `${protectedRoot}/settings.json`, "settings-copy.json");

      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(testDir, "settings-copy.json"), "utf8")).toBe("settings");
      expect(readFileSync(join(testDir, protectedRoot, "settings.json"), "utf8")).toBe("settings");
    },
  );

  it.each(["data", "data/browser-profiles"])(
    "rejects copying denied source or ancestor %s",
    async (source) => {
      mkdirSync(join(testDir, "data", "browser-profiles"), { recursive: true });
      writeFileSync(join(testDir, "data", "browser-profiles", "secret.json"), "secret");
      const result = await fileCopy(testDir, source, "data-copy");

      expect(result).toEqual({ ok: false, error: "Invalid path" });
      expect(existsSync(join(testDir, "data-copy"))).toBe(false);
    },
  );

  it("reports one retained partial directory after a nested copy conflict", async () => {
    mkdirSync(join(testDir, "source", "nested"), { recursive: true });
    writeFileSync(join(testDir, "source", "nested", "file.md"), "content");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fileCopy(testDir, "source", "target", {
      afterDirectoryClaim: async (target) => { mkdirSync(join(target, "nested")); },
    });
    warn.mockRestore();

    expect(result).toEqual({ ok: false, error: "Failed to copy", partialPath: "target" });
    expect(existsSync(join(testDir, "target"))).toBe(true);
  });

  it("rejects copying a directory into its descendant before target creation", async () => {
    mkdirSync(join(testDir, "source"));
    const result = await fileCopy(
      testDir,
      "source",
      "source/child",
      { afterDirectoryClaim: async () => { throw new Error("target was created"); } },
    );

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "source", "child"))).toBe(false);
  });

  it("fails closed when the claimed copy target is swapped for a symlink", async () => {
    const outsideDir = join(tmpdir(), `file-copy-target-swap-${Date.now()}`);
    mkdirSync(join(testDir, "source", "nested"), { recursive: true });
    mkdirSync(outsideDir);
    writeFileSync(join(testDir, "source", "nested", "file.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fileCopy(testDir, "source", "target", {
      afterDirectoryClaim: async (target) => {
        rmSync(target, { recursive: true });
        symlinkSync(outsideDir, target, "dir");
      },
    });
    warn.mockRestore();

    expect(result).toEqual({ ok: false, error: "Failed to copy", partialPath: "target" });
    expect(existsSync(join(outsideDir, "nested"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("fails closed when a source child is swapped for a symlink", async () => {
    const outsideFile = join(tmpdir(), `file-copy-source-swap-${Date.now()}.md`);
    mkdirSync(join(testDir, "source"));
    writeFileSync(join(testDir, "source", "child.md"), "source");
    writeFileSync(outsideFile, "outside-secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fileCopy(testDir, "source", "target", {
      afterSourceEntryInspection: async (source) => {
        rmSync(source);
        symlinkSync(outsideFile, source);
      },
    });
    warn.mockRestore();

    expect(result).toEqual({ ok: false, error: "Failed to copy", partialPath: "target" });
    expect(existsSync(join(testDir, "target", "child.md"))).toBe(false);
    rmSync(outsideFile, { force: true });
  });
});

describe("fileDuplicate reconciliation", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-dup-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("duplicates a file with copy suffix", async () => {
    writeFileSync(join(testDir, "file.md"), "content");
    const result = await fileDuplicate(testDir, "file.md");
    expect(result).toEqual({ ok: true, newPath: "file copy.md" });
    expect(readFileSync(join(testDir, "file copy.md"), "utf8")).toBe("content");
  });

  it("increments copy number if copy exists", async () => {
    writeFileSync(join(testDir, "file.md"), "content");
    writeFileSync(join(testDir, "file copy.md"), "content");
    expect(await fileDuplicate(testDir, "file.md")).toEqual({
      ok: true,
      newPath: "file copy 2.md",
    });
  });

  it("duplicates a directory", async () => {
    mkdirSync(join(testDir, "folder"));
    writeFileSync(join(testDir, "folder", "a.txt"), "a");
    const result = await fileDuplicate(testDir, "folder");
    expect(result).toEqual({ ok: true, newPath: "folder copy" });
    expect(readFileSync(join(testDir, "folder copy", "a.txt"), "utf8")).toBe("a");
  });

  it("returns error if source not found", async () => {
    expect(await fileDuplicate(testDir, "nope.md")).toEqual({
      ok: false,
      error: "Source not found",
      status: 404,
    });
  });

  it("rejects duplicated symlink sources", async () => {
    const outsideFile = join(tmpdir(), `file-dup-outside-${Date.now()}.md`);
    writeFileSync(outsideFile, "outside");
    symlinkSync(outsideFile, join(testDir, "linked.md"));
    const result = await fileDuplicate(testDir, "linked.md");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "linked copy.md"))).toBe(false);
    rmSync(outsideFile, { force: true });
  });

  it.each(["system", "agents"])(
    "preserves legacy duplication from protected read-only source %s",
    async (protectedRoot) => {
      mkdirSync(join(testDir, protectedRoot));
      writeFileSync(join(testDir, protectedRoot, "settings.json"), "settings");
      const result = await fileDuplicate(testDir, protectedRoot);

      expect(result).toEqual({ ok: true, newPath: `${protectedRoot} copy` });
      expect(readFileSync(join(testDir, `${protectedRoot} copy`, "settings.json"), "utf8")).toBe("settings");
      expect(readFileSync(join(testDir, protectedRoot, "settings.json"), "utf8")).toBe("settings");
    },
  );

  it.each(["data", "data/browser-profiles"])(
    "rejects duplicating denied source or ancestor %s",
    async (source) => {
      mkdirSync(join(testDir, "data", "browser-profiles"), { recursive: true });
      writeFileSync(join(testDir, "data", "browser-profiles", "secret.json"), "secret");
      const result = await fileDuplicate(testDir, source);

      expect(result).toEqual({ ok: false, error: "Invalid path" });
      expect(existsSync(join(testDir, "data copy"))).toBe(false);
      expect(existsSync(join(testDir, "data", "browser-profiles copy"))).toBe(false);
    },
  );

  it("does not fan out copy names after a nested duplicate conflict", async () => {
    mkdirSync(join(testDir, "folder", "nested"), { recursive: true });
    writeFileSync(join(testDir, "folder", "nested", "file.md"), "content");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fileDuplicate(testDir, "folder", {
      afterDirectoryClaim: async (target) => { mkdirSync(join(target, "nested")); },
    });
    warn.mockRestore();

    expect(result).toEqual({
      ok: false,
      newPath: "folder copy",
      error: "Failed to duplicate",
    });
    expect(existsSync(join(testDir, "folder copy"))).toBe(true);
    expect(existsSync(join(testDir, "folder copy 2"))).toBe(false);
  });

  it("gives concurrent duplicate claimants distinct exclusive destinations", async () => {
    writeFileSync(join(testDir, "file.md"), "content");
    const results = await Promise.all([
      fileDuplicate(testDir, "file.md"),
      fileDuplicate(testDir, "file.md"),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.newPath))).toEqual(
      new Set(["file copy.md", "file copy 2.md"]),
    );
    expect(readFileSync(join(testDir, "file copy.md"), "utf8")).toBe("content");
    expect(readFileSync(join(testDir, "file copy 2.md"), "utf8")).toBe("content");
  });
});
