// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectTab from "../../desktop/src/renderer/src/features/project/ProjectTab";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";

const NOW = "2026-07-12T12:00:00.000Z";

function summaryFixture({ projectWorkspace = true }: { projectWorkspace?: boolean } = {}): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsThreadCreate", enabled: true },
      { id: "codingAgentsSameThreadTurns", enabled: true },
      { id: "codingAgentsReview", enabled: true },
      ...(projectWorkspace ? [{ id: "codingAgentsProjectWorkspace", enabled: true }] : []),
    ],
    providers: [{
      id: "codex",
      kind: "codex",
      displayName: "Codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default"],
      defaultMode: "default",
      setupActions: [],
    }],
    projects: {
      items: [{ id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 2, attentionCount: 3 }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function workspaceFixture(): ProjectAgentWorkspace {
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 },
    tasks: {
      items: [{
        id: "task_auth",
        projectId: "matrix-os",
        title: "Auth hardening",
        status: "todo",
        priority: "normal",
        order: 0,
        threadCount: 1,
        activeThreadCount: 1,
        attentionCount: 0,
      }],
      hasMore: false,
      limit: 100,
    },
    projectThreads: {
      items: [{
        id: "thread_plan",
        providerId: "codex",
        title: "Plan the auth work",
        status: "running",
        attention: "none",
        projectId: "matrix-os",
        createdAt: NOW,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 100,
    },
    taskThreads: {
      items: [{
        id: "thread_auth",
        providerId: "codex",
        title: "Harden the auth route",
        status: "running",
        attention: "none",
        projectId: "matrix-os",
        taskId: "task_auth",
        createdAt: NOW,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 100,
    },
    updatedAt: NOW,
  };
}

function threadSnapshot(threadId: string) {
  return {
    thread: {
      id: threadId,
      providerId: "codex",
      title: threadId === "thread_plan" ? "Plan the auth work" : "Harden the auth route",
      status: "running",
      attention: "none",
      projectId: "matrix-os",
      createdAt: NOW,
      updatedAt: NOW,
    },
    events: { items: [], hasMore: false, limit: 200 },
  };
}

function mockOperator(summary: RuntimeSummary = summaryFixture()) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summary;
    if (channel === "runtime:get-reviews") return { items: [], hasMore: false, limit: 50 };
    if (channel === "runtime:get-notification-preferences") {
      return { attentionPush: { approval: true, input: true, failed: true, completed: true } };
    }
    if (channel === "runtime:get-project-workspace") return workspaceFixture();
    if (channel === "runtime:get-thread-snapshot") {
      return threadSnapshot((payload as { threadId: string }).threadId);
    }
    if (channel === "state:get") return { value: null };
    if (channel === "state:set") return { ok: true };
    if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
      return { ok: true };
    }
    throw new Error(`unexpected channel ${channel}: ${JSON.stringify(payload)}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return invoke;
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function resetStores() {
  useBoard.setState(useBoard.getInitialState(), true);
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {} });
  useProjectChatLauncher.setState({ composerRequest: null });
  useCodingAgentWorkspace.setState({
    status: "idle",
    summary: null,
    summaryRevision: 0,
    error: null,
    reviewsStatus: "idle",
    reviews: null,
    reviewsError: null,
    threadSnapshotStatus: "idle",
    threadSnapshot: null,
    threadSnapshotError: null,
    activeThreadId: null,
    notificationPreferencesStatus: "idle",
    notificationPreferences: null,
    createStatus: "idle",
    createError: null,
  });
  useConnection.setState({
    status: "signed-in",
    handle: "operator",
    platformHost: "https://platform.test",
    runtimeSlot: "primary",
    api: null,
  });
}

describe("ProjectTab", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    resetStores();
    mockOperator();
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }],
      cardsByProject: { "matrix-os": [] },
      firstLoadByProject: { "matrix-os": false },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the project header with the runtime status and defaults to the board view", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    expect(screen.getByText("Matrix OS")).toBeTruthy();
    // The board is the default project view.
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    const board = screen.getByRole("button", { name: "Board" });
    const chats = screen.getByRole("button", { name: "Chats" });
    expect(board.getAttribute("aria-pressed")).toBe("true");
    expect(chats.getAttribute("aria-pressed")).toBe("false");
    // Runtime status stays visible in the project workspace header.
    expect(await screen.findByText("Primary")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh agent workspace" })).toBeTruthy();
  });

  it("shows the project attention count in the header", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    await screen.findByText("No tasks yet");
    expect(screen.getByLabelText("3 need attention")).toBeTruthy();
  });

  it("switches to the chats view and persists the choice per project", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    // The project chats list replaces the board.
    expect(await screen.findByRole("button", { name: "Chat Plan the auth work" })).toBeTruthy();
    expect(screen.queryByText("No tasks yet")).toBeNull();
    // The board view choice survives a remount.
    cleanup();
    render(<ProjectTab projectSlug="matrix-os" active />);
    expect((await screen.findAllByRole("button", { name: "Chats" }))[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("loads the project workspace and auto-selects the first chat", async () => {
    const invoke = mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    // The first listed chat becomes the selected conversation.
    expect(await screen.findByRole("button", { name: "Chat Plan the auth work" })).toBeTruthy();
    await waitFor(() => {
      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_plan");
    });
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_plan");
      expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.id).toBe("thread_plan");
    });
    expect(invoke).toHaveBeenCalledWith("runtime:get-project-workspace", { projectId: "matrix-os" });
  });

  it("opens a chat from the list inside the project context", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);

    const row = await screen.findByRole("button", { name: "Chat Harden the auth route" });
    fireEvent.click(row);

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_auth");
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.id).toBe("thread_auth");
    });
  });

  it("groups task chats under their task and offers per-task new chat", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByText("Auth hardening")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat in Matrix OS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat for Auth hardening" })).toBeTruthy();
  });

  it("opens the draft composer for this project when a compose request arrives", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });

    useProjectChatLauncher.getState().requestComposer("matrix-os");

    // The request is consumed and the draft composer replaces the selected
    // conversation in place.
    await waitFor(() => {
      expect(useProjectChatLauncher.getState().composerRequest).toBeNull();
    });
    expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
    await waitFor(() => {
      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    });
  });

  it("ignores compose requests for another project", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });

    useProjectChatLauncher.getState().requestComposer("website");

    expect(screen.queryByLabelText("Message new chat")).toBeNull();
    expect(useProjectChatLauncher.getState().composerRequest?.projectId).toBe("website");
  });

  it("shows the hero empty state until a chat is selected", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });
    useProjectView.getState().setSelectedThread("matrix-os", null);

    // The hero replaces the conversation pane; the rail keeps its chats.
    expect(await screen.findByText("What should we work on?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chat Plan the auth work" })).toBeTruthy();
  });

  it("keeps working from the runtime summary when the project workspace capability is off", async () => {
    const summary = summaryFixture({ projectWorkspace: false });
    summary.activeThreads.items = [{
      id: "thread_alpha",
      providerId: "codex",
      title: "Fix settings route",
      status: "running",
      attention: "none",
      projectId: "matrix-os",
      createdAt: NOW,
      updatedAt: NOW,
    }];
    mockOperator(summary);
    render(<ProjectChatsView projectId="matrix-os" active />);

    // Threads still list from the runtime summary projection…
    expect(await screen.findByRole("button", { name: "Chat Fix settings route" })).toBeTruthy();
    // …and no project-workspace load was attempted.
    expect(
      (window.operator.invoke as ReturnType<typeof vi.fn>).mock.calls
        .some(([channel]) => channel === "runtime:get-project-workspace"),
    ).toBe(false);
  });

  it("surfaces a safe error when the project workspace cannot load", async () => {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "runtime:get-summary") return summaryFixture();
          if (channel === "runtime:get-reviews") return { items: [], hasMore: false, limit: 50 };
          if (channel === "runtime:get-notification-preferences") {
            return { attentionPush: { approval: true, input: true, failed: true, completed: true } };
          }
          if (channel === "runtime:get-project-workspace") throw new Error("boom");
          if (channel === "state:get") return { value: null };
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByText("Project workspace unavailable")).toBeTruthy();
  });
});
