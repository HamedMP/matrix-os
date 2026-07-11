// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  AgentKanbanBoard,
  AgentWorkspaceViewSwitch,
} from "../../desktop/src/renderer/src/features/coding-agents/AgentKanbanBoard";
import { AgentKanbanWorkspace } from "../../desktop/src/renderer/src/features/coding-agents/AgentKanbanWorkspace";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const NOW = "2026-07-10T12:00:00.000Z";

function thread(id: string, taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    providerId: "codex",
    title: id === "thread_one" ? "Implement the route" : "Add regression coverage",
    status: "completed" as const,
    attention: "completed" as const,
    projectId: "matrix-os",
    taskId,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspace(): ProjectAgentWorkspace {
  return {
    project: {
      id: "matrix-os",
      label: "Matrix OS",
      status: "available",
      taskCount: 3,
      threadCount: 2,
      attentionCount: 1,
    },
    tasks: {
      items: [
        {
          id: "task_auth",
          projectId: "matrix-os",
          title: "Desktop auth",
          status: "todo",
          priority: "high",
          order: 2,
          threadCount: 2,
          activeThreadCount: 1,
          attentionCount: 1,
          latestThreadAt: NOW,
        },
        {
          id: "task_release",
          projectId: "matrix-os",
          title: "Release checks",
          status: "complete",
          priority: "normal",
          order: 1,
          threadCount: 0,
          activeThreadCount: 0,
          attentionCount: 0,
        },
        {
          id: "task_archived",
          projectId: "matrix-os",
          title: "Archived task",
          status: "archived",
          priority: "low",
          order: 0,
          threadCount: 0,
          activeThreadCount: 0,
          attentionCount: 0,
        },
      ],
      hasMore: false,
      limit: 100,
    },
    projectThreads: { items: [], hasMore: false, limit: 100 },
    taskThreads: {
      items: [thread("thread_one", "task_auth"), thread("thread_two", "task_auth")],
      hasMore: false,
      limit: 100,
    },
    updatedAt: NOW,
  };
}

const providers: RuntimeSummary["providers"] = [{
  id: "codex",
  kind: "codex",
  displayName: "Codex",
  availability: "available",
  installStatus: "installed",
  authStatus: "authenticated",
  supportedModes: ["default"],
  defaultMode: "default",
  setupActions: [],
}];

describe("AgentKanbanBoard", () => {
  afterEach(cleanup);

  it("renders canonical columns, hides archived tasks, and exposes bounded aggregates", () => {
    render(
      <AgentKanbanBoard
        workspace={workspace()}
        providers={providers}
        selectedTaskId="task_auth"
        selectedThreadId="thread_one"
        canMoveTasks
        movingTaskId={null}
        mutationError={null}
        onSelectTask={vi.fn()}
        onOpenThread={vi.fn()}
        onMoveTask={vi.fn()}
      />,
    );

    for (const label of ["Todo", "Running", "Waiting", "Blocked", "Complete"]) {
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
    }
    expect(screen.queryByText("Archived task")).toBeNull();
    expect(screen.getByText("2 chats")).toBeTruthy();
    expect(screen.getByText("1 active")).toBeTruthy();
    expect(screen.getByText("1 needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open chat Implement the route" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open chat Add regression coverage" })).toBeTruthy();
  });

  it("opens either attached chat and moves only through the explicit canonical task action", () => {
    const onSelectTask = vi.fn();
    const onOpenThread = vi.fn();
    const onMoveTask = vi.fn();
    render(
      <AgentKanbanBoard
        workspace={workspace()}
        providers={providers}
        selectedTaskId="task_release"
        selectedThreadId="thread_one"
        canMoveTasks
        movingTaskId={null}
        mutationError={null}
        onSelectTask={onSelectTask}
        onOpenThread={onOpenThread}
        onMoveTask={onMoveTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open chat Add regression coverage" }));
    expect(onSelectTask).toHaveBeenCalledWith("task_auth");
    expect(onOpenThread).toHaveBeenCalledWith("thread_two");

    fireEvent.change(screen.getByLabelText("Move Desktop auth"), {
      target: { value: "blocked" },
    });
    expect(onMoveTask).toHaveBeenCalledWith("task_auth", "blocked", 2);
  });

  it("does not move a task when only an attached thread status changes", () => {
    const onMoveTask = vi.fn();
    const view = render(
      <AgentKanbanBoard
        workspace={workspace()}
        providers={providers}
        selectedTaskId="task_auth"
        selectedThreadId="thread_one"
        canMoveTasks
        movingTaskId={null}
        mutationError={null}
        onSelectTask={vi.fn()}
        onOpenThread={vi.fn()}
        onMoveTask={onMoveTask}
      />,
    );
    const updated = workspace();
    updated.taskThreads.items[0] = thread("thread_one", "task_auth", {
      status: "running",
      attention: "approval_required",
    });

    view.rerender(
      <AgentKanbanBoard
        workspace={updated}
        providers={providers}
        selectedTaskId="task_auth"
        selectedThreadId="thread_one"
        canMoveTasks
        movingTaskId={null}
        mutationError={null}
        onSelectTask={vi.fn()}
        onOpenThread={vi.fn()}
        onMoveTask={onMoveTask}
      />,
    );

    expect(onMoveTask).not.toHaveBeenCalled();
  });
});

describe("AgentKanbanWorkspace", () => {
  afterEach(() => {
    cleanup();
    useBoard.setState(useBoard.getInitialState(), true);
    useCodingAgentProjectWorkspace.setState(
      useCodingAgentProjectWorkspace.getInitialState(),
      true,
    );
    useConnection.setState(useConnection.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("contains projection refresh failures after a successful canonical task move", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("private upstream detail"));
    const moveTask = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useConnection.setState({ api: {} as ApiClient });
    useCodingAgentProjectWorkspace.setState({
      workspace: workspace(),
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_one",
      refresh,
    });
    useBoard.setState({
      cardsByProject: {
        "matrix-os": workspace().tasks.items.map((task) => ({
          id: task.id,
          projectSlug: task.projectId,
          title: task.title,
          description: "",
          status: task.status,
          priority: task.priority,
          order: task.order,
          parentTaskId: null,
          linkedSessionId: null,
          linkedWorktreeId: null,
          previewIds: [],
          tags: [],
          updatedAt: null,
          revision: null,
        })),
      },
      selectProject: vi.fn().mockResolvedValue(undefined),
      moveTask,
      error: null,
    });

    render(<AgentKanbanWorkspace providers={providers} />);
    fireEvent.change(screen.getByLabelText("Move Desktop auth"), {
      target: { value: "blocked" },
    });

    await waitFor(() => expect(moveTask).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[coding-agents] project workspace refresh failed after task move (Error)",
    ));
  });
});

describe("AgentWorkspaceViewSwitch", () => {
  afterEach(cleanup);

  it("switches modes without owning or rewriting project, task, or thread identity", () => {
    const onChange = vi.fn();
    render(<AgentWorkspaceViewSwitch viewMode="conversation" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));

    expect(onChange).toHaveBeenCalledWith("kanban");
  });
});
