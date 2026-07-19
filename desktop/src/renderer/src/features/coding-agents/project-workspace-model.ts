import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
} from "@matrix-os/contracts";

export function resolveNewChatRelation(
  workspace: ProjectAgentWorkspace | null,
  projectId: string,
  taskId?: string,
): { projectId: string; taskId?: string } | null {
  if (!workspace || workspace.project.id !== projectId) return null;
  if (!taskId) return { projectId: workspace.project.id };
  const taskInPage = workspace.tasks.items.some((task) => task.id === taskId);
  // A selected chat can belong to a paged task outside the bounded tasks page;
  // taskThreads.items backs both grouped and unlisted task conversations.
  const taskCarriedByThread = workspace.taskThreads.items.some(
    (thread) => thread.taskId === taskId,
  );
  if (!taskInPage && !taskCarriedByThread) return null;
  return { projectId: workspace.project.id, taskId };
}

export interface GroupedProjectWorkspaceThreads {
  projectThreads: AgentThreadSummary[];
  taskThreads: Record<string, AgentThreadSummary[]>;
  unlistedTaskThreads: AgentThreadSummary[];
}

export function groupProjectWorkspaceThreads(
  workspace: ProjectAgentWorkspace,
): GroupedProjectWorkspaceThreads {
  const taskThreads: Record<string, AgentThreadSummary[]> = {};
  const visibleTaskIds = new Set(workspace.tasks.items.map((task) => task.id));
  const unlistedTaskThreads: AgentThreadSummary[] = [];
  for (const thread of workspace.taskThreads.items) {
    if (!thread.taskId || !visibleTaskIds.has(thread.taskId)) {
      unlistedTaskThreads.push(thread);
      continue;
    }
    const existing = taskThreads[thread.taskId];
    if (existing) existing.push(thread);
    else taskThreads[thread.taskId] = [thread];
  }
  return {
    projectThreads: [...workspace.projectThreads.items],
    taskThreads,
    unlistedTaskThreads,
  };
}

/**
 * Reconciles the persisted per-project chat selection against a freshly loaded
 * workspace. A selection survives when the workspace page carries the thread
 * or the runtime summary still lists it (attention/active threads may live
 * outside the bounded workspace pages). Otherwise the newest listed chat wins
 * so the Chats view always has a conversation to show; null when the project
 * has no chats at all.
 */
export function reconcileProjectChatSelection(
  workspace: ProjectAgentWorkspace,
  selectedThreadId: string | null,
  externallyKnownThreadIds: ReadonlySet<string>,
): string | null {
  const listed = [
    ...workspace.projectThreads.items,
    ...workspace.taskThreads.items,
  ];
  if (selectedThreadId) {
    const stillValid = listed.some((thread) => thread.id === selectedThreadId)
      || externallyKnownThreadIds.has(selectedThreadId);
    if (stillValid) return selectedThreadId;
  }
  return listed[0]?.id ?? null;
}
