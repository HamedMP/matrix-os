import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileBatchTrashInvalidRequestError,
  FileBatchTrashService,
  FileBatchTrashUnavailableError,
} from "../../packages/gateway/src/file-management/batch-service.js";
import { FileOperationRequestIdConflictError } from "../../packages/gateway/src/file-management/result-cache.js";

const OWNER_ID = "owner-a";

describe("FileBatchTrashService", () => {
  let homePath: string;
  let service: FileBatchTrashService;
  let requestCounter: number;
  const extraRoots: string[] = [];

  beforeEach(() => {
    homePath = join(tmpdir(), `file-batch-trash-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(join(homePath, "projects", "inbox"), { recursive: true });
    service = new FileBatchTrashService();
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

  function input(requestId: string, sources: string[]) {
    return { ownerId: OWNER_ID, homePath, requestId, sources };
  }

  function nextRequestId(): string {
    const suffix = String(requestCounter++).padStart(12, "0");
    return `b9d9d1d8-8e5d-45d0-8d17-${suffix}`;
  }
});
