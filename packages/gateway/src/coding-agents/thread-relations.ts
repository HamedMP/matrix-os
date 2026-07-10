import type { CreateAgentThreadRequest } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";

const TASK_PAGE_LIMIT = 100;
const MAX_TASK_PAGES = 10;

interface ProjectRelationSource {
  getProject(projectId: string): Promise<
    | { ok: true; project: { slug: string } }
    | { ok: false; status: number; error: unknown }
  >;
}

interface TaskRelationSource {
  listTasks(projectId: string, input: unknown): Promise<
    | { ok: true; tasks: Array<{ id: string; projectSlug: string }>; nextCursor: string | null }
    | { ok: false; status: number; error: unknown }
  >;
}

export interface CodingAgentThreadRelationValidator {
  validateCreate(principal: RequestPrincipal, request: CreateAgentThreadRequest): Promise<void>;
}

export interface CodingAgentThreadRelationValidatorOptions {
  projectManager: ProjectRelationSource;
  taskManager: TaskRelationSource;
  principalOwnerIds?: readonly string[];
}

export class CodingAgentThreadRelationError extends Error {
  constructor(readonly code: "invalid_relation" | "validation_unavailable") {
    super(code);
    this.name = "CodingAgentThreadRelationError";
  }
}

function boundedOwnerIds(values: readonly string[] | undefined): string[] {
  const ids: string[] = [];
  for (const value of values ?? []) {
    if (!value || ids.includes(value) || ids.length >= 8) continue;
    ids.push(value);
  }
  return ids;
}

function canCreate(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

export function createCodingAgentThreadRelationValidator(
  options: CodingAgentThreadRelationValidatorOptions,
): CodingAgentThreadRelationValidator {
  const ownerIds = boundedOwnerIds(options.principalOwnerIds);

  return {
    async validateCreate(principal, request) {
      if (!request.projectId || !canCreate(principal, ownerIds)) {
        throw new CodingAgentThreadRelationError("invalid_relation");
      }
      const projectResult = await options.projectManager.getProject(request.projectId);
      if (!projectResult.ok || projectResult.project.slug !== request.projectId) {
        throw new CodingAgentThreadRelationError(
          !projectResult.ok && projectResult.status >= 500
            ? "validation_unavailable"
            : "invalid_relation",
        );
      }
      if (!request.taskId) return;

      let cursor: string | undefined;
      for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
        const taskResult = await options.taskManager.listTasks(request.projectId, {
          includeArchived: false,
          limit: TASK_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        if (!taskResult.ok) {
          throw new CodingAgentThreadRelationError(
            taskResult.status >= 500 ? "validation_unavailable" : "invalid_relation",
          );
        }
        if (taskResult.tasks.some((task) =>
          task.id === request.taskId && task.projectSlug === request.projectId
        )) {
          return;
        }
        if (!taskResult.nextCursor) {
          throw new CodingAgentThreadRelationError("invalid_relation");
        }
        if (taskResult.nextCursor === cursor) {
          throw new CodingAgentThreadRelationError("validation_unavailable");
        }
        cursor = taskResult.nextCursor;
      }
      throw new CodingAgentThreadRelationError("invalid_relation");
    },
  };
}
