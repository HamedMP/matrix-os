import { expect, it } from "vitest";
import { CanonicalChatMessageSchema } from "@matrix-os/contracts";
import { withChatSessionHistory, prepareChatSessionContext, contextForChatSession } from "../../packages/gateway/src/chat/session-history.js";
const owner = { type: "personal" as const, ownerId: "owner_history" };
const message = (seq: number, role = "user", state = "committed", parts = [{ type: "text", text: `TEXT_${seq}` }]) =>
  CanonicalChatMessageSchema.parse({ id: `msg_history_${seq}`, chatId: "chat_history", seq, role, state, parts, createdAt: "2026-10-05T00:00:00Z" });

it("frames only committed text, bounds UTF-8 history, and does not recreate attachment/tool/reference authority", () => {
  const context = withChatSessionHistory({
    chatId: "chat_history", title: "History", throughSeq: 6, requestHash: "a".repeat(64), truncated: true,
    messages: [message(1, "assistant", "committed", [{ type: "text", text: "AUTHORED\ufffd " + "兔".repeat(8_000) }]),
      message(2, "tool"), message(3, "system"), message(4, "assistant", "failed"),
      message(5, "user", "committed", [{ type: "resource_reference", resource: { kind: "chat", id: "chat_other", label: "DO_NOT_FETCH" } }]),
      message(6, "assistant", "committed", [
        { type: "text", text: "TEXT_6" },
        { type: "attachment_reference", attachmentId: "attachment_old", kind: "file", label: "OLD_ATTACHMENT", ownerReference: "uploads/old-secret.txt" },
        { type: "tool_result", toolCallId: "tool_old", outcome: "success", text: "OLD_TOOL_SECRET", truncated: false },
      ]), message(7)],
  });
  expect(Buffer.byteLength(context.history!.text)).toBeLessThanOrEqual(12_000);
  expect(context.history!.text).not.toContain("\ufffd");
  expect(context.history!.text).toContain("Assistant: TEXT_6");
  for (const omitted of ["TEXT_2", "TEXT_3", "TEXT_4", "DO_NOT_FETCH", "TEXT_7", "OLD_ATTACHMENT", "old-secret", "OLD_TOOL_SECRET"]) expect(context.history!.text).not.toContain(omitted);
  expect(context.history!.truncated).toBe(true);
  expect(context.chats).toEqual([]);
  expect(context.agent).toBeUndefined();
});

it("fails closed when the owner-scoped history is missing or shared", async () => {
  for (const detail of [null, { record: { chat: { lifecycle: "active", collaboration: {} } } }]) {
    await expect(prepareChatSessionContext({ repository: { getDetailPage: async () => detail as never }, owner,
      chatId: "chat_history", instanceId: "codex_default", throughSeq: 4, requestHash: "a".repeat(64), resumeState: undefined,
    })).rejects.toThrow("context_unavailable");
  }
});

it("preserves a delivery-filtered gap alongside native resume instead of replaying unheard text", async () => {
  const context = withChatSessionHistory({ chatId: "chat_history", title: "History", throughSeq: 4,
    requestHash: "a".repeat(64), truncated: false, messages: [message(4, "assistant", "committed", [{ type: "text", text: "HEARD_ONLY" }])] });
  const repository = { getDetailPage: async () => { throw new Error("Must not replace delivery-filtered history"); } };
  expect(contextForChatSession(context, { sessionId: "native" }, true)).toEqual(context);
  await expect(prepareChatSessionContext({ repository, owner, chatId: "chat_history", instanceId: "codex_default",
    throughSeq: 4, requestHash: "a".repeat(64), resumeState: { sessionId: "native" }, context, preserveHistory: true,
  })).resolves.toEqual(context);
  expect(contextForChatSession(context, { sessionId: "native" })?.history).toBeUndefined();
});

it("preserves a truncated delivery-filtered rebuild when the current boundary is newer", async () => {
  const context = withChatSessionHistory({ chatId: "chat_history", title: "History", throughSeq: 40,
    requestHash: "a".repeat(64), truncated: true, messages: [message(40, "assistant", "committed", [{ type: "text", text: "HEARD_ONLY" }])] });
  const repository = { getDetailPage: async () => { throw new Error("Must not reload unfiltered assistant text"); } };
  await expect(prepareChatSessionContext({ repository, owner, chatId: "chat_history", instanceId: "codex_default",
    throughSeq: 80, requestHash: "a".repeat(64), resumeState: undefined, context, preserveHistory: true,
  })).resolves.toEqual(context);
});
