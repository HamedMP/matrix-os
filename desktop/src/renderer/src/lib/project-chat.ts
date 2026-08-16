// Canonical routing for opening coding-agent chats in the project-centric
// shell. A chat always opens inside its project tab (Chats view active) —
// notifications, global Recents, the command palette, and future panels all
// funnel through openProjectChat so there is exactly one way to land on a
// conversation.
import { create } from "zustand";
import { invoke } from "./operator";
import { diagnosticErrorKind } from "./errors";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../stores/runtime-generation";
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

function conversationTitleFor(threadId: string): string {
  const workspace = useCodingAgentWorkspace.getState();
  const summaryThread = [
    ...(workspace.summary?.attentionThreads.items ?? []),
    ...(workspace.summary?.activeThreads.items ?? []),
  ].find((thread) => thread.id === threadId);
  if (summaryThread?.title) return summaryThread.title;
  if (workspace.threadSnapshot?.thread.id === threadId) {
    return workspace.threadSnapshot.thread.title;
  }
  for (const entry of Object.values(useProjectWorkspaces.getState().entries)) {
    const projectWorkspace = entry.workspace;
    if (!projectWorkspace) continue;
    const listed = [
      ...projectWorkspace.projectThreads.items,
      ...projectWorkspace.taskThreads.items,
    ].find((thread) => thread.id === threadId);
    if (listed?.title) return listed.title;
  }
  return "Agent conversation";
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
  if (options.threadId) {
    useTabs.getState().recordRecentConversation(
      options.threadId,
      conversationTitleFor(options.threadId),
    );
  }
  // ensure() records load failures in its own entry state and never rejects.
  void useProjectWorkspaces.getState().ensure(projectId);
  if (options.threadId) {
    const workspace = useCodingAgentWorkspace.getState();
    if (workspace.activeThreadId !== options.threadId) {
      workspace.loadThreadSnapshot(options.threadId).catch((err: unknown) => {
        console.warn(
          "[project-chat] thread open failed:",
          diagnosticErrorKind(err),
        );
      });
    }
  }
  if (options.compose) {
    useProjectChatLauncher.getState().requestComposer(projectId);
  }
}

/**
 * Routes a coding-agent thread (notification, palette, or Recents) into its
 * project context. The project is resolved from the runtime summary or the
 * already-loaded snapshot; when neither knows it, the default project is a
 * best-effort fallback so the conversation still opens somewhere sensible.
 */
// Asks the runtime which project owns a thread. Used only when nothing loaded
// locally knows, so the cost is paid once per genuinely unknown thread.
async function resolveThreadProjectId(threadId: string): Promise<string | undefined> {
  try {
    const snapshot = await invoke("runtime:get-thread-snapshot", { threadId });
    return snapshot?.thread?.projectId ?? undefined;
  } catch (err: unknown) {
    console.warn(
      "[project-chat] thread project lookup failed:",
      diagnosticErrorKind(err),
    );
    return undefined;
  }
}

export async function openCodingAgentThread(threadId: string): Promise<void> {
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
  // Resolve authoritatively before choosing a tab. Falling straight through to
  // defaultProjectId() opens the conversation under whichever project happens
  // to be active; the snapshot later reveals the real projectId but nothing
  // reroutes, so the chat stays selected and persisted under the wrong project.
  const known = listed?.projectId ?? snapshotProjectId ?? workspaceProjectId;
  let projectId = known;
  if (!projectId) {
    const runtimeGeneration = captureRuntimeGeneration();
    const resolved = await resolveThreadProjectId(threadId);
    // openProjectChat persists a thread selection, so committing after an
    // account or computer change would pin a thread that does not exist on the
    // machine now in view.
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
    // Only guess when the runtime genuinely could not resolve it. The guess
    // opens the chat under whichever project is active and nothing reroutes.
    projectId = resolved ?? defaultProjectId() ?? undefined;
  }
  if (!projectId) {
    console.warn("[project-chat] cannot open a thread before any project exists");
    return;
  }
  openProjectChat(projectId, { threadId });
}
