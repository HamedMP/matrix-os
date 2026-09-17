import type { ChatRepository } from "./repository.js";
import type { CanonicalChatOrchestrator } from "./orchestrator.js";
import type { ProjectChatCleanup } from "../project-deletion-cleanup.js";

/** Lists active AND archived chats; hardDelete owns the transactional descendant cascade/outbox. */
export function createProjectChatCleanup(options: {
  repository: Pick<ChatRepository, "list" | "hardDelete">;
  orchestrator: Pick<CanonicalChatOrchestrator, "cancelRun">;
}): ProjectChatCleanup {
  return async (project, principal) => {
    const owner = { type: "personal" as const, ownerId: principal.userId };
    // Older clients used the slug; newer references may use the immutable project id.
    for (const projectId of new Set([project.slug, project.id])) {
      for (let pageNumber = 0; ; pageNumber++) {
        if (pageNumber >= 1_000) throw new Error("Project chat cleanup capacity exceeded");
        const page = await options.repository.list(owner, { projectId, limit: 100 });
        if (page.items.length === 0) break;
        for (const chat of page.items) {
          if (chat.activeRun) await options.orchestrator.cancelRun(owner, chat.chat.id, chat.activeRun.runId);
          await options.repository.hardDelete(owner, { chatId: chat.chat.id, clientRequestId: `req_project_delete_${chat.chat.id}` });
        }
      }
    }
  };
}
