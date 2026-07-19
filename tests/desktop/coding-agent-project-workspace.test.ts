import { describe, expect, it } from "vitest";
import type { ProjectAgentWorkspace } from "@matrix-os/contracts";
import {
  resolveNewChatRelation,
  groupProjectWorkspaceThreads,
  reconcileProjectChatSelection,
} from "../../desktop/src/renderer/src/features/coding-agents/project-workspace-model";

const NOW = "2026-07-10T12:00:00.000Z";

function thread(id: string, title: string, taskId?: string) {
  return {
    id,
    providerId: "codex",
    title,
    status: "running" as const,
    attention: "none" as const,
    projectId: "matrix-os",
    ...(taskId ? { taskId } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workspace(): ProjectAgentWorkspace {
  return {
    project: {
      id: "matrix-os",
      label: "Matrix OS",
      status: "available",
      taskCount: 1,
      threadCount: 3,
      attentionCount: 0,
    },
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
      items: [thread("thread_audit", "Audit architecture")],
      hasMore: false,
      limit: 100,
    },
    taskThreads: {
      items: [
        thread("thread_plan", "Plan auth changes", "task_auth"),
        thread("thread_fix", "Implement auth changes", "task_auth"),
      ],
      hasMore: false,
      limit: 100,
    },
    updatedAt: NOW,
  };
}

describe("coding-agent project workspace model", () => {
  it("keeps a persisted chat selection the fresh workspace still lists", () => {
    expect(reconcileProjectChatSelection(workspace(), "thread_fix", new Set())).toBe("thread_fix");
  });

  it("falls back from a stale persisted chat to the first listed chat", () => {
    expect(reconcileProjectChatSelection(workspace(), "thread_deleted", new Set())).toBe("thread_audit");
    expect(reconcileProjectChatSelection(workspace(), null, new Set())).toBe("thread_audit");
  });

  it("keeps a selection the summary still carries outside the workspace page", () => {
    expect(reconcileProjectChatSelection(workspace(), "thread_attention", new Set(["thread_attention"]))).toBe("thread_attention");
  });

  it("returns null when the project has no chats at all", () => {
    const empty = workspace();
    empty.projectThreads = { ...empty.projectThreads, items: [] };
    empty.taskThreads = { ...empty.taskThreads, items: [] };
    expect(reconcileProjectChatSelection(empty, "thread_deleted", new Set())).toBeNull();
  });

  it("DT-002 and DT-003 group every task chat separately from project chats", () => {
    const grouped = groupProjectWorkspaceThreads(workspace());

    expect(grouped.projectThreads.map((item) => item.id)).toEqual(["thread_audit"]);
    expect(grouped.taskThreads.task_auth?.map((item) => item.id)).toEqual([
      "thread_plan",
      "thread_fix",
    ]);
  });

  it("accepts only the canonical workspace project slug and one of its tasks", () => {
    expect(resolveNewChatRelation(workspace(), "matrix-os", "task_auth")).toEqual({
      projectId: "matrix-os",
      taskId: "task_auth",
    });
    expect(resolveNewChatRelation(workspace(), "proj_legacy", "task_auth")).toBeNull();
    expect(resolveNewChatRelation(workspace(), "matrix-os", "task_other")).toBeNull();
  });

  it("accepts a selected paged task carried by an unlisted task thread", () => {
    const paged = workspace();
    paged.taskThreads = {
      ...paged.taskThreads,
      items: [
        ...paged.taskThreads.items,
        thread("thread_paged", "Paged task chat", "task_paged"),
      ],
      hasMore: true,
    };
    // task_paged is outside the bounded tasks page but a visible thread carries it.
    expect(resolveNewChatRelation(paged, "matrix-os", "task_paged")).toEqual({
      projectId: "matrix-os",
      taskId: "task_paged",
    });
    // A task neither in the page nor carried by any thread is still rejected.
    expect(resolveNewChatRelation(paged, "matrix-os", "task_missing")).toBeNull();
  });
});
