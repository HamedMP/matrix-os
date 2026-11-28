import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { lstat } from "node:fs/promises";
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
  fileDelete,
  trashList,
  trashRestore,
  trashEmpty,
} from "../../packages/gateway/src/trash.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat) };
});

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
    expect(readFileSync(join(testDir, result.trashPath!), "utf8")).toBe("goodbye");
  });

  it("moves a directory to .trash", async () => {
    mkdirSync(join(testDir, "folder"));
    writeFileSync(join(testDir, "folder", "a.txt"), "a");
    const result = await fileDelete(testDir, "folder");
    expect(result.ok).toBe(true);
    expect(existsSync(join(testDir, "folder"))).toBe(false);
    expect(readFileSync(join(testDir, result.trashPath!, "a.txt"), "utf8")).toBe("a");
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

  it("keeps both recovery records when source names collide", async () => {
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

  it("leaves the source and prior recovery records intact when the index write fails", async () => {
    writeFileSync(join(testDir, "older.txt"), "older");
    await fileDelete(testDir, "older.txt");
    writeFileSync(join(testDir, "new.txt"), "new");
    mkdirSync(join(testDir, ".trash", ".manifest.json.tmp"));

    await expect(fileDelete(testDir, "new.txt")).resolves.toMatchObject({ ok: false, status: 503 });
    expect(readFileSync(join(testDir, "new.txt"), "utf8")).toBe("new");
    expect((await trashList(testDir)).entries.map((entry) => entry.name)).toEqual(["older.txt"]);
  });

  it("does not replace unreadable recovery metadata with an empty index", async () => {
    mkdirSync(join(testDir, ".trash"));
    writeFileSync(join(testDir, ".trash", ".manifest.json"), "corrupt");
    writeFileSync(join(testDir, "new.txt"), "new");

    await expect(fileDelete(testDir, "new.txt")).resolves.toMatchObject({ ok: false, status: 503 });
    expect(readFileSync(join(testDir, "new.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(testDir, ".trash", ".manifest.json"), "utf8")).toBe("corrupt");
  });

  it("does not move a folder containing protected system files", async () => {
    mkdirSync(join(testDir, "system"));
    writeFileSync(join(testDir, "system", "config.json"), "config");

    await expect(fileDelete(testDir, "system")).resolves.toMatchObject({ ok: false, status: 403 });
    expect(readFileSync(join(testDir, "system", "config.json"), "utf8")).toBe("config");
  });

  it("returns error for non-existent file", async () => {
    const result = await fileDelete(testDir, "nope.md");
    expect(result).toEqual({ ok: false, error: "Not found", status: 404 });
  });

  it("returns error for path traversal", async () => {
    const result = await fileDelete(testDir, "../../etc/passwd");
    expect(result).toEqual({ ok: false, error: "Invalid path" });
  });

  it("rejects deleting browser profile files", async () => {
    mkdirSync(join(testDir, "data", "browser-profiles"), { recursive: true });
    writeFileSync(join(testDir, "data", "browser-profiles", "session.json"), "{}");

    const result = await fileDelete(testDir, "data/browser-profiles/session.json");

    expect(result).toEqual({ ok: false, error: "Invalid path" });
    expect(existsSync(join(testDir, "data", "browser-profiles", "session.json"))).toBe(true);
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

  it("preserves legacy recovery records through a new move and restores them", async () => {
    mkdirSync(join(testDir, ".trash"));
    writeFileSync(join(testDir, ".trash", "legacy.txt"), "legacy bytes");
    writeFileSync(join(testDir, ".trash", ".manifest.json"), JSON.stringify([{
      name: "legacy.txt",
      originalPath: "notes/legacy.txt",
      deletedAt: "2026-01-01T00:00:00.000Z",
      trashPath: ".trash/legacy.txt",
    }]));
    writeFileSync(join(testDir, "new.txt"), "new bytes");

    expect((await fileDelete(testDir, "new.txt")).ok).toBe(true);
    expect((await trashList(testDir)).entries.map(entry => entry.name)).toEqual(["legacy.txt", "new.txt"]);
    await expect(trashRestore(testDir, ".trash/legacy.txt")).resolves.toEqual({ ok: true, restoredTo: "notes/legacy.txt" });
    expect(readFileSync(join(testDir, "notes", "legacy.txt"), "utf8")).toBe("legacy bytes");
  });

  it("can list and restore a legacy POSIX name containing a backslash and newline", async () => {
    const name = "legacy\\with-newline\n.txt";
    const trashPath = `.trash/${name}`;
    mkdirSync(join(testDir, ".trash"));
    writeFileSync(join(testDir, trashPath), "legacy bytes");
    writeFileSync(join(testDir, ".trash", ".manifest.json"), JSON.stringify([{
      name, originalPath: name, deletedAt: "2026-01-01T00:00:00.000Z", trashPath,
    }]));

    expect((await trashList(testDir)).entries).toEqual([expect.objectContaining({ name, trashPath })]);
    await expect(trashRestore(testDir, trashPath)).resolves.toEqual({ ok: true, restoredTo: name });
    expect(readFileSync(join(testDir, name), "utf8")).toBe("legacy bytes");
  });

  it.each(["file", "folder"] as const)("keeps a concurrently recreated %s and its Trash backup", async (kind) => {
    const destination = join(testDir, "recreated");
    if (kind === "file") writeFileSync(destination, "original bytes");
    else {
      mkdirSync(destination);
      writeFileSync(join(destination, "notes.txt"), "original bytes");
    }
    const moved = await fileDelete(testDir, "recreated");
    const originalLstat = vi.mocked(lstat).getMockImplementation()!;
    let recreated = false;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      try { return await originalLstat(...args); }
      catch (error) {
        if (!recreated && args[0] === destination) {
          recreated = true;
          if (kind === "file") writeFileSync(destination, "new user bytes");
          else mkdirSync(destination);
        }
        throw error;
      }
    });
    try {
      await expect(trashRestore(testDir, moved.trashPath!)).resolves.toMatchObject({ ok: false, status: 409 });
      expect(recreated).toBe(true);
      if (kind === "file") expect(readFileSync(destination, "utf8")).toBe("new user bytes");
      else expect(existsSync(join(destination, "notes.txt"))).toBe(false);
      const trashedContent = kind === "file" ? join(testDir, moved.trashPath!) : join(testDir, moved.trashPath!, "notes.txt");
      expect(readFileSync(trashedContent, "utf8")).toBe("original bytes");
      expect((await trashList(testDir)).entries).toMatchObject([{ trashPath: moved.trashPath }]);
    } finally {
      vi.mocked(lstat).mockImplementation(originalLstat);
    }
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

  it("restores a directory even if stale index cleanup fails", async () => {
    mkdirSync(join(testDir, "folder"));
    writeFileSync(join(testDir, "folder", "notes.txt"), "notes");
    const moved = await fileDelete(testDir, "folder");
    mkdirSync(join(testDir, ".trash", ".manifest.json.tmp"));

    await expect(trashRestore(testDir, moved.trashPath!)).resolves.toMatchObject({ ok: true, restoredTo: "folder" });
    expect(readFileSync(join(testDir, "folder", "notes.txt"), "utf8")).toBe("notes");
    expect((await trashList(testDir)).entries).toEqual([]);
  });

  it("does not restore a new item when an old Trash token is reused", async () => {
    writeFileSync(join(testDir, "note.txt"), "first");
    const first = await fileDelete(testDir, "note.txt");
    await trashRestore(testDir, first.trashPath!);
    writeFileSync(join(testDir, "note.txt"), "second");
    const second = await fileDelete(testDir, "note.txt");

    expect(second.trashPath).not.toBe(first.trashPath);
    await expect(trashRestore(testDir, first.trashPath!)).resolves.toMatchObject({ ok: false, status: 404 });
    expect((await trashList(testDir)).entries).toMatchObject([{ trashPath: second.trashPath }]);
  });

  it("keeps a trashed item recoverable when the restore path is occupied by a dangling link", async () => {
    writeFileSync(join(testDir, "conflict.md"), "original");
    const moved = await fileDelete(testDir, "conflict.md");
    symlinkSync(join(testDir, "missing"), join(testDir, "conflict.md"));

    await expect(trashRestore(testDir, moved.trashPath!)).resolves.toMatchObject({ ok: false, status: 409 });
    expect((await trashList(testDir)).entries).toHaveLength(1);
  });

  it("returns 404 for non-existent trash path", async () => {
    const result = await trashRestore(testDir, ".trash/nonexistent.md");
    expect(result).toEqual({ ok: false, error: "Not found in trash", status: 404 });
  });

  it("rejects path traversal in trashPath", async () => {
    const result = await trashRestore(testDir, "../../etc/passwd");
    expect(result).toEqual({ ok: false, error: "Invalid trash path" });
  });

  it("rejects trashPath outside .trash directory", async () => {
    const result = await trashRestore(testDir, "agents/builder.md");
    expect(result).toEqual({ ok: false, error: "Invalid trash path" });
  });

  it("rejects restoring browser profile files", async () => {
    mkdirSync(join(testDir, ".trash"), { recursive: true });
    writeFileSync(join(testDir, ".trash", "session.json"), "{}");
    writeFileSync(
      join(testDir, ".trash", ".manifest.json"),
      JSON.stringify([
        {
          name: "session.json",
          originalPath: "data/browser-profiles/session.json",
          deletedAt: new Date().toISOString(),
          trashPath: ".trash/session.json",
        },
      ]),
    );

    const result = await trashRestore(testDir, ".trash/session.json");

    expect(result).toEqual({
      ok: false,
      error: "Cannot restore to a protected path",
      status: 403,
    });
    expect(existsSync(join(testDir, ".trash", "session.json"))).toBe(true);
    expect(existsSync(join(testDir, "data", "browser-profiles", "session.json"))).toBe(false);
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
