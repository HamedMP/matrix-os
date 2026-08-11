import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { spawnSync } from "node:child_process";
import { fileCopy, fileDuplicate } from "../../packages/gateway/src/file-ops.js";
import { isNativeFileCapabilityTarget } from "../../packages/gateway/src/file-management/native-file-capability.js";

const describeNative = isNativeFileCapabilityTarget() ? describe : describe.skip;

describeNative("fileCopy safety", () => {
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

  it("rejects copying a directory into its descendant before target creation", async () => {
    mkdirSync(join(testDir, "source"));
    const result = await fileCopy(testDir, "source", "source/child");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "source", "child"))).toBe(false);
  });

  it("reports one retained partial directory after a nested native copy failure", async () => {
    mkdirSync(join(testDir, "source"));
    expect(spawnSync("mkfifo", [join(testDir, "source", "unsupported-fifo")]).status).toBe(0);

    const result = await fileCopy(testDir, "source", "target");

    expect(result).toEqual({ ok: false, error: "Failed to copy", partialPath: "target" });
    expect(existsSync(join(testDir, "target"))).toBe(true);
  });

  it("contains a target-parent symlink swap after Gateway authorization", async () => {
    const outsideDir = join(tmpdir(), `file-copy-target-swap-${Date.now()}`);
    mkdirSync(join(testDir, "target-parent"));
    mkdirSync(outsideDir);
    writeFileSync(join(testDir, "source.md"), "source");

    const result = await fileCopy(testDir, "source.md", "target-parent/copied.md", {
      beforeNativeMutation: async () => {
        rmSync(join(testDir, "target-parent"), { recursive: true });
        symlinkSync(outsideDir, join(testDir, "target-parent"), "dir");
      },
    });

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(outsideDir, "copied.md"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

});

describeNative("fileDuplicate reconciliation", () => {
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

  it("does not fan out copy names after a nested native duplicate failure", async () => {
    mkdirSync(join(testDir, "folder"));
    expect(spawnSync("mkfifo", [join(testDir, "folder", "unsupported-fifo")]).status).toBe(0);

    const result = await fileDuplicate(testDir, "folder");

    expect(result).toEqual({
      ok: false,
      newPath: "folder copy",
      error: "Failed to duplicate",
    });
    expect(existsSync(join(testDir, "folder copy"))).toBe(true);
    expect(existsSync(join(testDir, "folder copy 2"))).toBe(false);
  });
});
