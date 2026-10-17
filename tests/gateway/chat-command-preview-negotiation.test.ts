import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";

function fixture() {
  const at = "2026-10-12T00:00:00.000Z";
  const preview = "cat /home/matrix/home/report.txt\nprintf done";
  const getDetail = vi.fn(async () => ({
    record: { chat: { id: "chat_command", ownerScope: { type: "personal" as const, ownerId: "owner_1" },
      title: "Command review", lifecycle: "active" as const, attention: "none" as const,
      revision: 1, messageCount: 0, createdAt: at, updatedAt: at } },
    messages: [], turns: [], runs: [], activities: [{ id: "activity_command", chatId: "chat_command", runId: "run_command",
      occurredAt: at, type: "agent.activity" as const, activityId: "tool_command", kind: "command" as const,
      label: "Run command", status: "completed" as const, preview, previewKind: "command" as const,
      detail: "Working directory: ~/" }],
  }));
  // This test exercises only GET detail and its version-validation middleware.
  const service = { getDetail } satisfies Pick<CanonicalChatRouteService, "getDetail">;
  const app = new Hono().route("/", createCanonicalChatRoutes({ service: service as CanonicalChatRouteService,
    getPrincipal: () => ({ userId: "owner_1", source: "jwt" }) }));
  return { app, getDetail, preview };
}

it("negotiates authorized private command previews without breaking legacy detail reads", async () => {
  const { app, preview } = fixture();
  const legacy = await app.request("/api/chats/chat_command?messageVersion=2&inputVersion=1");
  expect(legacy.status).toBe(200);
  const oldBody = await legacy.json();
  expect(oldBody.activities[0]).not.toHaveProperty("preview");
  expect(oldBody.activities[0]).toMatchObject({ label: "Run command", detail: "Working directory: ~/" });
  const current = await app.request("/api/chats/chat_command?messageVersion=2&inputVersion=1&commandPreviewVersion=1");
  expect(current.status).toBe(200);
  expect((await current.json()).activities[0].preview).toBe(preview);
});

it.each(["2", "1&commandPreviewVersion=0"])("rejects invalid or repeated command preview negotiation %s before service access", async value => {
  const { app, getDetail } = fixture();
  const response = await app.request(`/api/chats/chat_command?commandPreviewVersion=${value}`);
  expect(response.status).toBe(400);
  expect(getDetail).not.toHaveBeenCalled();
});
