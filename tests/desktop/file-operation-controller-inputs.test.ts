import { describe, expect, it, vi } from "vitest";
import { createFileOperationController } from "@desktop/renderer/src/features/files/file-operation-controller";
import { CAPS, IDS, makeApi, makeHarness } from "./file-operation-controller-fixture";

describe("FileOperationController public input validation", () => {
  it("rejects an unsupported create kind before allocating or mutating state", async () => {
    const create = vi.fn().mockResolvedValue({
      ok: true,
      path: "projects/link",
      resultCode: "created",
      capabilities: CAPS,
    });
    const createRequestId = vi.fn(() => IDS[0]!);
    const h = makeHarness({ api: makeApi({ create }), createRequestId });
    const before = h.controller.snapshot;

    await expect(h.controller.create({
      parentDirectory: "projects",
      name: "link",
      kind: "symlink",
    } as never)).resolves.toMatchObject({
      status: "failed",
      requestId: "",
      retainedPaths: [],
      notice: "request_mismatch",
    });

    expect(createRequestId).not.toHaveBeenCalled();
    expect(h.loadDirectory).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(h.controller.snapshot).toBe(before);
  });

  it.each([
    ["unsupported resolution", { source: "projects/a", resolution: "overwrite" }],
    ["unknown property", { source: "projects/a", resolution: "keep-both", unexpected: true }],
  ])("rejects a conflict choice with %s without consuming the preflight", async (_case, choice) => {
    const executeMove = vi.fn().mockResolvedValue({
      results: [{ source: "projects/a", destination: "archive/a", code: "moved" }],
      affectedDirectories: ["projects", "archive"],
    });
    const api = makeApi({
      preflightMove: vi.fn().mockResolvedValue({
        sources: ["projects/a"],
        destinationDirectory: "archive",
        conflicts: [{ source: "projects/a", destination: "archive/a" }],
        invalid: [],
        preflightFingerprint: "fp",
      }),
      executeMove,
    });
    const h = makeHarness({ api });
    const prepared = await h.controller.preflightMove({
      sources: ["projects/a"],
      destinationDirectory: "archive",
    });
    const before = h.controller.snapshot;

    await expect(h.controller.executeMove({
      preflight: prepared.preflight!,
      conflictChoices: [choice],
    } as never)).resolves.toMatchObject({
      status: "failed",
      notice: "request_mismatch",
      retainedPaths: ["projects/a"],
    });

    expect(executeMove).not.toHaveBeenCalled();
    expect(h.loadDirectory).not.toHaveBeenCalled();
    expect(h.controller.snapshot).toBe(before);

    await expect(h.controller.executeMove({
      preflight: prepared.preflight!,
      conflictChoices: [{ source: "projects/a", resolution: "keep-both" }],
    })).resolves.toMatchObject({ status: "completed", succeededPaths: ["projects/a"] });
    expect(executeMove).toHaveBeenCalledOnce();
  });

  it("bounds scope primitives and strips non-serializable unknown properties", async () => {
    const create = vi.fn().mockResolvedValue({
      ok: true,
      path: "projects/new",
      resultCode: "created",
      capabilities: CAPS,
    });
    const api = makeApi({ create });
    const createRequestId = vi.fn(() => IDS[0]!);
    const controller = createFileOperationController({
      getApi: () => api,
      createRequestId,
      getScope: () => ({
        directory: "projects",
        runtimeSlot: "x".repeat(65),
        authGeneration: Number.NaN,
        unexpected: 1n,
      } as never),
      loadDirectory: vi.fn(),
    });

    expect(controller.snapshot.scope).toEqual({
      directory: "projects",
      runtimeSlot: "",
      authGeneration: 0,
    });
    expect(() => JSON.stringify(controller.snapshot)).not.toThrow();
    await expect(controller.create({ parentDirectory: "projects", name: "new", kind: "file" }))
      .resolves.toMatchObject({ status: "stale", requestId: "" });
    expect(createRequestId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
