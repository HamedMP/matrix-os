// Board (kanban) store. Wire shapes verified against
// packages/gateway/src/workspace-routes.ts + task-manager.ts:
//   GET  /api/workspace/projects            -> { projects: ProjectConfig[], nextCursor: null }
//   GET  /api/projects/{slug}/tasks         -> { tasks: TaskRecord[], nextCursor: string|null }
//   POST /api/projects/{slug}/tasks         -> { task: TaskRecord }
//   PATCH/DELETE /api/projects/{slug}/tasks/{id} -> { task } / { ok: true }
// Server is last-write-wins, so mutations are serialized per task and stale
// writes trigger a refetch instead of a silent overwrite (FR-011).
import { create } from "zustand";
import { z } from "zod/v4";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";

export type CardStatus = "todo" | "running" | "waiting" | "blocked" | "complete" | "archived";
export type CardPriority = "low" | "normal" | "high" | "urgent";

export interface Card {
  id: string;
  projectSlug: string;
  title: string;
  description: string;
  status: CardStatus;
  priority: CardPriority;
  order: number;
  parentTaskId: string | null;
  linkedSessionId: string | null;
  linkedWorktreeId: string | null;
  previewIds: string[];
  tags: string[];
  updatedAt: string | null;
  revision: number | null;
}

export interface Project {
  slug: string;
  name: string;
  localPath?: string;
  githubBacked?: boolean;
}

export const BOARD_COLUMNS: readonly CardStatus[] = [
  "todo",
  "running",
  "waiting",
  "blocked",
  "complete",
];

const CardStatusSchema = z.enum(["todo", "running", "waiting", "blocked", "complete", "archived"]);

const WireTaskSchema = z.object({
  id: z.string().min(1),
  projectSlug: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  status: CardStatusSchema,
  priority: z.enum(["low", "normal", "high", "urgent"]),
  order: z.number(),
  parentTaskId: z.string().nullish(),
  linkedSessionId: z.string().nullish(),
  linkedWorktreeId: z.string().nullish(),
  previewIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  updatedAt: z.string().nullish(),
  revision: z.number().nullish(),
});

const WireProjectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  localPath: z.string().min(1).optional(),
  github: z.object({ owner: z.string(), repo: z.string() }).passthrough().optional(),
});

function toProject(raw: unknown): Project | null {
  const parsed = WireProjectSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    slug: parsed.data.slug,
    name: parsed.data.name,
    ...(parsed.data.localPath
      ? { localPath: parsed.data.localPath, githubBacked: parsed.data.github !== undefined }
      : {}),
  };
}

function toCard(raw: unknown): Card | null {
  const parsed = WireTaskSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[board] Ignoring task with unexpected wire shape");
    return null;
  }
  const task = parsed.data;
  return {
    id: task.id,
    projectSlug: task.projectSlug,
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    order: task.order,
    parentTaskId: task.parentTaskId ?? null,
    linkedSessionId: task.linkedSessionId ?? null,
    linkedWorktreeId: task.linkedWorktreeId ?? null,
    previewIds: task.previewIds,
    tags: task.tags,
    updatedAt: task.updatedAt ?? null,
    revision: task.revision ?? null,
  };
}

