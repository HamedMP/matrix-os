import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fileMkdir,
  fileTouch,
  fileRename,
  fileCopy,
  createFile,
  fileDuplicate,
  renameFile,
} from "../../packages/gateway/src/file-ops.js";

describe("fileMkdir", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-ops-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a directory", async () => {
    const result = await fileMkdir(testDir, "new-folder");
    expect(result).toEqual({ ok: true, path: "new-folder" });
    expect(existsSync(join(testDir, "new-folder"))).toBe(true);
  });

  it("creates nested directories", async () => {
    const result = await fileMkdir(testDir, "a/b/c");
    expect(result).toEqual({ ok: true, path: "a/b/c" });
    expect(existsSync(join(testDir, "a", "b", "c"))).toBe(true);
  });

  it("returns error for path traversal", async () => {
    const result = await fileMkdir(testDir, "../../evil");
    expect(result).toEqual({ ok: false, error: "Invalid path" });
  });

  it("re-authorizes protected roots before creating a legacy directory", async () => {
    mkdirSync(join(testDir, "system"), { recursive: true });

    const result = await fileMkdir(testDir, "system/blocked");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "system", "blocked"))).toBe(false);
  });

  it.each(["data", "data/browser-profiles"])(
    "rejects structural mutation of denied root or ancestor %s",
    async (requestedPath) => {
      const result = await fileMkdir(testDir, requestedPath);

      expect(result).toEqual({ ok: false, error: "Invalid path" });
      expect(existsSync(join(testDir, requestedPath))).toBe(false);
    },
  );

  it("rejects symlinked parent directories", async () => {
    const outsideDir = join(tmpdir(), `file-ops-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(testDir, "linked"), "dir");

    const result = await fileMkdir(testDir, "linked/owned");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(outsideDir, "owned"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("succeeds if directory already exists", async () => {
    mkdirSync(join(testDir, "existing"));
    const result = await fileMkdir(testDir, "existing");
    expect(result.ok).toBe(true);
  });
});

describe("Desktop typed file mutations", () => {
  let testDir: string;
  const requestId = "a9d9d1d8-8e5d-45d0-8d17-2c85f4e19a11";

  beforeEach(() => {
    testDir = join(tmpdir(), `desktop-file-ops-test-${Date.now()}`);
    mkdirSync(join(testDir, "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates an exclusive typed file and returns its normalized path and capabilities", async () => {
    const result = await createFile(testDir, {
      requestId,
      parentDirectory: "projects",
      name: "notes.md",
      kind: "file",
    });

    expect(result).toEqual({
      ok: true,
      path: "projects/notes.md",
      resultCode: "created",
      capabilities: { canRename: true, canMove: true, canTrash: true },
    });
    expect(readFileSync(join(testDir, "projects", "notes.md"), "utf8")).toBe("");
  });

  it("renames a typed file without allowing an occupied target", async () => {
    writeFileSync(join(testDir, "projects", "old.md"), "content");

    const result = await renameFile(testDir, {
      requestId,
      path: "projects/old.md",
      name: "new.md",
    });

    expect(result).toEqual({
      ok: true,
      path: "projects/new.md",
      resultCode: "renamed",
      capabilities: { canRename: true, canMove: true, canTrash: true },
    });
    expect(existsSync(join(testDir, "projects", "old.md"))).toBe(false);
    expect(readFileSync(join(testDir, "projects", "new.md"), "utf8")).toBe("content");
  });

  it("rejects an occupied typed rename target without overwriting it", async () => {
    writeFileSync(join(testDir, "projects", "old.md"), "source");
    writeFileSync(join(testDir, "projects", "occupied.md"), "destination");

    const result = await renameFile(testDir, {
      requestId,
      path: "projects/old.md",
      name: "occupied.md",
    });

    expect(result).toEqual({ ok: false, errorCode: "destination_conflict" });
    expect(readFileSync(join(testDir, "projects", "old.md"), "utf8")).toBe("source");
    expect(readFileSync(join(testDir, "projects", "occupied.md"), "utf8")).toBe("destination");
  });

  it("renames an ordinary owner file in the home root", async () => {
    writeFileSync(join(testDir, "root.md"), "root");

    const result = await renameFile(testDir, {
      requestId,
      path: "root.md",
      name: "renamed.md",
    });

    expect(result).toMatchObject({ ok: true, path: "renamed.md", resultCode: "renamed" });
    expect(readFileSync(join(testDir, "renamed.md"), "utf8")).toBe("root");
  });

  it("creates an ordinary owner file in the home root", async () => {
    const result = await createFile(testDir, {
      requestId,
      parentDirectory: "",
      name: "root.md",
      kind: "file",
    });

    expect(result).toMatchObject({ ok: true, path: "root.md", resultCode: "created" });
    expect(readFileSync(join(testDir, "root.md"), "utf8")).toBe("");
  });

  it.each([".ssh", ".trash", "system", "agents"])(
    "rejects typed create targeting protected root %s",
    async (name) => {
      const result = await createFile(testDir, {
        requestId,
        parentDirectory: "",
        name,
        kind: "directory",
      });

      expect(result).toEqual({ ok: false, errorCode: "protected" });
      expect(existsSync(join(testDir, name))).toBe(false);
    },
  );

  it.each([".ssh", ".trash", "system", "agents"])(
    "rejects typed rename targeting protected root %s",
    async (name) => {
      writeFileSync(join(testDir, "source.md"), "source");

      const result = await renameFile(testDir, {
        requestId,
        path: "source.md",
        name,
      });

      expect(result).toEqual({ ok: false, errorCode: "protected" });
      expect(readFileSync(join(testDir, "source.md"), "utf8")).toBe("source");
      expect(existsSync(join(testDir, name))).toBe(false);
    },
  );

  it("lets only one concurrent typed rename claimant create a destination", async () => {
    writeFileSync(join(testDir, "first.md"), "first");
    writeFileSync(join(testDir, "second.md"), "second");

    const results = await Promise.all([
      renameFile(testDir, { requestId, path: "first.md", name: "claimed.md" }),
      renameFile(testDir, { requestId, path: "second.md", name: "claimed.md" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.errorCode === "destination_conflict")).toHaveLength(1);
    const targetContent = readFileSync(join(testDir, "claimed.md"), "utf8");
    const losingSource = targetContent === "first" ? "second.md" : "first.md";
    expect(readFileSync(join(testDir, losingSource), "utf8")).toBe(
      losingSource === "first.md" ? "first" : "second",
    );
  });

  it("keeps a source-destination duplicate when typed rename cleanup fails", async () => {
    writeFileSync(join(testDir, "source.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await renameFile(
      testDir,
      { requestId, path: "source.md", name: "destination.md" },
      { removeSource: async () => { throw new Error("simulated cleanup failure"); } },
    );
    warn.mockRestore();

    expect(result).toMatchObject({
      ok: false,
      path: "destination.md",
      resultCode: "cleanup_failed",
      errorCode: "cleanup_failed",
    });
    expect(readFileSync(join(testDir, "source.md"), "utf8")).toBe("source");
    expect(readFileSync(join(testDir, "destination.md"), "utf8")).toBe("source");
  });
});

describe("fileTouch", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-touch-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates an empty file", async () => {
    const result = await fileTouch(testDir, "new.md");
    expect(result).toEqual({ ok: true, path: "new.md" });
    expect(readFileSync(join(testDir, "new.md"), "utf-8")).toBe("");
  });

  it("creates a file with content", async () => {
    const result = await fileTouch(testDir, "with-content.md", "# Hello");
    expect(result).toEqual({ ok: true, path: "with-content.md" });
    expect(readFileSync(join(testDir, "with-content.md"), "utf-8")).toBe(
      "# Hello",
    );
  });

  it("returns 409 if file already exists", async () => {
    writeFileSync(join(testDir, "existing.md"), "content");
    const result = await fileTouch(testDir, "existing.md");
    expect(result).toEqual({
      ok: false,
      error: "File already exists",
      status: 409,
    });
  });

  it("creates parent directories if needed", async () => {
    const result = await fileTouch(testDir, "deep/nested/file.txt", "hello");
    expect(result.ok).toBe(true);
    expect(
      readFileSync(join(testDir, "deep", "nested", "file.txt"), "utf-8"),
    ).toBe("hello");
  });

  it("returns error for path traversal", async () => {
    const result = await fileTouch(testDir, "../../evil.txt");
    expect(result).toEqual({ ok: false, error: "Invalid path" });
  });

  it("rejects writes through symlinked parent directories", async () => {
    const outsideDir = join(tmpdir(), `file-touch-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(testDir, "linked"), "dir");

    const result = await fileTouch(testDir, "linked/owned.txt", "owned");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(outsideDir, "owned.txt"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("fileRename", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-rename-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("renames a file", async () => {
    writeFileSync(join(testDir, "old.md"), "content");
    const result = await fileRename(testDir, "old.md", "new.md");
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(testDir, "old.md"))).toBe(false);
    expect(readFileSync(join(testDir, "new.md"), "utf-8")).toBe("content");
  });

  it("moves a file to a different directory", async () => {
    writeFileSync(join(testDir, "file.md"), "content");
    mkdirSync(join(testDir, "sub"));
    const result = await fileRename(testDir, "file.md", "sub/file.md");
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(testDir, "sub", "file.md"))).toBe(true);
  });

  it("returns 404 if source not found", async () => {
    const result = await fileRename(testDir, "nope.md", "new.md");
    expect(result).toEqual({
      ok: false,
      error: "Source not found",
      status: 404,
    });
  });

  it("returns 409 if destination exists", async () => {
    writeFileSync(join(testDir, "a.md"), "a");
    writeFileSync(join(testDir, "b.md"), "b");
    const result = await fileRename(testDir, "a.md", "b.md");
    expect(result).toEqual({
      ok: false,
      error: "Destination already exists",
      status: 409,
    });
  });

  it("rejects moves into symlinked parent directories", async () => {
    const outsideDir = join(tmpdir(), `file-rename-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(testDir, "linked"), "dir");
    writeFileSync(join(testDir, "a.md"), "a");

    const result = await fileRename(testDir, "a.md", "linked/a.md");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "a.md"))).toBe(true);
    expect(existsSync(join(outsideDir, "a.md"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("keeps a source-destination duplicate when legacy rename cleanup fails", async () => {
    writeFileSync(join(testDir, "source.md"), "source");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fileRename(
      testDir,
      "source.md",
      "destination.md",
      { removeSource: async () => { throw new Error("simulated cleanup failure"); } },
    );
    warn.mockRestore();

    expect(result).toEqual({ ok: false, error: "Failed to rename" });
    expect(readFileSync(join(testDir, "source.md"), "utf8")).toBe("source");
    expect(readFileSync(join(testDir, "destination.md"), "utf8")).toBe("source");
  });
});

describe("fileCopy", () => {
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
    expect(readFileSync(join(testDir, "copy.md"), "utf-8")).toBe("content");
    expect(readFileSync(join(testDir, "original.md"), "utf-8")).toBe("content");
  });

  it("copies a directory recursively", async () => {
    mkdirSync(join(testDir, "dir"));
    writeFileSync(join(testDir, "dir", "a.txt"), "a");
    writeFileSync(join(testDir, "dir", "b.txt"), "b");
    const result = await fileCopy(testDir, "dir", "dir-copy");
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(testDir, "dir-copy", "a.txt"), "utf-8")).toBe("a");
    expect(readFileSync(join(testDir, "dir-copy", "b.txt"), "utf-8")).toBe("b");
  });

  it("returns error if source not found", async () => {
    const result = await fileCopy(testDir, "nope.md", "copy.md");
    expect(result).toEqual({
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

  it("preserves legacy copying from a protected read-only source", async () => {
    mkdirSync(join(testDir, "system"));
    writeFileSync(join(testDir, "system", "settings.json"), "settings");

    const result = await fileCopy(testDir, "system/settings.json", "settings-copy.json");

    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(testDir, "settings-copy.json"), "utf8")).toBe("settings");
    expect(readFileSync(join(testDir, "system", "settings.json"), "utf8")).toBe("settings");
  });
});

describe("fileDuplicate", () => {
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
    expect(readFileSync(join(testDir, "file copy.md"), "utf-8")).toBe(
      "content",
    );
  });

  it("increments copy number if copy exists", async () => {
    writeFileSync(join(testDir, "file.md"), "content");
    writeFileSync(join(testDir, "file copy.md"), "content");
    const result = await fileDuplicate(testDir, "file.md");
    expect(result).toEqual({ ok: true, newPath: "file copy 2.md" });
  });

  it("duplicates a directory", async () => {
    mkdirSync(join(testDir, "folder"));
    writeFileSync(join(testDir, "folder", "a.txt"), "a");
    const result = await fileDuplicate(testDir, "folder");
    expect(result).toEqual({ ok: true, newPath: "folder copy" });
    expect(readFileSync(join(testDir, "folder copy", "a.txt"), "utf-8")).toBe(
      "a",
    );
  });

  it("returns error if source not found", async () => {
    const result = await fileDuplicate(testDir, "nope.md");
    expect(result).toEqual({
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

  it("preserves legacy duplication from a protected read-only source", async () => {
    mkdirSync(join(testDir, "system"));
    writeFileSync(join(testDir, "system", "settings.json"), "settings");

    const result = await fileDuplicate(testDir, "system");

    expect(result).toEqual({ ok: true, newPath: "system copy" });
    expect(readFileSync(join(testDir, "system copy", "settings.json"), "utf8")).toBe("settings");
    expect(readFileSync(join(testDir, "system", "settings.json"), "utf8")).toBe("settings");
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
