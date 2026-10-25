// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { AppError } from "@desktop/shared/app-error";

const record = { chat: { id: "chat_retry", ownerScope: { type: "personal" as const, ownerId: "owner_test" },
  title: "Retry", lifecycle: "active" as const, attention: "none" as const, revision: 1, messageCount: 0,
  createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" } };
const detail = { record, messages: [], turns: [], runs: [], activities: [] };
const input = { parts: [{ type: "text" as const, text: "Send once" }],
  selection: { instanceId: "codex_test", model: "test" }, interactionMode: "default", permissionMode: "supervised" };

describe("Electron admission retry identity", () => {
  it("keeps the original request ID when readback is inconclusive and the user retries unchanged text", async () => {
    const admitTurn = vi.fn().mockRejectedValue(new AppError("timeout"));
    const client = { list: vi.fn(async () => ({ items: [record] })), getDetail: vi.fn(async () => detail), admitTurn } as unknown as CanonicalChatClient;
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: record.chat.id }));
    try {
      await act(async () => {});
      await act(async () => { await hook.result.current.submitTurn(input, "Retry"); });
      const original = admitTurn.mock.calls[0][1].clientRequestId;
      await act(async () => { await hook.result.current.submitTurn(input, "Retry"); });
      expect(admitTurn.mock.calls[1][1].clientRequestId).toBe(original);
      await act(async () => { await hook.result.current.submitTurn({ ...input, parts: [{ type: "text", text: "Different" }] }, "Retry"); });
      expect(admitTurn.mock.calls[2][1].clientRequestId).not.toBe(original);
    } finally { hook.unmount(); }
  });
});
