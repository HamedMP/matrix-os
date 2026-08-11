import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { link, lstat, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fileDelete,
  TrashManifestQueue,
  TrashManifestQueueCapacityError,
  TrashManifestQueueClosedError,
  TrashManifestUnavailableError,
  trashList,
  trashRestore,
  trashEmpty,
} from "../../packages/gateway/src/trash.js";
import type { NativeFileCapabilityResult } from "../../packages/gateway/src/file-management/native-file-capability.js";
import type { NoReplaceFileMoveCapability } from "../../packages/gateway/src/file-ops.js";

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
    const result = await fileDelete(testDir, "doomed.md", { moveCapability });
    expect(result.ok).toBe(true);
    expect(result.trashPath).toBeDefined();
    expect(existsSync(join(testDir, "doomed.md"))).toBe(false);
    expect(existsSync(join(testDir, ".trash", "doomed.md"))).toBe(true);
  });

  it("moves a directory to .trash", async () => {
    mkdirSync(join(testDir, "folder"));
    writeFileSync(join(testDir, "folder", "a.txt"), "a");
    const result = await fileDelete(testDir, "folder", { moveCapability });
    expect(result.ok).toBe(true);
    expect(existsSync(join(testDir, "folder"))).toBe(false);
    expect(existsSync(join(testDir, ".trash", "folder", "a.txt"))).toBe(true);
  });

  it("records entry in manifest", async () => {
    writeFileSync(join(testDir, "logged.md"), "content");
    await fileDelete(testDir, "logged.md", { moveCapability });
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
    await fileDelete(testDir, "dup.md", { moveCapability });
    writeFileSync(join(testDir, "dup.md"), "second");
    const result = await fileDelete(testDir, "dup.md", { moveCapability });
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
    await fileDelete(testDir, "a.md", { moveCapability });
    await fileDelete(testDir, "b.txt", { moveCapability });
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
    const deleteResult = await fileDelete(testDir, "restore-me.md", { moveCapability });
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
    await fileDelete(testDir, "a.md", { moveCapability });
    const bResult = await fileDelete(testDir, "b.md", { moveCapability });

    await trashRestore(testDir, bResult.trashPath!);
    const list = await trashList(testDir);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].name).toBe("a.md");
  });

  it("returns 409 if original location is occupied", async () => {
    writeFileSync(join(testDir, "conflict.md"), "original");
    const deleteResult = await fileDelete(testDir, "conflict.md", { moveCapability });
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
    await fileDelete(testDir, "a.md", { moveCapability });
    await fileDelete(testDir, "b.md", { moveCapability });
    await fileDelete(testDir, "c.md", { moveCapability });

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
  let manifestQueue: TrashManifestQueue;

  beforeEach(() => {
    testDir = join(tmpdir(), `trash-concurrent-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manifestQueue = new TrashManifestQueue();
  });

  afterEach(async () => {
    await manifestQueue.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("handles concurrent deletes without corrupting manifest", async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `content ${i}`);
    }

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fileDelete(testDir, `file${i}.md`, { manifestQueue, moveCapability })),
    );

    const list = await trashList(testDir, manifestQueue);
    expect(list.entries).toHaveLength(5);
  });
});

describe("Trash manifest serialization", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("bounds active home queues and removes an entry when that home becomes idle", async () => {
    const queue = new TrashManifestQueue({ maxHomes: 1 });
    const firstHome = makeRoot("trash-queue-first");
    const secondHome = makeRoot("trash-queue-second");
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(firstHome, () => gate);

    await expect(queue.run(secondHome, async () => "never"))
      .rejects.toBeInstanceOf(TrashManifestQueueCapacityError);

    releaseFirst();
    await first;
    await expect(queue.run(secondHome, async () => "admitted"))
      .resolves.toBe("admitted");
    await queue.close();
  });

  it("drains accepted work and rejects new work after shutdown begins", async () => {
    const queue = new TrashManifestQueue({ maxHomes: 1 });
    const home = makeRoot("trash-queue-close");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(home, async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const second = queue.run(home, async () => {
      events.push("second");
    });
    await Promise.resolve();

    const closing = queue.close();
    await expect(queue.run(home, async () => undefined))
      .rejects.toBeInstanceOf(TrashManifestQueueClosedError);
    releaseFirst();
    await closing;
    await Promise.all([first, second]);

    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("bounds pending operations even when they all target one home", async () => {
    const queue = new TrashManifestQueue({ maxHomes: 1, maxPending: 2 });
    const home = makeRoot("trash-queue-pending");
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(home, () => gate);
    const second = queue.run(home, async () => "second");
    const third = queue.run(home, async () => "third");

    const admission = await Promise.race([
      third.then(
        () => "resolved",
        (error: unknown) => error instanceof TrashManifestQueueCapacityError ? "rejected" : "wrong-error",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    releaseFirst();
    await Promise.allSettled([first, second, third]);
    expect(admission).toBe("rejected");
    await expect(queue.run(home, async () => "after-idle"))
      .resolves.toBe("after-idle");
    await queue.close();
  });

  it("does not treat malformed manifest JSON as empty Trash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const home = makeRoot("trash-malformed-manifest");
    const trashDir = join(home, ".trash");
    mkdirSync(trashDir);
    writeFileSync(join(trashDir, ".manifest.json"), "{not-json");
    writeFileSync(join(home, "keep.md"), "keep");

    await expect(trashList(home)).rejects.toBeInstanceOf(TrashManifestUnavailableError);
    const result = await fileDelete(home, "keep.md", { moveCapability });

    expect(result).toEqual({ ok: false, error: "Trash operation failed", status: 500 });
    expect(readFileSync(join(home, "keep.md"), "utf8")).toBe("keep");
    expect(readFileSync(join(trashDir, ".manifest.json"), "utf8")).toBe("{not-json");
  });

  it("distinguishes an unreadable manifest from a missing manifest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const home = makeRoot("trash-unreadable-manifest");
    const manifestPath = join(home, ".trash", ".manifest.json");
    mkdirSync(manifestPath, { recursive: true });

    await expect(trashList(home)).rejects.toMatchObject({
      code: "failed",
      message: "Trash manifest is unavailable",
    });
  });

  it("rejects manifest entries whose trash path is outside the Trash namespace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const home = makeRoot("trash-invalid-entry-path");
    const trashDir = join(home, ".trash");
    mkdirSync(trashDir);
    writeFileSync(join(trashDir, ".manifest.json"), JSON.stringify([{
      name: "outside.md",
      originalPath: "projects/outside.md",
      deletedAt: "2026-08-11T00:00:00.000Z",
      trashPath: "projects/outside.md",
    }]));

    await expect(trashList(home)).rejects.toBeInstanceOf(TrashManifestUnavailableError);
  });

  it.runIf(process.platform !== "win32")("preserves existing portable-path names that typed create would not admit", async () => {
    const home = makeRoot("trash-existing-name");
    writeFileSync(join(home, "legacy:name.md"), "legacy");

    await fileDelete(home, "legacy:name.md", { moveCapability });

    await expect(trashList(home)).resolves.toMatchObject({
      entries: [{ name: "legacy:name.md", originalPath: "legacy:name.md" }],
    });
  });

  it.runIf(process.platform !== "win32")("rejects a manifest symlink instead of reading through it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const home = makeRoot("trash-manifest-symlink");
    const trashDir = join(home, ".trash");
    mkdirSync(trashDir);
    writeFileSync(join(home, "outside-manifest.json"), "[]");
    symlinkSync(join(home, "outside-manifest.json"), join(trashDir, ".manifest.json"));
    writeFileSync(join(home, "stay.md"), "stay");

    const result = await fileDelete(home, "stay.md", { moveCapability });

    expect(result).toEqual({ ok: false, error: "Trash operation failed", status: 500 });
    expect(readFileSync(join(home, "stay.md"), "utf8")).toBe("stay");
    expect(readFileSync(join(home, "outside-manifest.json"), "utf8")).toBe("[]");
  });

  function makeRoot(prefix: string): string {
    const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    return root;
  }
});

class FilesystemNoReplaceMoveCapability implements NoReplaceFileMoveCapability {
  async move(
    homePath: string,
    sourcePath: string,
    targetPath: string,
    createParents: boolean,
  ): Promise<NativeFileCapabilityResult> {
    if (createParents) return { ok: false, code: "invalid_path" };
    const source = join(homePath, sourcePath);
    const target = join(homePath, targetPath);
    try {
      const stats = await lstat(source);
      if (stats.isDirectory()) {
        await mkdir(target);
        await rmdir(target);
        await rename(source, target);
      } else {
        await link(source, target);
        await unlink(source);
      }
      return { ok: true, code: "ok" };
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return { ok: false, code: "source_missing" };
      if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) {
        return { ok: false, code: "destination_conflict" };
      }
      return { ok: false, code: "failed" };
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const moveCapability = new FilesystemNoReplaceMoveCapability();
