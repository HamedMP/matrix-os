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
  fileDelete,
  trashList,
  trashRestore,
  trashEmpty,
} from "../../packages/gateway/src/trash.js";

describe("fileDelete", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("moves a file to .trash", async () => {
    writeFileSync(join(testDir, "doomed.md"), "goodbye");
    const result = await fileDelete(testDir, "doomed.md");
    expect(result.ok).toBe(true);
    expect(result.trashPath).toBeDefined();
    expect(existsSync(join(testDir, "doomed.md"))).toBe(false);
    expect(existsSync(join(testDir, ".trash", "doomed.md"))).toBe(true);
  });

  it("moves a directory to .trash", async () => {
    mkdirSync(join(testDir, "folder"));
    writeFileSync(join(testDir, "folder", "a.txt"), "a");
    const result = await fileDelete(testDir, "folder");
    expect(result.ok).toBe(true);
    expect(existsSync(join(testDir, "folder"))).toBe(false);
    expect(existsSync(join(testDir, ".trash", "folder", "a.txt"))).toBe(true);
  });

  it("records entry in manifest", async () => {
    writeFileSync(join(testDir, "logged.md"), "content");
    await fileDelete(testDir, "logged.md");
    const manifest = JSON.parse(
      readFileSync(join(testDir, ".trash", ".manifest.json"), "utf-8"),
    );
    expect(manifest).toHaveLength(1);
    expect(manifest[0].originalPath).toBe("logged.md");
    expect(manifest[0].name).toBe("logged.md");
    expect(manifest[0].deletedAt).toBeDefined();
  });

  it("handles name collision by appending timestamp", async () => {
    writeFileSync(join(testDir, "dup.md"), "first");
    await fileDelete(testDir, "dup.md");
    writeFileSync(join(testDir, "dup.md"), "second");
    const result = await fileDelete(testDir, "dup.md");
    expect(result.ok).toBe(true);
    // Both should exist in trash
    const manifest = JSON.parse(
      readFileSync(join(testDir, ".trash", ".manifest.json"), "utf-8"),
    );
    expect(manifest).toHaveLength(2);
  });

  it("returns error for non-existent file", async () => {
    const result = await fileDelete(testDir, "nope.md");
    expect(result).toEqual({ ok: false, error: "Not found", status: 404 });
  });

  it("returns error for path traversal", async () => {
    const result = await fileDelete(testDir, "../../etc/passwd");
    expect(result).toEqual({ ok: false, error: "Invalid path" });
  });
});

describe("trashList", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-list-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns empty entries when trash is empty", async () => {
    const result = await trashList(testDir);
    expect(result.entries).toEqual([]);
  });

  it("lists trashed items with metadata", async () => {
    writeFileSync(join(testDir, "a.md"), "aaa");
    writeFileSync(join(testDir, "b.txt"), "bb");
    await fileDelete(testDir, "a.md");
    await fileDelete(testDir, "b.txt");
    const result = await trashList(testDir);
    expect(result.entries).toHaveLength(2);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain("a.md");
    expect(names).toContain("b.txt");
    expect(result.entries[0].originalPath).toBeDefined();
    expect(result.entries[0].deletedAt).toBeDefined();
    expect(result.entries[0].type).toBeDefined();
  });
});

describe("trashRestore", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-restore-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("restores a file to its original location", async () => {
    writeFileSync(join(testDir, "restore-me.md"), "content");
    const deleteResult = await fileDelete(testDir, "restore-me.md");
    expect(existsSync(join(testDir, "restore-me.md"))).toBe(false);

    const result = await trashRestore(testDir, deleteResult.trashPath!);
    expect(result).toEqual({ ok: true, restoredTo: "restore-me.md" });
    expect(readFileSync(join(testDir, "restore-me.md"), "utf-8")).toBe(
      "content",
    );
    expect(existsSync(join(testDir, deleteResult.trashPath!))).toBe(false);
  });

  it("removes entry from manifest after restore", async () => {
    writeFileSync(join(testDir, "a.md"), "a");
    writeFileSync(join(testDir, "b.md"), "b");
    await fileDelete(testDir, "a.md");
    const bResult = await fileDelete(testDir, "b.md");

    await trashRestore(testDir, bResult.trashPath!);
    const list = await trashList(testDir);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].name).toBe("a.md");
  });

  it("returns 409 if original location is occupied", async () => {
    writeFileSync(join(testDir, "conflict.md"), "original");
    const deleteResult = await fileDelete(testDir, "conflict.md");
    writeFileSync(join(testDir, "conflict.md"), "new content");

    const result = await trashRestore(testDir, deleteResult.trashPath!);
    expect(result).toEqual({
      ok: false,
      error: "Destination already exists",
      status: 409,
    });
  });

  it("returns 404 for non-existent trash path", async () => {
    const result = await trashRestore(testDir, ".trash/nonexistent.md");
    expect(result).toEqual({ ok: false, error: "Not found in trash", status: 404 });
  });
});

describe("trashEmpty", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-empty-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("permanently deletes all trash contents", async () => {
    writeFileSync(join(testDir, "a.md"), "a");
    writeFileSync(join(testDir, "b.md"), "b");
    writeFileSync(join(testDir, "c.md"), "c");
    await fileDelete(testDir, "a.md");
    await fileDelete(testDir, "b.md");
    await fileDelete(testDir, "c.md");

    const result = await trashEmpty(testDir);
    expect(result).toEqual({ ok: true, deleted: 3 });
    const list = await trashList(testDir);
    expect(list.entries).toEqual([]);
  });

  it("returns 0 deleted when trash is empty", async () => {
    const result = await trashEmpty(testDir);
    expect(result).toEqual({ ok: true, deleted: 0 });
  });
});

describe("concurrent operations", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-concurrent-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("handles concurrent deletes without corrupting manifest", async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `content ${i}`);
    }

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => fileDelete(testDir, `file${i}.md`)),
    );

    const list = await trashList(testDir);
    expect(list.entries).toHaveLength(5);
  });
});
