// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkBotHeaderBinding } from "@desktop/renderer/src/features/work/use-work-bot-header-binding";

const scope = { client: {}, chatId: "chat_bot", runtimeSlot: "primary", authGeneration: 1,
  route: "chat" as const, initialChatView: "conversation" as const };
const binding = { client: {}, chatId: "chat_bot", status: "bot" as const, agentId: "bot_writer" };

describe("Bot toolbar content ownership", () => {
  for (const next of [
    { ...scope, route: "project" as const, projectSlug: "portfolio" },
    { ...scope, initialChatView: "draft" as const },
    { ...scope, projectSlug: "other-project" },
    { ...scope, sharedScopeId: "shared-chat" },
  ]) {
    it(`discards the old content report on route/view changes ${JSON.stringify(next)}`, () => {
      const { result, rerender } = renderHook(useWorkBotHeaderBinding, { initialProps: scope as Parameters<typeof useWorkBotHeaderBinding>[0] });
      const oldReport = result.current.report;
      act(() => { oldReport(binding); });
      expect(result.current.agentId).toBe(binding.agentId);
      rerender(next);
      expect(result.current.agentId).toBeNull();
      act(() => { oldReport(binding); });
      expect(result.current.agentId).toBeNull();
    });
  }

  it("keeps unresolved and ordinary content fail-closed even if a stale agent ID is supplied", () => {
    const { result } = renderHook(useWorkBotHeaderBinding, { initialProps: scope });
    for (const status of ["loading", "error", "ordinary"] as const) {
      act(() => { result.current.report({ ...binding, status }); });
      expect(result.current.agentId).toBeNull();
    }
  });
});
