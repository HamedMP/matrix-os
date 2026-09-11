// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  formatRelativeTime,
  buildProjectThreadListModel,
  ProjectThreadList,
  threadRailStatus,
} from "../../desktop/src/renderer/src/features/project/ProjectThreadList";

const NOW_MS = Date.parse("2026-07-15T12:00:00.000Z");

function thread(overrides: Partial<AgentThreadSummary>): AgentThreadSummary {
  return {
    id: "thread_x",
    providerId: "codex",
    title: "Some chat",
    status: "running",
    attention: "none",
    createdAt: "2026-07-15T11:00:00.000Z",
    updatedAt: "2026-07-15T11:55:00.000Z",
    ...overrides,
  } as AgentThreadSummary;
}

describe("threadRailStatus", () => {
  it("maps active execution to running", () => {
    for (const status of ["queued", "starting", "running"] as const) {
      expect(threadRailStatus(thread({ status }))).toEqual({ tone: "running", label: "Running" });
    }
  });

  it("maps approval and input waits to waiting, attention first", () => {
    expect(threadRailStatus(thread({ status: "waiting_for_approval" }))).toEqual({ tone: "waiting", label: "Waiting" });
    expect(threadRailStatus(thread({ status: "waiting_for_input" }))).toEqual({ tone: "waiting", label: "Waiting" });
    expect(threadRailStatus(thread({ status: "running", attention: "approval_required" }))).toEqual({
      tone: "waiting",
      label: "Waiting",
    });
    expect(threadRailStatus(thread({ status: "running", attention: "input_required" }))).toEqual({
      tone: "waiting",
      label: "Waiting",
    });
  });

  it("maps failures to failed, attention first", () => {
    expect(threadRailStatus(thread({ status: "failed" }))).toEqual({ tone: "failed", label: "Failed" });
    expect(threadRailStatus(thread({ status: "running", attention: "failed" }))).toEqual({ tone: "failed", label: "Failed" });
  });

  it("maps completion to done", () => {
    expect(threadRailStatus(thread({ status: "completed" }))).toEqual({ tone: "done", label: "Done" });
    expect(threadRailStatus(thread({ status: "running", attention: "completed" }))).toEqual({ tone: "done", label: "Done" });
  });

  it("gives no pill to inactive threads", () => {
    for (const status of ["aborted", "stale", "archived"] as const) {
      expect(threadRailStatus(thread({ status }))).toBeNull();
    }
  });
});

describe("formatRelativeTime", () => {
  it("returns an empty label for unparseable timestamps", () => {
    expect(formatRelativeTime("not-a-date", NOW_MS)).toBe("");
  });

  it("labels sub-minute deltas as just now, including slight future skew", () => {
    expect(formatRelativeTime("2026-07-15T11:59:30.000Z", NOW_MS)).toBe("just now");
    expect(formatRelativeTime("2026-07-15T12:00:10.000Z", NOW_MS)).toBe("just now");
  });

  it("labels minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-07-15T11:55:00.000Z", NOW_MS)).toBe("5m ago");
    expect(formatRelativeTime("2026-07-15T09:00:00.000Z", NOW_MS)).toBe("3h ago");
    expect(formatRelativeTime("2026-07-13T12:00:00.000Z", NOW_MS)).toBe("2d ago");
  });

  it("falls back to a date for older threads", () => {
    const label = formatRelativeTime("2026-07-01T12:00:00.000Z", NOW_MS);
    expect(label).not.toBe("");
    expect(label).not.toContain("ago");
  });
});

function summaryFixture(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsProjectWorkspace", enabled: true }],
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
    projects: { items: [{ id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 4, attentionCount: 0 }], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: "2026-07-15T12:00:00.000Z",
  };
}

