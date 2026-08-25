import { describe, expect, it, vi } from "vitest";
import { searchHomeChatResources } from "../../desktop/src/renderer/src/features/chat/chat-resource-search";

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
});
