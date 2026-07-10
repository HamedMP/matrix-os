// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadSnapshot, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { AgentProjectWorkspaceShell } from "../../desktop/src/renderer/src/features/coding-agents/AgentProjectWorkspaceShell";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const NOW = "2026-07-10T12:00:00.000Z";

function thread(id: string, projectId: string) {
  return {
    id,
    providerId: "codex",
    title: id === "thread_project" ? "Project chat" : "External chat",
    status: "completed" as const,
    attention: "completed" as const,
    projectId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function snapshot(id: string, projectId: string): AgentThreadSnapshot {
  return {
    thread: thread(id, projectId),
    events: { items: [], hasMore: false, limit: 200 },
  };
}

function summary(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsProjectWorkspace", enabled: true }],
    providers: [],
    projects: {
      items: [
        { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 1, attentionCount: 0 },
        { id: "website", label: "Website", status: "available", taskCount: 0, threadCount: 1, attentionCount: 0 },
      ],
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16_384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8_192,
      maxListItems: 20,
    },
    serverTime: NOW,
  };
}

function workspace(): ProjectAgentWorkspace {
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 1, attentionCount: 0 },
    tasks: { items: [], hasMore: false, limit: 100 },
    projectThreads: { items: [thread("thread_project", "matrix-os")], hasMore: false, limit: 100 },
    taskThreads: { items: [], hasMore: false, limit: 100 },
    updatedAt: NOW,
  };
}

function resetStores(): void {
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
  useCodingAgentWorkspace.setState({
    activeThreadId: null,
    threadSnapshotStatus: "idle",
    threadSnapshot: null,
    threadSnapshotError: null,
  });
  useConnection.setState({
    status: "signed-in",
    handle: "operator",
    runtimeSlot: "primary",
  });
}

