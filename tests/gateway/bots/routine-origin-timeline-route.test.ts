import { expect, it, vi } from "vitest";
import { createRoutineOriginRoutes } from "../../../packages/gateway/src/bots/routine-origin-routes.js";

const path = "/api/chats/chat_source/routine-origin";
const legacy = { sourceChatId: "chat_source", pending: [], deliveries: [], hasMore: false, deliveryPending: false };

it("negotiates retained approval history without changing the legacy response or approval route", async () => {
  const approved = { sourceChatId: "chat_source", anchorMessageId: "msg_original_request", decision: "approve" as const,
    interaction: { interactionId: "in_abcdefgh", chatId: "chat_target", taskId: "task_abcdefgh", agentId: "bot_abcdefgh",
      kind: "approval" as const, status: "resolved" as const, blocking: true, expiresAt: "2026-11-07T10:00:00.000Z", revision: 2 } };
  const read = vi.fn(async (_owner: string, _chat: string, timeline?: boolean) => timeline
    ? { ...legacy, history: [approved] }
    : legacy);
  const verifyApproval = vi.fn();
  const routes = createRoutineOriginRoutes({
    service: { read, resolve: vi.fn() },
    getPrincipal: () => ({ userId: "authenticated-owner", source: "jwt" }),
    handle: "fixture", machineId: "fixture-machine", runtimeSlot: "primary", verifyApproval, admitContinuation: vi.fn(),
  });

  const timeline = await routes.request(path + "?timeline=1");
  expect(timeline.status).toBe(200);
  expect(await timeline.json()).toEqual({ ...legacy, history: [approved] });
  expect(read).toHaveBeenCalledWith("authenticated-owner", "chat_source", true);

  const original = await routes.request(path);
  expect(original.status).toBe(200);
  expect(await original.json()).toEqual(legacy);
  expect(read).toHaveBeenLastCalledWith("authenticated-owner", "chat_source");

  for (const query of ["?timeline=0", "?timeline=1&timeline=1", "?timeline=1&owner=forged"]) {
    expect((await routes.request(path + query)).status).toBe(400);
  }
  expect((await routes.request(path + "/in_abcdefgh/resolve?timeline=1", { method: "POST" })).status).toBe(400);
  expect(read).toHaveBeenCalledTimes(2);
  expect(verifyApproval).not.toHaveBeenCalled();
});
