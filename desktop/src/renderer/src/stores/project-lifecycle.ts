import { create } from "zustand";
import { AppError, categoryMessage } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";
import { readSystemVersionIdentity } from "../lib/system-version";
import { parseProject, type Project, useBoard } from "./board";
import { useCodingAgentWorkspace } from "./coding-agent-workspace";
import { clearProjectView } from "./project-view";
import { clearProjectWorkspace } from "./project-workspaces";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";
import { useTabs } from "./tabs";

type LifecycleAction =
  | { type: "archive" }
  | { type: "restore" }
  | { type: "rename"; name: string }
  | { type: "delete"; confirmation: string };

const SAFE_ACTION_ERRORS: Record<string, string> = {
  project_active: "Stop active project work before continuing.",
  confirmation_mismatch: "Enter the exact project name to continue.",
  activity_check_failed: "Project activity could not be checked. Try again.",
  delete_incomplete: "Project deletion could not be completed. Try again.",
};

const PROJECT_ACTIONS_UNAVAILABLE =
  "Project management is unavailable on this computer. Restart Matrix services and try again.";
const PROJECT_UPDATE_INCOMPLETE =
  "This computer has not finished applying its update. Restart Matrix services, then try again.";

async function safeActionError(api: ApiClient, error: unknown): Promise<string> {
  if (error instanceof AppError) {
    if (error.category === "notFound" && !error.detail) {
      try {
        const info = await api.get<unknown>("/api/system/info");
        const { installedVersion, runningVersion } = readSystemVersionIdentity(info);
        if (installedVersion && runningVersion && installedVersion !== runningVersion) {
          return PROJECT_UPDATE_INCOMPLETE;
        }
      } catch (_diagnosticError: unknown) {
        console.warn("[project-lifecycle] Gateway runtime identity could not be inspected");
      }
      return PROJECT_ACTIONS_UNAVAILABLE;
    }
    return (error.detail && SAFE_ACTION_ERRORS[error.detail]) || categoryMessage(error.category);
  }
  return categoryMessage("server");
}

function lifecyclePath(slug: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/actions`;
}

interface ProjectLifecycleState {
  archivedProjects: Project[];
  loading: boolean;
  pendingProjectSlug: string | null;
  error: string | null;
  clearError(): void;
  loadArchivedProjects(api: ApiClient): Promise<boolean>;
  archiveProject(api: ApiClient, slug: string): Promise<boolean>;
  restoreProject(api: ApiClient, slug: string): Promise<boolean>;
  renameProject(api: ApiClient, slug: string, name: string): Promise<boolean>;
  deleteProject(api: ApiClient, slug: string, confirmation: string): Promise<boolean>;
}

export const useProjectLifecycle = create<ProjectLifecycleState>()((set, get) => {
  async function loadArchivedProjects(api: ApiClient): Promise<boolean> {
    const generation = captureRuntimeGeneration();
    set({ loading: true });
    try {
      const response = await api.get<{ projects: unknown[] }>("/api/workspace/projects?visibility=archived");
      if (!isCurrentRuntimeGeneration(generation)) return false;
      const archivedProjects = (response.projects ?? [])
        .map(parseProject)
        .filter((project): project is Project => project?.archivedAt !== undefined);
      set({ archivedProjects, loading: false, error: null });
      return true;
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation)) return false;
      const message = await safeActionError(api, error);
      if (!isCurrentRuntimeGeneration(generation)) return false;
      set({ loading: false, error: message });
      return false;
    }
  }

  async function applyAction(api: ApiClient, slug: string, action: LifecycleAction): Promise<boolean> {
    const generation = captureRuntimeGeneration();
    set({ pendingProjectSlug: slug, error: null });
    try {
      await api.post(lifecyclePath(slug), action);
      if (!isCurrentRuntimeGeneration(generation)) return false;
      if (action.type === "archive" || action.type === "delete") {
        useBoard.getState().removeProjectState(slug);
        useTabs.getState().closeProjectTabs(slug);
        clearProjectWorkspace(slug);
        clearProjectView(slug);
      }
      const [activeLoaded, archivedLoaded] = await Promise.all([
        useBoard.getState().loadProjects(api),
        get().loadArchivedProjects(api),
      ]);
      if (!isCurrentRuntimeGeneration(generation)) return false;
      void useCodingAgentWorkspace.getState().refresh();
      set({
        pendingProjectSlug: null,
        error: activeLoaded && archivedLoaded
          ? null
          : "Project updated, but project lists could not be refreshed. Try again.",
      });
      return true;
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation)) return false;
      const message = await safeActionError(api, error);
      if (!isCurrentRuntimeGeneration(generation)) return false;
      set({ pendingProjectSlug: null, error: message });
      return false;
    }
  }

  return {
    archivedProjects: [],
    loading: false,
    pendingProjectSlug: null,
    error: null,
    clearError: () => set({ error: null }),
    loadArchivedProjects,
    archiveProject: (api, slug) => applyAction(api, slug, { type: "archive" }),
    restoreProject: (api, slug) => applyAction(api, slug, { type: "restore" }),
    renameProject: (api, slug, name) => applyAction(api, slug, { type: "rename", name }),
    deleteProject: (api, slug, confirmation) => applyAction(api, slug, { type: "delete", confirmation }),
  };
});
