import { describe, expect, it, vi } from "vitest";
import { R2WorkspaceFiles, MAX_TEXT_BYTES } from "../../packages/workspace-worker/src/data/files.js";

describe("durable R2 owner files", () => {
  it("bounds text reads and isolates immutable owner prefixes", async () => {
    const put = vi.fn(async () => null);
    const files = new R2WorkspaceFiles({ get: async () => ({ size: MAX_TEXT_BYTES + 1, text: async () => "large" }), put, delete: async () => {} });
    await expect(files.read("key")).rejects.toThrow();
    const key = await files.write("owner/a", "hello");
    expect(key).toMatch(/^workspace-files\/owner%2Fa\//);
    expect(put).toHaveBeenCalledWith(key, "hello", { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  });
  it("sweeps only old unreferenced files in bounded pages and retains current pointers", async () => {
    const remove = vi.fn(async () => {});
    const files = new R2WorkspaceFiles({
      get: async () => null, put: async () => null, delete: remove,
      list: async () => ({ objects: [
        { key: "workspace-files/owner/live", uploaded: new Date(0) },
        { key: "workspace-files/owner/orphan", uploaded: new Date(0) },
        { key: "workspace-files/owner/recent", uploaded: new Date(100_000) },
      ], truncated: false }),
    });
    const references = vi.fn(async () => ["workspace-files/owner/live"]);
    expect(await files.sweepUnreferenced(references, { now: 100_000, graceMs: 10_000 })).toEqual({ deleted: 1 });
    expect(remove).toHaveBeenCalledExactlyOnceWith("workspace-files/owner/orphan");
  });
});
