import {
  KernelConversationContextProjectionSchema,
  type KernelConversationContextProjection,
} from "@matrix-os/contracts";
import {
  createProjectManager,
} from "./project-manager.js";
import type { OwnerScope } from "./state-ops.js";

type ProjectManager = Pick<
  ReturnType<typeof createProjectManager>,
  "getProject" | "resolveProjectWorkingDirectory"
>;

export interface ResolvedConversationContext {
  projection: KernelConversationContextProjection;
  workingDirectory: string;
}

export function createConversationContextResolver(projectManager: ProjectManager) {
  return {
    async resolve(
      projectId: string,
      ownerScope?: OwnerScope,
    ): Promise<ResolvedConversationContext | null> {
      const result = await projectManager.getProject(projectId, ownerScope);
      if (!result.ok) return null;

      const workingDirectory = await projectManager.resolveProjectWorkingDirectory(result.project);
      if (!workingDirectory) return null;

      const projection = KernelConversationContextProjectionSchema.safeParse({
        projectId: result.project.slug,
        projectName: result.project.name,
        projectKind: result.project.kind,
        repositoryLabel: result.project.github
          ? `${result.project.github.owner}/${result.project.github.repo}`
          : result.project.name,
        status: "ready",
      });
      if (!projection.success) return null;

      return { projection: projection.data, workingDirectory };
    },
  };
}

export type ConversationContextResolver = ReturnType<typeof createConversationContextResolver>;
