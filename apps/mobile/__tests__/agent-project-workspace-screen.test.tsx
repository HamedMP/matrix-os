jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    removeItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

import React from "react";
import * as ReactNative from "react-native";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  AgentProjectList,
  AgentProjectWorkspaceScreen,
} from "../components/agents/agent-project-workspace-screen";
import { AGENT_WORKSPACE_STATE_STORAGE_KEY } from "../lib/agent-workspace-state";

const summary = {
  runtime: { id: "rt_primary", label: "Primary", status: "available" },
  capabilities: [
    { id: "codingAgentsProjectWorkspace", enabled: true },
    { id: "codingAgentsConversationView", enabled: true },
    { id: "codingAgentsKanbanView", enabled: true },
    { id: "codingAgentsThreadCreate", enabled: true },
  ],
  providers: [],
  projects: {
    items: [
      {
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 1,
        threadCount: 3,
        attentionCount: 1,
      },
      {
        id: "website",
        label: "Website",
        status: "available",
        taskCount: 0,
        threadCount: 0,
        attentionCount: 0,
      },
    ],
    hasMore: false,
    limit: 50,
  },
  activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [], hasMore: false, limit: 20 },
  terminalSessions: { items: [], hasMore: false, limit: 20 },
  previewSessions: { items: [], hasMore: false, limit: 20 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: {
    maxPromptBytes: 16_384,
    maxAttachmentCount: 8,
    maxTerminalInputBytes: 8_192,
    maxListItems: 20,
  },
  serverTime: "2026-07-10T14:00:00.000Z",
} satisfies RuntimeSummary;

const workspace = {
  project: summary.projects.items[0],
  tasks: {
    items: [{
      id: "task_auth",
      projectId: "matrix-os",
      title: "Repair authentication",
      status: "running",
      priority: "high",
      order: 0,
      threadCount: 2,
      activeThreadCount: 1,
      attentionCount: 1,
    }],
    hasMore: false,
    limit: 100,
  },
  projectThreads: {
    items: [{
      id: "thread_audit",
      providerId: "codex",
      title: "Project audit",
      status: "running",
      attention: "none",
      projectId: "matrix-os",
      createdAt: "2026-07-10T13:00:00.000Z",
      updatedAt: "2026-07-10T13:30:00.000Z",
    }],
    hasMore: false,
    limit: 100,
  },
  taskThreads: {
    items: [
      {
        id: "thread_plan",
        providerId: "codex",
        title: "Plan repair",
        status: "completed",
        attention: "none",
        projectId: "matrix-os",
        taskId: "task_auth",
        createdAt: "2026-07-10T13:00:00.000Z",
        updatedAt: "2026-07-10T13:20:00.000Z",
      },
      {
        id: "thread_fix",
        providerId: "codex",
        title: "Implement repair",
        status: "running",
        attention: "approval_required",
        projectId: "matrix-os",
        taskId: "task_auth",
        createdAt: "2026-07-10T13:05:00.000Z",
        updatedAt: "2026-07-10T13:30:00.000Z",
      },
    ],
    hasMore: false,
    limit: 100,
  },
  updatedAt: "2026-07-10T13:30:00.000Z",
} satisfies ProjectAgentWorkspace;

function clientFixture() {
  return {
    connect: jest.fn(),
    getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
    getCodingAgentProjectWorkspace: jest.fn().mockResolvedValue({ ok: true, workspace }),
  };
}

