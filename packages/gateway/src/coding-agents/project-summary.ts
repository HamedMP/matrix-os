import { ProjectSummarySchema } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { createProjectManager } from "../project-manager.js";
import { createTaskManager } from "../task-manager.js";
import {
  CODING_AGENT_PROJECT_SUMMARY_LIMIT,
  type CodingAgentProjectSummaryStore,
} from "./runtime-summary.js";

const TASK_COUNT_LIMIT = 100;
const TASK_READ_CONCURRENCY = 8;

type ProjectSummary = ReturnType<typeof ProjectSummarySchema.parse>;

interface CanonicalProjectSummarySource {
  listManagedProjects(): Promise<{
    projects: Array<{ slug: string; name: string; updatedAt: string }>;
    nextCursor: string | null;
  }>;
}

interface CanonicalTaskSummarySource {
  listTasks(projectId: string, input: unknown): Promise<
    | { ok: true; tasks: Array<{ id: string }>; nextCursor: string | null }
    | { ok: false; status: number; error: unknown }
  >;
}

interface ProjectThreadSummarySource {
  listProjectCounts(principal: RequestPrincipal): Promise<Array<{
    projectId: string;
    threadCount: number;
    attentionCount: number;
  }>>;
}

export interface CodingAgentProjectSummaryStoreOptions {
  projectManager: CanonicalProjectSummarySource;
  taskManager: CanonicalTaskSummarySource;
  threads?: ProjectThreadSummarySource;
  principalOwnerIds?: readonly string[];
}

export interface OwnerCodingAgentProjectSummaryStoreOptions {
  homePath: string;
  threads?: ProjectThreadSummarySource;
  principalOwnerIds?: readonly string[];
}

function boundedOwnerIds(values: readonly string[] | undefined): string[] {
  const ids: string[] = [];
  for (const value of values ?? []) {
    if (!value || ids.includes(value) || ids.length >= 8) continue;
    ids.push(value);
  }
  return ids;
}

function canReadProjects(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<R | undefined> = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]!);
    }
  });
  await Promise.all(workers);
  return results as R[];
}

export function createCodingAgentProjectSummaryStore(
  options: CodingAgentProjectSummaryStoreOptions,
): CodingAgentProjectSummaryStore {
  const ownerIds = boundedOwnerIds(options.principalOwnerIds);

  return {
    async listProjectSummaries(principal, signal) {
      if (!canReadProjects(principal, ownerIds)) {
        return { items: [], hasMore: false, limit: CODING_AGENT_PROJECT_SUMMARY_LIMIT };
      }

      signal.throwIfAborted();
      const projectResult = await awaitWithAbort(options.projectManager.listManagedProjects(), signal);
      const rawProjects = projectResult.projects
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.slug.localeCompare(right.slug));
      const projectWindow = rawProjects.slice(0, CODING_AGENT_PROJECT_SUMMARY_LIMIT);
      signal.throwIfAborted();
      const threadCounts = options.threads
        ? await awaitWithAbort(options.threads.listProjectCounts(principal), signal)
        : [];

      const summaries = await mapWithConcurrency(projectWindow, TASK_READ_CONCURRENCY, async (project) => {
        signal.throwIfAborted();
        const taskResult = await awaitWithAbort(
          options.taskManager.listTasks(project.slug, {
            includeArchived: false,
            limit: TASK_COUNT_LIMIT,
          }),
          signal,
        );
        const counts = threadCounts.find((candidate) => candidate.projectId === project.slug);
        return ProjectSummarySchema.safeParse({
          id: project.slug,
          label: project.name,
          status: "available",
          taskCount: taskResult.ok ? taskResult.tasks.length : 0,
          threadCount: counts?.threadCount ?? 0,
          attentionCount: counts?.attentionCount ?? 0,
          updatedAt: project.updatedAt,
        });
      });
      const items: ProjectSummary[] = summaries.flatMap((parsed) => parsed.success ? [parsed.data] : []);

      return {
        items,
        hasMore: projectResult.nextCursor !== null || rawProjects.length > CODING_AGENT_PROJECT_SUMMARY_LIMIT,
        limit: CODING_AGENT_PROJECT_SUMMARY_LIMIT,
      };
    },
  };
}

export function createOwnerCodingAgentProjectSummaryStore(
  options: OwnerCodingAgentProjectSummaryStoreOptions,
): CodingAgentProjectSummaryStore {
  return createCodingAgentProjectSummaryStore({
    projectManager: createProjectManager({ homePath: options.homePath }),
    taskManager: createTaskManager({ homePath: options.homePath }),
    threads: options.threads,
    principalOwnerIds: options.principalOwnerIds,
  });
}