export function groupCardsByColumn(cards: Card[]): Record<CardStatus, Card[]> {
  const grouped: Record<CardStatus, Card[]> = {
    todo: [],
    running: [],
    waiting: [],
    blocked: [],
    complete: [],
    archived: [],
  };
  for (const card of cards) {
    if (card.status === "archived") continue;
    grouped[card.status].push(card);
  }
  for (const status of BOARD_COLUMNS) {
    grouped[status].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  return grouped;
}

function categoryOf(err: unknown): AppErrorCategory {
  return err instanceof AppError ? err.category : "server";
}

const TASKS_PAGE_LIMIT = 100;
const MAX_TASK_PAGES = 10;
const MAX_PENDING_TASK_MUTATIONS = 250;

// Per-task in-flight chains so two rapid mutations cannot interleave. The
// stored tail never rejects, while the returned promise preserves the caller's
// success/failure result. Entries evict themselves once their chain settles,
// and the live map has a hard cap.
const taskMutationTails = new Map<string, Promise<void>>();

function canEnqueueTaskMutation(taskId: string): boolean {
  return taskMutationTails.has(taskId) || taskMutationTails.size < MAX_PENDING_TASK_MUTATIONS;
}

function enqueueTaskMutation(taskId: string, fn: () => Promise<void>): Promise<void> {
  if (!canEnqueueTaskMutation(taskId)) {
    return Promise.reject(new AppError("server"));
  }
  const tail = taskMutationTails.get(taskId) ?? Promise.resolve();
  const run = tail.then(fn);
  const storedTail = run.catch(() => undefined);
  taskMutationTails.set(taskId, storedTail);
  void storedTail.finally(() => {
    if (taskMutationTails.get(taskId) === storedTail) taskMutationTails.delete(taskId);
  });
  return run;
}

function taskPath(slug: string, taskId?: string): string {
  const base = `/api/projects/${encodeURIComponent(slug)}/tasks`;
  return taskId === undefined ? base : `${base}/${encodeURIComponent(taskId)}`;
}

async function fetchAllTasks(api: ApiClient, slug: string): Promise<Card[]> {
  const cards: Card[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const response: { tasks: unknown[]; nextCursor: string | null } = await api.get(
      `${taskPath(slug)}?limit=${TASKS_PAGE_LIMIT}${query}`,
    );
    for (const raw of response.tasks ?? []) {
      const card = toCard(raw);
      if (card) cards.push(card);
    }
    if (!response.nextCursor) break;
    cursor = response.nextCursor;
  }
  return cards;
}

export interface TaskEventCreated {
  type: "task:created";
  task: unknown;
}

export interface TaskEventUpdated {
  type: "task:updated";
  taskId: string;
  status: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: CardStatus;
  priority?: CardPriority;
}

export type CardPatch = Partial<Pick<Card, "title" | "description" | "status" | "priority" | "order">>;

interface BoardState {
  projects: Project[];
  activeProjectSlug: string | null;
  cardsByProject: Record<string, Card[]>;
  firstLoadByProject: Record<string, boolean>;
  refreshing: boolean;
  error: AppErrorCategory | null;
  loadProjects(api: ApiClient): Promise<boolean>;
  createProject(api: ApiClient, input: {
    name: string;
    mode: "scratch" | "github" | "folder";
    url?: string;
    path?: string;
  }): Promise<Project | null>;
  selectProject(api: ApiClient, slug: string): Promise<void>;
  refreshTasks(api: ApiClient, slug: string): Promise<void>;
  createTask(api: ApiClient, slug: string, input: CreateTaskInput): Promise<Card | null>;
  updateTask(api: ApiClient, slug: string, taskId: string, patch: CardPatch): Promise<void>;
  linkSession(
    api: ApiClient,
    slug: string,
    taskId: string,
    fields: { linkedSessionId?: string; linkedWorktreeId?: string; status?: CardStatus },
  ): Promise<void>;
  moveTask(api: ApiClient, slug: string, taskId: string, status: CardStatus, order: number): Promise<void>;
  archiveTask(api: ApiClient, slug: string, taskId: string): Promise<void>;
  deleteTask(api: ApiClient, slug: string, taskId: string): Promise<void>;
  applyTaskEvent(event: TaskEventCreated | TaskEventUpdated): void;
}

export const useBoard = create<BoardState>()((set, get) => {
  function replaceProjectCards(slug: string, cards: Card[]): void {
    set((state) => ({ cardsByProject: { ...state.cardsByProject, [slug]: cards } }));
  }

  function patchCard(slug: string, taskId: string, apply: (card: Card) => Card): void {
    set((state) => {
      const cards = state.cardsByProject[slug];
      if (!cards) return state;
      return {
        cardsByProject: {
          ...state.cardsByProject,
          [slug]: cards.map((card) => (card.id === taskId ? apply(card) : card)),
        },
      };
    });
  }

  async function refreshInto(api: ApiClient, slug: string): Promise<void> {
    const runtimeGeneration = captureRuntimeGeneration();
    set({ refreshing: true });
    try {
      const cards = await fetchAllTasks(api, slug);
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
      replaceProjectCards(slug, cards);
      set({ refreshing: false, error: null });
    } catch (err: unknown) {
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
      console.error("[board] Failed to load tasks:", err);
      set({ refreshing: false, error: categoryOf(err) });
    }
  }

  function mutateTask(
    api: ApiClient,
    slug: string,
    taskId: string,
    patch: CardPatch,
  ): Promise<void> {
    const before = get().cardsByProject[slug]?.find((card) => card.id === taskId);
    if (!before) return Promise.resolve();
    if (!canEnqueueTaskMutation(taskId)) {
      set({ error: "server" });
      return Promise.resolve();
    }
    const runtimeGeneration = captureRuntimeGeneration();
    patchCard(slug, taskId, (card) => ({ ...card, ...patch }));
    return enqueueTaskMutation(taskId, async () => {
      try {
        const response = await api.patch<{ task: unknown }>(taskPath(slug, taskId), patch);
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
        const card = toCard(response.task);
        if (card) patchCard(slug, taskId, () => card);
        set({ error: null });
      } catch (err: unknown) {
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
        console.error("[board] Task update failed:", err);
        patchCard(slug, taskId, () => before);
        // FR-011: a rejected write may mean our base was stale — converge on
        // server truth instead of silently overwriting, then surface the
        // mutation failure (the refetch must not clear it).
        await refreshInto(api, slug);
        set({ error: categoryOf(err) });
      }
    });
  }

  return {
    projects: [],
    activeProjectSlug: null,
    cardsByProject: {},
    firstLoadByProject: {},
    refreshing: false,
    error: null,

    loadProjects: async (api) => {
      const runtimeGeneration = captureRuntimeGeneration();
      try {
        const response = await api.get<{ projects: unknown[] }>("/api/workspace/projects");
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
        const projects: Project[] = [];
        for (const raw of response.projects ?? []) {
          const project = toProject(raw);
          if (project) projects.push(project);
        }
        set({ projects, error: null });
        return true;
      } catch (err: unknown) {
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
        console.error("[board] Failed to load projects:", err);
        set({ error: categoryOf(err) });
        return false;
      }
    },

    createProject: async (api, input) => {
      // A create that settles after a computer switch must not repopulate the
      // new computer's board with the previous runtime's projects.
      const runtimeGeneration = captureRuntimeGeneration();
      try {
        const body = input.mode === "github"
          ? { name: input.name, mode: "github" as const, url: input.url }
          : input.mode === "folder"
            ? { name: input.name, mode: "folder" as const, path: input.path }
            : { name: input.name, mode: "scratch" as const };
        const res = await api.post<{ project: unknown }>("/api/projects", body);
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        const project = toProject(res.project);
        if (!project) {
          const refreshed = await get().loadProjects(api);
          set({ error: refreshed ? "server" : get().error });
          return null;
        }
        // Refresh the list so the sidebar shows it immediately.
        const refreshed = await get().loadProjects(api);
        if (refreshed) set({ error: null });
        return project;
      } catch (err: unknown) {
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        console.error("[board] Create project failed:", err);
        set({ error: categoryOf(err) });
        return null;
      }
    },

    selectProject: async (api, slug) => {
      const hasCache = get().cardsByProject[slug] !== undefined;
      // L11: the skeleton shows only when this project has never loaded;
      // otherwise cached cards stay visible while we revalidate.
      set((state) => ({
        activeProjectSlug: slug,
        firstLoadByProject: { ...state.firstLoadByProject, [slug]: !hasCache },
      }));
      try {
        await refreshInto(api, slug);
      } finally {
        set((state) => ({ firstLoadByProject: { ...state.firstLoadByProject, [slug]: false } }));
      }
    },

    refreshTasks: async (api, slug) => {
      await refreshInto(api, slug);
    },

    createTask: async (api, slug, input) => {
      const runtimeGeneration = captureRuntimeGeneration();
      try {
        const response = await api.post<{ task: unknown }>(taskPath(slug), input);
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        const card = toCard(response.task);
        if (!card) {
          set({ error: "server" });
          return null;
        }
        set((state) => ({
          cardsByProject: {
            ...state.cardsByProject,
            [slug]: (state.cardsByProject[slug] ?? []).some((existing) => existing.id === card.id)
              ? (state.cardsByProject[slug] ?? [])
              : [...(state.cardsByProject[slug] ?? []), card],
          },
          error: null,
        }));
        return card;
      } catch (err: unknown) {
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        console.error("[board] Task create failed:", err);
        set({ error: categoryOf(err) });
        return null;
      }
    },

    updateTask: (api, slug, taskId, patch) => mutateTask(api, slug, taskId, patch),

    linkSession: (api, slug, taskId, fields) => {
      const before = get().cardsByProject[slug]?.find((card) => card.id === taskId);
      if (!before) {
        const err = new AppError("server");
        set({ error: err.category });
        return Promise.reject(err);
      }
      patchCard(slug, taskId, (card) => ({
        ...card,
        ...(fields.linkedSessionId !== undefined ? { linkedSessionId: fields.linkedSessionId } : {}),
        ...(fields.linkedWorktreeId !== undefined ? { linkedWorktreeId: fields.linkedWorktreeId } : {}),
        ...(fields.status !== undefined ? { status: fields.status } : {}),
      }));
      const runtimeGeneration = captureRuntimeGeneration();
      return enqueueTaskMutation(taskId, async () => {
        try {
          const response = await api.patch<{ task: unknown }>(taskPath(slug, taskId), fields);
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
          const card = toCard(response.task);
          if (card) patchCard(slug, taskId, () => card);
          set({ error: null });
        } catch (err: unknown) {
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
          console.error("[board] Link session failed:", err);
          patchCard(slug, taskId, () => before);
          await refreshInto(api, slug);
          set({ error: categoryOf(err) });
          throw err;
        }
      });
    },

    moveTask: (api, slug, taskId, status, order) =>
      mutateTask(api, slug, taskId, { status, order }),

    archiveTask: (api, slug, taskId) => {
      const cards = get().cardsByProject[slug];
      if (!cards?.some((card) => card.id === taskId)) return Promise.resolve();
      if (!canEnqueueTaskMutation(taskId)) {
        set({ error: "server" });
        return Promise.resolve();
      }
      const runtimeGeneration = captureRuntimeGeneration();
      return enqueueTaskMutation(taskId, async () => {
        try {
          const response = await api.patch<{ task: unknown }>(taskPath(slug, taskId), {
            status: "archived",
          });
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
          const card = toCard(response.task);
          if (card) patchCard(slug, taskId, () => card);
          set({ error: null });
        } catch (err: unknown) {
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
          console.error("[board] Task archive failed:", err);
          set({ error: categoryOf(err) });
        }
      });
    },

    deleteTask: (api, slug, taskId) => {
      const cards = get().cardsByProject[slug];
      if (!cards?.some((card) => card.id === taskId)) return Promise.resolve();
      if (!canEnqueueTaskMutation(taskId)) {
        set({ error: "server" });
        return Promise.resolve();
      }
      const runtimeGeneration = captureRuntimeGeneration();
      return enqueueTaskMutation(taskId, async () => {
        try {
          await api.delete<{ ok: boolean }>(taskPath(slug, taskId));
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
          set((state) => {
            const current = state.cardsByProject[slug] ?? [];
            return {
              cardsByProject: {
                ...state.cardsByProject,
                [slug]: current.filter((card) => card.id !== taskId),
              },
              error: null,
            };
          });
        } catch (err: unknown) {
          if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
          console.error("[board] Task delete failed:", err);
          set({ error: categoryOf(err) });
        }
      });
    },

    applyTaskEvent: (event) => {
      if (event.type === "task:created") {
        const card = toCard(event.task);
        if (!card) return;
        set((state) => {
          const cards = state.cardsByProject[card.projectSlug] ?? [];
          if (cards.some((existing) => existing.id === card.id)) return state;
          return {
            cardsByProject: {
              ...state.cardsByProject,
              [card.projectSlug]: [...cards, card],
            },
          };
        });
        return;
      }
      const status = CardStatusSchema.safeParse(event.status);
      if (!status.success) return;
      set((state) => {
        const cardsByProject = { ...state.cardsByProject };
        let changed = false;
        for (const [slug, cards] of Object.entries(cardsByProject)) {
          if (!cards.some((card) => card.id === event.taskId)) continue;
          cardsByProject[slug] = cards.map((card) =>
            card.id === event.taskId ? { ...card, status: status.data } : card,
          );
          changed = true;
        }
        return changed ? { cardsByProject } : state;
      });
    },
  };
});
