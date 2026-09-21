import { CollaborationProjectAccessReadinessSchema, type CollaborationProjectAccessReadiness } from "@matrix-os/contracts";
import type { CollaborationRepository } from "./repository.js";
import type { ProjectInventoryResourceSource } from "./project-inventory.js";
import { ProjectInventoryError } from "./project-inventory.js";

/** Read-only projection for the existing access popover; no host paths, tokens or confirmation secrets. */
export function createProjectAccessReadiness(options: {
  repository: Pick<CollaborationRepository, "getScope">;
  source: Pick<ProjectInventoryResourceSource, "listChats" | "getGitSetup">;
}) {
  return {
    async get(input: { scopeId: string }): Promise<CollaborationProjectAccessReadiness> {
      const scope = await options.repository.getScope(input.scopeId);
      if (!scope || scope.kind !== "project" || scope.lifecycle !== "shared") {
        throw new ProjectInventoryError("project_unavailable");
      }
      const [chats, gitSetup] = await Promise.all([
        options.source.listChats(scope.ownerId, scope.resourceId),
        options.source.getGitSetup?.(scope.ownerId, scope.resourceId) ?? Promise.resolve({
          identity: { status: "unavailable" as const },
          forgeCredential: { status: "unavailable" as const },
        }),
      ]);
      return CollaborationProjectAccessReadinessSchema.parse({
        scopeId: scope.id,
        chatRoots: chats.map((chat) => ({
          chatId: chat.id,
          ...(chat.executionRoot ? { executionRoot: chat.executionRoot } : {}),
          ...(chat.branch ? { branch: chat.branch } : {}),
          ...(chat.dirty !== undefined ? { dirty: chat.dirty } : {}),
          readiness: chat.compatibility,
        })),
        gitSetup,
      });
    },
  };
}

export type ProjectAccessReadiness = ReturnType<typeof createProjectAccessReadiness>;
