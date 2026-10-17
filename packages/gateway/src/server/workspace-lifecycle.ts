import type { Hono } from "hono";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { createProjectChatCleanup } from "../chat/project-deletion.js";
import type { GatewayCollaborationRuntime } from "../collaboration/wiring.js";
import { createWorkspaceRoutes } from "../workspace-routes.js";
import { createWorkspaceStartupRecovery } from "../workspace-startup-recovery.js";

/** Bind both owner deletion entry points before recovering any durable tombstones. */
export async function registerWorkspaceLifecycle(options: {
  app: Hono;
  shellRoutes: Hono;
  chatRepository: ChatRepository | null;
  orchestrator: CanonicalChatOrchestrator | null;
  collaboration: GatewayCollaborationRuntime | null;
  workspace: Omit<Parameters<typeof createWorkspaceRoutes>[0], "deleteProjectChats" | "configureSharedProjectDeletion">;
  recovery: Omit<Parameters<typeof createWorkspaceStartupRecovery>[0], "deleteProjectChats">;
}) {
  const deleteProjectChats = options.chatRepository && options.orchestrator
    ? createProjectChatCleanup({ repository: options.chatRepository, orchestrator: options.orchestrator,
      resolveSharedScope: options.collaboration?.resolveChatDeletionScope,
    })
    : async () => { throw new Error("Project chat cleanup unavailable"); };
  options.app.route("/", createWorkspaceRoutes({ ...options.workspace, deleteProjectChats,
    configureSharedProjectDeletion: options.collaboration?.enableProjectDeletion,
  }));
  options.app.route("/api", options.shellRoutes);
  // Shared journals retain scope identity even if a crash occurred after local cleanup.
  // Recover them first, once Chat and terminal cleanup are available.
  try {
    const shared = await options.collaboration?.recoverProjectDeletions();
    if (shared?.failed) console.warn("[gateway] Shared project deletion recovery deferred", shared.failed);
  } catch (error: unknown) {
    console.warn("[gateway] Shared project deletion recovery unavailable", error instanceof Error ? error.name : "UnknownError");
  }
  const recovery = createWorkspaceStartupRecovery({ ...options.recovery, deleteProjectChats,
    canRecoverProjectDeletion: options.collaboration?.canRecoverProjectDeletion,
  });
  const result = await recovery.run();
  if (result.status === "degraded") console.warn("[gateway] Workspace startup recovery completed with degraded steps");
  return recovery;
}
