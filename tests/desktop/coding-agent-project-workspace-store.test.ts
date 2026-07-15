// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";

const NOW = "2026-07-10T12:00:00.000Z";

function summary(runtimeId: string, projectId: string, label: string): RuntimeSummary {
  return {
    runtime: { id: runtimeId, label: "Primary", status: "available" },
    capabilities: [
      { id: "codingAgentsProjectWorkspace", enabled: true },
      { id: "codingAgentsConversationView", enabled: true },
      { id: "codingAgentsKanbanView", enabled: true },
    ],
    providers: [],
    projects: {
      items: [{ id: projectId, label, status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 }],
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

function workspace(projectId: string, taskId: string, threadId: string): ProjectAgentWorkspace {
  return {
    project: { id: projectId, label: projectId === "matrix-os" ? "Matrix OS" : "Website", status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 },
    tasks: {
      items: [{
        id: taskId,
        projectId,
        title: "Primary task",
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
    projectThreads: { items: [], hasMore: false, limit: 100 },
    taskThreads: {
      items: [{
        id: threadId,
        providerId: "codex",
        title: "Primary chat",
        status: "running",
        attention: "none",
        projectId,
        taskId,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 100,
    },
    updatedAt: NOW,
  };
}

function resetStore(): void {
  useCodingAgentProjectWorkspace.setState({
    status: "idle",
    runtimeId: null,
    runtimeScope: null,
    summary: null,
    workspace: null,
    error: null,
    selectedProjectId: null,
    selectedTaskId: null,
    selectedThreadId: null,
    viewMode: "conversation",
  });
}

describe("coding-agent project workspace store", () => {
  beforeEach(() => {
    resetStore();
  });

  it("DT-004 reconciles stale persisted refs and writes only bounded safe UI refs", async () => {
    const matrixWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "state:get") {
        return {
          value: {
            runtimeScope: "rt_primary",
            selectedProjectId: "matrix-os",
            selectedTaskId: "task_auth",
            selectedThreadId: "thread_deleted",
            viewMode: "conversation",
            updatedAt: NOW,
          },
        };
      }
      if (channel === "runtime:get-project-workspace") return matrixWorkspace;
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}: ${JSON.stringify(payload)}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
      viewMode: "conversation",
    });
    const persisted = invoke.mock.calls.find(([channel]) => channel === "state:set")?.[1] as {
      key: string;
      value: Record<string, unknown>;
    };
    expect(persisted.key).toBe("codingAgentWorkspace");
    expect(persisted.value).toMatchObject({
      runtimeScope: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
      viewMode: "conversation",
    });
    expect(persisted.value).not.toHaveProperty("summary");
    expect(persisted.value).not.toHaveProperty("transcript");
    expect(persisted.value).not.toHaveProperty("token");
  });

  it("DT-004 drops the previous runtime selection before accepting the new runtime workspace", async () => {
    const workspaces: Record<string, ProjectAgentWorkspace> = {
      "matrix-os": workspace("matrix-os", "task_auth", "thread_plan"),
      website: workspace("website", "task_docs", "thread_docs"),
    };
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "state:get") return { value: null };
      if (channel === "runtime:get-project-workspace") {
        return workspaces[(payload as { projectId: string }).projectId];
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_secondary", "website", "Website"),
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      runtimeId: "rt_secondary",
      selectedProjectId: "website",
      selectedTaskId: "task_docs",
      selectedThreadId: "thread_docs",
    });
    expect(useCodingAgentProjectWorkspace.getState().workspace?.project.id).toBe("website");
  });

  it("does not send a persisted project id to a different account scope", async () => {
    const pagedSummary = summary("rt_primary", "website", "Website");
    pagedSummary.projects.hasMore = true;
    const websiteWorkspace = workspace("website", "task_docs", "thread_docs");
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "state:get") {
        return {
          value: {
            runtimeScope: "first-account|https://app.matrix-os.com|primary",
            selectedProjectId: "matrix-os",
            selectedTaskId: "task_auth",
            selectedThreadId: "thread_plan",
            viewMode: "conversation",
            updatedAt: NOW,
          },
        };
      }
      if (channel === "runtime:get-project-workspace") {
        expect(payload).toEqual({ projectId: "website" });
        return websiteWorkspace;
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      pagedSummary,
      "second-account|https://app.matrix-os.com|primary",
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "website",
      selectedTaskId: "task_docs",
      selectedThreadId: "thread_docs",
    });
  });

  it("does not carry an in-memory chat selection into a new account scope", async () => {
    const firstWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    const secondWorkspace = workspace("matrix-os", "task_docs", "thread_new");
    secondWorkspace.tasks.items.push({
      ...firstWorkspace.tasks.items[0]!,
    });
    secondWorkspace.taskThreads.items.push({
      ...firstWorkspace.taskThreads.items[0]!,
    });
    let workspaceRequests = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequests += 1;
        return workspaceRequests === 1 ? firstWorkspace : secondWorkspace;
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    const runtimeSummary = summary("rt_primary", "matrix-os", "Matrix OS");

    await useCodingAgentProjectWorkspace.getState().hydrate(
      runtimeSummary,
      "first-account|https://app.matrix-os.com|primary",
    );
    await useCodingAgentProjectWorkspace.getState().hydrate(
      runtimeSummary,
      "second-account|https://app.matrix-os.com|primary",
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_docs",
      selectedThreadId: "thread_new",
    });
  });

  it("restores a persisted project that is outside the bounded summary page", async () => {
    const pagedSummary = summary("rt_primary", "matrix-os", "Matrix OS");
    pagedSummary.projects.hasMore = true;
    const websiteWorkspace = workspace("website", "task_docs", "thread_docs");
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "state:get") {
        return {
          value: {
            runtimeScope: "rt_primary",
            selectedProjectId: "website",
            selectedTaskId: "task_docs",
            selectedThreadId: "thread_docs",
            viewMode: "conversation",
            updatedAt: NOW,
          },
        };
      }
      if (channel === "runtime:get-project-workspace") {
        expect(payload).toEqual({ projectId: "website" });
        return websiteWorkspace;
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(pagedSummary);

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "website",
      selectedTaskId: "task_docs",
      selectedThreadId: "thread_docs",
    });
  });

  it("preserves the same-scope workspace while routine hydration revalidates it", async () => {
    const previousWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    const nextWorkspace = workspace("matrix-os", "task_docs", "thread_docs");
    nextWorkspace.taskThreads.items[0]!.title = "Second account chat";
    let resolveReload: (value: ProjectAgentWorkspace) => void = () => undefined;
    const reload = new Promise<ProjectAgentWorkspace>((resolve) => {
      resolveReload = resolve;
    });
    let workspaceRequestCount = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequestCount += 1;
        return workspaceRequestCount === 1 ? previousWorkspace : reload;
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    const runtimeSummary = summary("rt_primary", "matrix-os", "Matrix OS");

    await useCodingAgentProjectWorkspace.getState().hydrate(runtimeSummary);
    const pendingHydration = useCodingAgentProjectWorkspace.getState().hydrate(runtimeSummary);

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "loading",
      workspace: previousWorkspace,
    });

    resolveReload(nextWorkspace);
    await pendingHydration;
    expect(useCodingAgentProjectWorkspace.getState().workspace?.taskThreads.items[0]?.title)
      .toBe("Second account chat");
  });

  it("preserves task and thread selection across a transient workspace failure", async () => {
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    let workspaceRequestCount = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequestCount += 1;
        if (workspaceRequestCount === 2) throw new Error("temporary outage");
        return projectWorkspace;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    await useCodingAgentProjectWorkspace.getState().refresh();

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "error",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
    });

    await useCodingAgentProjectWorkspace.getState().refresh();
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
    });
  });

  it("keeps the last known workspace projection when a refresh fails", async () => {
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    let workspaceRequestCount = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequestCount += 1;
        if (workspaceRequestCount === 2) throw new Error("temporary outage");
        return projectWorkspace;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    await useCodingAgentProjectWorkspace.getState().refresh();

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "error",
      error: "Project workspace unavailable",
    });
    expect(useCodingAgentProjectWorkspace.getState().workspace).toBe(projectWorkspace);
  });

  it("keeps the current board visible while a refresh is in flight", async () => {
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    let resolveReload: (value: ProjectAgentWorkspace) => void = () => undefined;
    const reload = new Promise<ProjectAgentWorkspace>((resolve) => {
      resolveReload = resolve;
    });
    let workspaceRequestCount = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequestCount += 1;
        return workspaceRequestCount === 1 ? projectWorkspace : reload;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    const pendingRefresh = useCodingAgentProjectWorkspace.getState().refresh();

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({ status: "loading" });
    expect(useCodingAgentProjectWorkspace.getState().workspace).toBe(projectWorkspace);

    resolveReload(projectWorkspace);
    await pendingRefresh;
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({ status: "ready" });
  });

  it("keeps a selection made while a refresh is in flight", async () => {
    const docsTask = {
      id: "task_docs",
      projectId: "matrix-os",
      title: "Docs task",
      status: "todo",
      priority: "normal",
      order: 1,
      threadCount: 0,
      activeThreadCount: 0,
      attentionCount: 0,
    } as const;
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    projectWorkspace.tasks.items.push({ ...docsTask });
    const refreshed = workspace("matrix-os", "task_auth", "thread_plan");
    refreshed.tasks.items.push({ ...docsTask });
    let resolveReload: (value: ProjectAgentWorkspace) => void = () => undefined;
    const reload = new Promise<ProjectAgentWorkspace>((resolve) => {
      resolveReload = resolve;
    });
    let workspaceRequestCount = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequestCount += 1;
        return workspaceRequestCount === 1 ? projectWorkspace : reload;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    const pendingRefresh = useCodingAgentProjectWorkspace.getState().refresh();
    // The retained board stays interactive during the refresh; a click made
    // now must survive the refresh settling.
    useCodingAgentProjectWorkspace.getState().selectTask("task_docs");

    resolveReload(refreshed);
    await pendingRefresh;

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_docs",
      selectedThreadId: null,
    });
  });

  it("E2E-006 reconciles an externally focused thread across project workspaces", async () => {
    const workspaces: Record<string, ProjectAgentWorkspace> = {
      "matrix-os": workspace("matrix-os", "task_auth", "thread_plan"),
      website: workspace("website", "task_docs", "thread_docs"),
    };
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "state:get") return { value: null };
      if (channel === "runtime:get-project-workspace") {
        return workspaces[(payload as { projectId: string }).projectId];
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    const runtimeSummary = summary("rt_primary", "matrix-os", "Matrix OS");
    runtimeSummary.projects.items.push({
      id: "website",
      label: "Website",
      status: "available",
      taskCount: 1,
      threadCount: 1,
      attentionCount: 0,
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(runtimeSummary);
    await useCodingAgentProjectWorkspace.getState().focusExternalThread(
      "thread_docs",
      { projectId: "website", taskId: "task_docs" },
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "website",
      selectedTaskId: "task_docs",
      selectedThreadId: "thread_docs",
    });
    expect(useCodingAgentProjectWorkspace.getState().workspace?.project.id).toBe("website");
  });

  it("selects the visible workspace project when it is outside the summary page", async () => {
    const pagedSummary = summary("rt_primary", "matrix-os", "Matrix OS");
    pagedSummary.projects.hasMore = true;
    const websiteWorkspace = workspace("website", "task_docs", "thread_docs");
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "runtime:get-project-workspace") {
        expect(payload).toEqual({ projectId: "website" });
        return websiteWorkspace;
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      runtimeId: "rt_primary",
      runtimeScope: "rt_primary",
      summary: pagedSummary,
      workspace: websiteWorkspace,
      selectedProjectId: "matrix-os",
      selectedTaskId: null,
      selectedThreadId: null,
    });

    await useCodingAgentProjectWorkspace.getState().selectProject("website");

    expect(invoke).toHaveBeenCalledWith("runtime:get-project-workspace", {
      projectId: "website",
    });
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "website",
      selectedTaskId: "task_docs",
      selectedThreadId: "thread_docs",
    });
  });

  it("keeps the selected task and chat when the active project is selected again", async () => {
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "runtime:get-project-workspace") return projectWorkspace;
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    await useCodingAgentProjectWorkspace.getState().selectProject("matrix-os");

    expect(invoke.mock.calls.filter(([channel]) => (
      channel === "runtime:get-project-workspace"
    ))).toHaveLength(1);
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
    });

    useCodingAgentProjectWorkspace.setState({ status: "error", workspace: null });
    await useCodingAgentProjectWorkspace.getState().selectProject("matrix-os");
    expect(invoke.mock.calls.filter(([channel]) => (
      channel === "runtime:get-project-workspace"
    ))).toHaveLength(2);
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
    });
  });

  it("keeps an externally focused chat selected when it is outside the bounded task chat page", async () => {
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_visible");
    projectWorkspace.taskThreads.hasMore = true;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "runtime:get-project-workspace") return projectWorkspace;
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().hydrate(
      summary("rt_primary", "matrix-os", "Matrix OS"),
    );
    await useCodingAgentProjectWorkspace.getState().focusExternalThread(
      "thread_outside_page",
      { projectId: "matrix-os", taskId: "task_auth" },
    );
    await useCodingAgentProjectWorkspace.getState().refresh();

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_outside_page",
    });
  });

  it("resolves a new chat target for a preserved out-of-page task selection", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("workspace refresh should not be requested");
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    // An externally focused conversation can select a task outside the bounded
    // tasks and taskThreads pages; selection reconciliation preserved it, so a
    // new chat for that selection must still resolve.
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      runtimeId: "rt_primary",
      runtimeScope: "rt_primary",
      summary: summary("rt_primary", "matrix-os", "Matrix OS"),
      workspace: workspace("matrix-os", "task_auth", "thread_plan"),
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_external",
      selectedThreadId: "thread_external",
    });

    const relation = await useCodingAgentProjectWorkspace.getState().resolveNewChatTarget(
      "matrix-os",
      "task_external",
    );

    expect(relation).toEqual({ projectId: "matrix-os", taskId: "task_external" });
    expect(invoke).not.toHaveBeenCalledWith("runtime:get-project-workspace", expect.anything());
  });

  it("resolves a new chat target immediately when the current workspace already lists it", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("workspace refresh should not be requested");
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      runtimeId: "rt_primary",
      runtimeScope: "rt_primary",
      summary: summary("rt_primary", "matrix-os", "Matrix OS"),
      workspace: workspace("matrix-os", "task_auth", "thread_plan"),
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
    });

    const relation = await useCodingAgentProjectWorkspace.getState().resolveNewChatTarget(
      "matrix-os",
      "task_auth",
    );

    expect(relation).toEqual({ projectId: "matrix-os", taskId: "task_auth" });
    expect(invoke).not.toHaveBeenCalledWith("runtime:get-project-workspace", expect.anything());
  });

  it("refreshes the workspace once and resolves a stale new chat target", async () => {
    const staleWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    const refreshedWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    refreshedWorkspace.tasks.items.push({
      ...refreshedWorkspace.tasks.items[0]!,
      id: "task_paged",
      title: "Paged task",
    });
    let workspaceRequests = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequests += 1;
        return refreshedWorkspace;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      runtimeId: "rt_primary",
      runtimeScope: "rt_primary",
      summary: summary("rt_primary", "matrix-os", "Matrix OS"),
      workspace: staleWorkspace,
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_paged",
      selectedThreadId: null,
    });

    const relation = await useCodingAgentProjectWorkspace.getState().resolveNewChatTarget(
      "matrix-os",
      "task_paged",
    );

    expect(workspaceRequests).toBe(1);
    expect(relation).toEqual({ projectId: "matrix-os", taskId: "task_paged" });
  });

  it("returns null after a single bounded refresh when the target stays unresolved", async () => {
    const projectWorkspace = workspace("matrix-os", "task_auth", "thread_plan");
    let workspaceRequests = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        workspaceRequests += 1;
        return projectWorkspace;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      runtimeId: "rt_primary",
      runtimeScope: "rt_primary",
      summary: summary("rt_primary", "matrix-os", "Matrix OS"),
      workspace: projectWorkspace,
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_missing",
      selectedThreadId: null,
    });

    const relation = await useCodingAgentProjectWorkspace.getState().resolveNewChatTarget(
      "matrix-os",
      "task_missing",
    );

    expect(relation).toBeNull();
    expect(workspaceRequests).toBe(1);
  });

  it("opens a freshly created project and lands the navigator on it", async () => {
    const createdSummary = summary("rt_primary", "matrix-os", "Matrix OS");
    createdSummary.projects.items.push({
      id: "desktop",
      label: "Desktop",
      status: "available",
      taskCount: 0,
      threadCount: 0,
      attentionCount: 0,
    });
    const desktopWorkspace = workspace("desktop", "task_start", "thread_start");
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") {
        expect(payload).toEqual({ projectId: "desktop" });
        return desktopWorkspace;
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().openCreatedProject(
      createdSummary,
      "desktop",
      "operator|https://app.matrix-os.com|primary",
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "ready",
      runtimeScope: "operator|https://app.matrix-os.com|primary",
      selectedProjectId: "desktop",
    });
    expect(useCodingAgentProjectWorkspace.getState().workspace?.project.id).toBe("desktop");
  });

  it("surfaces a workspace error state when opening a created project fails to load", async () => {
    const createdSummary = summary("rt_primary", "matrix-os", "Matrix OS");
    createdSummary.projects.items.push({
      id: "desktop",
      label: "Desktop",
      status: "available",
      taskCount: 0,
      threadCount: 0,
      attentionCount: 0,
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "state:get") return { value: null };
      if (channel === "state:set") return { ok: true };
      if (channel === "runtime:get-project-workspace") throw new Error("temporary outage");
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });

    await useCodingAgentProjectWorkspace.getState().openCreatedProject(
      createdSummary,
      "desktop",
      "operator|https://app.matrix-os.com|primary",
    );

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      status: "error",
      selectedProjectId: "desktop",
      error: "Project workspace unavailable",
    });
  });

  it("DT-008 switches view mode without changing project, task, or chat identity", () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      runtimeId: "rt_primary",
      runtimeScope: "operator|https://app.matrix-os.com|primary",
      summary: summary("rt_primary", "matrix-os", "Matrix OS"),
      workspace: workspace("matrix-os", "task_auth", "thread_plan"),
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
      viewMode: "conversation",
    });

    useCodingAgentProjectWorkspace.getState().setViewMode("kanban");

    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
      viewMode: "kanban",
    });
    expect(invoke).toHaveBeenCalledWith("state:set", {
      key: "codingAgentWorkspace",
      value: expect.objectContaining({
        runtimeScope: "operator|https://app.matrix-os.com|primary",
        selectedProjectId: "matrix-os",
        selectedTaskId: "task_auth",
        selectedThreadId: "thread_plan",
        viewMode: "kanban",
      }),
    });
  });
});
