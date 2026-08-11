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
import { fileMkdir, fileRename, fileTouch } from "../../packages/gateway/src/file-ops.js";
import { isNativeFileCapabilityTarget } from "../../packages/gateway/src/file-management/native-file-capability.js";

const describeNative = isNativeFileCapabilityTarget() ? describe : describe.skip;

describeNative("fileMkdir", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-ops-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a directory", async () => {
    expect(await fileMkdir(testDir, "new-folder")).toEqual({ ok: true, path: "new-folder" });
    expect(existsSync(join(testDir, "new-folder"))).toBe(true);
  });

  it("creates nested directories", async () => {
    expect(await fileMkdir(testDir, "a/b/c")).toEqual({ ok: true, path: "a/b/c" });
    expect(existsSync(join(testDir, "a", "b", "c"))).toBe(true);
  });

  it("returns error for path traversal", async () => {
    expect(await fileMkdir(testDir, "../../evil")).toEqual({ ok: false, error: "Invalid path" });
  });

  it("re-authorizes protected roots before creating a legacy directory", async () => {
    mkdirSync(join(testDir, "system"), { recursive: true });
    expect(await fileMkdir(testDir, "system/blocked")).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "system", "blocked"))).toBe(false);
  });

  it.each(["data", "data/browser-profiles"])(
    "rejects structural mutation of denied root or ancestor %s",
    async (requestedPath) => {
      expect(await fileMkdir(testDir, requestedPath)).toEqual({ ok: false, error: "Invalid path" });
      expect(existsSync(join(testDir, requestedPath))).toBe(false);
    },
  );

  it("rejects symlinked parent directories", async () => {
    const outsideDir = join(tmpdir(), `file-ops-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(testDir, "linked"), "dir");
    expect(await fileMkdir(testDir, "linked/owned")).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(outsideDir, "owned"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("succeeds if directory already exists", async () => {
    mkdirSync(join(testDir, "existing"));
    expect((await fileMkdir(testDir, "existing")).ok).toBe(true);
  });
});

describeNative("fileTouch", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `file-touch-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates an empty file", async () => {
    expect(await fileTouch(testDir, "new.md")).toEqual({ ok: true, path: "new.md" });
    expect(readFileSync(join(testDir, "new.md"), "utf8")).toBe("");
  });

  it("creates a file with content", async () => {
    expect(await fileTouch(testDir, "with-content.md", "# Hello")).toEqual({
      ok: true,
      path: "with-content.md",
    });
    expect(readFileSync(join(testDir, "with-content.md"), "utf8")).toBe("# Hello");
  });

  it("returns 409 if file already exists", async () => {
    writeFileSync(join(testDir, "existing.md"), "content");
    expect(await fileTouch(testDir, "existing.md")).toEqual({
      ok: false,
      error: "File already exists",
      status: 409,
    });
  });

  it("creates parent directories if needed", async () => {
    expect((await fileTouch(testDir, "deep/nested/file.txt", "hello")).ok).toBe(true);
    expect(readFileSync(join(testDir, "deep", "nested", "file.txt"), "utf8")).toBe("hello");
  });

  it("returns error for path traversal", async () => {
    expect(await fileTouch(testDir, "../../evil.txt")).toEqual({ ok: false, error: "Invalid path" });
  });

  it("rejects writes through symlinked parent directories", async () => {
    const outsideDir = join(tmpdir(), `file-touch-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(testDir, "linked"), "dir");
    expect(await fileTouch(testDir, "linked/owned.txt", "owned")).toEqual({
      ok: false,
      error: "Invalid path",
    });
    expect(existsSync(join(outsideDir, "owned.txt"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describeNative("fileRename compatibility", () => {
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
    expect(await fileRename(testDir, "old.md", "new.md")).toEqual({ ok: true });
    expect(existsSync(join(testDir, "old.md"))).toBe(false);
    expect(readFileSync(join(testDir, "new.md"), "utf8")).toBe("content");
  });

  it("moves a file to a different directory", async () => {
    writeFileSync(join(testDir, "file.md"), "content");
    mkdirSync(join(testDir, "sub"));
    expect(await fileRename(testDir, "file.md", "sub/file.md")).toEqual({ ok: true });
    expect(existsSync(join(testDir, "sub", "file.md"))).toBe(true);
  });

  it("returns 404 if source not found", async () => {
    expect(await fileRename(testDir, "nope.md", "new.md")).toEqual({
      ok: false,
      error: "Source not found",
      status: 404,
    });
  });

  it("returns 409 if destination exists", async () => {
    writeFileSync(join(testDir, "a.md"), "a");
    writeFileSync(join(testDir, "b.md"), "b");
    expect(await fileRename(testDir, "a.md", "b.md")).toEqual({
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
    expect(await fileRename(testDir, "a.md", "linked/a.md")).toEqual({
      ok: false,
      error: "Invalid path",
    });
    expect(existsSync(join(testDir, "a.md"))).toBe(true);
    expect(existsSync(join(outsideDir, "a.md"))).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects a legacy directory rename into its descendant before target creation", async () => {
    mkdirSync(join(testDir, "folder"));
    const result = await fileRename(testDir, "folder", "folder/child");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "folder", "child"))).toBe(false);
  });
});
