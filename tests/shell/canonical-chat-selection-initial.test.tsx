// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { useCanonicalChatSelection } from "@/hooks/useCanonicalChatSelection";

const record = (id: string) => ({ chat: { id } }) as unknown as ChatNavigationRecord;

describe("useCanonicalChatSelection initial id", () => {
  it("keeps a linked chat selected before and after the list loads", () => {
    const scope = {};
    const { result, rerender } = renderHook(
      ({ candidates, fresh }) => useCanonicalChatSelection({
        scope, candidates, authoritativeItems: candidates, fresh, truncated: false, initialExplicit: true, initialId: "chat_linked",
      }),
      { initialProps: { candidates: [] as ChatNavigationRecord[], fresh: false } },
    );
    expect(result.current[0]).toBe("chat_linked");
    rerender({ candidates: [record("chat_newest"), record("chat_linked")], fresh: true });
    expect(result.current[0]).toBe("chat_linked");
  });

  it("falls back to the newest chat when no id is linked", () => {
    const scope = {};
    const { result } = renderHook(() => useCanonicalChatSelection({
      scope, candidates: [record("chat_newest")], authoritativeItems: [record("chat_newest")], fresh: true, truncated: false, initialExplicit: false,
    }));
    expect(result.current[0]).toBe("chat_newest");
  });
});