describe("mobile project-first coding-agent workspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.removeItem).mockResolvedValue(undefined);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders project-first entry rows from the bounded runtime summary", () => {
    const onOpenProject = jest.fn();
    render(<AgentProjectList summary={summary} onOpenProject={onOpenProject} />);

    fireEvent.press(screen.getByLabelText("Open project Matrix OS"));

    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("1 task · 3 conversations")).toBeTruthy();
    expect(screen.getByText("1 needs attention")).toBeTruthy();
    expect(screen.getByText("Website")).toBeTruthy();
    expect(onOpenProject).toHaveBeenCalledWith("matrix-os");
  });

  it("hydrates project chats and every independently selectable task conversation", async () => {
    const client = clientFixture();
    const onOpenThread = jest.fn();
    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={onOpenThread}
        onNewConversation={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    expect(screen.getByText("Repair authentication")).toBeTruthy();
    expect(screen.getByText("Plan repair")).toBeTruthy();
    expect(screen.getByText("Implement repair")).toBeTruthy();
    expect(screen.getByLabelText("Repair authentication, 2 conversations")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Open conversation Plan repair"));
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith({
      projectId: "matrix-os",
      taskId: "task_auth",
      threadId: "thread_plan",
    }));
    fireEvent.press(screen.getByLabelText("Open conversation Implement repair"));
    await waitFor(() => expect(onOpenThread).toHaveBeenLastCalledWith({
      projectId: "matrix-os",
      taskId: "task_auth",
      threadId: "thread_fix",
    }));
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      AGENT_WORKSPACE_STATE_STORAGE_KEY,
      expect.stringContaining('"selectedThreadId":"thread_fix"'),
    );
  });

  it("hydrates the first live project when the Chats tab has no routed project", async () => {
    const client = clientFixture();
    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId={null}
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    expect(await screen.findByText("Project audit")).toBeTruthy();
    expect(client.getCodingAgentProjectWorkspace).toHaveBeenCalledWith({ projectId: "matrix-os" });
  });

  it("opens a valid routed project that is beyond the bounded summary page", async () => {
    const requestedWorkspace: ProjectAgentWorkspace = {
      ...workspace,
      project: {
        id: "older-project",
        label: "Older Project",
        status: "available",
        taskCount: 0,
        threadCount: 0,
        attentionCount: 0,
      },
      tasks: { items: [], hasMore: false, limit: 100 },
      projectThreads: { items: [], hasMore: false, limit: 100 },
      taskThreads: { items: [], hasMore: false, limit: 100 },
    };
    const client = clientFixture();
    client.getCodingAgentRuntimeSummary.mockResolvedValue({
      ok: true,
      summary: {
        ...summary,
        projects: { ...summary.projects, hasMore: true, nextCursor: "website" },
      },
    });
    client.getCodingAgentProjectWorkspace.mockResolvedValue({ ok: true, workspace: requestedWorkspace });
    const onOpenProject = jest.fn();

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="older-project"
        onOpenProject={onOpenProject}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Open project Older Project" })).toBeTruthy();
    expect(client.getCodingAgentProjectWorkspace).toHaveBeenCalledWith({ projectId: "older-project" });
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("falls back to a live summary project only when the routed project endpoint rejects it", async () => {
    const client = clientFixture();
    client.getCodingAgentProjectWorkspace
      .mockResolvedValueOnce({ ok: false, error: "Project workspace unavailable" })
      .mockResolvedValueOnce({ ok: true, workspace });
    const onOpenProject = jest.fn();

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="stale-project"
        onOpenProject={onOpenProject}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    expect(await screen.findByText("Project audit")).toBeTruthy();
    expect(screen.getByText("The previous project was unavailable. Showing a live project instead.")).toBeTruthy();
    expect(client.getCodingAgentProjectWorkspace).toHaveBeenNthCalledWith(1, { projectId: "stale-project" });
    expect(client.getCodingAgentProjectWorkspace).toHaveBeenNthCalledWith(2, { projectId: "matrix-os" });
    expect(onOpenProject).toHaveBeenCalledWith("matrix-os");
  });

  it("loads and merges every bounded workspace list from gateway cursors", async () => {
    const firstPage: ProjectAgentWorkspace = {
      ...workspace,
      tasks: { ...workspace.tasks, hasMore: true, nextCursor: "task_auth" },
      projectThreads: { ...workspace.projectThreads, hasMore: true, nextCursor: "thread_audit" },
      taskThreads: { ...workspace.taskThreads, hasMore: true, nextCursor: "thread_fix" },
    };
    const secondPage: ProjectAgentWorkspace = {
      ...workspace,
      tasks: {
        items: [{
          ...workspace.tasks.items[0],
          id: "task_release",
          title: "Ship release",
          order: 1,
          threadCount: 1,
          activeThreadCount: 0,
          attentionCount: 0,
        }],
        hasMore: false,
        limit: 100,
      },
      projectThreads: {
        items: [{
          ...workspace.projectThreads.items[0],
          id: "thread_docs",
          title: "Write release notes",
        }],
        hasMore: false,
        limit: 100,
      },
      taskThreads: {
        items: [{
          ...workspace.taskThreads.items[0],
          id: "thread_ship",
          taskId: "task_release",
          title: "Publish candidate",
        }],
        hasMore: false,
        limit: 100,
      },
    };
    const client = clientFixture();
    client.getCodingAgentProjectWorkspace
      .mockResolvedValueOnce({ ok: true, workspace: firstPage })
      .mockResolvedValueOnce({ ok: true, workspace: secondPage });

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    fireEvent.press(await screen.findByRole("button", { name: "Load more project workspace" }));

    expect(await screen.findByText("Ship release")).toBeTruthy();
    expect(screen.getByText("Write release notes")).toBeTruthy();
    expect(screen.getByText("Publish candidate")).toBeTruthy();
    expect(client.getCodingAgentProjectWorkspace).toHaveBeenLastCalledWith({
      projectId: "matrix-os",
      taskCursor: "task_auth",
      taskLimit: 100,
      projectThreadCursor: "thread_audit",
      projectThreadLimit: 100,
      taskThreadCursor: "thread_fix",
      taskThreadLimit: 100,
    });
    expect(screen.queryByRole("button", { name: "Load more project workspace" })).toBeNull();
  });

  it("hides all chat creation affordances when the runtime disables thread creation", async () => {
    const client = clientFixture();
    client.getCodingAgentRuntimeSummary.mockResolvedValue({
      ok: true,
      summary: {
        ...summary,
        capabilities: summary.capabilities.filter(({ id }) => id !== "codingAgentsThreadCreate"),
      },
    });

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    expect(screen.queryByRole("button", { name: "New project conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation for Repair authentication" })).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Show Kanban" }));
    expect(await screen.findByTestId("kanban-phone-board")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New Kanban conversation for Repair authentication" })).toBeNull();
  });

  it("restores safe selection, drops stale child references, and refreshes on foreground", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_missing",
      selectedThreadId: "thread_missing",
      viewMode: "conversation",
      updatedAt: "2026-07-10T13:00:00.000Z",
      transcript: "must never be restored",
    }));
    let appStateListener: ((state: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove } as never;
    });
    const client = clientFixture();

    const view = render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    const firstSaved = JSON.parse(jest.mocked(AsyncStorage.setItem).mock.calls.at(-1)?.[1] ?? "{}");
    expect(firstSaved).toMatchObject({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: null,
      selectedThreadId: null,
      viewMode: "conversation",
    });
    expect(JSON.stringify(firstSaved)).not.toMatch(/transcript|events|terminalOutput|fileContents|diff|approval|token|resume/i);

    await act(async () => {
      appStateListener?.("active");
    });
    await waitFor(() => expect(client.getCodingAgentRuntimeSummary).toHaveBeenCalledTimes(2));
    expect(client.getCodingAgentProjectWorkspace).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(remove).toHaveBeenCalled();
  });

  it("keeps the specific recovery message when a refresh retains the last projection", async () => {
    let appStateListener: ((state: string) => void) | undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: jest.fn() } as never;
    });
    const client = clientFixture();
    client.getCodingAgentProjectWorkspace
      .mockResolvedValueOnce({ ok: true, workspace })
      .mockResolvedValueOnce({ ok: false, error: "Project workspace unavailable" });
    client.getCodingAgentRuntimeSummary
      .mockResolvedValueOnce({ ok: true, summary })
      .mockResolvedValueOnce({
        ok: true,
        summary: {
          ...summary,
          projects: { items: [], hasMore: false, limit: 50 },
        },
      });

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    await act(async () => {
      appStateListener?.("active");
    });

    expect(await screen.findByText("No coding projects are available.")).toBeTruthy();
    expect(screen.getByText("Project audit")).toBeTruthy();
  });

  it("keeps the last bounded projection visible while reconnecting and offers retry", async () => {
    const client = clientFixture();
    const onOpenProject = jest.fn();
    const onOpenThread = jest.fn();
    const onNewConversation = jest.fn();
    const view = render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={onOpenProject}
        onOpenThread={onOpenThread}
        onNewConversation={onNewConversation}
      />,
    );
    await screen.findByText("Project audit");

    view.rerender(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="disconnected"
        requestedProjectId="matrix-os"
        onOpenProject={onOpenProject}
        onOpenThread={onOpenThread}
        onNewConversation={onNewConversation}
      />,
    );

    expect(screen.getByText("Project audit")).toBeTruthy();
    expect(screen.getByText("Workspace offline. Showing the last refreshed project.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Retry project workspace" }));
    expect(client.connect).toHaveBeenCalled();
  });

  it("rehydrates the gateway projection after reconnecting", async () => {
    const client = clientFixture();
    const onOpenProject = jest.fn();
    const onOpenThread = jest.fn();
    const onNewConversation = jest.fn();
    const view = render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={onOpenProject}
        onOpenThread={onOpenThread}
        onNewConversation={onNewConversation}
      />,
    );
    await screen.findByText("Project audit");

    view.rerender(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="disconnected"
        requestedProjectId="matrix-os"
        onOpenProject={onOpenProject}
        onOpenThread={onOpenThread}
        onNewConversation={onNewConversation}
      />,
    );
    view.rerender(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={onOpenProject}
        onOpenThread={onOpenThread}
        onNewConversation={onNewConversation}
      />,
    );

    await waitFor(() => expect(client.getCodingAgentProjectWorkspace).toHaveBeenCalledTimes(2));
  });

  it("preserves selected project, task, and thread while switching Conversation and Kanban", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "conversation",
      updatedAt: "2026-07-10T13:00:00.000Z",
    }));
    const onViewModeChange = jest.fn();

    render(
      <AgentProjectWorkspaceScreen
        client={clientFixture() as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
        onViewModeChange={onViewModeChange}
      />,
    );

    await screen.findByText("Project audit");
    fireEvent.press(screen.getByRole("button", { name: "Show Kanban" }));

    expect(await screen.findByTestId("kanban-phone-board")).toBeTruthy();
    const kanbanSelection = JSON.parse(jest.mocked(AsyncStorage.setItem).mock.calls.at(-1)?.[1] ?? "{}");
    expect(kanbanSelection).toMatchObject({
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "kanban",
    });
    expect(onViewModeChange).toHaveBeenCalledWith("kanban");

    fireEvent.press(screen.getByRole("button", { name: "Show Conversation" }));
    expect(await screen.findByText("Project chats")).toBeTruthy();
    expect(onViewModeChange).toHaveBeenLastCalledWith("conversation");
  });

  it("renders canonical task columns and bounded aggregates without inferring status from threads", async () => {
    const canonicalWorkspace: ProjectAgentWorkspace = {
      ...workspace,
      tasks: {
        ...workspace.tasks,
        items: [{ ...workspace.tasks.items[0], status: "todo" }],
      },
    };
    const client = clientFixture();
    client.getCodingAgentProjectWorkspace.mockResolvedValue({ ok: true, workspace: canonicalWorkspace });

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
        onViewModeChange={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    fireEvent.press(screen.getByRole("button", { name: "Show Kanban" }));

    expect(await screen.findByLabelText("To do column, 1 task")).toBeTruthy();
    expect(screen.getByLabelText("Running column, 0 tasks")).toBeTruthy();
    expect(screen.getByLabelText("Repair authentication, todo, 2 conversations, 1 active, 1 needs attention")).toBeTruthy();
    expect(screen.queryByLabelText(/Archived column/)).toBeNull();
  });

  it("opens every attached task conversation from Kanban with exact identity", async () => {
    const onOpenThread = jest.fn();
    render(
      <AgentProjectWorkspaceScreen
        client={clientFixture() as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={onOpenThread}
        onNewConversation={jest.fn()}
        onViewModeChange={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    fireEvent.press(screen.getByRole("button", { name: "Show Kanban" }));
    fireEvent.press(await screen.findByLabelText("Open Kanban conversation Plan repair"));
    expect(onOpenThread).toHaveBeenCalledWith({
      projectId: "matrix-os",
      taskId: "task_auth",
      threadId: "thread_plan",
    });

    fireEvent.press(screen.getByRole("button", { name: "Show Kanban" }));
    fireEvent.press(await screen.findByLabelText("Open Kanban conversation Implement repair"));
    expect(onOpenThread).toHaveBeenLastCalledWith({
      projectId: "matrix-os",
      taskId: "task_auth",
      threadId: "thread_fix",
    });
  });

  it("uses a Kanban route as an initial seed without overriding Conversation after foregrounding", async () => {
    let appStateListener: ((state: string) => void) | undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: jest.fn() } as never;
    });
    const client = clientFixture();

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
        onViewModeChange={jest.fn()}
        routeViewMode="kanban"
      />,
    );

    fireEvent.press(await screen.findByLabelText("Open Kanban conversation Plan repair"));
    expect(await screen.findByText("Project chats")).toBeTruthy();

    await act(async () => {
      appStateListener?.("active");
    });
    await waitFor(() => expect(client.getCodingAgentProjectWorkspace).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Project chats")).toBeTruthy();
    expect(screen.queryByTestId("kanban-phone-board")).toBeNull();
  });

  it("keeps the Kanban route seed when foreground hydration races the initial safe-reference save", async () => {
    let appStateListener: ((state: string) => void) | undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: jest.fn() } as never;
    });
    let resolveFirstSave: (() => void) | undefined;
    jest.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockResolvedValue(undefined);
    const client = clientFixture();

    render(
      <AgentProjectWorkspaceScreen
        client={client as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
        onViewModeChange={jest.fn()}
        routeViewMode="kanban"
      />,
    );

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
    await act(async () => {
      appStateListener?.("active");
    });
    await waitFor(() => expect(client.getCodingAgentProjectWorkspace).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveFirstSave?.();
    });

    expect(await screen.findByTestId("kanban-phone-board")).toBeTruthy();
    const latestSelection = JSON.parse(
      jest.mocked(AsyncStorage.setItem).mock.calls.at(-1)?.[1] ?? "{}",
    );
    expect(latestSelection.viewMode).toBe("kanban");
  });

  it("uses the tablet Kanban board layout at tablet widths", async () => {
    jest.spyOn(ReactNative, "useWindowDimensions").mockReturnValue({
      width: 1024,
      height: 768,
      scale: 2,
      fontScale: 1,
    });

    render(
      <AgentProjectWorkspaceScreen
        client={clientFixture() as never}
        connectionState="connected"
        requestedProjectId="matrix-os"
        onOpenProject={jest.fn()}
        onOpenThread={jest.fn()}
        onNewConversation={jest.fn()}
        onViewModeChange={jest.fn()}
      />,
    );

    await screen.findByText("Project audit");
    fireEvent.press(screen.getByRole("button", { name: "Show Kanban" }));

    expect(await screen.findByTestId("kanban-tablet-board")).toBeTruthy();
  });
});
