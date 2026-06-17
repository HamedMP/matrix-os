// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useThreads, type AgentThread } from "../../desktop/src/renderer/src/stores/threads";

vi.mock("../../desktop/src/renderer/src/features/threads/ThreadView", () => ({
  default: ({ threadId }: { threadId: string }) => (
    <div data-testid="thread-view">thread:{threadId}</div>
  ),
}));

function thread(id: string, title: string): AgentThread {
  return {
    id,
    requestId: `request-${id}`,
    sessionId: null,
    taskId: null,
    title,
    status: "running",
    transcript: [],
    unread: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

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
    useThreads.setState({ threads: [], activeThreadId: null });
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

  it("switches from Hermes to an agent thread from the rail", () => {
    useThreads.setState({
      threads: [thread("t1", "Build parser")],
      activeThreadId: null,
    });

    render(<ChatTab />);
    expect(screen.queryByTestId("thread-view")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Build parser" }));

    expect(useThreads.getState().activeThreadId).toBe("t1");
    expect(screen.getByTestId("thread-view").textContent).toBe("thread:t1");
  });

  it("falls back to Hermes when the active agent thread is removed", () => {
    useThreads.setState({
      threads: [thread("t1", "Build parser")],
      activeThreadId: "t1",
    });

    render(<ChatTab />);
    expect(screen.getByTestId("thread-view").textContent).toBe("thread:t1");

    act(() => {
      useThreads.setState({ threads: [], activeThreadId: "t1" });
    });

    expect(screen.queryByTestId("thread-view")).toBeNull();
    expect(screen.getByText("hello")).toBeTruthy();
  });
});
