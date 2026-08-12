import { describe, expect, it, vi } from "vitest";
import {
  FILE_MUTATION_TIMEOUT_MS,
  createFileManagementApi,
} from "@desktop/renderer/src/features/files/file-management-api";
import { AppError } from "@desktop/renderer/src/lib/errors";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { parseBrowserEntries } from "@desktop/renderer/src/features/files/browser-entries";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
    ...overrides,
  } as ApiClient;
}

const capabilities = { canRename: true, canMove: true, canTrash: true };

describe("FileManagementApi", () => {
  it("treats missing or malformed legacy listing capabilities as all false", () => {
    const [missing, malformed] = parseBrowserEntries([
      { name: "legacy.md", type: "file" },
      { name: "untrusted.md", type: "file", capabilities: { ...capabilities, futureFlag: true } },
    ]);

    expect(missing?.capabilities).toEqual({ canRename: false, canMove: false, canTrash: false });
    expect(malformed?.capabilities).toEqual({ canRename: false, canMove: false, canTrash: false });
  });

  it("lists a normalized directory through the exact route and parses bounded capabilities", async () => {
    const get = vi.fn().mockResolvedValue({
      path: "projects",
      entries: [{
        name: "notes.md",
        type: "file",
        size: 12,
        gitStatus: null,
        modified: "2026-08-11T00:00:00.000Z",
        capabilities,
      }],
    });
    const api = createFileManagementApi(makeClient({ get }));

    await expect(api.list("projects")).resolves.toEqual({
      path: "projects",
      entries: [{
        name: "notes.md",
        type: "file",
        sizeBytes: 12,
        modifiedAt: "2026-08-11T00:00:00.000Z",
        capabilities,
      }],
    });
    expect(get).toHaveBeenCalledWith("/api/files/list?path=projects");
  });

  it("keeps legacy listings readable and treats missing or malformed capabilities as all false", async () => {
    const get = vi.fn().mockResolvedValue({
      path: "projects",
      entries: [
        { name: "legacy.md", type: "file", gitStatus: null },
        { name: "malformed.md", type: "file", gitStatus: null, capabilities: { ...capabilities, extra: true } },
      ],
    });
    const api = createFileManagementApi(makeClient({ get }));

    const result = await api.list("projects");
    expect(result.entries.map((entry) => entry.capabilities)).toEqual([
      { canRename: false, canMove: false, canTrash: false },
      { canRename: false, canMove: false, canTrash: false },
    ]);
  });

  it("rejects paths/names over their UTF-8 byte limits and mixed-parent batches before transport", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const api = createFileManagementApi(makeClient({ get, post }));

    await expect(api.list(`projects/${"界".repeat(1_365)}`)).rejects.toMatchObject({ category: "server" });
    await expect(api.create({ requestId: REQUEST_ID, parentDirectory: "projects", name: "界".repeat(86), kind: "file" }))
      .rejects.toMatchObject({ category: "server" });
    await expect(api.preflightMove({ requestId: REQUEST_ID, sources: ["projects/a", "archive/b"], destinationDirectory: "dest" }))
      .rejects.toMatchObject({ category: "server" });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("uses exact create/rename payloads and explicit bounded mutation timeouts", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ ok: true, path: "projects/new.md", resultCode: "created", capabilities })
      .mockResolvedValueOnce({ ok: true, path: "projects/final.md", resultCode: "renamed", capabilities });
    const api = createFileManagementApi(makeClient({ post }));

    await api.create({ requestId: REQUEST_ID, parentDirectory: "projects", name: "new.md", kind: "file" });
    await api.rename({ requestId: REQUEST_ID, path: "projects/new.md", name: "final.md" });

    expect(post).toHaveBeenNthCalledWith(1, "/api/files/create", {
      requestId: REQUEST_ID,
      parentDirectory: "projects",
      name: "new.md",
      kind: "file",
    }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS });
    expect(post).toHaveBeenNthCalledWith(2, "/api/files/rename", {
      requestId: REQUEST_ID,
      path: "projects/new.md",
      name: "final.md",
    }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS });
  });

  it("reuses one move request id across exact preflight and execute payloads", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        sources: ["projects/a.md"], destinationDirectory: "archive",
        conflicts: [{ source: "projects/a.md", destination: "archive/a.md" }],
        invalid: [], preflightFingerprint: "fingerprint-a",
      })
      .mockResolvedValueOnce({
        results: [{ source: "projects/a.md", destination: "archive/a copy.md", code: "moved" }],
        affectedDirectories: ["projects", "archive"],
      });
    const api = createFileManagementApi(makeClient({ post }));

    const preflight = await api.preflightMove({
      requestId: REQUEST_ID,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    });
    await api.executeMove({
      requestId: REQUEST_ID,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
      preflightFingerprint: preflight.preflightFingerprint,
      conflictChoices: [{ source: "projects/a.md", resolution: "keep-both" }],
    });

    expect(post).toHaveBeenNthCalledWith(1, "/api/files/batch/move", {
      requestId: REQUEST_ID, phase: "preflight", sources: ["projects/a.md"], destinationDirectory: "archive",
    }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS });
    expect(post).toHaveBeenNthCalledWith(2, "/api/files/batch/move", {
      requestId: REQUEST_ID, phase: "execute", preflightFingerprint: "fingerprint-a",
      conflictChoices: [{ source: "projects/a.md", resolution: "keep-both" }],
    }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS });
  });

  it.each([" ", ".", "..", "a:b", "trail.", "CON"])("rejects the invalid portable mutation name %j before transport", async (name) => {
    const post = vi.fn();
    const api = createFileManagementApi(makeClient({ post }));
    await expect(api.create({ requestId: REQUEST_ID, parentDirectory: "projects", name, kind: "file" }))
      .rejects.toMatchObject({ category: "server" });
    expect(post).not.toHaveBeenCalled();
  });

  it("correlates list, preflight, execute, and Trash responses to the exact request", async () => {
    const get = vi.fn().mockResolvedValue({ path: "archive", entries: [] });
    const post = vi.fn()
      .mockResolvedValueOnce({
        sources: ["projects/foreign"], destinationDirectory: "archive", conflicts: [], invalid: [], preflightFingerprint: "fp",
      })
      .mockResolvedValueOnce({
        results: [{ source: "projects/b", destination: "archive/b", code: "moved" }],
        affectedDirectories: ["projects", "archive"],
      })
      .mockResolvedValueOnce({
        results: [{ source: "projects/foreign", code: "trashed" }], sourceDirectory: "projects",
      });
    const api = createFileManagementApi(makeClient({ get, post }));

    await expect(api.list("projects")).rejects.toMatchObject({ category: "server" });
    await expect(api.preflightMove({ requestId: REQUEST_ID, sources: ["projects/a"], destinationDirectory: "archive" }))
      .rejects.toMatchObject({ category: "server" });
    await expect(api.executeMove({
      requestId: REQUEST_ID, sources: ["projects/a", "projects/b"], destinationDirectory: "archive",
      preflightFingerprint: "fp", conflictChoices: [],
    }))
      .rejects.toMatchObject({ category: "server" });
    await expect(api.trash({ requestId: REQUEST_ID, sources: ["projects/a"] }))
      .rejects.toMatchObject({ category: "server" });
  });

  it("rejects preflight conflicts outside the requested target and overlapping invalid rows", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        sources: ["projects/a"], destinationDirectory: "archive",
        conflicts: [{ source: "projects/a", destination: "other/a" }], invalid: [], preflightFingerprint: "fp",
      })
      .mockResolvedValueOnce({
        sources: ["projects/a"], destinationDirectory: "archive",
        conflicts: [{ source: "projects/a", destination: "archive/a" }],
        invalid: [{ source: "projects/a", code: "invalid_destination" }], preflightFingerprint: "fp",
      });
    const api = createFileManagementApi(makeClient({ post }));

    await expect(api.preflightMove({ requestId: REQUEST_ID, sources: ["projects/a"], destinationDirectory: "archive" }))
      .rejects.toMatchObject({ category: "server" });
    await expect(api.preflightMove({ requestId: REQUEST_ID, sources: ["projects/a"], destinationDirectory: "archive" }))
      .rejects.toMatchObject({ category: "server" });
  });

  it("posts ordered batch Trash sources with a UUID", async () => {
    const post = vi.fn().mockResolvedValue({
      results: [
        { source: "projects/a.md", code: "trashed" },
        { source: "projects/b.md", code: "source_missing" },
      ],
      sourceDirectory: "projects",
    });
    const api = createFileManagementApi(makeClient({ post }));

    const result = await api.trash({ requestId: REQUEST_ID, sources: ["projects/a.md", "projects/b.md"] });

    expect(result.results.map((item) => item.source)).toEqual(["projects/a.md", "projects/b.md"]);
    expect(post).toHaveBeenCalledWith("/api/files/batch/trash", {
      requestId: REQUEST_ID,
      sources: ["projects/a.md", "projects/b.md"],
    }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS });
  });

  it("rejects foreign move destinations, non-moved destinations, and affected directories", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        results: [{ source: "projects/a", destination: "foreign/a", code: "moved" }],
        affectedDirectories: ["projects", "archive"],
      })
      .mockResolvedValueOnce({
        results: [{ source: "projects/a", destination: "archive/a", code: "failed" }],
        affectedDirectories: ["projects", "archive"],
      })
      .mockResolvedValueOnce({
        results: [{ source: "projects/a", destination: "archive/a", code: "moved" }],
        affectedDirectories: ["projects", "foreign"],
      });
    const api = createFileManagementApi(makeClient({ post }));
    const execute = () => api.executeMove({
      requestId: REQUEST_ID, sources: ["projects/a"], destinationDirectory: "archive",
      preflightFingerprint: "fp", conflictChoices: [],
    });

    await expect(execute()).rejects.toMatchObject({ category: "server" });
    await expect(execute()).rejects.toMatchObject({ category: "server" });
    await expect(execute()).rejects.toMatchObject({ category: "server" });
  });

  it.each([
    { path: "/absolute" },
    { path: "projects", entries: Array.from({ length: 1001 }, (_, index) => ({ name: `f${index}`, type: "file", capabilities })) },
    { path: "projects", entries: [{ name: "raw/escape", type: "file", capabilities }] },
  ])("fails malformed or oversized list responses closed", async (response) => {
    const api = createFileManagementApi(makeClient({ get: vi.fn().mockResolvedValue(response) }));
    await expect(api.list("projects")).rejects.toMatchObject({ category: "server" });
  });

  it("fails unknown result codes, oversized fingerprints, and malformed response paths closed", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ results: [{ source: "projects/a", code: "provider_raw" }], sourceDirectory: "projects" })
      .mockResolvedValueOnce({ sources: ["projects/a"], destinationDirectory: "archive", conflicts: [], invalid: [], preflightFingerprint: "x".repeat(513) })
      .mockResolvedValueOnce({ ok: true, path: "/private/result", resultCode: "created", capabilities });
    const api = createFileManagementApi(makeClient({ post }));

    await expect(api.trash({ requestId: REQUEST_ID, sources: ["projects/a"] })).rejects.toBeInstanceOf(AppError);
    await expect(api.preflightMove({ requestId: REQUEST_ID, sources: ["projects/a"], destinationDirectory: "archive" })).rejects.toMatchObject({ category: "server" });
    await expect(api.create({ requestId: REQUEST_ID, parentDirectory: "projects", name: "a", kind: "file" })).rejects.toMatchObject({ category: "server" });
  });
});
