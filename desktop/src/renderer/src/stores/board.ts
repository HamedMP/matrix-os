// Project catalog: the computer's projects and the active one. A project's
// task board lives in the shared `@matrix-os/ui/project-board` client, not here.
//   GET  /api/workspace/projects -> { projects: ProjectConfig[], nextCursor: null }
//   POST /api/projects           -> { project }
import { create } from "zustand";
import { z } from "zod/v4";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";

export type ProjectListStatus = "idle" | "loading" | "ready" | "error";

export interface Project {
  id?: string;
  slug: string;
  name: string;
  kind: "scratch" | "github" | "folder";
  archivedAt?: string;
  localPath?: string;
  githubBacked?: boolean;
  github?: { owner: string; repo: string };
  repository?: string;
  defaultBranch?: string;
  description?: string;
  pinned?: boolean;
  updatedAt?: string;
}

const PROJECT_CREATE_TIMEOUT_MS = 30_000;
const PROJECT_CREATE_RETRY_TIMEOUT_MS = 310_000;

const WireProjectSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
  localPath: z.string().min(1).optional(),
  kind: z.enum(["scratch", "github", "folder"]).optional(),
  archivedAt: z.string().datetime().optional(),
  description: z.string().max(1_000).optional(),
  pinned: z.boolean().optional(),
  updatedAt: z.string().max(64).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  github: z.object({ owner: z.string().min(1).max(200), repo: z.string().min(1).max(200) }).passthrough().optional(),
});

export function parseProject(raw: unknown): Project | null {
  const parsed = WireProjectSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    slug: parsed.data.slug,
    name: parsed.data.name,
    kind: parsed.data.kind ?? (parsed.data.github ? "github" : "scratch"),
    ...(parsed.data.archivedAt ? { archivedAt: parsed.data.archivedAt } : {}),
    ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(parsed.data.updatedAt ? { updatedAt: parsed.data.updatedAt } : {}),
    ...(parsed.data.github ? { repository: `${parsed.data.github.owner}/${parsed.data.github.repo}` } : {}),
    ...(parsed.data.defaultBranch ? { defaultBranch: parsed.data.defaultBranch } : {}),
    ...(parsed.data.localPath
      ? { localPath: parsed.data.localPath, githubBacked: parsed.data.github !== undefined }
      : {}),
    ...(parsed.data.github ? { github: parsed.data.github } : {}),
  };
}

function categoryOf(err: unknown): AppErrorCategory {
  return err instanceof AppError ? err.category : "server";
}

interface BoardState {
  projects: Project[];
  projectsStatus: ProjectListStatus;
  projectsError: AppErrorCategory | null;
  activeProjectSlug: string | null;
  error: AppErrorCategory | null;
  loadProjects(api: ApiClient): Promise<boolean>;
  applyProjectMetadata(project: Project): void;
  createProject(api: ApiClient, input: {
    name: string;
    description?: string;
    mode: "scratch" | "github" | "folder";
    url?: string;
    path?: string;
  }): Promise<Project | null>;
  /** Records the project the operator is working in. */
  selectProject(slug: string): void;
  removeProjectState(slug: string): void;
}

export const useBoard = create<BoardState>()((set, get) => {
  let projectListGeneration = 0;
  return {
    projects: [],
    projectsStatus: "idle",
    projectsError: null,
    activeProjectSlug: null,
    error: null,

    applyProjectMetadata: (project) => {
      projectListGeneration += 1;
      set(state => ({ projectsStatus: "ready", projects: state.projects.map(current => current.slug === project.slug && current.id === project.id ? project : current) }));
    },

    loadProjects: async (api) => {
      const loadGeneration = ++projectListGeneration;
      const runtimeGeneration = captureRuntimeGeneration();
      set({ projectsStatus: "loading", projectsError: null });
      try {
        const response = await api.get<{ projects: unknown[] }>("/api/workspace/projects");
        if (!isCurrentRuntimeGeneration(runtimeGeneration) || loadGeneration !== projectListGeneration) return false;
        const projects: Project[] = [];
        for (const raw of response.projects ?? []) {
          const project = parseProject(raw);
          if (project) projects.push(project);
        }
        set({ projects, projectsStatus: "ready", projectsError: null, error: null });
        return true;
      } catch (err: unknown) {
        if (!isCurrentRuntimeGeneration(runtimeGeneration) || loadGeneration !== projectListGeneration) return false;
        console.error("[board] Failed to load projects:", err);
        const error = categoryOf(err);
        set({ projectsStatus: "error", projectsError: error, error });
        return false;
      }
    },

    createProject: async (api, input) => {
      // A create that settles after a computer switch must not repopulate the
      // new computer's board with the previous runtime's projects.
      const runtimeGeneration = captureRuntimeGeneration();
      try {
        const clientRequestId = `req_desktop_project_${crypto.randomUUID()}`;
        const body = input.mode === "github"
          ? { name: input.name, description: input.description, mode: "github" as const, url: input.url, clientRequestId }
          : input.mode === "folder"
            ? { name: input.name, description: input.description, mode: "folder" as const, path: input.path, clientRequestId }
            : { name: input.name, description: input.description, mode: "scratch" as const, clientRequestId };
        const sendCreate = (timeoutMs: number) => api.post<{ project: unknown }>(
          "/api/projects",
          body,
          { timeoutMs },
        );
        let res: { project: unknown };
        try {
          res = await sendCreate(PROJECT_CREATE_TIMEOUT_MS);
        } catch (err: unknown) {
          if (!(err instanceof AppError) || err.category !== "timeout") throw err;
          // The gateway bounds Git cloning at five minutes. Waiting slightly
          // longer on the replay lets the original request finish and return
          // its persisted idempotent result instead of surfacing ambiguity.
          res = await sendCreate(PROJECT_CREATE_RETRY_TIMEOUT_MS);
        }
        if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
        const project = parseProject(res.project);
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

    selectProject: (slug) => set({ activeProjectSlug: slug }),

    removeProjectState: (slug) => {
      set((state) => ({
        projects: state.projects.filter((project) => project.slug !== slug),
        activeProjectSlug: state.activeProjectSlug === slug ? null : state.activeProjectSlug,
      }));
    },
  };
});
