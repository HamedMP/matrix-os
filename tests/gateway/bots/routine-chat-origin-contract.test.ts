import { expect, it } from "vitest";
import { CanonicalChatMessageSchema } from "../../../packages/contracts/src/canonical-chat.js";
import { CanonicalCreateChatTurnRequestSchema } from "../../../packages/contracts/src/canonical-chat-api.js";
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
