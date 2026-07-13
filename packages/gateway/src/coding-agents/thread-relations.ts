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
  validateThread?(
    principal: RequestPrincipal,
    relation: { projectId?: string; taskId?: string },
  ): Promise<void>;
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

  async function validateRelation(
    principal: RequestPrincipal,
    relation: { projectId?: string; taskId?: string },
  ): Promise<void> {
    if (!relation.projectId || !canCreate(principal, ownerIds)) {
      throw new CodingAgentThreadRelationError("invalid_relation");
    }
    const projectResult = await options.projectManager.getProject(relation.projectId);
    if (!projectResult.ok || projectResult.project.slug !== relation.projectId) {
      throw new CodingAgentThreadRelationError(
        !projectResult.ok && projectResult.status >= 500
          ? "validation_unavailable"
          : "invalid_relation",
      );
    }
    if (!relation.taskId) return;

    let cursor: string | undefined;
    for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
      const taskResult = await options.taskManager.listTasks(relation.projectId, {
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
        task.id === relation.taskId && task.projectSlug === relation.projectId
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
  }

  return {
    async validateCreate(principal, request) {
      await validateRelation(principal, request);
    },
    async validateThread(principal, relation) {
      await validateRelation(principal, relation);
    },
  };
}
