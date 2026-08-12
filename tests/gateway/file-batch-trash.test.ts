import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileBatchTrashInvalidRequestError,
  FileBatchTrashService,
  FileBatchTrashUnavailableError,
} from "../../packages/gateway/src/file-management/batch-service.js";
import { FileOperationRequestIdConflictError } from "../../packages/gateway/src/file-management/result-cache.js";
import { FileOperationResultCache } from "../../packages/gateway/src/file-management/result-cache.js";
import type { NativeFileCapabilityResult } from "../../packages/gateway/src/file-management/native-file-capability.js";
import type { NoReplaceFileMoveCapability } from "../../packages/gateway/src/file-ops.js";
import { TrashManifestQueue } from "../../packages/gateway/src/trash.js";

const OWNER_ID = "owner-a";

describe("FileBatchTrashService", () => {
  let homePath: string;
  let service: FileBatchTrashService;
  let capability: FilesystemNoReplaceMoveCapability;
  let requestCounter: number;
  const extraRoots: string[] = [];

  beforeEach(() => {
    homePath = join(tmpdir(), `file-batch-trash-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(join(homePath, "projects", "inbox"), { recursive: true });
    capability = new FilesystemNoReplaceMoveCapability();
    service = new FileBatchTrashService({ moveCapability: capability });
    requestCounter = 1;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.close();
    rmSync(homePath, { recursive: true, force: true });
    for (const root of extraRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns ordered per-item results and the authoritative source directory", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "one.md"), "one");
    mkdirSync(join(homePath, "projects", "inbox", "folder"));
    writeFileSync(join(homePath, "projects", "inbox", "folder", "nested.md"), "nested");

    const result = await service.trash(input(nextRequestId(), [
      "projects/inbox/one.md",
      "projects/inbox/folder",
    ]));

    expect(result).toEqual({
      results: [
        { source: "projects/inbox/one.md", code: "trashed" },
        { source: "projects/inbox/folder", code: "trashed" },
      ],
      sourceDirectory: "projects/inbox",
    });
    const manifest = JSON.parse(readFileSync(join(homePath, ".trash", ".manifest.json"), "utf8"));
    expect(manifest.map((entry: { originalPath: string }) => entry.originalPath))
      .toEqual(["projects/inbox/one.md", "projects/inbox/folder"]);
  });

  it("serializes legacy and batch Trash operations through the same owned home queue", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "legacy.md"), "legacy");
    writeFileSync(join(homePath, "projects", "inbox", "batch.md"), "batch");

    const [legacy, batch] = await Promise.all([
      service.delete(homePath, "projects/inbox/legacy.md"),
      service.trash(input(nextRequestId(), ["projects/inbox/batch.md"])),
    ]);

    expect(legacy.ok).toBe(true);
    expect(batch.results).toEqual([{ source: "projects/inbox/batch.md", code: "trashed" }]);
    const list = await service.list(homePath);
    expect(list.entries.map((entry) => entry.originalPath).sort()).toEqual([
      "projects/inbox/batch.md",
      "projects/inbox/legacy.md",
    ]);
  });

  it("keeps a source named .manifest.json without overwriting the Trash manifest", async () => {
    writeFileSync(join(homePath, "projects", ".manifest.json"), "owner bytes");

    const result = await service.trash(input(nextRequestId(), ["projects/.manifest.json"]));
    const listed = await service.list(homePath);

    expect(result.results).toEqual([{ source: "projects/.manifest.json", code: "trashed" }]);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0].trashPath).not.toBe(".trash/.manifest.json");
    expect(readFileSync(join(homePath, listed.entries[0].trashPath), "utf8")).toBe("owner bytes");
    expect(() => JSON.parse(readFileSync(join(homePath, ".trash", ".manifest.json"), "utf8")))
      .not.toThrow();
  });

  it("reserves the Trash manifest namespace without case sensitivity", async () => {
    writeFileSync(join(homePath, "projects", ".MANIFEST.JSON"), "owner bytes");

    const result = await service.trash(input(nextRequestId(), ["projects/.MANIFEST.JSON"]));
    const listed = await service.list(homePath);

    expect(result.results).toEqual([{ source: "projects/.MANIFEST.JSON", code: "trashed" }]);
    expect(listed.entries[0].trashPath.toLowerCase()).not.toBe(".trash/.manifest.json");
    expect(readFileSync(join(homePath, listed.entries[0].trashPath), "utf8")).toBe("owner bytes");
  });

  it.each([
    ["exact", ".manifest.json.00000000-0000-4000-8000-000000000000.tmp"],
    ["case variant", ".MANIFEST.JSON.00000000-0000-4000-8000-000000000000.TMP"],
    ["255-byte boundary", `.manifest.json.${"a".repeat(236)}.tmp`],
  ])("trashes a temp-looking user basename: %s", async (_description, sourceName) => {
    expect(Buffer.byteLength(sourceName, "utf8")).toBeLessThanOrEqual(255);
    writeFileSync(join(homePath, "projects", sourceName), "owner temp-looking bytes");

    const result = await service.trash(input(nextRequestId(), [`projects/${sourceName}`]));
    const listed = await service.list(homePath);

    expect(result.results).toEqual([{ source: `projects/${sourceName}`, code: "trashed" }]);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0].trashPath).not.toBe(`.trash/${sourceName}`);
    expect(Buffer.byteLength(listed.entries[0].trashPath.split("/").at(-1)!, "utf8"))
      .toBeLessThanOrEqual(255);
    expect(readFileSync(join(homePath, listed.entries[0].trashPath), "utf8"))
      .toBe("owner temp-looking bytes");
  });

  it("preserves a late claimant and retries a bounded no-replace Trash name", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "race.md"), "source");
    let installedClaimant = false;
    capability.beforeMove = async (targetPath) => {
      if (installedClaimant || targetPath !== ".trash/race.md") return;
      installedClaimant = true;
      writeFileSync(join(homePath, targetPath), "claimant");
    };

    const result = await service.trash(input(nextRequestId(), ["projects/inbox/race.md"]));
    const listed = await service.list(homePath);

    expect(result.results).toEqual([{ source: "projects/inbox/race.md", code: "trashed" }]);
    expect(readFileSync(join(homePath, ".trash", "race.md"), "utf8")).toBe("claimant");
    expect(listed.entries[0].trashPath).not.toBe(".trash/race.md");
    expect(readFileSync(join(homePath, listed.entries[0].trashPath), "utf8")).toBe("source");
  });

  it.runIf(process.platform !== "win32")("preserves a dangling symlink claimant and its outside target", async () => {
    const outside = join(dirname(homePath), `${homePath.split("/").at(-1)}-dangling`);
    mkdirSync(outside);
    extraRoots.push(outside);
    mkdirSync(join(homePath, ".trash"));
    symlinkSync(join(outside, "missing.md"), join(homePath, ".trash", "dangling.md"));
    writeFileSync(join(homePath, "projects", "inbox", "dangling.md"), "source");

    const result = await service.trash(input(nextRequestId(), ["projects/inbox/dangling.md"]));
    const listed = await service.list(homePath);

    expect(result.results).toEqual([{ source: "projects/inbox/dangling.md", code: "trashed" }]);
    expect(lstatSync(join(homePath, ".trash", "dangling.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "missing.md"))).toBe(false);
    expect(listed.entries[0].trashPath).not.toBe(".trash/dangling.md");
    expect(readFileSync(join(homePath, listed.entries[0].trashPath), "utf8")).toBe("source");
  });

  it("rejects manifest entries that claim reserved manifest or temp paths", async () => {
    mkdirSync(join(homePath, ".trash"));
    for (const reservedPath of [
      ".trash/.manifest.json",
      ".trash/.manifest.json.00000000-0000-4000-8000-000000000000.tmp",
      ".trash/.MANIFEST.JSON.00000000-0000-4000-8000-000000000000.TMP",
    ]) {
      writeFileSync(join(homePath, ".trash", ".manifest.json"), JSON.stringify([{
        name: "owner.md",
        originalPath: "projects/owner.md",
        deletedAt: "2026-08-11T00:00:00.000Z",
        trashPath: reservedPath,
      }]));
      await expect(service.list(homePath)).rejects.toMatchObject({
        code: "failed",
        message: "Trash manifest is unavailable",
      });
    }
  });

  it("reports protected items without moving them", async () => {
    mkdirSync(join(homePath, "system"));
    writeFileSync(join(homePath, "system", "settings.json"), "{}");

    const result = await service.trash(input(nextRequestId(), ["system/settings.json"]));

    expect(result.results).toEqual([{ source: "system/settings.json", code: "protected" }]);
    expect(existsSync(join(homePath, "system", "settings.json"))).toBe(true);
  });

  it("keeps ordered successful results around a missing-item failure without rollback", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "first.md"), "first");
    writeFileSync(join(homePath, "projects", "inbox", "last.md"), "last");

    const result = await service.trash(input(nextRequestId(), [
      "projects/inbox/first.md",
      "projects/inbox/missing.md",
      "projects/inbox/last.md",
    ]));

    expect(result.results).toEqual([
      { source: "projects/inbox/first.md", code: "trashed" },
      { source: "projects/inbox/missing.md", code: "source_missing" },
      { source: "projects/inbox/last.md", code: "trashed" },
    ]);
    expect(existsSync(join(homePath, "projects", "inbox", "first.md"))).toBe(false);
    expect(existsSync(join(homePath, "projects", "inbox", "last.md"))).toBe(false);
  });

  it("replays an identical request without moving the source twice", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "replay.md"), "replay");
    const request = input(nextRequestId(), ["projects/inbox/replay.md"]);

    const first = await service.trash(request);
    const replay = await service.trash(request);

    expect(replay).toEqual(first);
    const manifest = JSON.parse(readFileSync(join(homePath, ".trash", ".manifest.json"), "utf8"));
    expect(manifest).toHaveLength(1);
  });

  it("rejects reuse of an owner request ID with different sources", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "one.md"), "one");
    writeFileSync(join(homePath, "projects", "inbox", "two.md"), "two");
    const requestId = nextRequestId();
    await service.trash(input(requestId, ["projects/inbox/one.md"]));

    await expect(service.trash(input(requestId, ["projects/inbox/two.md"])))
      .rejects.toBeInstanceOf(FileOperationRequestIdConflictError);
    expect(readFileSync(join(homePath, "projects", "inbox", "two.md"), "utf8")).toBe("two");
  });

  it.runIf(process.platform !== "win32")("rejects source and parent symlinks that escape owner home", async () => {
    const outside = join(dirname(homePath), `${homePath.split("/").at(-1)}-outside`);
    mkdirSync(outside);
    extraRoots.push(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(join(outside, "secret.md"), join(homePath, "projects", "inbox", "linked.md"));
    symlinkSync(outside, join(homePath, "projects", "linked-parent"), "dir");

    const sourceResult = await service.trash(input(nextRequestId(), ["projects/inbox/linked.md"]));
    const parentResult = await service.trash(input(nextRequestId(), ["projects/linked-parent/secret.md"]));

    expect(sourceResult.results).toEqual([
      { source: "projects/inbox/linked.md", code: "invalid_destination" },
    ]);
    expect(parentResult.results).toEqual([
      { source: "projects/linked-parent/secret.md", code: "invalid_destination" },
    ]);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("secret");
  });

  it.runIf(process.platform !== "win32")("fails safely when the Trash directory is a symlink outside owner home", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outside = join(dirname(homePath), `${homePath.split("/").at(-1)}-trash-outside`);
    mkdirSync(outside);
    extraRoots.push(outside);
    symlinkSync(outside, join(homePath, ".trash"), "dir");
    writeFileSync(join(homePath, "projects", "inbox", "stay.md"), "stay");

    const result = await service.trash(input(nextRequestId(), ["projects/inbox/stay.md"]));

    expect(result.results).toEqual([{ source: "projects/inbox/stay.md", code: "failed" }]);
    expect(readFileSync(join(homePath, "projects", "inbox", "stay.md"), "utf8")).toBe("stay");
    expect(existsSync(join(outside, "stay.md"))).toBe(false);
    expect(existsSync(join(outside, ".manifest.json"))).toBe(false);
  });

  it("accepts exactly 100 sources and rejects 101 before moving anything", async () => {
    const sources = Array.from({ length: 101 }, (_, index) => `projects/inbox/${index}.md`);
    for (const source of sources) writeFileSync(join(homePath, source), source);

    const accepted = await service.trash(input(nextRequestId(), sources.slice(0, 100)));
    expect(accepted.results).toHaveLength(100);
    expect(accepted.results.every((result) => result.code === "trashed")).toBe(true);

    await expect(service.trash(input(nextRequestId(), sources)))
      .rejects.toBeInstanceOf(FileBatchTrashInvalidRequestError);
    expect(readFileSync(join(homePath, sources[100]), "utf8")).toBe(sources[100]);
  });

  it("rejects new work after service shutdown releases its owned resources", async () => {
    await service.close();

    await expect(service.trash(input(nextRequestId(), ["projects/inbox/later.md"])))
      .rejects.toBeInstanceOf(FileBatchTrashUnavailableError);
  });

  it.each(["capacity", "closed"] as const)(
    "surfaces manifest queue %s as operation unavailable instead of an item failure",
    async (scenario) => {
      const manifestQueue = new TrashManifestQueue({ maxPending: 1 });
      let release: (() => void) | undefined;
      let blocked: Promise<void> | undefined;
      if (scenario === "capacity") {
        blocked = manifestQueue.run(homePath, () => new Promise<void>((resolve) => {
          release = resolve;
        }));
        await Promise.resolve();
      } else {
        await manifestQueue.close();
      }
      const constrained = new FileBatchTrashService({ manifestQueue, moveCapability: capability });

      await expect(constrained.trash(input(nextRequestId(), ["projects/inbox/later.md"])))
        .rejects.toMatchObject({ code: "operation_unavailable" });

      release?.();
      if (blocked) await blocked;
      await constrained.close();
      if (scenario === "capacity") await manifestQueue.close();
    },
  );

  it("shares one close promise and does not resolve a concurrent close before active Trash drains", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "drain.md"), "drain");
    let releaseMove!: () => void;
    let markMoveStarted!: () => void;
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    capability.beforeMove = async () => {
      markMoveStarted();
      await moveGate;
    };
    const operation = service.trash(input(nextRequestId(), ["projects/inbox/drain.md"]));
    const admission = await Promise.race([
      moveStarted.then(() => "started"),
      operation.then(() => "completed"),
    ]);
    expect(admission).toBe("started");

    const firstClose = service.close();
    const secondClose = service.close();
    expect(secondClose).toBe(firstClose);
    let closeSettled = false;
    void secondClose.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseMove();
    await Promise.all([operation, firstClose, secondClose]);
    expect(existsSync(join(homePath, "projects", "inbox", "drain.md"))).toBe(false);
  });

  it("leaves injected queue and result cache ownership with their caller", async () => {
    await service.close();
    const queue = new TrashManifestQueue();
    const cache = new FileOperationResultCache();
    const cacheInput = {
      ownerId: OWNER_ID,
      namespace: "ownership",
      requestId: nextRequestId(),
      payloadHash: "same-payload",
    };
    await cache.run(cacheInput, async () => "retained");
    service = new FileBatchTrashService({
      manifestQueue: queue,
      resultCache: cache,
      moveCapability: capability,
    });

    await service.close();

    await expect(queue.run(homePath, async () => "queue-open")).resolves.toBe("queue-open");
    await expect(cache.run(cacheInput, async () => "cleared")).resolves.toBe("retained");
    await queue.close();
    cache.close();
  });

  it("closes each owned queue and result cache exactly once", async () => {
    await service.close();
    const queueClose = vi.spyOn(TrashManifestQueue.prototype, "close");
    const cacheClose = vi.spyOn(FileOperationResultCache.prototype, "close");
    service = new FileBatchTrashService({ moveCapability: capability });

    await Promise.all([service.close(), service.close()]);

    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(cacheClose).toHaveBeenCalledTimes(1);
  });

  it("cleans a partial manifest temp write and retains the moved item as a safe orphan", async () => {
    await service.close();
    let temporaryPath: string | undefined;
    service = new FileBatchTrashService({
      moveCapability: capability,
      manifestIo: {
        writeTemporary: async (path, contents) => {
          temporaryPath = path;
          await writeFile(path, contents, { flag: "wx" });
          throw new Error("injected temp write failure");
        },
      },
    });
    writeFileSync(join(homePath, "projects", "inbox", "write-failure.md"), "orphan bytes");

    const result = await service.trash(input(nextRequestId(), ["projects/inbox/write-failure.md"]));

    expect(result.results).toEqual([{ source: "projects/inbox/write-failure.md", code: "failed" }]);
    expect(existsSync(join(homePath, "projects", "inbox", "write-failure.md"))).toBe(false);
    expect(readFileSync(join(homePath, ".trash", "write-failure.md"), "utf8")).toBe("orphan bytes");
    expect(temporaryPath).toBeDefined();
    expect(existsSync(temporaryPath!)).toBe(false);
    expect(existsSync(join(homePath, ".trash", ".manifest.json"))).toBe(false);
  });

  it("cleans the manifest temp file after atomic manifest rename fails", async () => {
    await service.close();
    service = new FileBatchTrashService({
      moveCapability: capability,
      manifestIo: {
        replaceManifest: async () => {
          throw new Error("injected manifest rename failure");
        },
      },
    });
    writeFileSync(join(homePath, "projects", "inbox", "rename-failure.md"), "orphan bytes");

    const result = await service.trash(input(nextRequestId(), ["projects/inbox/rename-failure.md"]));

    expect(result.results).toEqual([{ source: "projects/inbox/rename-failure.md", code: "failed" }]);
    expect(readFileSync(join(homePath, ".trash", "rename-failure.md"), "utf8")).toBe("orphan bytes");
    expect(readdirSync(join(homePath, ".trash")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(homePath, ".trash", ".manifest.json"))).toBe(false);
  });

  function input(requestId: string, sources: string[]) {
    return { ownerId: OWNER_ID, homePath, requestId, sources };
  }

  function nextRequestId(): string {
    const suffix = String(requestCounter++).padStart(12, "0");
    return `b9d9d1d8-8e5d-45d0-8d17-${suffix}`;
  }
});

class FilesystemNoReplaceMoveCapability implements NoReplaceFileMoveCapability {
  beforeMove?: (targetPath: string) => Promise<void>;

  async move(
    homePath: string,
    sourcePath: string,
    targetPath: string,
    createParents: boolean,
  ): Promise<NativeFileCapabilityResult> {
    if (createParents) return { ok: false, code: "invalid_path" };
    await this.beforeMove?.(targetPath);
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
