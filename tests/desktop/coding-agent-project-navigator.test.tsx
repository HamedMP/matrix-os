// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { AgentProjectNavigator } from "../../desktop/src/renderer/src/features/coding-agents/AgentProjectNavigator";

const NOW = "2026-07-10T12:00:00.000Z";

function summaryFixture(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsProjectWorkspace", enabled: true }],
    providers: [],
    projects: {
      items: [
        { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 3, attentionCount: 0 },
        { id: "website", label: "Website", status: "available", taskCount: 1, threadCount: 1, attentionCount: 1 },
      ],
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
  const baseThread = {
    providerId: "codex",
    status: "running" as const,
    attention: "none" as const,
    projectId: "matrix-os",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 3, attentionCount: 0 },
    tasks: {
      items: [{
        id: "task_auth",
        projectId: "matrix-os",
        title: "Harden authentication",
        status: "running",
        priority: "high",
        order: 0,
        threadCount: 2,
        activeThreadCount: 2,
        attentionCount: 0,
      }],
      hasMore: false,
      limit: 100,
    },
    projectThreads: {
      items: [{ ...baseThread, id: "thread_audit", title: "Audit architecture" }],
      hasMore: false,
      limit: 100,
    },
    taskThreads: {
      items: [
        { ...baseThread, id: "thread_plan", taskId: "task_auth", title: "Plan auth changes" },
        { ...baseThread, id: "thread_fix", taskId: "task_auth", title: "Implement auth changes" },
      ],
      hasMore: false,
      limit: 100,
    },
    updatedAt: NOW,
  };
}

afterEach(cleanup);

describe("AgentProjectNavigator", () => {
  it("offers recovery by creating a project when the selected computer is empty", () => {
    const onNewProject = vi.fn();
    const emptySummary = summaryFixture();
    emptySummary.projects.items = [];
    render(
      <AgentProjectNavigator
        summary={emptySummary}
        workspace={null}
        status="ready"
        selectedProjectId={null}
        selectedTaskId={null}
        selectedThreadId={null}
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
        onNewProject={onNewProject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(onNewProject).toHaveBeenCalledOnce();
  });

  it("offers provider recovery through Settings", () => {
    const onOpenSettings = vi.fn();
    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId={null}
        selectedThreadId={null}
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open agent settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("creates Matrix projects from the Agents navigator", () => {
    const onNewProject = vi.fn();
    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId={null}
        selectedThreadId={null}
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
        onNewProject={onNewProject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(onNewProject).toHaveBeenCalledOnce();
  });

  it("DT-001 renders every bounded project from the trusted projection", () => {
    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId={null}
        selectedThreadId={null}
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project Website" })).toBeTruthy();
  });

  it("DT-002 renders two task chats as independently selectable rows", () => {
    const onSelectThread = vi.fn();
    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId="task_auth"
        selectedThreadId="thread_plan"
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={onSelectThread}
        onNewChat={vi.fn()}
      />,
    );

    const taskGroup = screen.getByRole("group", { name: "Task Harden authentication" });
    fireEvent.click(within(taskGroup).getByRole("button", { name: "Chat Plan auth changes" }));
    fireEvent.click(within(taskGroup).getByRole("button", { name: "Chat Implement auth changes" }));

    expect(onSelectThread).toHaveBeenNthCalledWith(1, "thread_plan");
    expect(onSelectThread).toHaveBeenNthCalledWith(2, "thread_fix");
  });

  it("DT-003 keeps project chats outside task groups and targets new chat context", () => {
    const onNewChat = vi.fn();
    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId={null}
        selectedThreadId="thread_audit"
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={onNewChat}
      />,
    );

    const projectChats = screen.getByRole("group", { name: "Project chats" });
    expect(within(projectChats).getByRole("button", { name: "Chat Audit architecture" })).toBeTruthy();
    expect(within(projectChats).queryByText("Plan auth changes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat for Harden authentication" }));
    expect(onNewChat).toHaveBeenNthCalledWith(1, "matrix-os");
    expect(onNewChat).toHaveBeenNthCalledWith(2, "matrix-os", "task_auth");
  });

  it("keeps returned conversations visible when their task is outside the bounded task page", () => {
    const workspace = workspaceFixture();
    workspace.tasks.hasMore = true;
    workspace.taskThreads.items.push({
      ...workspace.taskThreads.items[0]!,
      id: "thread_hidden_task",
      taskId: "task_outside_page",
      title: "Continue paged task",
    });

    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspace}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId={null}
        selectedThreadId={null}
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );

    expect(within(screen.getByRole("group", { name: "Other task conversations" }))
      .getByRole("button", { name: "Chat Continue paged task" })).toBeTruthy();
  });

  it("renders the latest gateway thread snapshot over a cached workspace row", () => {
    const workspace = workspaceFixture();
    const liveThread = {
      ...workspace.taskThreads.items[0]!,
      status: "completed" as const,
      attention: "completed" as const,
      updatedAt: "2026-07-10T12:01:00.000Z",
    };

    render(
      <AgentProjectNavigator
        summary={summaryFixture()}
        workspace={workspace}
        liveThread={liveThread}
        status="ready"
        selectedProjectId="matrix-os"
        selectedTaskId="task_auth"
        selectedThreadId="thread_plan"
        onSelectProject={vi.fn()}
        onSelectTask={vi.fn()}
        onSelectThread={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );

    const row = screen.getByRole("button", { name: "Chat Plan auth changes" });
    expect(within(row).getByText("Done")).toBeTruthy();
    expect(within(row).queryByText("Working")).toBeNull();
  });
});
