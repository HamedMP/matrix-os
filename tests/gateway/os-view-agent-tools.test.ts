import { describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument, type OsViewStateResponse } from "@matrix-os/contracts";
import { createOsViewAgentTools } from "../../packages/gateway/src/os-view-state/agent-tools.js";
import { OsViewStateConflictError } from "../../packages/gateway/src/os-view-state/repository.js";

function state(revision = 1): OsViewStateResponse {
  return {
    revision,
    document: { ...createDefaultOsViewDocument(), desktop: { windows: [], icons: [] } },
    updatedAt: "2026-09-08T12:00:00.000Z",
  };
}

const sushiCatalog = [{
  slug: "sushi-counter",
  name: "Sushi Counter",
  file: "sushi-counter/index.html",
  path: "/files/apps/sushi-counter/index.html",
}] as never;

describe("OS-view agent tools", () => {
  it("lists canonical placeable catalog entries and resolves exact appId server-side", async () => {
    let current = state();
    const repository = {
      getOrCreate: vi.fn(async () => current),
      patch: vi.fn(async (ownerId: string, input: { patch: OsViewStateResponse["document"] }) => {
        current = {
          ...current,
          revision: current.revision + 1,
          document: { ...current.document, ...input.patch },
        };
        return current;
      }),
    };
    const changed = vi.fn();
    const tools = createOsViewAgentTools({
      repository: repository as never,
      ownerId: "owner_one",
      homePath: "/unused",
      listCatalog: async () => sushiCatalog,
      onChanged: changed,
    });

    await expect(tools.listPlaceableApps()).resolves.toEqual(expect.arrayContaining([
      { appId: "chat", name: "Chat", path: "__chat__" },
      { appId: "sushi-counter", name: "Sushi Counter", path: "apps/sushi-counter/index.html" },
    ]));
    await expect(tools.addAppToDesktop("sushi-counter")).resolves.toEqual({ status: "added" });
    expect(repository.patch).toHaveBeenCalledWith("owner_one", expect.objectContaining({
      patch: { desktop: { icons: [{ path: "apps/sushi-counter/index.html", x: 20, y: 20 }] } },
    }));
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it("rejects invalid or unknown IDs and is idempotent for an existing icon", async () => {
    const current = state();
    current.document.desktop.icons = [{ path: "apps/sushi-counter/index.html", x: 20, y: 20 }];
    const repository = {
      getOrCreate: vi.fn(async () => current),
      patch: vi.fn(),
    };
    const tools = createOsViewAgentTools({
      repository: repository as never,
      ownerId: "owner_one",
      homePath: "/unused",
      listCatalog: async () => sushiCatalog,
    });

    await expect(tools.addAppToDesktop("../sushi-counter")).resolves.toEqual({ status: "failed" });
    await expect(tools.addAppToDesktop("missing")).resolves.toEqual({ status: "failed" });
    await expect(tools.addAppToDesktop("sushi-counter")).resolves.toEqual({ status: "already-present" });
    expect(repository.patch).not.toHaveBeenCalled();
  });

  it("lists every built-in destination but excludes Create app and presentation switches", async () => {
    const tools = createOsViewAgentTools({
      repository: { getOrCreate: vi.fn(), patch: vi.fn() } as never,
      ownerId: "owner_one",
      homePath: "/unused",
      listCatalog: async () => ([
        { slug: "create", name: "Create app", file: "", path: "__create-app__" },
        { slug: "canvas", name: "Canvas", file: "", path: "__os-view-canvas__" },
        { slug: "desktop", name: "Desktop", file: "", path: "__os-view-desktop__" },
      ] as never),
    });

    const apps = await tools.listPlaceableApps();
    expect(apps.map((app) => app.appId)).toEqual([
      "chat", "terminal", "files", "editor", "vscode",
      "settings", "plugins", "browser", "notes", "whiteboard",
    ]);
  });

  it("rebases a conflict against the newest owner revision", async () => {
    const first = state(3);
    const concurrent = state(4);
    concurrent.document.desktop.icons = [{ path: "__chat__", x: 20, y: 20 }];
    const updated = state(5);
    updated.document.desktop.icons = [
      ...concurrent.document.desktop.icons,
      { path: "apps/sushi-counter/index.html", x: 20, y: 112 },
    ];
    const repository = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(concurrent),
      patch: vi.fn()
        .mockRejectedValueOnce(new OsViewStateConflictError(4))
        .mockResolvedValueOnce(updated),
    };
    const tools = createOsViewAgentTools({
      repository: repository as never,
      ownerId: "owner_two",
      homePath: "/unused",
      listCatalog: async () => sushiCatalog,
    });

    await expect(tools.addAppToDesktop("sushi-counter")).resolves.toEqual({ status: "added" });
    expect(repository.patch).toHaveBeenLastCalledWith("owner_two", expect.objectContaining({
      baseRevision: 4,
      patch: { desktop: { icons: updated.document.desktop.icons } },
    }));
  });

  it("keeps placement owner-scoped without accepting an owner from tool input", async () => {
    const states = new Map<string, OsViewStateResponse>([
      ["owner_one", state()],
      ["owner_two", state()],
    ]);
    const repository = {
      getOrCreate: vi.fn(async (ownerId: string) => states.get(ownerId)!),
      patch: vi.fn(async (ownerId: string, input: {
        patch: { desktop: { icons: OsViewStateResponse["document"]["desktop"]["icons"] } };
      }) => {
        const current = states.get(ownerId)!;
        const updated = {
          ...current,
          revision: current.revision + 1,
          document: {
            ...current.document,
            desktop: { ...current.document.desktop, icons: input.patch.desktop.icons },
          },
        };
        states.set(ownerId, updated);
        return updated;
      }),
    };
    const ownerOneTools = createOsViewAgentTools({
      repository,
      ownerId: "owner_one",
      homePath: "/unused",
      listCatalog: async () => sushiCatalog,
    });

    await expect(ownerOneTools.addAppToDesktop("sushi-counter")).resolves.toEqual({ status: "added" });
    expect(states.get("owner_one")?.document.desktop.icons).toHaveLength(1);
    expect(states.get("owner_two")?.document.desktop.icons).toEqual([]);
    expect(repository.patch).toHaveBeenCalledWith("owner_one", expect.any(Object));
  });

  it("returns desktop-full without writing when no usable slot remains", async () => {
    const current = state();
    current.document.desktop.icons = Array.from({ length: 98 }, (_, index) => ({
      path: `apps/existing-${index}/index.html`,
      x: 20 + Math.floor(index / 7) * 88,
      y: 20 + (index % 7) * 92,
    }));
    const repository = {
      getOrCreate: vi.fn(async () => current),
      patch: vi.fn(),
    };
    const tools = createOsViewAgentTools({
      repository: repository as never,
      ownerId: "owner_one",
      homePath: "/unused",
      listCatalog: async () => sushiCatalog,
    });

    await expect(tools.addAppToDesktop("sushi-counter")).resolves.toEqual({ status: "desktop-full" });
    expect(repository.patch).not.toHaveBeenCalled();
  });
});