describe("AgentProjectWorkspaceShell", () => {
  beforeEach(resetStores);
  afterEach(cleanup);

  it("rehydrates the project projection when the account scope changes", async () => {
    const projectWorkspace = workspace();
    const invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "state:get") return Promise.resolve({ value: null });
      if (channel === "state:set") return Promise.resolve({ ok: true });
      if (channel === "runtime:get-project-workspace") return Promise.resolve(projectWorkspace);
      if (channel === "runtime:get-thread-snapshot") {
        return Promise.resolve(snapshot((payload as { threadId: string }).threadId, "matrix-os"));
      }
      if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    window.operator = { invoke, on: vi.fn(() => () => undefined) };

    render(
      <AgentProjectWorkspaceShell summary={summary()} onNewChat={vi.fn()}>
        <div>Workspace</div>
      </AgentProjectWorkspaceShell>,
    );
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace"))
        .toHaveLength(1);
    });

    act(() => {
      useConnection.setState({ handle: "second-account" });
    });

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace"))
        .toHaveLength(2);
    });
  });

  it("clears prior-scope thread details when the next account workspace fails", async () => {
    const projectWorkspace = workspace();
    let workspaceRequests = 0;
    const invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "state:get") return Promise.resolve({ value: null });
      if (channel === "state:set") return Promise.resolve({ ok: true });
      if (channel === "runtime:get-project-workspace") {
        workspaceRequests += 1;
        return workspaceRequests === 1
          ? Promise.resolve(projectWorkspace)
          : Promise.reject(new Error("workspace unavailable"));
      }
      if (channel === "runtime:get-thread-snapshot") {
        return Promise.resolve(snapshot((payload as { threadId: string }).threadId, "matrix-os"));
      }
      if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    window.operator = { invoke, on: vi.fn(() => () => undefined) };

    render(
      <AgentProjectWorkspaceShell summary={summary()} onNewChat={vi.fn()}>
        <div>Workspace</div>
      </AgentProjectWorkspaceShell>,
    );
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_project");
    });

    act(() => {
      useConnection.setState({ handle: "second-account" });
    });

    await waitFor(() => {
      expect(useCodingAgentProjectWorkspace.getState().status).toBe("error");
      expect(useCodingAgentProjectWorkspace.getState().selectedThreadId).toBeNull();
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBeNull();
      expect(useCodingAgentWorkspace.getState().threadSnapshot).toBeNull();
    });
  });

  it("does not retry a failed external-thread focus until another focus event", async () => {
    const projectWorkspace = workspace();
    let websiteRequests = 0;
    const neverSettles = new Promise<ProjectAgentWorkspace>(() => undefined);
    const invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "state:get") return Promise.resolve({ value: null });
      if (channel === "state:set") return Promise.resolve({ ok: true });
      if (channel === "runtime:get-project-workspace") {
        if ((payload as { projectId: string }).projectId === "website") {
          websiteRequests += 1;
          return websiteRequests === 1
            ? Promise.reject(new Error("workspace unavailable"))
            : neverSettles;
        }
        return Promise.resolve(projectWorkspace);
      }
      if (channel === "runtime:get-thread-snapshot") {
        return Promise.resolve(snapshot((payload as { threadId: string }).threadId, "matrix-os"));
      }
      if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    window.operator = { invoke, on: vi.fn(() => () => undefined) };

    render(
      <AgentProjectWorkspaceShell summary={summary()} onNewChat={vi.fn()}>
        <div>Workspace</div>
      </AgentProjectWorkspaceShell>,
    );
    await waitFor(() => {
      expect(useCodingAgentProjectWorkspace.getState().status).toBe("ready");
    });

    act(() => {
      useCodingAgentWorkspace.setState({
        activeThreadId: "thread_external",
        threadSnapshotStatus: "ready",
        threadSnapshot: snapshot("thread_external", "website"),
      });
    });
    await waitFor(() => {
      expect(websiteRequests).toBeGreaterThanOrEqual(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(websiteRequests).toBe(1);
  });

  it("focuses an external thread once its delayed snapshot provides project context", async () => {
    const projectWorkspace = workspace();
    const websiteWorkspace: ProjectAgentWorkspace = {
      ...projectWorkspace,
      project: {
        id: "website",
        label: "Website",
        status: "available",
        taskCount: 0,
        threadCount: 1,
        attentionCount: 0,
      },
      projectThreads: {
        items: [thread("thread_external", "website")],
        hasMore: false,
        limit: 100,
      },
    };
    let websiteRequests = 0;
    const invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "state:get") return Promise.resolve({ value: null });
      if (channel === "state:set") return Promise.resolve({ ok: true });
      if (channel === "runtime:get-project-workspace") {
        if ((payload as { projectId: string }).projectId === "website") {
          websiteRequests += 1;
          return Promise.resolve(websiteWorkspace);
        }
        return Promise.resolve(projectWorkspace);
      }
      if (channel === "runtime:get-thread-snapshot") {
        return Promise.resolve(snapshot((payload as { threadId: string }).threadId, "matrix-os"));
      }
      if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    window.operator = { invoke, on: vi.fn(() => () => undefined) };

    render(
      <AgentProjectWorkspaceShell summary={summary()} onNewChat={vi.fn()}>
        <div>Workspace</div>
      </AgentProjectWorkspaceShell>,
    );
    await waitFor(() => {
      expect(useCodingAgentProjectWorkspace.getState().status).toBe("ready");
    });

    act(() => {
      useCodingAgentWorkspace.setState({
        activeThreadId: "thread_external",
        threadSnapshotStatus: "loading",
        threadSnapshot: null,
      });
    });
    expect(websiteRequests).toBe(0);

    act(() => {
      useCodingAgentWorkspace.setState({
        threadSnapshotStatus: "ready",
        threadSnapshot: snapshot("thread_external", "website"),
      });
    });

    await waitFor(() => {
      expect(websiteRequests).toBe(1);
      expect(useCodingAgentProjectWorkspace.getState().selectedProjectId).toBe("website");
      expect(useCodingAgentProjectWorkspace.getState().selectedThreadId).toBe("thread_external");
    });
  });

  it("clears stale thread details when selecting a project workspace that fails", async () => {
    const projectWorkspace = workspace();
    const invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "state:get") return Promise.resolve({ value: null });
      if (channel === "state:set") return Promise.resolve({ ok: true });
      if (channel === "runtime:get-project-workspace") {
        return (payload as { projectId: string }).projectId === "website"
          ? Promise.reject(new Error("workspace unavailable"))
          : Promise.resolve(projectWorkspace);
      }
      if (channel === "runtime:get-thread-snapshot") {
        return Promise.resolve(snapshot((payload as { threadId: string }).threadId, "matrix-os"));
      }
      if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    window.operator = { invoke, on: vi.fn(() => () => undefined) };

    render(
      <AgentProjectWorkspaceShell summary={summary()} onNewChat={vi.fn()}>
        <div>Workspace</div>
      </AgentProjectWorkspaceShell>,
    );
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_project");
    });

    await act(async () => {
      await useCodingAgentProjectWorkspace.getState().selectProject("website");
    });

    expect(useCodingAgentProjectWorkspace.getState().status).toBe("error");
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBeNull();
      expect(useCodingAgentWorkspace.getState().threadSnapshot).toBeNull();
    });
  });
});
