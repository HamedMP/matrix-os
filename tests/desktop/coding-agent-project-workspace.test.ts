import { describe, expect, it } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  resolveNewChatRelation,
  groupProjectWorkspaceThreads,
  reconcileProjectWorkspaceSelection,
  resolveSelectedProjectId,
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

function summary(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsProjectWorkspace", enabled: true },
      { id: "codingAgentsConversationView", enabled: true },
    ],
    providers: [],
    projects: {
      items: [
        { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 3, attentionCount: 0 },
        { id: "website", label: "Website", status: "available", taskCount: 0, threadCount: 0, attentionCount: 0 },
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
  it("DT-004 falls back from a stale persisted project to the first live project", () => {
    expect(resolveSelectedProjectId(summary(), "deleted-project")).toBe("matrix-os");
  });

  it("DT-004 reconciles a stale task chat to an independently selectable live chat", () => {
    expect(reconcileProjectWorkspaceSelection(workspace(), {
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_deleted",
      viewMode: "conversation",
    })).toEqual({
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
      viewMode: "conversation",
    });
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
});
