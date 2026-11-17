import { expect, it, vi } from "vitest";
import { CanonicalChatMessageSchema } from "../../../packages/contracts/src/canonical-chat.js";
import { CanonicalCreateChatTurnRequestSchema } from "../../../packages/contracts/src/canonical-chat-api.js";
import { createRoutineOriginRoutes } from "../../../packages/gateway/src/bots/routine-origin-routes.js";
export const receipt = { type: "routine_receipt", engine: "matrix", routineId: "rt_" + "a".repeat(24), fireId: "fire_" + "b".repeat(24), attempt: 1,
  status: "completed", scheduledFor: "2026-11-06T00:00:00.000Z", canonicalChatId: "chat_target", canonicalTaskId: "task_target", canonicalRunId: "run_target", canonicalMessageId: "msg_target", model: "approved-model" };
it("accepts persisted attributed routine receipts without borrowing a source Run or Turn", () => {
  expect(CanonicalChatMessageSchema.safeParse({ id: "msg_receipt", chatId: "chat_source", seq: 2, role: "system", state: "committed", parts: [receipt, { type: "text", text: "Approved result" }], createdAt: "2026-11-06T00:01:00.000Z" }).success).toBe(true);
});
it("rejects user supplied receipt provenance at the canonical admission boundary", () => {
  const input = { clientRequestId: "req_forged", baseRevision: 0, selection: { instanceId: "claude_code_default", model: "fixture-model" }, interactionMode: "default", permissionMode: "full_access" };
  expect(CanonicalCreateChatTurnRequestSchema.safeParse({ ...input, parts: [{ type: "text", text: "Valid text" }] }).success).toBe(true);
  expect(CanonicalCreateChatTurnRequestSchema.safeParse({ ...input, parts: [receipt] }).success).toBe(false);
});
it.each([{ role: "assistant" }, { state: "pending" }, { runId: "run_foreign" }, { turnId: "cturn_foreign" }])("refuses forged receipt storage context %j", patch => {
  expect(CanonicalChatMessageSchema.safeParse({ id: "msg_receipt", chatId: "chat_source", seq: 2, role: "system", state: "committed", parts: [receipt], createdAt: "2026-11-06T00:01:00.000Z", ...patch }).success).toBe(false);
});

it("adds executor names only to the negotiated timeline response", async () => {
  const sourceChatId = "chat_source";
  const item = { sourceChatId, anchorMessageId: "msg_source",
    interaction: { interactionId: "in_fixture01", chatId: "chat_target", taskId: "task_target01", agentId: "bot_fixture01",
      kind: "approval" as const, status: "pending" as const, blocking: true, expiresAt: "2099-01-01T00:00:00.000Z", revision: 1 } };
  const read = vi.fn(async (_owner: string, _chat: string, includeHistory?: boolean, includeExecutorNames?: true) => ({
    sourceChatId, pending: [includeExecutorNames ? { ...item, executorName: "Research Bot" } : item],
    ...(includeHistory ? { history: [] } : {}), deliveries: [], hasMore: false, deliveryPending: false,
  }));
  const verifyApproval = vi.fn();
  const routes = createRoutineOriginRoutes({
    service: { read, resolve: vi.fn() }, verifyApproval, admitContinuation: vi.fn(),
    getPrincipal: () => ({ userId: "verified-owner", source: "jwt" }),
    handle: "fixture", machineId: "fixture-machine", runtimeSlot: "primary",
  });
  const path = `/api/chats/${sourceChatId}/routine-origin`;

  const named = await routes.request(`${path}?timeline=2`);
  expect(named.status).toBe(200);
  expect(await named.json()).toMatchObject({ pending: [{ ...item, executorName: "Research Bot" }], history: [] });
  expect(read).toHaveBeenLastCalledWith("verified-owner", sourceChatId, true, true);

  const oldTimeline = await routes.request(`${path}?timeline=1`);
  expect(oldTimeline.status).toBe(200);
  const original = { sourceChatId, pending: [item], deliveries: [], hasMore: false, deliveryPending: false };
  expect(await oldTimeline.json()).toEqual({ ...original, history: [] });
  expect(read).toHaveBeenLastCalledWith("verified-owner", sourceChatId, true);
  const legacy = await routes.request(path);
  expect(legacy.status).toBe(200);
  expect(await legacy.json()).toEqual(original);
  expect(read).toHaveBeenLastCalledWith("verified-owner", sourceChatId);

  expect((await routes.request(`${path}?timeline=2&owner=forged`)).status).toBe(400);
  expect((await routes.request(`${path}/in_fixture01/resolve?timeline=2`, { method: "POST" })).status).toBe(400);
  expect(read).toHaveBeenCalledTimes(3);
  expect(verifyApproval).not.toHaveBeenCalled();
});
