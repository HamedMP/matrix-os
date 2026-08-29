import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { NotesController } from "../../desktop/src/renderer/src/features/notes/notes-controller";
import { captureRuntimeGeneration } from "../../desktop/src/renderer/src/stores/runtime-generation";

function apiWith(post: ApiClient["post"]): ApiClient {
  return { post } as ApiClient;
}

describe("NotesController", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("loads notes and selects the newest result", async () => {
    const post = vi.fn(async () => [{
      id: "note-1",
      title: "Groceries",
      content: "- Milk",
      content_json: null,
      created_at: "2026-08-29T08:00:00.000Z",
      updated_at: "2026-08-29T08:00:00.000Z",
    }]) as ApiClient["post"];
    const controller = new NotesController(apiWith(post), captureRuntimeGeneration());

    await controller.load();

    expect(controller.getSnapshot()).toMatchObject({
      selectedId: "note-1",
      loading: false,
      error: null,
      notes: [expect.objectContaining({ id: "note-1", title: "Groceries" })],
    });
    expect(post).toHaveBeenCalledWith("/api/bridge/query", {
      app: "notes",
      table: "notes",
      action: "find",
      orderBy: { created_at: "desc", id: "desc" },
      limit: 100,
      offset: 0,
    });
  });

  it("keeps edits dirty until the exact note version is saved", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce([{
        id: "note-1",
        title: "Draft",
        content: "",
        content_json: null,
        created_at: "2026-08-29T08:00:00.000Z",
        updated_at: "2026-08-29T08:00:00.000Z",
      }])
      .mockResolvedValueOnce({});
    const controller = new NotesController(apiWith(post), captureRuntimeGeneration());
    await controller.load();

    controller.edit("note-1", { title: "Finished" });
    expect(controller.getSnapshot().dirtyIds).toEqual(["note-1"]);

    await expect(controller.flush()).resolves.toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ dirtyIds: [], saving: false, error: null });
    expect(post).toHaveBeenLastCalledWith("/api/bridge/query", expect.objectContaining({
      app: "notes",
      table: "notes",
      action: "update",
      id: "note-1",
      data: expect.objectContaining({ title: "Finished" }),
    }));
  });

  it("removes local state only after the delete succeeds", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce([{
        id: "note-1",
        title: "Disposable",
        content: "",
        content_json: null,
        created_at: "2026-08-29T08:00:00.000Z",
        updated_at: "2026-08-29T08:00:00.000Z",
      }])
      .mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new NotesController(apiWith(post), captureRuntimeGeneration());
    await controller.load();

    try {
      await expect(controller.remove("note-1")).resolves.toBe(false);
      expect(controller.getSnapshot().notes).toHaveLength(1);
      expect(controller.getSnapshot().selectedId).toBe("note-1");
      expect(controller.getSnapshot().error).toBe("The note could not be deleted. Try again.");
    } finally {
      warn.mockRestore();
    }
  });
});
