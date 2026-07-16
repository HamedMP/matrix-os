// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
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

function codingAgentSummaryFixture() {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: {
      items: [
        {
          id: "thread_server",
          providerId: "codex",
          title: "Server-backed run",
          status: "running",
          attention: "none",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:03:00.000Z",
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
    useCodingAgentWorkspace.setState({ summary: null, activeThreadId: null });
    useTabs.setState({ tabs: [], activeTabId: null });
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

  it("lists coding-agent workspace threads in the rail", () => {
    useCodingAgentWorkspace.setState({ summary: codingAgentSummaryFixture() });

    render(<ChatTab />);

    expect(screen.getByRole("button", { name: "Server-backed run" })).toBeTruthy();
  });

  it("routes a coding-agent rail selection to the Agents workspace", () => {
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useCodingAgentWorkspace.setState({
      summary: codingAgentSummaryFixture(),
      loadThreadSnapshot,
    });

    render(<ChatTab />);
    fireEvent.click(screen.getByRole("button", { name: "Server-backed run" }));

    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_server");
    const tabs = useTabs.getState();
    expect(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.kind).toBe("agents");
    // The chat pane itself stays on Hermes; the transcript renders in the workspace.
    expect(screen.queryByTestId("thread-view")).toBeNull();
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
