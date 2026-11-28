import { createNotificationPreferenceRoutes } from "../notifications/routes.js";
import type { Hono } from "hono";
import { createProductionChatDriveContext } from "../chat/drive-context-production.js";
import { createChatDriveProjectRoutes } from "../chat/drive-projects.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import { createCodingAgentProjectMutationService } from "../coding-agents/project-mutations.js";
import { createCodingAgentRoutes, type CodingAgentRouteDeps } from "../coding-agents/routes.js";
import type { LegacyProjectOperationAdmission } from "../collaboration/project-fence.js";
import { resolveRealHomeLocation } from "../collaboration/home-location.js";
import { createLegacyProjectPathAdmission, type LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import { appFileFenceTarget } from "../app-files/paths.js";
import type { FilePreviewService } from "../file-preview-service.js";
import { registerProjectAgentContextRoute } from "../project-agent-context-routes.js";
import type { createProjectManager } from "../project-manager.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { registerFileRoutes } from "./file-routes.js";
import { registerOfficeDocumentRoutes } from "../office/routes.js";

type ProjectManager = ReturnType<typeof createProjectManager>;

type CodingAgentOptions = Omit<CodingAgentRouteDeps, "projectMutations" | "resolveProjectId"> & {
  projects: Pick<ProjectManager, "createProject" | "getProject">;
};

export function registerGatewayCodingAgentRoutes(app: Hono, options: CodingAgentOptions): void {
  const { projects, projectOperationAdmission, ...deps } = options;
  if (deps.notificationPreferences) {
    app.route("/api/notifications", createNotificationPreferenceRoutes({
      store: deps.notificationPreferences.preferences, getPrincipal: deps.getPrincipal,
    }));
  }
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
  /** The document service the kernel tools use; mounted as-is so both share one per-path lock. */
  officeDocumentRoutes?: Hono;
}

/**
 * The write fence over the owner's managed projects, or undefined without a
 * collaboration database. Shared by the owner file routes, the app file
 * bridge and the document service, so all three refuse the same writes.
 * Paths are matched in the home's real location, where folder projects
 * record their roots, so a home reached through a link is fenced like the
 * unlinked home.
 */
export function createGatewayProjectPathAdmission(
  options: Pick<ProjectFileOptions, "homePath" | "projects" | "projectOperationAdmission">,
  resolveTarget?: (homePath: string, path: string) => string | null,
): LegacyProjectPathAdmission | undefined {
  const { homePath, projects, projectOperationAdmission } = options;
  if (!projectOperationAdmission) return undefined;
  return createLegacyProjectPathAdmission({
    homePath,
    projectOperationAdmission,
    resolveHomeLocation: resolveRealHomeLocation,
    ...(resolveTarget ? { resolveTarget } : {}),
    listOwnerProjects: async (ownerType, ownerId) => {
      const result = await projects.listManagedProjects({
        visibility: "all",
        ownerScope: { type: ownerType === "organization" ? "org" : "user", id: ownerId },
      });
      return result.projects.map(project => ({ id: project.id, localPath: project.localPath }));
    },
  });
}

/**
 * The same fence for the app file bridge. It matches paths without
 * synchronous filesystem calls, so an app save or folder creation never
 * blocks other gateway requests while the fence is consulted.
 */
export function createGatewayAppFileProjectPathAdmission(
  options: Pick<ProjectFileOptions, "homePath" | "projects" | "projectOperationAdmission">,
): LegacyProjectPathAdmission | undefined {
  return createGatewayProjectPathAdmission(options, appFileFenceTarget);
}

export function registerGatewayProjectFileRoutes(app: Hono, options: ProjectFileOptions): void {
  const { homePath, filePreviewService, executionRoots } = options;
  const projectPathAdmission = createGatewayProjectPathAdmission(options);
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
  registerOfficeDocumentRoutes(app, options.officeDocumentRoutes ?? { homePath });
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
