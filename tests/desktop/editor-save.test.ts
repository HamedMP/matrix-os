import { describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import {
  createFilesApi,
  openFile,
  saveFile,
  saveFileOverwrite,
  type FilesApi,
} from "@desktop/renderer/src/features/editor/editor-save";

const MODIFIED_ISO = "2026-06-13T10:00:00.000Z";
const MODIFIED_MS = Date.parse(MODIFIED_ISO);

// Mirrors the gateway FileStatResult wire shape (packages/gateway/src/file-ops.ts).
function wireStat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "notes.md",
    path: "projects/notes.md",
    type: "file",
    size: 42,
    modified: MODIFIED_ISO,
    created: "2026-06-01T00:00:00.000Z",
    mime: "text/markdown",
    ...overrides,
  };
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue(wireStat()),
    getText: vi.fn().mockResolvedValue("file body"),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as ApiClient;
}

function makeFiles(overrides: Partial<FilesApi> = {}): FilesApi {
  return {
    stat: vi.fn().mockResolvedValue({ mtime: MODIFIED_MS }),
    read: vi.fn().mockResolvedValue("file body"),
    write: vi.fn().mockResolvedValue({ mtime: MODIFIED_MS + 5_000 }),
    ...overrides,
  };
}

describe("createFilesApi", () => {
  it("stats via /api/files/stat with an encoded query param and normalizes modified to epoch ms", async () => {
    const api = makeApi();
    const files = createFilesApi(api);
    const result = await files.stat("projects/my notes.md");
    expect(api.get).toHaveBeenCalledWith("/api/files/stat?path=projects%2Fmy%20notes.md");
    expect(result).toEqual({ mtime: MODIFIED_MS });
  });

  it("returns a null mtime when the stat response has no parsable modified field", async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue(wireStat({ modified: undefined })) });
    expect((await createFilesApi(api).stat("a.md")).mtime).toBeNull();

    const garbled = makeApi({ get: vi.fn().mockResolvedValue(wireStat({ modified: "not a date" })) });
    expect((await createFilesApi(garbled).stat("a.md")).mtime).toBeNull();
  });

  it("accepts a numeric modified field as epoch ms", async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue(wireStat({ modified: 12_345 })) });
    expect((await createFilesApi(api).stat("a.md")).mtime).toBe(12_345);
  });

  it("treats notFound stats as mtime null (new file) but propagates other errors", async () => {
    const missing = makeApi({ get: vi.fn().mockRejectedValue(new AppError("notFound")) });
    expect((await createFilesApi(missing).stat("new.md")).mtime).toBeNull();

    const offline = makeApi({ get: vi.fn().mockRejectedValue(new AppError("offline")) });
    await expect(createFilesApi(offline).stat("a.md")).rejects.toMatchObject({
      category: "offline",
    });
  });

  it("reads raw text from /files with per-segment path encoding", async () => {
    const api = makeApi();
    const files = createFilesApi(api);
    await expect(files.read("projects/my notes.md")).resolves.toBe("file body");
    expect(api.getText).toHaveBeenCalledWith("/files/projects/my%20notes.md");
  });

  it("writes raw text via PUT /files with per-segment path encoding", async () => {
    const api = makeApi();
    const files = createFilesApi(api);
    await expect(files.write("projects/my notes.md", "hello")).resolves.toEqual({ mtime: null });
    expect(api.putText).toHaveBeenCalledWith("/files/projects/my%20notes.md", "hello");
  });

  it("returns the normalized write mtime when PUT includes modified metadata", async () => {
    const api = makeApi({ putText: vi.fn().mockResolvedValue({ ok: true, modified: MODIFIED_ISO }) });
    await expect(createFilesApi(api).write("notes.md", "hello")).resolves.toEqual({ mtime: MODIFIED_MS });
  });
});

