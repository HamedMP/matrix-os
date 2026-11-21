// Electron Desktop transport and navigation for the shared add-project flow.
import { FOLDER_CONFLICT_COPY, type AddProjectSubmitContext } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { AppError, toUserMessage } from "../../lib/errors";
import { useBoard, type Project } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { cloneProject } from "./clone-project";

const MKDIR_TIMEOUT_MS = 30_000;
// The gateway bounds folder creation; a replay with the same request ID
// returns the original persisted result instead of surfacing ambiguity.
const MKDIR_RETRY_TIMEOUT_MS = 310_000;

async function createFolder(api: ApiClient, body: { name: string; parent: string; clientRequestId: string }) {
  try {
    let created: { path?: unknown };
    try {
      created = await api.post<{ path?: unknown }>("/api/projects/mkdir", body, { timeoutMs: MKDIR_TIMEOUT_MS });
    } catch (err: unknown) {
      if (!(err instanceof AppError) || err.category !== "timeout") throw err;
      created = await api.post<{ path?: unknown }>("/api/projects/mkdir", body, { timeoutMs: MKDIR_RETRY_TIMEOUT_MS });
    }
    if (typeof created.path !== "string" || created.path.length === 0) {
      return { ok: false as const, message: "Couldn't create the folder. Try again." };
    }
    return { ok: true as const, value: created.path };
  } catch (err: unknown) {
    return {
      ok: false as const,
      message: err instanceof AppError && err.detail === "folder_conflict" ? FOLDER_CONFLICT_COPY : toUserMessage(err),
    };
  }
}

export function createDesktopAddProjectContext(options: {
  api: ApiClient;
  isCurrent(): boolean;
  setError(message: string): void;
  close(): void;
  onCreatedProject?(project: Project): void;
  onProjectReady?(project: Project): Promise<void | (() => void)>;
}): AddProjectSubmitContext<Project> {
  const { api } = options;
  const board = () => useBoard.getState();
  return {
    getProjects: () => board().projects,
    createProject: (input) => board().createProject(api, input),
    cloneProject: async (input) => {
      const result = await cloneProject({ api, ...input });
      return result.ok ? { ok: true, value: result.project } : result;
    },
    createFolder: (input) => createFolder(api, input),
    loadProjects: () => board().loadProjects(api),
    selectProject: (project) => board().selectProject(api, project.slug),
    openProject: (project) => {
      useTabs.getState().openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug });
    },
    isCurrent: options.isCurrent,
    setError: options.setError,
    close: options.close,
    ...(options.onCreatedProject ? { onCreatedProject: options.onCreatedProject } : {}),
    ...(options.onProjectReady ? { onProjectReady: options.onProjectReady } : {}),
  };
}
