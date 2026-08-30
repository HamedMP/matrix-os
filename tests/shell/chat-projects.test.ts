import { describe, expect, it, vi } from "vitest";
import {
  buildWebChatRailModel,
  mutateWebChatProject,
} from "../../shell/src/lib/chat-projects.js";

const projects = [
  { id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "scratch" as const },
  { id: "proj_beta", slug: "beta", name: "Beta", kind: "folder" as const },
];

describe("web Chat project parity", () => {
  it("groups project conversations by stable project id and leaves global chats in Recents", () => {
    const model = buildWebChatRailModel([
      { id: "global", preview: "Global chat", messageCount: 1, createdAt: 1, updatedAt: 3 },
      {
        id: "alpha-chat",
        preview: "Alpha chat",
        messageCount: 1,
        createdAt: 1,
        updatedAt: 2,
        context: { projectId: "proj_alpha", projectName: "Alpha", projectKind: "scratch", status: "ready" },
      },
    ], projects);

    expect(model.projects).toMatchObject([
      { project: { slug: "alpha" }, conversations: [{ id: "alpha-chat" }] },
      { project: { slug: "beta" }, conversations: [] },
    ]);
    expect(model.recents).toMatchObject([{ id: "global" }]);
  });

  it("posts validated rename and exact-confirmation delete actions to the shared lifecycle route", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await mutateWebChatProject(fetcher, "https://matrix.test", "alpha", { type: "rename", name: "Alpha two" });
    await mutateWebChatProject(fetcher, "https://matrix.test", "alpha", { type: "delete", confirmation: "Alpha two" });

    expect(fetcher).toHaveBeenNthCalledWith(1, "https://matrix.test/api/projects/alpha/actions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "rename", name: "Alpha two" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://matrix.test/api/projects/alpha/actions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "delete", confirmation: "Alpha two" }),
    }));
  });
});
