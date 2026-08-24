import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
  RuntimeSummary,
  TaskAgentSummary,
} from "@matrix-os/contracts";
import { groupProjectWorkspaceThreads } from "../coding-agents/project-workspace-model";

export interface ProjectThreadListModel {
  projectThreads: AgentThreadSummary[];
  taskGroups: Array<{ task: TaskAgentSummary; threads: AgentThreadSummary[] }>;
  otherThreads: AgentThreadSummary[];
  truncated: boolean;
}

export type ThreadRailTone = "running" | "waiting" | "done" | "failed";
export type ThreadRailFilter = "all" | ThreadRailTone;
const MAX_WORKSPACE_LIST_ITEMS = 100;

export function canLoadMoreProjectThreads(workspace: ProjectAgentWorkspace | null): boolean {
  if (!workspace) return false;
  return [workspace.tasks, workspace.projectThreads, workspace.taskThreads]
    .some((page) => page.hasMore && page.items.length < MAX_WORKSPACE_LIST_ITEMS);
}

// Status pill for a rail row. Attention states win because they carry the
// actionable state; inactive threads (aborted/stale/archived) get no pill.
export function threadRailStatus(thread: AgentThreadSummary): { tone: ThreadRailTone; label: string } | null {
  if (thread.attention === "approval_required" || thread.attention === "input_required") {
    return { tone: "waiting", label: "Waiting" };
  }
  if (thread.attention === "failed" || thread.status === "failed") {
    return { tone: "failed", label: "Failed" };
  }
  if (thread.attention === "completed") {
    return { tone: "done", label: "Done" };
  }
  if (thread.status === "waiting_for_approval" || thread.status === "waiting_for_input") {
    return { tone: "waiting", label: "Waiting" };
  }
  if (thread.status === "queued" || thread.status === "starting" || thread.status === "running") {
    return { tone: "running", label: "Running" };
  }
  if (thread.status === "completed") {
    return { tone: "done", label: "Done" };
  }
  return null;
}

// Small local relative-time helper ("just now", "5m ago", "3h ago", "2d ago",
// then a short date) — deliberately no new dependency.
export function formatRelativeTime(iso: string, nowMs: number): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const deltaMs = Math.max(0, nowMs - parsed);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(parsed).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Builds the Chats list model for one project: the workspace pages grouped per
 * task, overlaid with the live runtime-summary projections (attention/active
 * threads are newer than the bounded workspace pages). Summary threads missing
 * from the workspace are appended so actionable chats never disappear; without
 * a workspace (capability off or load failed) the summary projection alone
 * backs the list.
 */
export function buildProjectThreadListModel(
  workspace: ProjectAgentWorkspace | null,
  summary: RuntimeSummary,
  projectId: string,
): ProjectThreadListModel {
  const grouped = workspace ? groupProjectWorkspaceThreads(workspace) : null;
  const projectThreads = grouped ? [...grouped.projectThreads] : [];
  const taskGroups = workspace
    ? workspace.tasks.items.map((task) => ({
        task,
        threads: [...(grouped?.taskThreads[task.id] ?? [])],
      }))
    : [];
  const otherThreads = grouped ? [...grouped.unlistedTaskThreads] : [];

  const overlay = new Map<string, AgentThreadSummary>();
  for (const thread of summary.activeThreads.items) {
    if (thread.projectId === projectId) overlay.set(thread.id, thread);
  }
  // Attention entries win the dedupe: they carry the actionable state.
  for (const thread of summary.attentionThreads.items) {
    if (thread.projectId === projectId) overlay.set(thread.id, thread);
  }

  const applyOverlay = (threads: AgentThreadSummary[]): AgentThreadSummary[] =>
    threads.map((thread) => {
      const live = overlay.get(thread.id);
      if (live) overlay.delete(thread.id);
      return live ?? thread;
    });

  const mergedProject = applyOverlay(projectThreads);
  const mergedGroups = taskGroups.map((group) => ({ ...group, threads: applyOverlay(group.threads) }));
  const mergedOther = applyOverlay(otherThreads);
  const mergedGroupByTaskId = new Map(mergedGroups.map((group) => [group.task.id, group]));

  for (const thread of overlay.values()) {
    const group = thread.taskId ? mergedGroupByTaskId.get(thread.taskId) : undefined;
    if (group) group.threads.push(thread);
    else if (thread.taskId) mergedOther.push(thread);
    else mergedProject.push(thread);
  }

  return {
    projectThreads: mergedProject,
    taskGroups: mergedGroups,
    otherThreads: mergedOther,
    truncated: Boolean(
      workspace && (workspace.tasks.hasMore || workspace.projectThreads.hasMore || workspace.taskThreads.hasMore),
    ),
  };
}

export function filterProjectThreadListModel(
  model: ProjectThreadListModel,
  query: string,
  status: ThreadRailFilter,
): ProjectThreadListModel {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery && status === "all") return model;

  const matches = (thread: AgentThreadSummary): boolean => {
    const matchesQuery = !normalizedQuery || thread.title.toLocaleLowerCase().includes(normalizedQuery);
    const matchesStatus = status === "all" || threadRailStatus(thread)?.tone === status;
    return matchesQuery && matchesStatus;
  };

  return {
    ...model,
    projectThreads: model.projectThreads.filter(matches),
    taskGroups: model.taskGroups
      .map((group) => ({ ...group, threads: group.threads.filter(matches) }))
      .filter((group) => group.threads.length > 0),
    otherThreads: model.otherThreads.filter(matches),
  };
}
