// Git review surfaces (US4/FR-050..054). Read paths exist in the gateway today;
// diff bodies are a gateway delta (see contracts/gateway-contract.md). Wire
// item shapes mirror project-manager.ts (BranchSummary/PullRequestSummary),
// worktree-manager.ts (WorktreeRecord), preview-manager.ts (PreviewRecord).
import { create } from "zustand";
import { z } from "zod/v4";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";

const BranchSchema = z.object({
  name: z.string().min(1),
  current: z.boolean().optional(),
  default: z.boolean().optional(),
});

const PrSchema = z.object({
  number: z.number(),
  title: z.string().optional(),
  author: z.string().optional(),
  headRef: z.string().optional(),
  baseRef: z.string().optional(),
  state: z.string().optional(),
});

const WorktreePrSchema = z.object({
  number: z.number(),
  title: z.string().optional(),
  headRef: z.string().optional(),
  baseRef: z.string().optional(),
});

const WorktreeSchema = z.object({
  id: z.string().min(1),
  projectSlug: z.string().optional(),
  path: z.string().optional(),
  sourceBranch: z.string().optional(),
  currentBranch: z.string().optional(),
  dirtyState: z.string().optional(),
  createdAt: z.string().optional(),
  pr: WorktreePrSchema.optional(),
});

const PreviewSchema = z.object({
  id: z.string().min(1),
  projectSlug: z.string().optional(),
  taskId: z.string().nullable().optional(),
  label: z.string().optional(),
  url: z.string().optional(),
  lastStatus: z.string().optional(),
  displayPreference: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type Branch = z.infer<typeof BranchSchema>;
export type PullRequest = z.infer<typeof PrSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type Preview = z.infer<typeof PreviewSchema>;
interface PreviewScope {
  projectSlug: string;
  taskId: string | null;
}

// Higher = worse; loadAll surfaces the worst category across failing surfaces.
const SEVERITY: Record<AppErrorCategory, number> = {
  unauthorized: 6,
  server: 5,
  misconfigured: 4,
  offline: 3,
  timeout: 2,
  fatalSession: 1,
  notFound: 0,
};

function categoryOf(err: unknown): AppErrorCategory {
  return err instanceof AppError ? err.category : "server";
}

function worstCategory(categories: AppErrorCategory[]): AppErrorCategory {
  return categories.reduce((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst));
}

function parseRows<T>(schema: z.ZodType<T>, rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const row of rows) {
    const result = schema.safeParse(row);
    if (result.success) out.push(result.data);
    else console.warn("[git] skipping malformed row");
  }
  return out;
}

let loadAllRequestSeq = 0;

interface GitState {
  branches: Branch[];
  prs: PullRequest[];
  worktrees: Worktree[];
  previews: Preview[];
  previewScope: PreviewScope | null;
  refreshedAt: string | null;
  loading: boolean;
  error: AppErrorCategory | null;
  loadAll(api: ApiClient, slug: string): Promise<void>;
  loadPreviews(api: ApiClient, slug: string, taskId?: string): Promise<void>;
  createWorktree(api: ApiClient, slug: string, input: { branch: string } | { pr: number }): Promise<Worktree | null>;
}

export const useGit = create<GitState>()((set, get) => ({
  branches: [],
  prs: [],
  worktrees: [],
  previews: [],
  previewScope: null,
  refreshedAt: null,
  loading: false,
  error: null,

  loadAll: async (api, slug) => {
    const requestSeq = ++loadAllRequestSeq;
    set({ branches: [], prs: [], worktrees: [], refreshedAt: null, loading: true, error: null });
    const failures: AppErrorCategory[] = [];
    const patch: Partial<GitState> = {};
    let branchRefreshed: string | undefined;
    let prRefreshed: string | undefined;

    await Promise.all([
      (async () => {
        try {
          const res = await api.get<{ branches?: unknown; refreshedAt?: unknown }>(
            `/api/projects/${slug}/branches`,
          );
          patch.branches = parseRows(BranchSchema, res.branches);
          if (typeof res.refreshedAt === "string") branchRefreshed = res.refreshedAt;
        } catch (err: unknown) {
          failures.push(categoryOf(err));
        }
      })(),
      (async () => {
        try {
          const res = await api.get<{ prs?: unknown; refreshedAt?: unknown }>(
            `/api/projects/${slug}/prs`,
          );
          patch.prs = parseRows(PrSchema, res.prs);
          if (typeof res.refreshedAt === "string") prRefreshed = res.refreshedAt;
        } catch (err: unknown) {
          failures.push(categoryOf(err));
        }
      })(),
      (async () => {
        try {
          const res = await api.get<{ worktrees?: unknown }>(`/api/projects/${slug}/worktrees`);
          patch.worktrees = parseRows(WorktreeSchema, res.worktrees);
        } catch (err: unknown) {
          failures.push(categoryOf(err));
        }
      })(),
    ]);

    set((state) => {
      if (requestSeq !== loadAllRequestSeq) {
        return {};
      }
      return {
        ...patch,
        refreshedAt: prRefreshed ?? branchRefreshed ?? state.refreshedAt,
        loading: false,
        error: failures.length > 0 ? worstCategory(failures) : null,
      };
    });
  },

  loadPreviews: async (api, slug, taskId) => {
    const scope: PreviewScope = { projectSlug: slug, taskId: taskId ?? null };
    const query = taskId ? `?limit=100&taskId=${encodeURIComponent(taskId)}` : "?limit=100";
    set({ previews: [], previewScope: scope });
    try {
      const res = await api.get<{ previews?: unknown }>(`/api/projects/${slug}/previews${query}`);
      set((state) => {
        if (
          state.previewScope?.projectSlug !== scope.projectSlug ||
          state.previewScope.taskId !== scope.taskId
        ) {
          return {};
        }
        return { previews: parseRows(PreviewSchema, res.previews), error: null };
      });
    } catch (err: unknown) {
      set((state) => {
        if (
          state.previewScope?.projectSlug !== scope.projectSlug ||
          state.previewScope.taskId !== scope.taskId
        ) {
          return {};
        }
        return { error: categoryOf(err) };
      });
    }
  },

  createWorktree: async (api, slug, input) => {
    try {
      const res = await api.post<{ worktree?: unknown }>(`/api/projects/${slug}/worktrees`, input);
      const parsed = WorktreeSchema.safeParse(res.worktree);
      if (!parsed.success) {
        console.warn("[git] createWorktree returned a malformed worktree");
        set({ error: "server" });
        return null;
      }
      const worktree = parsed.data;
      set((state) => ({
        worktrees: [...state.worktrees.filter((w) => w.id !== worktree.id), worktree],
        error: null,
      }));
      return worktree;
    } catch (err: unknown) {
      set({ error: categoryOf(err) });
      return null;
    }
  },
}));
