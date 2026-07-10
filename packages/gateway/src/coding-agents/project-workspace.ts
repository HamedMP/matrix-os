import {
  ProjectAgentWorkspaceSchema,
  ProjectSummarySchema,
  SafeDisplayStringSchema,
  TaskAgentSummarySchema,
  type AgentThreadSummary,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { createProjectManager } from "../project-manager.js";
import { createTaskManager } from "../task-manager.js";

export interface CodingAgentProjectWorkspaceQuery {
  taskCursor?: string;
  taskLimit: number;
  projectThreadCursor?: string;
  projectThreadLimit: number;
  taskThreadCursor?: string;
  taskThreadLimit: number;
}

const TASK_RELATION_PAGE_LIMIT = 100;
const MAX_TASK_RELATION_PAGES = 10;

interface CanonicalTask {
  id: string;
  projectSlug: string;
  title: string;
  status: "todo" | "running" | "waiting" | "blocked" | "complete" | "archived";
  priority: "low" | "normal" | "high" | "urgent";
  order: number;
  createdAt: string;
  updatedAt: string;
}

interface CanonicalProjectWorkspaceSource {
  getProject(projectId: string): Promise<
    | { ok: true; project: { slug: string; name: string; updatedAt: string } }
    | { ok: false; status: number; error: unknown }
  >;
}

interface CanonicalTaskWorkspaceSource {
  listTasks(projectId: string, input: unknown): Promise<
    | {
      ok: true;
      tasks: CanonicalTask[];
      nextCursor: string | null;
    }
    | { ok: false; status: number; error: unknown }
  >;
}

export interface CodingAgentTaskThreadAggregate {
  taskId: string;
  threadCount: number;
  activeThreadCount: number;
  attentionCount: number;
  latestThreadAt?: string;
}

export interface CodingAgentProjectThreadProjection {
  projectThreads: { items: AgentThreadSummary[]; hasMore: boolean; nextCursor?: string; limit: number };
  taskThreads: { items: AgentThreadSummary[]; hasMore: boolean; nextCursor?: string; limit: number };
  taskAggregates: CodingAgentTaskThreadAggregate[];
  threadCount: number;
  attentionCount: number;
}

export interface CodingAgentProjectWorkspaceThreadSource {
  getProjectWorkspaceThreads(
    principal: RequestPrincipal,
    projectId: string,
    query: CodingAgentProjectWorkspaceQuery,
    validTaskIds: readonly string[],
  ): Promise<CodingAgentProjectThreadProjection>;
}

export interface CodingAgentProjectWorkspaceStoreOptions {
  projectManager: CanonicalProjectWorkspaceSource;
  taskManager: CanonicalTaskWorkspaceSource;
  threads: CodingAgentProjectWorkspaceThreadSource;
  principalOwnerIds?: readonly string[];
  now?: () => Date;
}

export interface OwnerCodingAgentProjectWorkspaceStoreOptions {
  homePath: string;
  threads?: CodingAgentProjectWorkspaceThreadSource;
  principalOwnerIds?: readonly string[];
  now?: () => Date;
}

export class CodingAgentProjectWorkspaceError extends Error {
  constructor(readonly code: "project_not_found" | "invalid_cursor" | "project_workspace_unavailable") {
    super(code);
    this.name = "CodingAgentProjectWorkspaceError";
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

function canReadWorkspace(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function safeLabel(value: string, fallback: string): string {
  const bounded = value.length <= 120 ? value : `${value.slice(0, 117)}...`;
  const parsed = SafeDisplayStringSchema.safeParse(bounded);
  return parsed.success ? parsed.data : fallback;
}

function boundedOrder(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), 1_000_000);
}

async function loadCanonicalTasks(
  source: CanonicalTaskWorkspaceSource,
  projectId: string,
): Promise<CanonicalTask[]> {
  const tasks: CanonicalTask[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TASK_RELATION_PAGES; page += 1) {
    const result = await source.listTasks(projectId, {
      includeArchived: false,
      limit: TASK_RELATION_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) {
      throw new CodingAgentProjectWorkspaceError(
        result.status === 404 ? "project_not_found" : "project_workspace_unavailable",
      );
    }
    tasks.push(...result.tasks.filter((task) => task.projectSlug === projectId));
    if (!result.nextCursor) return tasks;
    if (result.nextCursor === cursor) {
      throw new CodingAgentProjectWorkspaceError("project_workspace_unavailable");
    }
    cursor = result.nextCursor;
  }
  throw new CodingAgentProjectWorkspaceError("project_workspace_unavailable");
}

export function createCodingAgentProjectWorkspaceStore(options: CodingAgentProjectWorkspaceStoreOptions) {
  const ownerIds = boundedOwnerIds(options.principalOwnerIds);
  const now = options.now ?? (() => new Date());

  return {
    async getProjectWorkspace(
      principal: RequestPrincipal,
      projectId: string,
      query: CodingAgentProjectWorkspaceQuery,
    ) {
      if (!canReadWorkspace(principal, ownerIds)) {
        throw new CodingAgentProjectWorkspaceError("project_not_found");
      }

      const projectResult = await options.projectManager.getProject(projectId);
      if (!projectResult.ok) {
        throw new CodingAgentProjectWorkspaceError(
          projectResult.status === 404 ? "project_not_found" : "project_workspace_unavailable",
        );
      }
      const canonicalTasks = await loadCanonicalTasks(options.taskManager, projectId);
      const cursorIndex = query.taskCursor
        ? canonicalTasks.findIndex((task) => task.id === query.taskCursor)
        : -1;
      if (query.taskCursor && cursorIndex < 0) {
        throw new CodingAgentProjectWorkspaceError("invalid_cursor");
      }
      const taskStart = query.taskCursor ? cursorIndex + 1 : 0;
      const taskWindow = canonicalTasks.slice(taskStart, taskStart + query.taskLimit);
      const taskHasMore = taskStart + taskWindow.length < canonicalTasks.length;
      const threadProjection = await options.threads.getProjectWorkspaceThreads(
        principal,
        projectId,
        query,
        canonicalTasks.map((task) => task.id),
      );
      const tasks = taskWindow.map((task) => {
        const aggregate = threadProjection.taskAggregates.find((candidate) => candidate.taskId === task.id);
        return TaskAgentSummarySchema.parse({
          id: task.id,
          projectId,
          title: safeLabel(task.title, "Task"),
          status: task.status,
          priority: task.priority,
          order: boundedOrder(task.order),
          threadCount: aggregate?.threadCount ?? 0,
          activeThreadCount: aggregate?.activeThreadCount ?? 0,
          attentionCount: aggregate?.attentionCount ?? 0,
          latestThreadAt: aggregate?.latestThreadAt,
        });
      });
      const project = ProjectSummarySchema.parse({
        id: projectId,
        label: safeLabel(projectResult.project.name, "Project"),
        status: "available",
        taskCount: canonicalTasks.length,
        threadCount: threadProjection.threadCount,
        attentionCount: threadProjection.attentionCount,
        updatedAt: projectResult.project.updatedAt,
      });

      return ProjectAgentWorkspaceSchema.parse({
        project,
        tasks: {
          items: tasks,
          hasMore: taskHasMore,
          ...(taskHasMore ? { nextCursor: taskWindow.at(-1)!.id } : {}),
          limit: query.taskLimit,
        },
        projectThreads: threadProjection.projectThreads,
        taskThreads: threadProjection.taskThreads,
        updatedAt: now().toISOString(),
      });
    },
  };
}

const emptyProjectWorkspaceThreads: CodingAgentProjectWorkspaceThreadSource = {
  async getProjectWorkspaceThreads(_principal, _projectId, query, _validTaskIds) {
    return {
      projectThreads: { items: [], hasMore: false, limit: query.projectThreadLimit },
      taskThreads: { items: [], hasMore: false, limit: query.taskThreadLimit },
      taskAggregates: [],
      threadCount: 0,
      attentionCount: 0,
    };
  },
};

export function createOwnerCodingAgentProjectWorkspaceStore(
  options: OwnerCodingAgentProjectWorkspaceStoreOptions,
) {
  return createCodingAgentProjectWorkspaceStore({
    projectManager: createProjectManager({ homePath: options.homePath }),
    taskManager: createTaskManager({ homePath: options.homePath }),
    threads: options.threads ?? emptyProjectWorkspaceThreads,
    principalOwnerIds: options.principalOwnerIds,
    now: options.now,
  });
}
