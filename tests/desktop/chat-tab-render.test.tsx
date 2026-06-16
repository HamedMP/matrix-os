// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";

describe("ChatTab", () => {
  beforeEach(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }],
    });
    useHermesChat.setState({
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: 1 }],
      status: "idle",
      send: vi.fn(),
      abort: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not render the full-height empty-state spacer when messages exist", () => {
    const { container } = render(<ChatTab />);

    expect(container.textContent).toContain("hello");
    expect(container.querySelector(".h-full.items-center.justify-center")).toBeNull();
  });
});
