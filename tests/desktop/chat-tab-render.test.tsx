// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
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
      view: "conversation",
      conversations: [],
      indexStatus: "ready",
      indexError: null,
      loadStatus: "idle",
      loadError: null,
      loadingConversationId: null,
      send: vi.fn(),
      abort: vi.fn(),
    });
    useThreads.setState({ threads: [], activeThreadId: null });
    useCodingAgentWorkspace.setState({ summary: null, activeThreadId: null });
    useProjectView.setState({ entries: {}, runtimeScope: null });
    useProjectWorkspaces.setState({ entries: {} });
    useTabs.setState({ tabs: [], activeTabId: null });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: null,
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
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

  it("renders connect cards with real lucide icons instead of placeholder squares", () => {
    useHermesChat.setState({ messages: [], status: "idle", send: vi.fn(), abort: vi.fn() });
    render(<ChatTab />);

    // Each onboarding connect card carries a glyph matching its label
    // semantics — no empty gray placeholder tiles.
    for (const title of ["Connect messaging", "Connect email", "Connect files"]) {
      const card = screen.getByText(title).parentElement;
      expect(card).not.toBeNull();
      expect(card?.querySelector("svg")).not.toBeNull();
    }
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

  it("routes a coding-agent rail selection into the project's chats view", async () => {
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useCodingAgentWorkspace.setState({
      summary: codingAgentSummaryFixture(),
      loadThreadSnapshot,
    });

    render(<ChatTab />);
    fireEvent.click(screen.getByRole("button", { name: "Server-backed run" }));

    await waitFor(() => expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_server"));
    const tabs = useTabs.getState();
    const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
    expect(active).toMatchObject({ kind: "project", projectSlug: "matrix-os" });
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_server");
    // The chat pane itself stays on Hermes; the transcript renders in the project.
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

  it("previews pasted files horizontally, uploads on Send, and sends Hermes readable paths", async () => {
    const send = vi.fn();
    const putBytes = vi.fn(async (path: string, file: File) => ({
      ok: true,
      path: decodeURIComponent(path.split("path=")[1] ?? ""),
      size: file.size,
    }));
    useHermesChat.setState({ messages: [], status: "idle", send, abort: vi.fn() });
    useConnection.setState({ api: { putBytes } as never });
    render(<React.StrictMode><ChatTab /></React.StrictMode>);

    const pane = screen.getByRole("region", { name: "Hermes conversation" });
    const pasted = new File(["screen"], "screen.png", { type: "image/png" });
    fireEvent.paste(pane, { clipboardData: { files: [pasted] } });

    expect(await screen.findByRole("button", { name: "Remove screen.png" })).toBeTruthy();
    const previewRow = screen.getByRole("group", { name: "Attachments" });
    expect(previewRow.className).toContain("overflow-x-auto");
    const input = screen.getByLabelText("Do anything");
    fireEvent.change(input, { target: { value: "Review this screenshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(putBytes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.stringMatching(
      /^Review this screenshot\n\nAttached files[\s\S]*~\/temporary\/desktop-chat\/[A-Za-z0-9]+-screen\.png \(\/home\/matrix\/home\/temporary\/desktop-chat\/[A-Za-z0-9]+-screen\.png\)$/,
    )));
    expect(screen.queryByRole("button", { name: "Remove screen.png" })).toBeNull();
  });

  it("does not intercept a text-only drop in Chat", () => {
    useHermesChat.setState({ messages: [], status: "idle", send: vi.fn(), abort: vi.fn() });
    render(<ChatTab />);

    const pane = screen.getByRole("region", { name: "Hermes conversation" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { items: [{ kind: "string" }], files: [] },
    });
    pane.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(screen.queryByRole("group", { name: "Attachments" })).toBeNull();
  });

  it("retains a failed Chat preview instead of sending", async () => {
    const send = vi.fn();
    useHermesChat.setState({ messages: [], status: "idle", send, abort: vi.fn() });
    useConnection.setState({ api: { putBytes: vi.fn().mockRejectedValue(new Error("offline")) } as never });
    render(<ChatTab />);
    const pane = screen.getByRole("region", { name: "Hermes conversation" });
    fireEvent.drop(pane, { dataTransfer: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect(await screen.findByText("Upload failed. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry notes.txt" })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("renders the persistent Hermes index newest-first with bounded metadata", () => {
    useHermesChat.setState({
      view: "index",
      indexStatus: "ready",
      indexError: null,
      conversations: [
        {
          id: "conversation-new",
          title: "Plan the launch",
          preview: "Review the final launch checklist",
          messageCount: 4,
          createdAt: 20,
          updatedAt: 30,
        },
        {
          id: "conversation-old",
          title: "Earlier notes",
          preview: "Summarize the customer interview",
          messageCount: 2,
          createdAt: 10,
          updatedAt: 15,
        },
      ],
    });

    render(<ChatTab />);

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    const newest = screen.getByRole("button", { name: "Plan the launch conversation" });
    const older = screen.getByRole("button", { name: "Earlier notes conversation" });
    expect(newest.textContent).toContain("Plan the launch");
    expect(newest.textContent).toContain("4 messages");
    expect(older.textContent).toContain("Earlier notes");
    expect(screen.queryByText("hello")).toBeNull();
  });

  it("shows loading, empty, and safe recovery states for conversation discovery", () => {
    useHermesChat.setState({ view: "index", indexStatus: "loading", conversations: [], indexError: null });
    const { rerender } = render(<ChatTab />);
    expect(screen.getByRole("status", { name: "Loading chats" })).toBeTruthy();

    act(() => useHermesChat.setState({ indexStatus: "ready", conversations: [] }));
    rerender(<ChatTab />);
    expect(screen.getByRole("heading", { name: "No chats yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();

    act(() => useHermesChat.setState({
      indexStatus: "error",
      indexError: "Conversations could not be loaded. Try again.",
    }));
    rerender(<ChatTab />);
    expect(screen.getByRole("alert").textContent).toContain("Conversations could not be loaded. Try again.");
    expect(screen.getByRole("button", { name: "Retry chats" })).toBeTruthy();
  });

  it("marks only the selected live conversation as running", () => {
    useHermesChat.setState({
      view: "index",
      sessionId: "conversation-selected",
      status: "streaming",
      indexStatus: "ready",
      conversations: [
        {
          id: "conversation-newer",
          title: "Newer but idle",
          preview: "idle",
          messageCount: 1,
          createdAt: 20,
          updatedAt: 30,
        },
        {
          id: "conversation-selected",
          title: "Selected and live",
          preview: "running",
          messageCount: 2,
          createdAt: 10,
          updatedAt: 15,
        },
      ],
    });

    render(<ChatTab />);

    expect(screen.getByRole("button", { name: "Selected and live conversation" }).textContent).toContain("Running");
    expect(screen.getByRole("button", { name: "Newer but idle conversation" }).textContent).not.toContain("Running");
  });

  it("creates and opens a server-backed empty conversation", async () => {
    const post = vi.fn().mockResolvedValue({ id: "conversation-created" });
    const get = vi.fn().mockResolvedValue([
      {
        id: "conversation-created",
        preview: "",
        messageCount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
    ]);
    useConnection.setState({ api: { post, get } as never });
    useHermesChat.setState({ view: "index", indexStatus: "ready", conversations: [] });

    render(<ChatTab />);
    fireEvent.click(screen.getAllByRole("button", { name: "New conversation" })[0]!);

    expect(await screen.findByRole("region", { name: "Hermes conversation" })).toBeTruthy();
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-created",
      messages: [],
    });
  });

  it("opens the selected canonical conversation and exposes a Chat breadcrumb", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "conversation-one",
      createdAt: 10,
      updatedAt: 20,
      totalCount: 1,
      messages: [
        { index: 0, role: "user", content: "persistent hello", contentTruncated: false, timestamp: 10 },
      ],
      hasMore: false,
      limit: 50,
    });
    useConnection.setState({ api: { get } as never });
    useHermesChat.setState({
      view: "index",
      indexStatus: "ready",
      conversations: [{
        id: "conversation-one",
        title: "Persistent plan",
        preview: "persistent hello",
        messageCount: 1,
        createdAt: 10,
        updatedAt: 20,
      }],
    });

    render(<ChatTab />);
    fireEvent.click(screen.getByRole("button", { name: /persistent plan conversation/i }));

    expect(await screen.findByText("persistent hello")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Chat breadcrumb" }).textContent).toContain("Persistent plan");
    expect(useHermesChat.getState().sessionId).toBe("conversation-one");
  });
});
