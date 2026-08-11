import { describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/renderer/src/lib/errors";
import {
  createFileOperationController,
  type FileOperationScope,
} from "@desktop/renderer/src/features/files/file-operation-controller";
import type { FileManagementApi } from "@desktop/renderer/src/features/files/file-management-api";

const CAPS = { canRename: true, canMove: true, canTrash: true };
const IDS = Array.from({ length: 20 }, (_, index) => `123e4567-e89b-42d3-a456-${(426614174000 + index).toString()}`);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeApi(overrides: Partial<FileManagementApi> = {}): FileManagementApi {
  return {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    preflightMove: vi.fn(),
    executeMove: vi.fn(),
    trash: vi.fn(),
    ...overrides,
  } as FileManagementApi;
}

function makeHarness(overrides: {
  api?: FileManagementApi;
  loadDirectory?: (directory: string, scope: FileOperationScope) => Promise<readonly string[]>;
} = {}) {
  let scope: FileOperationScope = { directory: "projects", runtimeSlot: "primary", authGeneration: 1 };
  let idIndex = 0;
  const api = overrides.api ?? makeApi();
  const loadDirectory = vi.fn(overrides.loadDirectory ?? (async () => []));
  const controller = createFileOperationController({
    getApi: () => api,
    createRequestId: () => IDS[idIndex++]!,
    getScope: () => scope,
    loadDirectory,
  });
  return {
    api,
    controller,
    loadDirectory,
    get scope() { return scope; },
    setScope(next: FileOperationScope) { scope = next; controller.syncScope(); },
  };
}

describe("FileOperationController", () => {
  it("uses unique UUIDs for create/rename and reconciles each authoritative parent", async () => {
    const api = makeApi({
      create: vi.fn().mockResolvedValue({ ok: true, path: "projects/new.md", resultCode: "created", capabilities: CAPS }),
      rename: vi.fn().mockResolvedValue({ ok: true, path: "projects/final.md", resultCode: "renamed", capabilities: CAPS }),
    });
    const h = makeHarness({ api, loadDirectory: async (directory) => [`${directory}/authoritative`] });

    const created = await h.controller.create({ parentDirectory: "projects", name: "new.md", kind: "file" });
    const renamed = await h.controller.rename({ path: "projects/new.md", name: "final.md" });

    expect(api.create).toHaveBeenCalledWith({
      requestId: IDS[0], parentDirectory: "projects", name: "new.md", kind: "file",
    });
    expect(api.rename).toHaveBeenCalledWith({ requestId: IDS[1], path: "projects/new.md", name: "final.md" });
    expect(created).toMatchObject({ status: "completed", requestId: IDS[0], succeededPaths: ["projects/new.md"] });
    expect(renamed).toMatchObject({ status: "completed", requestId: IDS[1], succeededPaths: ["projects/final.md"] });
    expect(h.loadDirectory.mock.calls.map(([directory]) => directory)).toEqual(["projects", "projects"]);
  });

  it("keeps one move UUID/fingerprint, exposes ordered conflicts, and executes explicit ordered choices", async () => {
    const executeGate = deferred<{
      results: Array<{ source: string; destination: string; code: "moved" }>;
      affectedDirectories: string[];
    }>();
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a", "projects/b"], destinationDirectory: "archive",
        conflicts: [
          { source: "projects/a", destination: "archive/a" },
          { source: "projects/b", destination: "archive/b" },
        ],
        invalid: [], preflightFingerprint: "fp-1",
      }),
      executeMove: vi.fn(() => executeGate.promise),
    });
    const h = makeHarness({ api });
    const preflight = await h.controller.preflightMove({ sources: ["projects/a", "projects/b"], destinationDirectory: "archive" });
    expect(preflight.status).toBe("needs-resolution");
    expect(preflight.preflight?.conflicts.map((item) => item.source)).toEqual(["projects/a", "projects/b"]);

    const execution = h.controller.executeMove({
      preflight: preflight.preflight!,
      conflictChoices: [
        { source: "projects/a", resolution: "keep-both" },
        { source: "projects/b", resolution: "skip" },
      ],
    });
    expect(h.controller.snapshot.pendingPaths).toEqual(["projects/a", "projects/b"]);
    executeGate.resolve({
      results: [
        { source: "projects/a", destination: "archive/a copy", code: "moved" },
        { source: "projects/b", destination: "archive/b", code: "moved" },
      ],
      affectedDirectories: ["projects", "archive"],
    });
    await execution;

    expect(api.executeMove).toHaveBeenCalledWith({
      requestId: IDS[0], preflightFingerprint: "fp-1",
      sources: ["projects/a", "projects/b"],
      conflictChoices: [
        { source: "projects/a", resolution: "keep-both" },
        { source: "projects/b", resolution: "skip" },
      ],
    });
  });

  it("does not execute a cancelled or mismatched preflight", async () => {
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a"], destinationDirectory: "archive", conflicts: [], invalid: [], preflightFingerprint: "fp",
      }),
    });
    const h = makeHarness({ api });
    const prepared = await h.controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "archive" });

    expect(h.controller.cancelMove(prepared.preflight!)).toMatchObject({ status: "cancelled", requestId: IDS[0] });
    await expect(h.controller.executeMove({ preflight: prepared.preflight!, conflictChoices: [] })).resolves.toMatchObject({
      status: "failed", notice: "request_mismatch",
    });
    expect(api.executeMove).not.toHaveBeenCalled();
  });

  it("retains failed/skipped/invalid rows and reloads source then destination in first-seen order", async () => {
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a", "projects/b", "projects/c"], destinationDirectory: "archive",
        conflicts: [], invalid: [{ source: "projects/c", code: "protected" }], preflightFingerprint: "fp",
      }),
      executeMove: vi.fn().mockResolvedValue({
        results: [
          { source: "projects/a", destination: "archive/a", code: "moved" },
          { source: "projects/b", code: "failed" },
          { source: "projects/c", code: "skipped" },
        ],
        affectedDirectories: ["projects", "archive", "projects"],
      }),
    });
    const h = makeHarness({ api });
    const prepared = await h.controller.preflightMove({ sources: ["projects/a", "projects/b", "projects/c"], destinationDirectory: "archive" });
    const result = await h.controller.executeMove({ preflight: prepared.preflight!, conflictChoices: [] });

    expect(result).toMatchObject({
      status: "completed",
      succeededPaths: ["projects/a"],
      retainedPaths: ["projects/b", "projects/c"],
      failures: [
        { source: "projects/b", code: "failed" },
        { source: "projects/c", code: "skipped" },
      ],
      affectedDirectories: ["projects", "archive"],
    });
    expect(h.loadDirectory.mock.calls.map(([directory]) => directory)).toEqual(["projects", "archive"]);
    expect(h.controller.snapshot.retainedPaths).toEqual(["projects/b", "projects/c"]);
  });

  it("keeps only failed Trash rows and performs no permanent-delete retry", async () => {
    const trash = vi.fn().mockResolvedValue({
      results: [
        { source: "projects/a", code: "trashed" },
        { source: "projects/b", code: "source_missing" },
      ],
      sourceDirectory: "projects",
    });
    const h = makeHarness({ api: makeApi({ trash }) });
    const result = await h.controller.trash({ sources: ["projects/a", "projects/b"] });

    expect(result).toMatchObject({ succeededPaths: ["projects/a"], retainedPaths: ["projects/b"] });
    expect(trash).toHaveBeenCalledOnce();
    expect(h.loadDirectory).toHaveBeenCalledOnce();
  });

  it("retains every Trash row when authoritative reconciliation itself fails", async () => {
    const trash = vi.fn().mockRejectedValue(new AppError("timeout"));
    const h = makeHarness({
      api: makeApi({ trash }),
      loadDirectory: async () => { throw new Error("filesystem unavailable"); },
    });

    await expect(h.controller.trash({ sources: ["projects/a"] })).resolves.toMatchObject({
      status: "uncertain", succeededPaths: [], retainedPaths: ["projects/a"],
      notice: "authoritative_reconciliation_required",
    });
  });

  it("keeps an uncertain Keep Both source ambiguous instead of trusting the pre-existing target", async () => {
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a"], destinationDirectory: "archive",
        conflicts: [{ source: "projects/a", destination: "archive/a" }], invalid: [], preflightFingerprint: "fp",
      }),
      executeMove: vi.fn().mockRejectedValue(new AppError("offline")),
    });
    const h = makeHarness({
      api,
      loadDirectory: async (directory) => directory === "archive" ? ["archive/a"] : [],
    });
    const prepared = await h.controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "archive" });
    const result = await h.controller.executeMove({
      preflight: prepared.preflight!,
      conflictChoices: [{ source: "projects/a", resolution: "keep-both" }],
    });

    expect(result).toMatchObject({ status: "uncertain", succeededPaths: [], retainedPaths: ["projects/a"] });
  });

  it.each(["timeout", "offline", "server"] as const)("reconciles an uncertain %s move without blind retry", async (category) => {
    const executeMove = vi.fn().mockRejectedValue(new AppError(category));
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a", "projects/b", "projects/c"], destinationDirectory: "archive",
        conflicts: [], invalid: [], preflightFingerprint: "fp",
      }),
      executeMove,
    });
    const listings: Record<string, string[]> = {
      projects: ["projects/b"],
      archive: ["archive/a", "archive/b"],
    };
    const h = makeHarness({ api, loadDirectory: async (directory) => listings[directory] ?? [] });
    const prepared = await h.controller.preflightMove({ sources: ["projects/a", "projects/b", "projects/c"], destinationDirectory: "archive" });
    const result = await h.controller.executeMove({ preflight: prepared.preflight!, conflictChoices: [] });

    expect(result).toMatchObject({
      status: "uncertain",
      succeededPaths: ["projects/a"],
      retainedPaths: ["projects/b", "projects/c"],
      notice: "authoritative_reconciliation_required",
    });
    expect(executeMove).toHaveBeenCalledOnce();
    expect(h.loadDirectory.mock.calls.map(([directory]) => directory)).toEqual(["projects", "archive"]);
  });

  it("classifies uncertain create and rename from their operation-specific authoritative targets", async () => {
    const api = makeApi({
      create: vi.fn().mockRejectedValue(new AppError("timeout")),
      rename: vi.fn().mockRejectedValue(new AppError("offline")),
    });
    const h = makeHarness({
      api,
      loadDirectory: async () => ["projects/new.md", "projects/final.md"],
    });

    const created = await h.controller.create({ parentDirectory: "projects", name: "new.md", kind: "file" });
    const renamed = await h.controller.rename({ path: "projects/old.md", name: "final.md" });

    expect(created).toMatchObject({ status: "uncertain", succeededPaths: ["projects/new.md"], retainedPaths: [] });
    expect(renamed).toMatchObject({ status: "uncertain", succeededPaths: ["projects/old.md"], retainedPaths: [] });
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.rename).toHaveBeenCalledOnce();
  });

  it("maps a request-id conflict to a bounded safe result", async () => {
    const h = makeHarness({ api: makeApi({ trash: vi.fn().mockRejectedValue(new AppError("server", { detail: "request_id_conflict" })) }) });
    await expect(h.controller.trash({ sources: ["projects/a"] })).resolves.toMatchObject({
      status: "failed", retainedPaths: ["projects/a"], notice: "request_conflict",
    });
  });

  it("suppresses stale runtime/auth writes after API and reload async boundaries", async () => {
    const mutation = deferred<{ ok: true; path: string; resultCode: "created"; capabilities: typeof CAPS }>();
    const reload = deferred<readonly string[]>();
    const h = makeHarness({
      api: makeApi({ create: vi.fn(() => mutation.promise) }),
      loadDirectory: () => reload.promise,
    });
    const seen: string[] = [];
    h.controller.subscribe((snapshot) => seen.push(`${snapshot.scope.runtimeSlot}:${snapshot.notice ?? "none"}`));
    const resultPromise = h.controller.create({ parentDirectory: "projects", name: "new", kind: "file" });
    mutation.resolve({ ok: true, path: "projects/new", resultCode: "created", capabilities: CAPS });
    await Promise.resolve();
    h.setScope({ directory: "", runtimeSlot: "preview", authGeneration: 2 });
    reload.resolve(["projects/new"]);

    await expect(resultPromise).resolves.toMatchObject({ status: "stale" });
    expect(h.controller.snapshot).toMatchObject({
      scope: { directory: "", runtimeSlot: "preview", authGeneration: 2 },
      pendingPaths: [], retainedPaths: [], notice: null,
    });
    expect(seen.at(-1)).toBe("preview:none");
  });

  it("synchronously resets an observed replacement scope at the next async boundary", async () => {
    const mutation = deferred<{ ok: true; path: string; resultCode: "created"; capabilities: typeof CAPS }>();
    let scope: FileOperationScope = { directory: "projects", runtimeSlot: "primary", authGeneration: 1 };
    const controller = createFileOperationController({
      getApi: () => makeApi({ create: vi.fn(() => mutation.promise) }),
      createRequestId: () => IDS[0]!,
      getScope: () => scope,
      loadDirectory: async () => [],
    });
    const pending = controller.create({ parentDirectory: "projects", name: "new", kind: "file" });
    scope = { directory: "", runtimeSlot: "preview", authGeneration: 2 };
    mutation.resolve({ ok: true, path: "projects/new", resultCode: "created", capabilities: CAPS });

    await expect(pending).resolves.toMatchObject({ status: "stale" });
    expect(controller.snapshot).toEqual(expect.objectContaining({ scope, status: "idle", pendingPaths: [] }));
  });

  it("clears pending state when the injected current-scope predicate alone becomes stale", async () => {
    const mutation = deferred<{ ok: true; path: string; resultCode: "created"; capabilities: typeof CAPS }>();
    let current = true;
    const scope: FileOperationScope = { directory: "projects", runtimeSlot: "primary", authGeneration: 1 };
    const controller = createFileOperationController({
      getApi: () => makeApi({ create: vi.fn(() => mutation.promise) }),
      createRequestId: () => IDS[0]!,
      getScope: () => scope,
      isScopeCurrent: () => current,
      loadDirectory: async () => [],
    });
    const pending = controller.create({ parentDirectory: "projects", name: "new", kind: "file" });
    current = false;
    mutation.resolve({ ok: true, path: "projects/new", resultCode: "created", capabilities: CAPS });

    await expect(pending).resolves.toMatchObject({ status: "stale" });
    expect(controller.snapshot).toMatchObject({ status: "idle", pendingPaths: [], retainedPaths: [], notice: null });
  });

  it("rejects oversized batch inputs without silently operating on a truncated prefix", async () => {
    const preflightMove = vi.fn();
    const trash = vi.fn();
    const h = makeHarness({ api: makeApi({ preflightMove, trash }) });
    const sources = Array.from({ length: 101 }, (_, index) => `projects/${index}`);

    await expect(h.controller.preflightMove({ sources, destinationDirectory: "archive" })).resolves.toMatchObject({
      status: "failed", retainedPaths: expect.any(Array), notice: "request_mismatch",
    });
    await expect(h.controller.trash({ sources })).resolves.toMatchObject({ status: "failed", notice: "request_mismatch" });
    expect(preflightMove).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });

  it("closes idempotently, clears listeners/active state, and suppresses late writes", async () => {
    const gate = deferred<{ ok: true; path: string; resultCode: "created"; capabilities: typeof CAPS }>();
    const h = makeHarness({ api: makeApi({ create: vi.fn(() => gate.promise) }) });
    const listener = vi.fn();
    h.controller.subscribe(listener);
    const pending = h.controller.create({ parentDirectory: "projects", name: "new", kind: "file" });
    h.controller.close();
    h.controller.close();
    gate.resolve({ ok: true, path: "projects/new", resultCode: "created", capabilities: CAPS });

    await expect(pending).resolves.toMatchObject({ status: "stale" });
    const callsAtClose = listener.mock.calls.length;
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(callsAtClose);
    expect(() => h.controller.subscribe(() => {})).toThrow(/closed/i);
  });

  it("caps listeners, active operations, pending rows, and returned failures", async () => {
    const gate = deferred<{ ok: true; path: string; resultCode: "created"; capabilities: typeof CAPS }>();
    const create = vi.fn(() => gate.promise);
    const h = makeHarness({ api: makeApi({ create }) });
    for (let index = 0; index < 32; index++) h.controller.subscribe(() => {});
    expect(() => h.controller.subscribe(() => {})).toThrow(/listener cap/i);

    const active = Array.from({ length: 8 }, (_, index) =>
      h.controller.create({ parentDirectory: "projects", name: `f${index}`, kind: "file" }));
    await expect(h.controller.create({ parentDirectory: "projects", name: "overflow", kind: "file" })).resolves.toMatchObject({
      status: "failed", notice: "operation_unavailable",
    });
    expect(create).toHaveBeenCalledTimes(8);
    expect(h.controller.snapshot.pendingPaths).toHaveLength(8);
    gate.resolve({ ok: true, path: "projects/done", resultCode: "created", capabilities: CAPS });
    await Promise.all(active);
  });
});
