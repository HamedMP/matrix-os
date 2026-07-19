// Canonical routing for opening coding-agent chats in the project-centric
// shell. A chat always opens inside its project tab (Chats view active) —
// notifications, the command palette, the chat rail, and future panels all
// funnel through openProjectChat so there is exactly one way to land on a
// conversation.
import { create } from "zustand";
import { useBoard } from "../stores/board";
import { useCodingAgentWorkspace } from "../stores/coding-agent-workspace";
import { useProjectView } from "../stores/project-view";
import { useProjectWorkspaces } from "../stores/project-workspaces";
import { useTabs } from "../stores/tabs";

export interface OpenProjectChatOptions {
  // Select this thread in the project's Chats view and load its conversation.
  threadId?: string | null;
  // Open the new-chat composer for the project once the view is visible.
  compose?: boolean;
}

interface ProjectChatLauncherState {
  // One-shot "open the composer" request consumed by the project's Chats view
  // when it mounts/becomes active. Carries a requestId so repeated requests
  // for the same project are not lost.
  composerRequest: { projectId: string; requestId: number } | null;
  requestComposer: (projectId: string) => void;
  consumeComposer: (projectId: string) => void;
}

let composerRequestSeq = 0;

export const useProjectChatLauncher = create<ProjectChatLauncherState>()((set) => ({
  composerRequest: null,
  requestComposer: (projectId) => {
    composerRequestSeq += 1;
    set({ composerRequest: { projectId, requestId: composerRequestSeq } });
  },
  consumeComposer: (projectId) =>
    set((state) =>
      state.composerRequest?.projectId === projectId ? { composerRequest: null } : state,
    ),
}));

/**
 * The project a global "new chat" should target: the open project tab first,
 * then the board's active project, then the first project. Null when the
 * runtime has no projects yet.
 */
export function defaultProjectId(): string | null {
  const tabs = useTabs.getState();
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  if (active?.kind === "project" && active.projectSlug) return active.projectSlug;
  const board = useBoard.getState();
  if (board.activeProjectSlug) return board.activeProjectSlug;
  return board.projects[0]?.slug ?? null;
}

function projectTitleFor(projectId: string): string {
  const boardProject = useBoard.getState().projects.find((project) => project.slug === projectId);
  if (boardProject) return boardProject.name || boardProject.slug;
  const summaryProject = useCodingAgentWorkspace
    .getState()
    .summary?.projects.items.find((project) => project.id === projectId);
  return summaryProject?.label ?? projectId;
}

export function openProjectChat(projectId: string, options: OpenProjectChatOptions = {}): void {
  const projectView = useProjectView.getState();
  projectView.setView(projectId, "chats");
  // Only an explicit thread updates the selection; a bare open keeps the
  // persisted conversation the user last had selected.
  if (options.threadId !== undefined) {
    projectView.setSelectedThread(projectId, options.threadId);
  }
  useTabs.getState().openTab({
    kind: "project",
    projectSlug: projectId,
    title: projectTitleFor(projectId),
  });
  // ensure() records load failures in its own entry state and never rejects.
  void useProjectWorkspaces.getState().ensure(projectId);
  if (options.threadId) {
    const workspace = useCodingAgentWorkspace.getState();
    if (workspace.activeThreadId !== options.threadId) {
      workspace.loadThreadSnapshot(options.threadId).catch((err: unknown) => {
        console.warn(
          "[project-chat] thread open failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }
  if (options.compose) {
    useProjectChatLauncher.getState().requestComposer(projectId);
  }
}

/**
 * Routes a coding-agent thread (notification, palette, chat rail) into its
 * project context. The project is resolved from the runtime summary or the
 * already-loaded snapshot; when neither knows it, the default project is a
 * best-effort fallback so the conversation still opens somewhere sensible.
 */
export function openCodingAgentThread(threadId: string): void {
  const workspace = useCodingAgentWorkspace.getState();
  const listed = [
    // Attention entries win the dedupe: they carry the actionable state.
    ...(workspace.summary?.attentionThreads.items ?? []),
    ...(workspace.summary?.activeThreads.items ?? []),
  ].find((thread) => thread.id === threadId);
  const snapshotProjectId = workspace.threadSnapshot?.thread.id === threadId
    ? workspace.threadSnapshot.thread.projectId
    : undefined;
  // Threads may live outside the bounded summary windows; any loaded project
  // workspace that lists the thread identifies its project just as well.
  const workspaceProjectId = (() => {
    for (const entry of Object.values(useProjectWorkspaces.getState().entries)) {
      const projectWorkspace = entry.workspace;
      if (!projectWorkspace) continue;
      const carries = [...projectWorkspace.projectThreads.items, ...projectWorkspace.taskThreads.items]
        .some((thread) => thread.id === threadId);
      if (carries) return projectWorkspace.project.id;
    }
    return undefined;
  })();
  const projectId = listed?.projectId ?? snapshotProjectId ?? workspaceProjectId ?? defaultProjectId();
  if (!projectId) {
    console.warn("[project-chat] cannot open a thread before any project exists");
    return;
  }
  openProjectChat(projectId, { threadId });
}
