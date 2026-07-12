import {
  CodingAgentProjectCreateRequestSchema,
  CodingAgentProjectCreateResponseSchema,
  type CodingAgentProjectCreateRequest,
  type CodingAgentProjectCreateResponse,
} from "@matrix-os/contracts";
import type { createProjectManager } from "../project-manager.js";
import type { RequestPrincipal } from "../request-principal.js";

type ProjectManager = Pick<ReturnType<typeof createProjectManager>, "createProject">;

export class CodingAgentProjectMutationError extends Error {
  constructor(
    readonly code: "project_invalid" | "project_conflict" | "project_create_unavailable",
    readonly status: 400 | 409 | 503,
  ) {
    super(code);
  }
}

export interface CodingAgentProjectMutationResult {
  status: 200 | 201;
  response: CodingAgentProjectCreateResponse;
}

export function createCodingAgentProjectMutationService(options: { projects: ProjectManager }) {
  return {
    async createProject(
      principal: RequestPrincipal,
      rawRequest: CodingAgentProjectCreateRequest,
    ): Promise<CodingAgentProjectMutationResult> {
      const request = CodingAgentProjectCreateRequestSchema.parse(rawRequest);
      const result = await options.projects.createProject({
        mode: request.mode,
        ...(request.mode === "scratch"
          ? { name: request.name, slug: request.slug }
          : { url: request.repositoryUrl, slug: request.slug }),
        ownerScope: { type: "user", id: principal.userId },
        clientRequestId: request.clientRequestId,
      });
      if (!result.ok) {
        if (result.status === 400 || result.status === 401) {
          throw new CodingAgentProjectMutationError("project_invalid", 400);
        }
        if (result.status === 409) {
          throw new CodingAgentProjectMutationError("project_conflict", 409);
        }
        throw new CodingAgentProjectMutationError("project_create_unavailable", 503);
      }
      const status = result.status === 200 ? 200 : 201;
      return {
        status,
        response: CodingAgentProjectCreateResponseSchema.parse({
          project: {
            id: result.project.slug,
            label: result.project.name,
            status: "available",
            taskCount: 0,
            threadCount: 0,
            attentionCount: 0,
            updatedAt: result.project.updatedAt,
          },
          existing: status === 200,
        }),
      };
    },
  };
}

export type CodingAgentProjectMutationService = ReturnType<typeof createCodingAgentProjectMutationService>;