describe("openFile", () => {
  it("returns content and the server mtime as the loaded baseline", async () => {
    const files = makeFiles();
    const opened = await openFile(files, "projects/notes.md");
    expect(opened).toEqual({
      path: "projects/notes.md",
      content: "file body",
      loadedMtime: MODIFIED_MS,
    });
  });

  it("propagates read failures", async () => {
    const files = makeFiles({ read: vi.fn().mockRejectedValue(new AppError("notFound")) });
    await expect(openFile(files, "missing.md")).rejects.toMatchObject({ category: "notFound" });
  });
});

describe("saveFile", () => {
  const opened = { path: "projects/notes.md", content: "old", loadedMtime: MODIFIED_MS };

  it("refuses to write when the server mtime differs from the loaded baseline", async () => {
    const files = makeFiles({ stat: vi.fn().mockResolvedValue({ mtime: MODIFIED_MS + 1_000 }) });
    const result = await saveFile(files, opened, "new content");
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(files.write).not.toHaveBeenCalled();
  });

  it("writes and returns the write response mtime when the baseline matches", async () => {
    const stat = vi.fn().mockResolvedValue({ mtime: MODIFIED_MS });
    const files = makeFiles({ stat });
    const result = await saveFile(files, opened, "new content");
    expect(files.write).toHaveBeenCalledWith("projects/notes.md", "new content");
    expect(result).toEqual({ ok: true, newMtime: MODIFIED_MS + 5_000 });
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("refreshes the baseline after writing when the gateway omits write mtime", async () => {
    const stat = vi.fn()
      .mockResolvedValueOnce({ mtime: MODIFIED_MS })
      .mockResolvedValueOnce({ mtime: MODIFIED_MS + 5_000 });
    const files = makeFiles({ stat, write: vi.fn().mockResolvedValue({ mtime: null }) });
    await expect(saveFile(files, opened, "new content")).resolves.toEqual({
      ok: true,
      newMtime: MODIFIED_MS + 5_000,
    });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("treats null mtimes as conflict-free only when both sides are null", async () => {
    const newFile = { path: "new.md", content: "", loadedMtime: null };
    const bothNull = makeFiles({
      stat: vi.fn().mockResolvedValue({ mtime: null }),
      write: vi.fn().mockResolvedValue({ mtime: MODIFIED_MS }),
    });
    await expect(saveFile(bothNull, newFile, "hello")).resolves.toEqual({
      ok: true,
      newMtime: MODIFIED_MS,
    });

    const serverHasFile = makeFiles({ stat: vi.fn().mockResolvedValue({ mtime: MODIFIED_MS }) });
    await expect(saveFile(serverHasFile, newFile, "hello")).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(serverHasFile.write).not.toHaveBeenCalled();

    const serverLostFile = makeFiles({ stat: vi.fn().mockResolvedValue({ mtime: null }) });
    await expect(saveFile(serverLostFile, opened, "hello")).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(serverLostFile.write).not.toHaveBeenCalled();
  });

  it("propagates network errors instead of swallowing them", async () => {
    const files = makeFiles({ stat: vi.fn().mockRejectedValue(new AppError("offline")) });
    await expect(saveFile(files, opened, "x")).rejects.toMatchObject({ category: "offline" });
    expect(files.write).not.toHaveBeenCalled();

    const writeFails = makeFiles({ write: vi.fn().mockRejectedValue(new AppError("timeout")) });
    await expect(saveFile(writeFails, opened, "x")).rejects.toMatchObject({ category: "timeout" });
  });
});

describe("saveFileOverwrite", () => {
  it("writes without a conflict precheck and returns the write response mtime", async () => {
    const stat = vi.fn();
    const files = makeFiles({
      stat,
      write: vi.fn().mockResolvedValue({ mtime: MODIFIED_MS + 9_000 }),
    });
    const newMtime = await saveFileOverwrite(files, "projects/notes.md", "forced");
    expect(files.write).toHaveBeenCalledWith("projects/notes.md", "forced");
    expect(stat).not.toHaveBeenCalled();
    expect(newMtime).toBe(MODIFIED_MS + 9_000);
  });
});
