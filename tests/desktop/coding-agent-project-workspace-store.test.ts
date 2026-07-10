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
});
