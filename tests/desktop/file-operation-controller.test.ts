import { describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/renderer/src/lib/errors";
import {
  createFileOperationController,
  type FileOperationScope,
} from "@desktop/renderer/src/features/files/file-operation-controller";
import { CAPS, IDS, deferred, makeApi, makeHarness } from "./file-operation-controller-fixture";

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
    expect(h.loadDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      "projects", "projects", "projects", "projects",
    ]);
  });

  it("keeps one move UUID/fingerprint, exposes ordered conflicts, and executes explicit ordered choices", async () => {
    const executeGate = deferred<{
      results: Array<{ source: string; destination?: string; code: "moved" | "skipped" }>;
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
        { source: "projects/b", code: "skipped" },
      ],
      affectedDirectories: ["projects", "archive"],
    });
    await execution;

    expect(api.executeMove).toHaveBeenCalledWith({
      requestId: IDS[0], preflightFingerprint: "fp-1",
      sources: ["projects/a", "projects/b"],
      destinationDirectory: "archive",
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

  it("atomically consumes a preflight so double execute and cancel cannot disturb the active promise", async () => {
    const gate = deferred<{
      results: Array<{ source: string; destination: string; code: "moved" }>;
      affectedDirectories: string[];
    }>();
    const executeMove = vi.fn(() => gate.promise);
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a"], destinationDirectory: "archive", conflicts: [], invalid: [], preflightFingerprint: "fp",
      }),
      executeMove,
    });
    const h = makeHarness({ api });
    const prepared = await h.controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "archive" });

    const first = h.controller.executeMove({ preflight: prepared.preflight!, conflictChoices: [] });
    const second = h.controller.executeMove({ preflight: prepared.preflight!, conflictChoices: [] });
    await expect(second).resolves.toMatchObject({ status: "failed", notice: "operation_unavailable" });
    expect(executeMove).toHaveBeenCalledOnce();
    expect(h.controller.snapshot).toMatchObject({ status: "pending", pendingPaths: ["projects/a"] });
    expect(h.controller.cancelMove(prepared.preflight!)).toMatchObject({
      status: "failed", notice: "operation_unavailable",
    });
    expect(h.controller.snapshot).toMatchObject({ status: "pending", pendingPaths: ["projects/a"] });

    gate.resolve({
      results: [{ source: "projects/a", destination: "archive/a", code: "moved" }],
      affectedDirectories: ["projects", "archive"],
    });
    await expect(first).resolves.toMatchObject({ status: "completed", succeededPaths: ["projects/a"] });
    expect(h.controller.snapshot).toMatchObject({ status: "completed", pendingPaths: [] });
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
        affectedDirectories: ["foreign"],
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

  it("requires a trustworthy pre-operation baseline to reconcile uncertain create and rename", async () => {
    const create = vi.fn().mockRejectedValue(new AppError("timeout"));
    const rename = vi.fn().mockRejectedValue(new AppError("offline"));
    const loadDirectory = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["projects/new.md"])
      .mockResolvedValueOnce(["projects/old.md"])
      .mockResolvedValueOnce(["projects/final.md"]);
    const h = makeHarness({ api: makeApi({ create, rename }), loadDirectory });

    await expect(h.controller.create({ parentDirectory: "projects", name: "new.md", kind: "file" })).resolves.toMatchObject({
      status: "uncertain", succeededPaths: ["projects/new.md"], retainedPaths: [],
    });
    await expect(h.controller.rename({ path: "projects/old.md", name: "final.md" })).resolves.toMatchObject({
      status: "uncertain", succeededPaths: ["projects/old.md"], retainedPaths: [],
    });
    expect(loadDirectory).toHaveBeenCalledTimes(4);
  });

  it("retains uncertain create when its pre-operation baseline is unavailable", async () => {
    const loadDirectory = vi.fn()
      .mockRejectedValueOnce(new Error("baseline unavailable"))
      .mockResolvedValueOnce(["projects/new.md"]);
    const h = makeHarness({
      api: makeApi({ create: vi.fn().mockRejectedValue(new AppError("timeout")) }),
      loadDirectory,
    });

    await expect(h.controller.create({ parentDirectory: "projects", name: "new.md", kind: "file" })).resolves.toMatchObject({
      status: "uncertain", succeededPaths: [], retainedPaths: ["projects/new.md"],
    });
    expect(loadDirectory).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["destination_conflict", "destination_conflict"],
    ["protected", "protected"],
    ["invalid_path", "invalid_destination"],
    ["cleanup_failed", "cleanup_failed"],
  ] as const)("keeps typed %s failed even when the target already exists", async (detail, code) => {
    const create = vi.fn().mockRejectedValue(new AppError("server", { detail }));
    const h = makeHarness({ api: makeApi({ create }), loadDirectory: async () => ["projects/new.md"] });

    await expect(h.controller.create({ parentDirectory: "projects", name: "new.md", kind: "file" })).resolves.toMatchObject({
      status: "failed", succeededPaths: [], retainedPaths: ["projects/new.md"],
      failures: [{ source: "projects/new.md", code }],
    });
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

  it.each(["create", "rename", "preflight", "trash"] as const)(
    "gates start-stale %s before UUID, pending state, reload, or transport",
    async (operation) => {
      const api = makeApi();
      const createRequestId = vi.fn(() => IDS[0]!);
      const h = makeHarness({ api, createRequestId, isScopeCurrent: () => false });
      const calls = {
        create: () => h.controller.create({ parentDirectory: "projects", name: "new", kind: "file" }),
        rename: () => h.controller.rename({ path: "projects/a", name: "b" }),
        preflight: () => h.controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "archive" }),
        trash: () => h.controller.trash({ sources: ["projects/a"] }),
      };

      await expect(calls[operation]()).resolves.toMatchObject({ status: "stale" });
      expect(createRequestId).not.toHaveBeenCalled();
      expect(h.loadDirectory).not.toHaveBeenCalled();
      expect(api[operation === "preflight" ? "preflightMove" : operation]).not.toHaveBeenCalled();
      expect(h.controller.snapshot).toMatchObject({ status: "idle", pendingPaths: [], preflight: null });
    },
  );

  it("gates start-stale execute and cancel before transport and clears the stored preflight", async () => {
    let current = true;
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a"], destinationDirectory: "archive", conflicts: [], invalid: [], preflightFingerprint: "fp",
      }),
    });
    const h = makeHarness({ api, isScopeCurrent: () => current });
    const prepared = await h.controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "archive" });
    current = false;

    await expect(h.controller.executeMove({ preflight: prepared.preflight!, conflictChoices: [] }))
      .resolves.toMatchObject({ status: "stale" });
    expect(h.controller.cancelMove(prepared.preflight!)).toMatchObject({ status: "stale" });
    expect(api.executeMove).not.toHaveBeenCalled();
    expect(h.controller.snapshot).toMatchObject({ status: "idle", pendingPaths: [], preflight: null });
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

  it("rejects invalid, foreign, duplicate, and self-descendant inputs before UUID or snapshot writes", async () => {
    const oversizedPath = `projects/${"界".repeat(1_366)}`;
    const operations = [
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.create({ parentDirectory: "archive", name: "new", kind: "file" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.create({ parentDirectory: "projects", name: "CON", kind: "file" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.rename({ path: "archive/a", name: "b" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.rename({ path: oversizedPath, name: "b" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.preflightMove({ sources: ["archive/a"], destinationDirectory: "dest" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "projects" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.preflightMove({ sources: ["projects/a"], destinationDirectory: "projects/a/child" }),
      (controller: ReturnType<typeof makeHarness>["controller"]) => controller.trash({ sources: ["projects/a", "projects/a"] }),
    ];

    for (const operation of operations) {
      const createRequestId = vi.fn(() => IDS[0]!);
      const h = makeHarness({ api: makeApi(), createRequestId });
      const before = h.controller.snapshot;
      await expect(operation(h.controller)).resolves.toMatchObject({
        status: "failed", notice: "request_mismatch", retainedPaths: [],
      });
      expect(createRequestId).not.toHaveBeenCalled();
      expect(h.loadDirectory).not.toHaveBeenCalled();
      for (const transport of [h.api.create, h.api.rename, h.api.preflightMove, h.api.executeMove, h.api.trash]) {
        expect(transport).not.toHaveBeenCalled();
      }
      expect(h.controller.snapshot).toBe(before);
    }
  });

  it("sanitizes an invalid scope directory and fails closed before UUID or transport", async () => {
    const api = makeApi();
    const createRequestId = vi.fn(() => IDS[0]!);
    const controller = createFileOperationController({
      getApi: () => api,
      createRequestId,
      getScope: () => ({ directory: "../foreign", runtimeSlot: "primary", authGeneration: 1 }),
      loadDirectory: vi.fn(),
    });

    expect(controller.snapshot.scope.directory).toBe("");
    await expect(controller.create({ parentDirectory: "", name: "new", kind: "file" }))
      .resolves.toMatchObject({ status: "stale" });
    expect(createRequestId).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    controller.close();
    expect(controller.snapshot.scope.directory).toBe("");
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
