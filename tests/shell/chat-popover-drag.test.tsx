// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPopover } from "../../shell/src/components/ChatPopover.js";
import { ChatProvider } from "../../shell/src/stores/chat-context.js";
import type { ChatState } from "../../shell/src/hooks/useChatState.js";

function makeChatStub(overrides: Partial<ChatState> = {}): ChatState {
  return {
    messages: [],
    sessionId: undefined,
    busy: false,
    currentTool: null,
    connected: true,
    queue: [],
    conversations: [],
    submitMessage: vi.fn(),
    newChat: vi.fn(),
    switchConversation: vi.fn(),
    abortCurrent: vi.fn(),
    ...overrides,
  } as ChatState;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function renderPopover() {
  return render(
    <ChatProvider value={makeChatStub()}>
      <ChatPopover open onOpenChange={vi.fn()} />
    </ChatProvider>,
  );
}

describe("ChatPopover drag + close", () => {
  beforeEach(() => {
    setViewport(1200, 800);
    // jsdom returns a zero-size rect; give the popup a realistic size so the
    // on-screen clamp leaves an in-bounds drag untouched.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 380,
      height: 460,
      top: 320,
      left: 410,
      right: 790,
      bottom: 780,
      x: 410,
      y: 320,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("moves the popover when dragging its header and persists the offset", () => {
    renderPopover();

    fireEvent.pointerDown(screen.getByTestId("chat-popover-drag-handle"), {
      pointerId: 1,
      clientX: 300,
      clientY: 200,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 340, clientY: 140 });

    expect(screen.getByTestId("chat-popover").style.translate).toBe("40px -60px");

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 340, clientY: 140 });
    expect(window.localStorage.getItem("matrix:chat-popover-offset")).toBe(
      JSON.stringify({ x: 40, y: -60 }),
    );
  });

  it("snaps back home on double-click", () => {
    renderPopover();

    fireEvent.pointerDown(screen.getByTestId("chat-popover-drag-handle"), {
      pointerId: 1,
      clientX: 300,
      clientY: 200,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 340, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 340, clientY: 140 });
    expect(screen.getByTestId("chat-popover").style.translate).toBe("40px -60px");

    fireEvent.doubleClick(screen.getByTestId("chat-popover-drag-handle"));
    expect(screen.getByTestId("chat-popover").style.translate).toBe("");
  });

  it("exposes a clear close control with an esc hint", () => {
    renderPopover();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByText("esc")).toBeTruthy();
  });
});
