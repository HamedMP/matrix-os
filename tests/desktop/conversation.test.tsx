// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation, ConversationContent } from "../../desktop/src/renderer/src/features/chat/elements/conversation";

describe("Conversation", () => {
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    class ResizeObserverStub {
      observe = observe;
      disconnect = disconnect;
      unobserve() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts observing when content appears after an empty mount", async () => {
    const { rerender } = render(<Conversation>{null}</Conversation>);

    expect(observe).not.toHaveBeenCalled();

    rerender(
      <Conversation>
        <ConversationContent>
          <div>Streaming reply</div>
        </ConversationContent>
      </Conversation>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(observe).toHaveBeenCalledTimes(1);
  });
});
