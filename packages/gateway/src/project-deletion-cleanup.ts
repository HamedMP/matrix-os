import { TerminalRuntimeError, type TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { createAgentSessionManager } from "./domains/sessions/agent-session-manager.js";
import type { CodingAgentThreadStore } from "./coding-agents/thread-store.js";
import type { ProjectConfig } from "./domains/workspace/project-manager.js";
import type { RequestPrincipal } from "./domains/identity/request-principal.js";
import type { createWorktreeManager } from "./domains/git/worktree-manager.js";
import type { createReviewStore } from "./domains/review/review-store.js";

export type ProjectChatCleanup = (project: ProjectConfig, principal: RequestPrincipal) => Promise<void>;

/** Shared by the request and restart recovery paths. The project tombstone fences new work. */
export function createProjectDeletionCleanup(options: {
  sessions: Pick<ReturnType<typeof createAgentSessionManager>, "deleteProjectSessions">;
  reviews: Pick<ReturnType<typeof createReviewStore>, "deleteProjectReviews">;
  threads?: Pick<CodingAgentThreadStore, "deleteProjectThreads">;
  terminal: Pick<TerminalRuntimeSocketClient, "listWorkspaces" | "deleteWorkspace" | "deleteTab">;
  deleteChats?: ProjectChatCleanup;
  worktrees?: Pick<ReturnType<typeof createWorktreeManager>, "listWorktrees" | "deleteWorktree">;
}) {
  return async (project: ProjectConfig, principal: RequestPrincipal): Promise<void> => {
    await options.deleteChats?.(project, principal);
    if (options.threads) {
      const result = await options.threads.deleteProjectThreads(principal, project.slug);
      if (!result.ok) throw new Error("Project thread cleanup failed");
    }
    const sessions = await options.sessions.deleteProjectSessions({
      projectSlug: project.slug, ownerId: principal.userId,
      // Keep session refs until all terminal cleanup succeeds, so retries can finish Main tabs too.
      beforeRemove: async (ownedSessions) => {
        const refs = ownedSessions.flatMap(session => session.terminalRef ? [session.terminalRef] : []);
        const workspaces = await options.terminal.listWorkspaces();
        for (const workspace of workspaces) {
          if (workspace.scope === "project" && workspace.projectId === project.id) {
            await removeTerminalIfPresent(() => options.terminal.deleteWorkspace(workspace.id, { confirmTerminate: true }));
          } else {
            for (const tab of workspace.tabs) {
              if (refs.some(ref => ref.workspaceId === workspace.id && ref.tabId === tab.id)) {
                await removeTerminalIfPresent(() => options.terminal.deleteTab({ workspaceId: workspace.id, tabId: tab.id }));
              }
            }
          }
        }
      },
    });
    if (!sessions.ok) throw new Error("Project session cleanup failed");
    const reviews = await options.reviews.deleteProjectReviews(project.slug);
    if (!reviews.ok) throw new Error("Project review cleanup failed");
    if (options.worktrees) {
      const listed = await options.worktrees.listWorktrees(project.slug, project.ownerScope);
      // Restart recovery may have already removed the registry record.
      if (!listed.ok) {
        if (listed.status === 404 && listed.error.code === "not_found") return;
        throw new Error("Project worktree inventory failed");
      }
      for (const worktree of listed.worktrees) {
        const removed = await options.worktrees.deleteWorktree({ projectSlug: project.slug,
          worktreeId: worktree.id, ownerScope: project.ownerScope, confirmDirtyDelete: true });
        if (!removed.ok && !(removed.status === 404 && removed.error.code === "not_found")) {
          throw new Error("Project worktree cleanup failed");
        }
      }
    }
  };
}

async function removeTerminalIfPresent(remove: () => Promise<void>): Promise<void> {
  try { await remove(); } catch (error: unknown) {
    if (!(error instanceof TerminalRuntimeError && error.code === "not_found")) throw error;
  }
}
