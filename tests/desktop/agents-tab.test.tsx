// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentsTab from "../../desktop/src/renderer/src/features/threads/AgentsTab";
import { useThreads, type AgentThread } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

vi.mock("../../desktop/src/renderer/src/features/threads/ThreadView", () => ({
  default: ({ threadId }: { threadId: string }) => <div data-testid="thread-view">{threadId}</div>,
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

describe("AgentsTab", () => {
  beforeEach(() => {
    useThreads.setState(useThreads.getInitialState(), true);
    useUi.setState({ composerOpen: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("falls back when the locally selected thread is removed", () => {
    const first = thread("thread-a", "Thread A");
    const second = thread("thread-b", "Thread B");
    useThreads.setState({ threads: [first, second], activeThreadId: null });

    render(<AgentsTab />);
    fireEvent.click(screen.getByRole("button", { name: /thread b/i }));
    expect(screen.getByTestId("thread-view").textContent).toBe("thread-b");

    act(() => {
      useThreads.setState({ threads: [first], activeThreadId: null });
    });

    return waitFor(() => {
      expect(screen.getByTestId("thread-view").textContent).toBe("thread-a");
    });
  });
});
