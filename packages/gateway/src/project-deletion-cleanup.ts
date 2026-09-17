import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { createAgentSessionManager } from "./agent-session-manager.js";
import type { CodingAgentThreadStore } from "./coding-agents/thread-store.js";
import type { ProjectConfig } from "./project-manager.js";
import type { RequestPrincipal } from "./request-principal.js";
import type { createReviewStore } from "./review-store.js";

export type ProjectChatCleanup = (project: ProjectConfig, principal: RequestPrincipal) => Promise<void>;

/** Shared by the request and restart recovery paths. The project tombstone fences new work. */
export function createProjectDeletionCleanup(options: {
  sessions: Pick<ReturnType<typeof createAgentSessionManager>, "deleteProjectSessions">;
  reviews: Pick<ReturnType<typeof createReviewStore>, "deleteProjectReviews">;
  threads?: Pick<CodingAgentThreadStore, "deleteProjectThreads">;
  terminal: Pick<TerminalRuntimeSocketClient, "listWorkspaces" | "deleteWorkspace" | "deleteTab">;
  deleteChats?: ProjectChatCleanup;
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
            await options.terminal.deleteWorkspace(workspace.id, { confirmTerminate: true });
          } else {
            for (const tab of workspace.tabs) {
              if (refs.some(ref => ref.workspaceId === workspace.id && ref.tabId === tab.id)) {
                await options.terminal.deleteTab({ workspaceId: workspace.id, tabId: tab.id });
              }
            }
          }
        }
      },
    });
    if (!sessions.ok) throw new Error("Project session cleanup failed");
    const reviews = await options.reviews.deleteProjectReviews(project.slug);
    if (!reviews.ok) throw new Error("Project review cleanup failed");
  };
}
