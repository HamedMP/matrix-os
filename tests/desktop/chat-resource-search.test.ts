import { describe, expect, it, vi } from "vitest";
import {
  searchGlobalChatResources,
  searchHomeChatResources,
  searchProjectChatResources,
} from "../../desktop/src/renderer/src/features/chat/chat-resource-search";

describe("Global Chat resource search", () => {
  it("browses root files and folders as soon as the user types @", async () => {
    const get = vi.fn(async () => ({
      entries: [
        { name: "projects", type: "directory" },
        { name: "README.md", type: "file" },
      ],
    }));

    await expect(searchHomeChatResources({ get }, "")).resolves.toEqual([
      { kind: "folder", id: "projects", label: "projects" },
      { kind: "file", id: "README.md", label: "README.md" },
    ]);
    expect(get).toHaveBeenCalledWith("/api/files/list?path=");
  });

  it("falls back to Home files when the selected Project workspace has no matches", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/api/coding-agents/files/search")) {
        return { matches: { items: [], hasMore: false, limit: 30 } };
      }
      return {
        results: [{ path: "apps/games/tetris/src/main.tsx", type: "file" }],
      };
    });

    await expect(searchGlobalChatResources({ get }, "matrix-os", "main")).resolves.toEqual([
      {
        kind: "file",
        id: "apps/games/tetris/src/main.tsx",
        label: "apps/games/tetris/src/main.tsx",
      },
    ]);
    expect(get).toHaveBeenNthCalledWith(
      1,
      "/api/coding-agents/files/search?projectId=matrix-os&query=main&limit=30",
    );
    expect(get).toHaveBeenNthCalledWith(2, "/api/files/search?q=main&limit=30");
  });

  it("keeps Project Chat file search scoped to the current Project root", async () => {
    const get = vi.fn(async () => ({
      matches: {
        items: [{ path: "src/main.tsx", kind: "file", updatedAt: "2026-08-26T00:00:00.000Z" }],
        hasMore: false,
        limit: 30,
      },
    }));

    await expect(searchProjectChatResources({ get }, "matrix-os", "main")).resolves.toEqual([
      { kind: "file", id: "src/main.tsx", label: "src/main.tsx" },
    ]);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      "/api/coding-agents/files/search?projectId=matrix-os&query=main&limit=30",
    );
  });
});
