// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectTab from "../../desktop/src/renderer/src/features/project/ProjectTab";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { clearDraftChats } from "../../desktop/src/renderer/src/stores/draft-chat";
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
    }, {
      id: "claude",
      kind: "claude",
      displayName: "Claude",
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
    terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
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
        providerId: "claude",
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

function emptyWorkspaceFixture(): ProjectAgentWorkspace {
  const workspace = workspaceFixture();
  return {
    ...workspace,
    project: {
      ...workspace.project,
      taskCount: 0,
      threadCount: 0,
      attentionCount: 0,
    },
    tasks: { ...workspace.tasks, items: [] },
    projectThreads: { ...workspace.projectThreads, items: [] },
    taskThreads: { ...workspace.taskThreads, items: [] },
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
    if (channel === "runtime:create-thread") return threadSnapshot("thread_new");
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
  clearDraftChats();
  useBoard.setState(useBoard.getInitialState(), true);
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {} });
  useProjectChatLauncher.setState({ composerRequest: null });
  useUi.setState({ createTaskOpen: false });
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

  it("opens on the Figma sessions landing with a real composer and session rows", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    expect(screen.getAllByText("Matrix OS").length).toBeGreaterThan(0);
    expect(await screen.findByRole("heading", { name: "Matrix OS" })).toBeTruthy();
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open session Plan the auth work" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open session Harden the auth route" })).toBeTruthy();
    expect(screen.getByLabelText("Codex provider")).toBeTruthy();
    expect(screen.getByLabelText("Claude provider")).toBeTruthy();
    expect(screen.queryByText("Recent sessions")).toBeNull();
    const board = screen.getByRole("button", { name: "Board" });
    const chats = screen.getByRole("button", { name: "Chats" });
    expect(board.getAttribute("aria-pressed")).toBe("false");
    expect(chats.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Primary Matrix computer")).toBeNull();
  });

  it("shows the project attention count in the header", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    await screen.findByLabelText("Message new chat");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByLabelText("3 need attention")).toBeTruthy();
  });

  it("starts a new chat through the canonical project composer", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    const input = await screen.findByLabelText("Message new chat");
    for (const key of "Review the auth flow") {
      fireEvent.keyDown(window, { key });
    }
    await waitFor(() => expect(input.textContent).toBe("Review the auth flow"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats"));
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_new");
  });

  it("opens a recent session in the detailed Chats view", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    fireEvent.click(await screen.findByRole("button", { name: "Open session Harden the auth route" }));

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_auth");
    expect(await screen.findByRole("region", { name: "Conversation Harden the auth route" })).toBeTruthy();
  });

  it("keeps all five workflow columns visible when the board has no tasks", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    fireEvent.click(screen.getByRole("button", { name: "Board" }));

    for (const status of ["Todo", "Running", "Waiting", "Blocked", "Complete"]) {
      expect(await screen.findByRole("button", { name: `New task in ${status}` })).toBeTruthy();
    }
    expect(screen.getAllByText("No tasks")).toHaveLength(5);
  });

  it("returns from Board to the sessions landing through Chats", async () => {
    render(<ProjectTab projectSlug="matrix-os" active />);

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    await screen.findByRole("button", { name: "New task in Todo" });
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("overview");
    expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
  });

  it("refreshes provider readiness whenever a zero-history Project Chat is reactivated", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    useCodingAgentWorkspace.setState({ status: "ready", summary: summaryFixture() });
    useProjectWorkspaces.setState({
      runtimeScope: "operator|https://platform.test|primary",
      entries: {
        "matrix-os": {
          status: "ready",
          workspace: emptyWorkspaceFixture(),
          error: null,
          fetchedAt: Date.now(),
        },
      },
    });

    const { rerender } = render(<ProjectTab projectSlug="matrix-os" active={false} />);
    expect(await screen.findByText("No sessions yet. Start one above.")).toBeTruthy();
    const summaryCallsBeforeEntry = invoke.mock.calls.filter(
      ([channel]) => channel === "runtime:get-summary",
    ).length;

    rerender(<ProjectTab projectSlug="matrix-os" active />);
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-summary").length)
        .toBe(summaryCallsBeforeEntry + 1);
    });

    rerender(<ProjectTab projectSlug="matrix-os" active={false} />);
    rerender(<ProjectTab projectSlug="matrix-os" active />);
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-summary").length)
        .toBe(summaryCallsBeforeEntry + 2);
    });
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
  });

  it("keeps global task creation available when the active project opens in Chats", async () => {
    const api = { get: vi.fn() };
    const selectProject = vi.fn(async (_api: unknown, projectSlug: string) => {
      useBoard.setState({ activeProjectSlug: projectSlug });
    });
    useConnection.setState({ api: api as never });
    useBoard.setState({ activeProjectSlug: null, selectProject });
    useProjectView.setState({
      entries: {
        "matrix-os": { view: "chats", selectedThreadId: null, touchedAt: Date.now() },
      },
    });

    render(<ProjectTab projectSlug="matrix-os" active />);
    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(api, "matrix-os"));

    act(() => useUi.getState().setCreateTaskOpen(true));

    expect(await screen.findByPlaceholderText("Task title")).toBeTruthy();
    expect(useBoard.getState().activeProjectSlug).toBe("matrix-os");
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

  it("reloads a selected chat when its active id survives but its snapshot does not", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    useProjectView.getState().setSelectedThread("matrix-os", "thread_auth");
    useCodingAgentWorkspace.setState({
      summary: summaryFixture(),
      status: "ready",
      activeThreadId: "thread_auth",
      threadSnapshot: null,
      threadSnapshotStatus: "idle",
    });

    render(<ProjectChatsView projectId="matrix-os" active />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("runtime:get-thread-snapshot", { threadId: "thread_auth" });
    });
    expect(await screen.findByRole("region", { name: "Conversation Harden the auth route" })).toBeTruthy();
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

    act(() => useProjectChatLauncher.getState().requestComposer("matrix-os"));

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

  it("refreshes provider readiness when opening a new chat", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });
    const summaryRevisionBeforeNewChat = useCodingAgentWorkspace.getState().summaryRevision;
    const summaryCallsBeforeNewChat = invoke.mock.calls.filter(
      ([channel]) => channel === "runtime:get-summary",
    ).length;
    const workspaceCallsBeforeNewChat = invoke.mock.calls.filter(
      ([channel]) => channel === "runtime:get-project-workspace",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));

    expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-summary").length)
        .toBe(summaryCallsBeforeNewChat + 1);
    });
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().summaryRevision)
        .toBe(summaryRevisionBeforeNewChat + 1);
    });
    expect(invoke.mock.calls.filter(
      ([channel]) => channel === "runtime:get-project-workspace",
    )).toHaveLength(workspaceCallsBeforeNewChat);
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
  });

  it("keeps the new-chat draft selected when the project workspace is refreshed", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    render(<ProjectTab projectSlug="matrix-os" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Open session Plan the auth work" }));
    await screen.findByRole("button", { name: "Chat Plan the auth work" });
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    const workspaceCallsBeforeRefresh = invoke.mock.calls.filter(
      ([channel]) => channel === "runtime:get-project-workspace",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace").length)
        .toBe(workspaceCallsBeforeRefresh + 1);
    });
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
  });

  it("keeps a new chat selected while the provider refresh is pending", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    const originalImplementation = invoke.getMockImplementation()!;
    useCodingAgentWorkspace.setState({ status: "ready", summary: summaryFixture() });

    render(<ProjectTab projectSlug="matrix-os" active />);
    await waitFor(() => expect(useCodingAgentWorkspace.getState().status).toBe("ready"));

    let resolveProviderRefresh!: (summary: RuntimeSummary) => void;
    let deferNextSummary = true;
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "runtime:get-summary" && deferNextSummary) {
        deferNextSummary = false;
        return new Promise<RuntimeSummary>((resolve) => {
          resolveProviderRefresh = resolve;
        });
      }
      return originalImplementation(channel, payload);
    });

    try {
      fireEvent.click(await screen.findByRole("button", { name: "Open session Plan the auth work" }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));
      await waitFor(() => expect(deferNextSummary).toBe(false));

      await screen.findByRole("button", { name: "Chat Plan the auth work" });
      fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
      expect(await screen.findByLabelText("Message new chat")).toBeTruthy();

      const workspaceCallsBeforeProviderSettles = invoke.mock.calls.filter(
        ([channel]) => channel === "runtime:get-project-workspace",
      ).length;
      await act(async () => {
        resolveProviderRefresh(summaryFixture());
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace").length)
          .toBe(workspaceCallsBeforeProviderSettles + 1);
      });

      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
      expect(screen.getByLabelText("Message new chat")).toBeTruthy();
    } finally {
      invoke.mockImplementation(originalImplementation);
    }
  });

  it("keeps a new chat selected while the project workspace refresh is pending", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    const originalImplementation = invoke.getMockImplementation()!;
    useCodingAgentWorkspace.setState({ status: "ready", summary: summaryFixture() });

    render(<ProjectTab projectSlug="matrix-os" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Open session Plan the auth work" }));
    await screen.findByRole("button", { name: "Chat Plan the auth work" });

    let resolveWorkspaceRefresh!: (workspace: ProjectAgentWorkspace) => void;
    let deferNextWorkspace = true;
    invoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === "runtime:get-project-workspace" && deferNextWorkspace) {
        deferNextWorkspace = false;
        return new Promise<ProjectAgentWorkspace>((resolve) => {
          resolveWorkspaceRefresh = resolve;
        });
      }
      return originalImplementation(channel, payload);
    });

    try {
      fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));
      await waitFor(() => expect(deferNextWorkspace).toBe(false));

      fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
      expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
      await act(async () => {
        resolveWorkspaceRefresh(workspaceFixture());
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(useProjectWorkspaces.getState().entries["matrix-os"]?.status).toBe("ready");
      });

      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
      expect(screen.getByLabelText("Message new chat")).toBeTruthy();
    } finally {
      invoke.mockImplementation(originalImplementation);
    }
  });

  it("keeps Board unselected across refresh and returns Chats to the sessions landing", async () => {
    const invoke = window.operator.invoke as ReturnType<typeof vi.fn>;
    render(<ProjectTab projectSlug="matrix-os" active />);
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    await screen.findByText("Primary Matrix computer");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    const workspaceCallsBeforeRefresh = invoke.mock.calls.filter(
      ([channel]) => channel === "runtime:get-project-workspace",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace").length)
        .toBe(workspaceCallsBeforeRefresh + 1);
    });
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("overview");
    expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
  });

  it("keeps a compose request pending until runtime capabilities finish loading", async () => {
    useCodingAgentWorkspace.setState({ status: "loading", summary: null });
    useProjectChatLauncher.getState().requestComposer("matrix-os");

    render(<ProjectChatsView projectId="matrix-os" active />);
    await act(async () => Promise.resolve());

    expect(useProjectChatLauncher.getState().composerRequest?.projectId).toBe("matrix-os");

    act(() => useCodingAgentWorkspace.setState({ status: "ready", summary: summaryFixture() }));

    await waitFor(() => expect(useProjectChatLauncher.getState().composerRequest).toBeNull());
    expect(await screen.findByLabelText("Message new chat")).toBeTruthy();
  });

  it("ignores a pending compose request after the project chat view unmounts", async () => {
    let resolveTarget!: (value: { projectId: string }) => void;
    const resolveNewChatTarget = vi.fn(() => new Promise<{ projectId: string }>((resolve) => {
      resolveTarget = resolve;
    }));
    useProjectWorkspaces.setState({ resolveNewChatTarget });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });
    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;

    act(() => useProjectChatLauncher.getState().requestComposer("matrix-os"));
    await waitFor(() => expect(resolveNewChatTarget).toHaveBeenCalledWith("matrix-os", undefined));
    cleanup();
    await act(async () => {
      resolveTarget({ projectId: "matrix-os" });
      await Promise.resolve();
    });

    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId);
  });

  it("ignores compose requests for another project", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });

    act(() => useProjectChatLauncher.getState().requestComposer("website"));

    expect(screen.queryByLabelText("Message new chat")).toBeNull();
    expect(useProjectChatLauncher.getState().composerRequest?.projectId).toBe("website");
  });

  it("shows the hero empty state until a chat is selected", async () => {
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Chat Plan the auth work" });
    act(() => useProjectView.getState().setSelectedThread("matrix-os", null));

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
