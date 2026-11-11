import type { Hono } from "hono";
import { createProductionChatDriveContext } from "../chat/drive-context-production.js";
import { createChatDriveProjectRoutes } from "../chat/drive-projects.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import { createCodingAgentProjectMutationService } from "../coding-agents/project-mutations.js";
import { createCodingAgentRoutes, type CodingAgentRouteDeps } from "../coding-agents/routes.js";
import type { LegacyProjectOperationAdmission } from "../collaboration/project-fence.js";
import { createLegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import type { FilePreviewService } from "../file-preview-service.js";
import { registerProjectAgentContextRoute } from "../project-agent-context-routes.js";
import type { createProjectManager } from "../project-manager.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { registerFileRoutes } from "./file-routes.js";

type ProjectManager = ReturnType<typeof createProjectManager>;

type CodingAgentOptions = Omit<CodingAgentRouteDeps, "projectMutations" | "resolveProjectId"> & {
  projects: Pick<ProjectManager, "createProject" | "getProject">;
};

export function registerGatewayCodingAgentRoutes(app: Hono, options: CodingAgentOptions): void {
  const { projects, projectOperationAdmission, ...deps } = options;
  app.route("/api/coding-agents", createCodingAgentRoutes({
    ...deps,
    projectMutations: createCodingAgentProjectMutationService({ projects }),
    ...(projectOperationAdmission ? {
      projectOperationAdmission,
      resolveProjectId: async (principal, projectSlug) => {
        const project = await projects.getProject(projectSlug, { type: "user", id: principal.userId });
        return project.ok ? project.project.id : null;
      },
    } : {}),
  }));
}

interface ProjectFileOptions {
  homePath: string;
  filePreviewService: FilePreviewService;
  executionRoots: ChatExecutionRootResolver | null;
  projects: Pick<ProjectManager, "listManagedProjects">;
  projectOperationAdmission?: LegacyProjectOperationAdmission;
}

export function registerGatewayProjectFileRoutes(app: Hono, options: ProjectFileOptions): void {
  const { homePath, filePreviewService, executionRoots, projects, projectOperationAdmission } = options;
  const projectPathAdmission = projectOperationAdmission
    ? createLegacyProjectPathAdmission({
        homePath,
        projectOperationAdmission,
        listOwnerProjects: async (ownerType, ownerId) => {
          const result = await projects.listManagedProjects({
            visibility: "all",
            ownerScope: { type: ownerType === "organization" ? "org" : "user", id: ownerId },
          });
          return result.projects.map(project => ({ id: project.id, localPath: project.localPath }));
        },
      })
    : undefined;
  registerFileRoutes(app, {
    homePath,
    filePreviewService,
    projectExecutionRoots: executionRoots,
    getPrincipal: requireRequestPrincipal,
    ...(projectPathAdmission ? {
      getOwnerId: c => requireRequestPrincipal(c).userId,
      projectPathAdmission,
    } : {}),
  });
  registerProjectAgentContextRoute(app, { executionRoots });
}

export async function registerGatewayProjectDriveRoutes(
  app: Hono,
  options: Parameters<typeof createProductionChatDriveContext>[0],
) {
  const context = createProductionChatDriveContext(options);
  app.route("/", context.routes);
  app.route("/", await createChatDriveProjectRoutes({
    repository: options.repository,
    drives: context.service,
    resolveOwner: c => ({ type: "personal", ownerId: requireRequestPrincipal(c).userId }),
  }));
  return context;
}
