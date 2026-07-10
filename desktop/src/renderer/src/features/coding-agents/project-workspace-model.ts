import type {
  AgentThreadSummary,
  ProjectAgentWorkspace,
  RuntimeSummary,
} from "@matrix-os/contracts";
import type {
  CodingAgentWorkspaceResumeState,
  CodingAgentWorkspaceViewMode,
} from "../../../../shared/coding-agent-project-workspace";

export type ProjectWorkspaceSelection = Omit<
  CodingAgentWorkspaceResumeState,
  "updatedAt"
>;

export interface GroupedProjectWorkspaceThreads {
  projectThreads: AgentThreadSummary[];
  taskThreads: Record<string, AgentThreadSummary[]>;
}

export function resolveSelectedProjectId(
  summary: RuntimeSummary,
  preferredProjectId: string | null,
): string | null {
  if (
    preferredProjectId
    && summary.projects.items.some((project) => project.id === preferredProjectId)
  ) {
    return preferredProjectId;
  }
  return summary.projects.items[0]?.id ?? null;
}

export function groupProjectWorkspaceThreads(
  workspace: ProjectAgentWorkspace,
): GroupedProjectWorkspaceThreads {
  const taskThreads: Record<string, AgentThreadSummary[]> = {};
  for (const thread of workspace.taskThreads.items) {
    if (!thread.taskId) continue;
    const existing = taskThreads[thread.taskId];
    if (existing) existing.push(thread);
    else taskThreads[thread.taskId] = [thread];
  }
  return {
    projectThreads: [...workspace.projectThreads.items],
    taskThreads,
  };
}

function selectionForThread(
  workspace: ProjectAgentWorkspace,
  thread: AgentThreadSummary,
  viewMode: CodingAgentWorkspaceViewMode,
): ProjectWorkspaceSelection {
  return {
    selectedProjectId: workspace.project.id,
    selectedTaskId: thread.taskId ?? null,
    selectedThreadId: thread.id,
    viewMode,
  };
}

export function reconcileProjectWorkspaceSelection(
  workspace: ProjectAgentWorkspace,
  preferred: ProjectWorkspaceSelection,
): ProjectWorkspaceSelection {
  const allThreads = [
    ...workspace.projectThreads.items,
    ...workspace.taskThreads.items,
  ];
  const selectedThread = preferred.selectedThreadId
    ? allThreads.find((thread) => thread.id === preferred.selectedThreadId)
    : undefined;
  if (selectedThread) {
    return selectionForThread(workspace, selectedThread, preferred.viewMode);
  }

  const selectedTask = preferred.selectedTaskId
    ? workspace.tasks.items.find((task) => task.id === preferred.selectedTaskId)
    : undefined;
  if (selectedTask) {
    const replacementThread = preferred.selectedThreadId
      ? workspace.taskThreads.items.find((thread) => thread.taskId === selectedTask.id)
      : undefined;
    return {
      selectedProjectId: workspace.project.id,
      selectedTaskId: selectedTask.id,
      selectedThreadId: replacementThread?.id ?? null,
      viewMode: preferred.viewMode,
    };
  }

  const fallbackThread = workspace.projectThreads.items[0]
    ?? workspace.taskThreads.items[0];
  if (fallbackThread) {
    return selectionForThread(workspace, fallbackThread, preferred.viewMode);
  }

  return {
    selectedProjectId: workspace.project.id,
    selectedTaskId: null,
    selectedThreadId: null,
    viewMode: preferred.viewMode,
  };
}
