import { describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument, type OsViewStateResponse } from "@matrix-os/contracts";
import { createTrustedOsViewAgentTools } from "../../packages/gateway/src/os-view-state/trusted-agent-tools.js";

function state(revision: number): OsViewStateResponse {
  return {
    revision,
    document: { ...createDefaultOsViewDocument(), desktop: { windows: [], icons: [] } },
    updatedAt: "2026-09-08T12:00:00.000Z",
  };
}

const catalog = [{ slug: "notes", name: "Notes", file: "notes/index.html", path: "/files/apps/notes/index.html" }] as never;

function repository() {
  let current = state(1);
  return {
    getOrCreate: vi.fn(async () => current),
    patch: vi.fn(async (_ownerId: string, input: { patch: OsViewStateResponse["document"] }) => {
      current = { ...current, revision: current.revision + 1, document: { ...current.document, ...input.patch } };
      return current;
    }),
  };
}

describe("createTrustedOsViewAgentTools", () => {
  it("binds the trimmed trusted owner and broadcasts changes to that owner only", async () => {
    const repo = repository();
    const broadcastToOwner = vi.fn();
    const tools = createTrustedOsViewAgentTools({
      repository: repo as never, ownerId: "  owner_one  ", homePath: "/unused", broadcastToOwner, listCatalog: async () => catalog,
    });
    expect(tools).toBeDefined();
    await expect(tools!.addAppToDesktop("notes")).resolves.toEqual({ status: "added" });
    expect(repo.patch).toHaveBeenCalledWith("owner_one", expect.anything());
    expect(broadcastToOwner).toHaveBeenCalledWith("owner_one", {
      type: "os-view:changed", revision: 2, updatedAt: "2026-09-08T12:00:00.000Z",
    });
  });

  it("returns no tools without a repository or a usable trusted owner", () => {
    const base = { homePath: "/unused", broadcastToOwner: vi.fn() };
    expect(createTrustedOsViewAgentTools({ ...base, repository: null, ownerId: "owner_one" })).toBeUndefined();
    expect(createTrustedOsViewAgentTools({ ...base, repository: repository() as never, ownerId: undefined })).toBeUndefined();
    expect(createTrustedOsViewAgentTools({ ...base, repository: repository() as never, ownerId: "   " })).toBeUndefined();
    expect(createTrustedOsViewAgentTools({ ...base, repository: repository() as never, ownerId: "o".repeat(161) })).toBeUndefined();
    expect(createTrustedOsViewAgentTools({ ...base, repository: repository() as never, ownerId: "o".repeat(160) })).toBeDefined();
  });
});
