// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../../shell/src/components/ChatPanel.js";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function renderChatPanel() {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
  return render(
    <ChatPanel
      messages={[]}
      sessionId={undefined}
      busy={false}
      connected
      conversations={[]}
      onNewChat={vi.fn()}
      onSwitchConversation={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

describe("ChatPanel drag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves the desktop chat panel when dragging its header", () => {
    setViewportWidth(1200);
    renderChatPanel();

    fireEvent.pointerDown(screen.getByTestId("chat-panel-drag-handle"), {
      pointerId: 1,
      clientX: 300,
      clientY: 40,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 180,
      clientY: 64,
    });

    expect(screen.getByTestId("chat-panel").style.transform).toBe("translate3d(-120px, 24px, 0)");
  });

  it("keeps the mobile chat panel fixed full-screen", () => {
    setViewportWidth(500);
    renderChatPanel();

    fireEvent.pointerDown(screen.getByTestId("chat-panel-drag-handle"), {
      pointerId: 1,
      clientX: 300,
      clientY: 40,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 180,
      clientY: 64,
    });

    expect(screen.getByTestId("chat-panel").style.transform).toBe("");
  });

  it("resets a desktop drag offset when resized to mobile", () => {
    setViewportWidth(1200);
    renderChatPanel();

    fireEvent.pointerDown(screen.getByTestId("chat-panel-drag-handle"), {
      pointerId: 1,
      clientX: 300,
      clientY: 40,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 180,
      clientY: 64,
    });

    expect(screen.getByTestId("chat-panel").style.transform).toBe("translate3d(-120px, 24px, 0)");

    setViewportWidth(500);
    fireEvent.resize(window);

    expect(screen.getByTestId("chat-panel").style.transform).toBe("");
  });
});
