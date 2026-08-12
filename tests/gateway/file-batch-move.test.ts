import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { copyFile, link, lstat, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectAffectedDirectories,
  FileBatchMoveService,
  FileBatchStalePreflightError,
} from "../../packages/gateway/src/file-management/batch-service.js";
import type {
  NativeFileCapabilityResult,
} from "../../packages/gateway/src/file-management/native-file-capability.js";
import type {
  NoReplaceFileMoveCapability,
} from "../../packages/gateway/src/file-ops.js";
import {
  FileOperationCacheCapacityError,
  type FileOperationResultCache,
} from "../../packages/gateway/src/file-management/result-cache.js";

const OWNER_ID = "owner-a";

class FilesystemNoReplaceMoveCapability implements NoReplaceFileMoveCapability {
  moveCalls = 0;
  beforeMove?: (targetPath: string) => Promise<void>;
  private forcedSource?: string;
  private forcedCode?: NativeFileCapabilityResult["code"];

  forceFailure(source: string, code: NativeFileCapabilityResult["code"]): void {
    this.forcedSource = source;
    this.forcedCode = code;
  }

  async move(
    homePath: string,
    sourcePath: string,
    targetPath: string,
    createParents: boolean,
  ): Promise<NativeFileCapabilityResult> {
    this.moveCalls += 1;
    if (createParents) return { ok: false, code: "invalid_path" };
    const forcedCode = sourcePath === this.forcedSource ? this.forcedCode : undefined;
    if (forcedCode) return { ok: false, code: forcedCode };
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
        try {
          await link(source, target);
        } catch (error: unknown) {
          if (!isErrno(error, "EPERM")) throw error;
          await copyFile(source, target, constants.COPYFILE_EXCL);
        }
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

describe("FileBatchMoveService", () => {
  let homePath: string;
  let capability: FilesystemNoReplaceMoveCapability;
  let service: FileBatchMoveService;
  let requestCounter: number;
  let extraRoots: string[];

  beforeEach(() => {
    homePath = join(tmpdir(), `file-batch-move-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(join(homePath, "projects", "inbox"), { recursive: true });
    mkdirSync(join(homePath, "projects", "archive"), { recursive: true });
    capability = new FilesystemNoReplaceMoveCapability();
    service = new FileBatchMoveService({ moveCapability: capability });
    requestCounter = 1;
    extraRoots = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    service.close();
    rmSync(homePath, { recursive: true, force: true });
    for (const root of extraRoots) rmSync(root, { recursive: true, force: true });
  });

  it("moves files and directories and returns authoritative affected directories", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "notes.md"), "notes");
    mkdirSync(join(homePath, "projects", "inbox", "folder"));
    writeFileSync(join(homePath, "projects", "inbox", "folder", "nested.txt"), "nested");

    const result = await preflightAndExecute(service, homePath, nextRequestId(), [
      "projects/inbox/notes.md",
      "projects/inbox/folder",
    ]);

    expect(result).toEqual({
      results: [
        { source: "projects/inbox/notes.md", destination: "projects/archive/notes.md", code: "moved" },
        { source: "projects/inbox/folder", destination: "projects/archive/folder", code: "moved" },
      ],
      affectedDirectories: ["projects/inbox", "projects/archive"],
    });
    expect(readFileSync(join(homePath, "projects", "archive", "notes.md"), "utf8")).toBe("notes");
    expect(readFileSync(join(homePath, "projects", "archive", "folder", "nested.txt"), "utf8")).toBe("nested");
  });

  it.runIf(process.platform !== "win32")("rejects FIFO and socket sources as invalid destinations", async () => {
    const fifoSource = "projects/inbox/events.fifo";
    const socketSource = "projects/inbox/events.sock";
    expect(spawnSync("mkfifo", [join(homePath, fifoSource)]).status).toBe(0);
    const server = createServer();
    const shortSocketPath = join(tmpdir(), `fbm-${process.pid}-${requestCounter}.sock`);
    server.listen(shortSocketPath);
    await once(server, "listening");
    renameSync(shortSocketPath, join(homePath, socketSource));
    try {
      const result = await preflightAndExecute(service, homePath, nextRequestId(), [fifoSource, socketSource]);
      expect(result.results).toEqual([
        { source: fifoSource, code: "invalid_destination" },
        { source: socketSource, code: "invalid_destination" },
      ]);
      expect(existsSync(join(homePath, "projects", "archive", "events.fifo"))).toBe(false);
      expect(existsSync(join(homePath, "projects", "archive", "events.sock"))).toBe(false);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("collects every source parent in first-seen order before the destination", () => {
    expect(collectAffectedDirectories(
      ["projects/one/a.md", "downloads/b.md", "projects/one/c.md"],
      "projects/archive",
    ))
      .toEqual(["projects/one", "downloads", "projects/archive"]);
  });

  it("uses Finder-style Keep Both names for files and directories", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "notes.md"), "incoming");
    mkdirSync(join(homePath, "projects", "inbox", "folder"));
    writeFileSync(join(homePath, "projects", "inbox", "folder", "incoming.txt"), "incoming folder");
    writeFileSync(join(homePath, "projects", "archive", "notes.md"), "original");
    writeFileSync(join(homePath, "projects", "archive", "notes copy.md"), "first copy");
    mkdirSync(join(homePath, "projects", "archive", "folder"));
    writeFileSync(join(homePath, "projects", "archive", "folder", "claimant.txt"), "claimant folder");

    const result = await preflightAndExecute(
      service,
      homePath,
      nextRequestId(),
      ["projects/inbox/notes.md", "projects/inbox/folder"],
      [
        { source: "projects/inbox/notes.md", resolution: "keep-both" },
        { source: "projects/inbox/folder", resolution: "keep-both" },
      ],
    );

    expect(result.results).toEqual([
      { source: "projects/inbox/notes.md", destination: "projects/archive/notes copy 2.md", code: "moved" },
      { source: "projects/inbox/folder", destination: "projects/archive/folder copy", code: "moved" },
    ]);
    expect(readFileSync(join(homePath, "projects", "archive", "notes.md"), "utf8")).toBe("original");
    expect(readFileSync(join(homePath, "projects", "archive", "notes copy.md"), "utf8")).toBe("first copy");
    expect(readFileSync(join(homePath, "projects", "archive", "notes copy 2.md"), "utf8")).toBe("incoming");
    expect(readFileSync(join(homePath, "projects", "archive", "folder", "claimant.txt"), "utf8")).toBe("claimant folder");
    expect(readFileSync(join(homePath, "projects", "archive", "folder copy", "incoming.txt"), "utf8")).toBe("incoming folder");
  });

  it("continues existing Finder copy numbering and truncates valid 255-byte names", async () => {
    const longName = `${"x".repeat(252)}.md`;
    const truncatedCopyName = `${"x".repeat(247)} copy.md`;
    writeFileSync(join(homePath, "projects", "inbox", "report copy.md"), "numbered source");
    writeFileSync(join(homePath, "projects", "archive", "report copy.md"), "numbered claimant");
    writeFileSync(join(homePath, "projects", "inbox", longName), "long source");
    writeFileSync(join(homePath, "projects", "archive", longName), "long claimant");

    const result = await preflightAndExecute(
      service,
      homePath,
      nextRequestId(),
      [`projects/inbox/report copy.md`, `projects/inbox/${longName}`],
      [
        { source: "projects/inbox/report copy.md", resolution: "keep-both" },
        { source: `projects/inbox/${longName}`, resolution: "keep-both" },
      ],
    );

    expect(result.results).toEqual([
      { source: "projects/inbox/report copy.md", destination: "projects/archive/report copy 2.md", code: "moved" },
      { source: `projects/inbox/${longName}`, destination: `projects/archive/${truncatedCopyName}`, code: "moved" },
    ]);
    expect(readFileSync(join(homePath, "projects", "archive", "report copy.md"), "utf8")).toBe("numbered claimant");
    expect(readFileSync(join(homePath, "projects", "archive", longName), "utf8")).toBe("long claimant");
  });

  it("treats a symlink Keep Both name as an atomic conflict and retries the next candidate", async () => {
    const outside = join(dirname(homePath), `${homePath.split("/").at(-1)}-claimant`);
    mkdirSync(outside);
    extraRoots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "outside claimant");
    writeFileSync(join(homePath, "projects", "inbox", "shared.txt"), "incoming");
    writeFileSync(join(homePath, "projects", "archive", "shared.txt"), "original claimant");
    symlinkSync(join(outside, "secret.txt"), join(homePath, "projects", "archive", "shared copy.txt"));

    const result = await preflightAndExecute(
      service,
      homePath,
      nextRequestId(),
      ["projects/inbox/shared.txt"],
      [{ source: "projects/inbox/shared.txt", resolution: "keep-both" }],
    );

    expect(result.results).toEqual([
      { source: "projects/inbox/shared.txt", destination: "projects/archive/shared copy 2.txt", code: "moved" },
    ]);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside claimant");
    expect(lstatSync(join(homePath, "projects", "archive", "shared copy.txt")).isSymbolicLink()).toBe(true);
  });

  it("preserves an atomic claimant that appears after preflight and never overwrites it", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "notes.md"), "incoming");
    const requestId = nextRequestId();
    const preflight = await service.preflight(batchInput(homePath, requestId, ["projects/inbox/notes.md"]));
    capability.beforeMove = async (targetPath) => {
      capability.beforeMove = undefined;
      writeFileSync(join(homePath, targetPath), "late claimant");
    };

    const result = await service.execute(executeInput(homePath, requestId, preflight.preflightFingerprint));

    expect(result.results).toEqual([{ source: "projects/inbox/notes.md", code: "destination_conflict" }]);
    expect(readFileSync(join(homePath, "projects", "archive", "notes.md"), "utf8")).toBe("late claimant");
    expect(readFileSync(join(homePath, "projects", "inbox", "notes.md"), "utf8")).toBe("incoming");
  });

  it("honors Skip and preflight cancellation without mutating either source", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "skip.md"), "skip source");
    writeFileSync(join(homePath, "projects", "archive", "skip.md"), "skip claimant");
    const skipId = nextRequestId();
    const skipPreflight = await service.preflight(batchInput(homePath, skipId, ["projects/inbox/skip.md"]));

    await expect(service.execute(executeInput(homePath, skipId, skipPreflight.preflightFingerprint, [
      { source: "projects/inbox/skip.md", resolution: "skip" },
    ]))).resolves.toMatchObject({
      results: [{ source: "projects/inbox/skip.md", code: "skipped" }],
    });

    writeFileSync(join(homePath, "projects", "inbox", "cancel.md"), "cancel source");
    await service.preflight(batchInput(homePath, nextRequestId(), ["projects/inbox/cancel.md"]));
    expect(readFileSync(join(homePath, "projects", "inbox", "cancel.md"), "utf8")).toBe("cancel source");
    expect(existsSync(join(homePath, "projects", "archive", "cancel.md"))).toBe(false);
  });

  it("fails closed for cross-device moves and continues with ordered partial results", async () => {
    for (const name of ["first.md", "cross-device.md", "missing.md", "last.md"]) {
      if (name !== "missing.md") writeFileSync(join(homePath, "projects", "inbox", name), name);
    }
    capability.forceFailure("projects/inbox/cross-device.md", "cross_device");
    const requestId = nextRequestId();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await preflightAndExecute(service, homePath, requestId, [
      "projects/inbox/first.md",
      "projects/inbox/cross-device.md",
      "projects/inbox/missing.md",
      "projects/inbox/last.md",
    ]);

    expect(result.results).toEqual([
      { source: "projects/inbox/first.md", destination: "projects/archive/first.md", code: "moved" },
      { source: "projects/inbox/cross-device.md", code: "failed" },
      { source: "projects/inbox/missing.md", code: "source_missing" },
      { source: "projects/inbox/last.md", destination: "projects/archive/last.md", code: "moved" },
    ]);
    expect(readFileSync(join(homePath, "projects", "inbox", "cross-device.md"), "utf8")).toBe("cross-device.md");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(requestId));
    errorSpy.mockRestore();
  });

  it("accepts exactly 100 items and rejects a 101-item request", async () => {
    const sources = Array.from({ length: 100 }, (_, index) => `projects/inbox/${index}.md`);
    for (const source of sources) writeFileSync(join(homePath, source), source);

    const result = await preflightAndExecute(service, homePath, nextRequestId(), sources);

    expect(result.results).toHaveLength(100);
    expect(result.results.every((item) => item.code === "moved")).toBe(true);
    await expect(service.preflight(batchInput(homePath, nextRequestId(), [
      ...sources,
      "projects/inbox/100.md",
    ]))).rejects.toMatchObject({ code: "invalid_destination" });
  });

  it("lets concurrent Keep Both requests preserve both contents under distinct claimed names", async () => {
    mkdirSync(join(homePath, "projects", "one"));
    mkdirSync(join(homePath, "projects", "two"));
    writeFileSync(join(homePath, "projects", "one", "shared.txt"), "one");
    writeFileSync(join(homePath, "projects", "two", "shared.txt"), "two");
    writeFileSync(join(homePath, "projects", "archive", "shared.txt"), "claimant");
    const firstId = nextRequestId();
    const secondId = nextRequestId();
    const [firstPreflight, secondPreflight] = await Promise.all([
      service.preflight(batchInput(homePath, firstId, ["projects/one/shared.txt"])),
      service.preflight(batchInput(homePath, secondId, ["projects/two/shared.txt"])),
    ]);

    const [first, second] = await Promise.all([
      service.execute(executeInput(homePath, firstId, firstPreflight.preflightFingerprint, [
        { source: "projects/one/shared.txt", resolution: "keep-both" },
      ])),
      service.execute(executeInput(homePath, secondId, secondPreflight.preflightFingerprint, [
        { source: "projects/two/shared.txt", resolution: "keep-both" },
      ])),
    ]);

    expect([first.results[0]?.destination, second.results[0]?.destination].sort()).toEqual([
      "projects/archive/shared copy 2.txt",
      "projects/archive/shared copy.txt",
    ]);
    expect(readFileSync(join(homePath, "projects", "archive", "shared.txt"), "utf8")).toBe("claimant");
    expect(new Set([
      readFileSync(join(homePath, "projects", "archive", "shared copy.txt"), "utf8"),
      readFileSync(join(homePath, "projects", "archive", "shared copy 2.txt"), "utf8"),
    ])).toEqual(new Set(["one", "two"]));
  });

  it("replays an identical execute result without moving twice", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "once.md"), "once");
    const requestId = nextRequestId();
    const preflight = await service.preflight(batchInput(homePath, requestId, ["projects/inbox/once.md"]));
    const execute = executeInput(homePath, requestId, preflight.preflightFingerprint);

    const first = await service.execute(execute);
    const replay = await service.execute(execute);

    expect(replay).toEqual(first);
    expect(capability.moveCalls).toBe(1);
    expect(readFileSync(join(homePath, "projects", "archive", "once.md"), "utf8")).toBe("once");
  });

  it("expires preflight ten minutes after its original completion even when replayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    try {
      writeFileSync(join(homePath, "projects", "inbox", "expiring.md"), "expiring");
      const requestId = nextRequestId();
      const input = batchInput(homePath, requestId, ["projects/inbox/expiring.md"]);
      const preflight = await service.preflight(input);
      await vi.advanceTimersByTimeAsync(599_999);
      await service.preflight(input);
      await vi.advanceTimersByTimeAsync(2);

      await expect(service.execute(executeInput(homePath, requestId, preflight.preflightFingerprint)))
        .rejects.toBeInstanceOf(FileBatchStalePreflightError);
      expect(readFileSync(join(homePath, "projects", "inbox", "expiring.md"), "utf8")).toBe("expiring");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a new preflight instead of evicting an accepted live preflight", async () => {
    const passthroughCache = {
      run: <T>(_input: unknown, operation: () => Promise<T>) => operation(),
      close: vi.fn(),
    } as unknown as FileOperationResultCache;
    const boundedService = new FileBatchMoveService({
      preflightResultCache: passthroughCache,
      moveCapability: capability,
    });
    writeFileSync(join(homePath, "projects", "inbox", "retained.md"), "retained");
    const firstId = nextRequestId();
    const first = await boundedService.preflight(
      batchInput(homePath, firstId, ["projects/inbox/retained.md"]),
    );
    for (let index = 1; index < 512; index += 1) {
      await boundedService.preflight(
        batchInput(homePath, nextRequestId(), ["projects/inbox/retained.md"]),
      );
    }

    await expect(boundedService.preflight(
      batchInput(homePath, nextRequestId(), ["projects/inbox/retained.md"]),
    )).rejects.toBeInstanceOf(FileOperationCacheCapacityError);
    await expect(boundedService.execute(
      executeInput(homePath, firstId, first.preflightFingerprint),
    )).resolves.toMatchObject({ results: [{ code: "moved" }] });
    boundedService.close();
  });

  it("preserves execution capacity for an accepted preflight when the preflight cache is full", async () => {
    writeFileSync(join(homePath, "projects", "inbox", "capacity.md"), "capacity");
    const firstId = nextRequestId();
    const first = await service.preflight(
      batchInput(homePath, firstId, ["projects/inbox/capacity.md"]),
    );
    for (let index = 1; index < 512; index += 1) {
      await service.preflight(
        batchInput(homePath, nextRequestId(), ["projects/inbox/capacity.md"]),
      );
    }

    await expect(service.execute(
      executeInput(homePath, firstId, first.preflightFingerprint),
    )).resolves.toMatchObject({ results: [{ source: "projects/inbox/capacity.md", code: "moved" }] });
  });

  it("re-authorizes symlinks and stale source state immediately before execution", async () => {
    const outside = join(dirname(homePath), `${homePath.split("/").at(-1)}-outside`);
    mkdirSync(outside);
    extraRoots.push(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    writeFileSync(join(homePath, "projects", "inbox", "source.md"), "source");
    const symlinkId = nextRequestId();
    const symlinkPreflight = await service.preflight(batchInput(homePath, symlinkId, ["projects/inbox/source.md"]));
    rmSync(join(homePath, "projects", "archive"), { recursive: true });
    symlinkSync(outside, join(homePath, "projects", "archive"), "dir");

    await expect(service.execute(executeInput(homePath, symlinkId, symlinkPreflight.preflightFingerprint))).resolves.toMatchObject({
      results: [{ source: "projects/inbox/source.md", code: "invalid_destination" }],
    });
    expect(existsSync(join(outside, "source.md"))).toBe(false);

    rmSync(join(homePath, "projects", "archive"));
    mkdirSync(join(homePath, "projects", "archive"));
    const sourceSymlinkId = nextRequestId();
    const sourceSymlinkPreflight = await service.preflight(batchInput(homePath, sourceSymlinkId, ["projects/inbox/source.md"]));
    rmSync(join(homePath, "projects", "inbox", "source.md"));
    symlinkSync(join(outside, "secret.md"), join(homePath, "projects", "inbox", "source.md"));
    await expect(service.execute(executeInput(homePath, sourceSymlinkId, sourceSymlinkPreflight.preflightFingerprint))).resolves.toMatchObject({
      results: [{ source: "projects/inbox/source.md", code: "invalid_destination" }],
    });
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("secret");

    rmSync(join(homePath, "projects", "inbox", "source.md"));
    writeFileSync(join(homePath, "projects", "inbox", "source.md"), "source");
    const missingId = nextRequestId();
    const missingPreflight = await service.preflight(batchInput(homePath, missingId, ["projects/inbox/source.md"]));
    rmSync(join(homePath, "projects", "inbox", "source.md"));
    await expect(service.execute(executeInput(homePath, missingId, missingPreflight.preflightFingerprint))).resolves.toMatchObject({
      results: [{ source: "projects/inbox/source.md", code: "source_missing" }],
    });
  });

  it("rejects traversal, protected roots, self-descendants, and mismatched stale fingerprints", async () => {
    await expect(service.preflight(batchInput(homePath, nextRequestId(), ["../escape.md"])))
      .rejects.toMatchObject({ code: "invalid_destination" });

    mkdirSync(join(homePath, "system"));
    writeFileSync(join(homePath, "system", "settings.json"), "{}");
    const protectedResult = await preflightAndExecute(service, homePath, nextRequestId(), ["system/settings.json"]);
    expect(protectedResult.results).toEqual([{ source: "system/settings.json", code: "protected" }]);

    mkdirSync(join(homePath, "projects", "inbox", "folder", "nested"), { recursive: true });
    const selfId = nextRequestId();
    const selfPreflight = await service.preflight({
      ...batchInput(homePath, selfId, ["projects/inbox/folder"]),
      destinationDirectory: "projects/inbox/folder/nested",
    });
    const selfResult = await service.execute(executeInput(homePath, selfId, selfPreflight.preflightFingerprint));
    expect(selfResult.results).toEqual([{ source: "projects/inbox/folder", code: "invalid_destination" }]);

    writeFileSync(join(homePath, "projects", "inbox", "stale.md"), "stale");
    const staleId = nextRequestId();
    await service.preflight(batchInput(homePath, staleId, ["projects/inbox/stale.md"]));
    await expect(service.execute(executeInput(homePath, staleId, "mismatched-fingerprint")))
      .rejects.toBeInstanceOf(FileBatchStalePreflightError);
    expect(readFileSync(join(homePath, "projects", "inbox", "stale.md"), "utf8")).toBe("stale");
  });

  function nextRequestId(): string {
    const suffix = String(requestCounter++).padStart(12, "0");
    return `a9d9d1d8-8e5d-45d0-8d17-${suffix}`;
  }
});

function batchInput(homePath: string, requestId: string, sources: string[]) {
  return {
    ownerId: OWNER_ID,
    homePath,
    requestId,
    sources,
    destinationDirectory: "projects/archive",
  };
}

function executeInput(
  homePath: string,
  requestId: string,
  preflightFingerprint: string,
  conflictChoices?: Array<{ source: string; resolution: "keep-both" | "skip" }>,
) {
  return { ownerId: OWNER_ID, homePath, requestId, preflightFingerprint, conflictChoices };
}

async function preflightAndExecute(
  service: FileBatchMoveService,
  homePath: string,
  requestId: string,
  sources: string[],
  conflictChoices?: Array<{ source: string; resolution: "keep-both" | "skip" }>,
) {
  const preflight = await service.preflight(batchInput(homePath, requestId, sources));
  return service.execute(executeInput(homePath, requestId, preflight.preflightFingerprint, conflictChoices));
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