function workspaceFixture(): ProjectAgentWorkspace {
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 4, attentionCount: 0 },
    tasks: { items: [], hasMore: false, limit: 100 },
    projectThreads: {
      items: [
        // Relative to the real clock: the rail's minute ticker drives "Nm ago".
        thread({ id: "thread_run", title: "Running chat", status: "running", updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
        thread({ id: "thread_wait", title: "Waiting chat", status: "waiting_for_approval", attention: "approval_required", updatedAt: "2026-07-15T09:00:00.000Z" }),
        thread({ id: "thread_done", title: "Done chat", status: "completed", updatedAt: "2026-07-13T12:00:00.000Z" }),
        thread({ id: "thread_fail", title: "Failed chat", status: "failed", updatedAt: "2026-07-13T12:00:00.000Z" }),
        thread({ id: "thread_arch", title: "Archived chat", status: "archived", updatedAt: "2026-07-13T12:00:00.000Z" }),
      ],
      hasMore: false,
      limit: 100,
    },
    taskThreads: { items: [], hasMore: false, limit: 100 },
    updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

describe("ProjectThreadList status rail", () => {
  afterEach(cleanup);

  it("lists a locally confirmed Project Chat while server projections catch up", () => {
    const workspace = workspaceFixture();
    workspace.projectThreads.items = [];
    workspace.taskThreads.items = [];
    render(
      <ProjectThreadList
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryFixture()}
        workspace={workspace}
        createdThreadHandles={[thread({
          id: "thread-new",
          title: "New project chat",
          projectId: "matrix-os",
          updatedAt: "2026-07-15T12:01:00.000Z",
        })]}
        status="ready"
        error={null}
        selectedThreadId={null}
        canCreate
        onSelectThread={() => {}}
        onNewChat={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat New project chat" })).toBeTruthy();
  });

  it("lets authoritative workspace rows replace optimistic creates", () => {
    const workspace = workspaceFixture();
    workspace.projectThreads.items = [thread({
      id: "thread-new",
      title: "Authoritative title",
      projectId: "matrix-os",
      status: "completed",
      updatedAt: "2026-07-15T12:00:00.000Z",
    })];
    const model = buildProjectThreadListModel(
      workspace,
      summaryFixture(),
      "matrix-os",
      [thread({ id: "thread-new", title: "Optimistic title", projectId: "matrix-os" })],
    );

    expect(model.projectThreads).toEqual([
      expect.objectContaining({ id: "thread-new", title: "Authoritative title", status: "completed" }),
    ]);
  });

  it("does not resurrect an optimistic row after a newer workspace omits or moves it", () => {
    const workspace = workspaceFixture();
    workspace.projectThreads.items = [];
    workspace.taskThreads.items = [];
    workspace.updatedAt = "2026-07-15T12:00:00.000Z";
    const created = thread({
      id: "thread-new",
      title: "Optimistic title",
      projectId: "matrix-os",
      updatedAt: "2026-07-15T11:59:00.000Z",
    });

    expect(buildProjectThreadListModel(workspace, summaryFixture(), "matrix-os", [created]).projectThreads)
      .toEqual([]);

    const movedSummary = summaryFixture();
    movedSummary.activeThreads.items = [{ ...created, projectId: "another-project" }];
    workspace.updatedAt = "2026-07-15T11:58:00.000Z";
    expect(buildProjectThreadListModel(workspace, movedSummary, "matrix-os", [created]).projectThreads)
      .toEqual([]);
  });

  it("renders a status pill and relative timestamp per row, none for archived", () => {
    render(
      <ProjectThreadList
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        error={null}
        selectedThreadId={null}
        canCreate
        onSelectThread={() => {}}
        onNewChat={() => {}}
        onRetry={() => {}}
      />,
    );

    const runningRow = screen.getByRole("button", { name: "Chat Running chat" });
    expect(runningRow.textContent).toContain("Running");
    expect(runningRow.textContent).toMatch(/\d+m ago|just now/);

    expect(screen.getByRole("button", { name: "Chat Waiting chat" }).textContent).toContain("Waiting");
    expect(screen.getByRole("button", { name: "Chat Done chat" }).textContent).toContain("Done");
    expect(screen.getByRole("button", { name: "Chat Failed chat" }).textContent).toContain("Failed");

    const archivedRow = screen.getByRole("button", { name: "Chat Archived chat" });
    expect(archivedRow.textContent).not.toContain("Running");
    expect(archivedRow.textContent).not.toContain("Waiting");
    expect(archivedRow.textContent).not.toContain("Done");
    expect(archivedRow.textContent).not.toContain("Failed");
    // The provider label stays.
    expect(archivedRow.textContent).toContain("Codex");
  });

  it("searches loaded chat titles and filters them by actionable status", () => {
    render(
      <ProjectThreadList
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryFixture()}
        workspace={workspaceFixture()}
        status="ready"
        error={null}
        selectedThreadId={null}
        canCreate
        onSelectThread={() => {}}
        onNewChat={() => {}}
        onRetry={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "done" },
    });
    expect(screen.getByRole("button", { name: "Chat Done chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat Running chat" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter chats by status" }), {
      target: { value: "failed" },
    });
    expect(screen.getByRole("button", { name: "Chat Failed chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat Done chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat Archived chat" })).toBeNull();
  });

  it("limits filtered empty copy to the loaded window while more chats remain", () => {
    const workspace = workspaceFixture();
    workspace.projectThreads.hasMore = true;
    workspace.projectThreads.nextCursor = "thread_arch";
    render(
      <ProjectThreadList
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryFixture()}
        workspace={workspace}
        status="ready"
        error={null}
        selectedThreadId={null}
        canCreate
        onSelectThread={() => {}}
        onNewChat={() => {}}
        onRetry={() => {}}
        onLoadMore={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "not loaded yet" },
    });

    expect(screen.getByText("No loaded chats match these filters. Load more to search older chats."))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more chats" })).toBeTruthy();
  });

  it("offers cursor-based load more when the workspace projection is truncated", () => {
    const workspace = workspaceFixture();
    workspace.projectThreads.hasMore = true;
    workspace.projectThreads.nextCursor = "thread_arch";
    const onLoadMore = vi.fn();
    render(
      <ProjectThreadList
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryFixture()}
        workspace={workspace}
        status="ready"
        error={null}
        selectedThreadId={null}
        canCreate
        onSelectThread={() => {}}
        onNewChat={() => {}}
        onRetry={() => {}}
        onLoadMore={onLoadMore}
      />,
    );

    screen.getByRole("button", { name: "Load more chats" }).click();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
