import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fileMkdir,
  fileTouch,
  fileRename,
  fileCopy,
  fileDuplicate,
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

  it("succeeds if directory already exists", async () => {
    mkdirSync(join(testDir, "existing"));
    const result = await fileMkdir(testDir, "existing");
    expect(result.ok).toBe(true);
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
});
