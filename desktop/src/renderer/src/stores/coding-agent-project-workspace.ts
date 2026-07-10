import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { create } from "zustand";
import {
  CodingAgentWorkspaceResumeStateSchema,
  type CodingAgentWorkspaceResumeState,
  type CodingAgentWorkspaceViewMode,
} from "../../../shared/coding-agent-project-workspace";
import {
  reconcileProjectWorkspaceSelection,
  resolveSelectedProjectId,
  type ProjectWorkspaceSelection,
} from "../features/coding-agents/project-workspace-model";
import { invoke } from "../lib/operator";

type ProjectWorkspaceStatus = "idle" | "loading" | "ready" | "error";

interface CodingAgentProjectWorkspaceState extends ProjectWorkspaceSelection {
  status: ProjectWorkspaceStatus;
  runtimeId: string | null;
  runtimeScope: string | null;
  summary: RuntimeSummary | null;
  workspace: ProjectAgentWorkspace | null;
  error: string | null;
  hydrate: (summary: RuntimeSummary, runtimeScope?: string) => Promise<void>;
  refresh: () => Promise<void>;
  selectProject: (projectId: string) => Promise<void>;
  selectTask: (taskId: string) => void;
  selectThread: (threadId: string) => void;
  focusExternalThread: (
    threadId: string,
    relation?: { projectId?: string; taskId?: string },
  ) => Promise<void>;
  setViewMode: (viewMode: CodingAgentWorkspaceViewMode) => void;
}

let hydrationGeneration = 0;

function currentSelection(
  state: Pick<CodingAgentProjectWorkspaceState, keyof ProjectWorkspaceSelection>,
): ProjectWorkspaceSelection {
  return {
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    selectedThreadId: state.selectedThreadId,
    viewMode: state.viewMode,
  };
}

function persistSelection(selection: ProjectWorkspaceSelection): void {
  const value: CodingAgentWorkspaceResumeState = {
    ...selection,
    updatedAt: new Date().toISOString(),
  };
  void invoke("state:set", { key: "codingAgentWorkspace", value }).catch(() => {
    console.warn("[coding-agents] workspace selection could not be saved");
  });
}

async function readPersistedSelection(): Promise<ProjectWorkspaceSelection | null> {
  try {
    const stored = await invoke("state:get", { key: "codingAgentWorkspace" });
    const parsed = CodingAgentWorkspaceResumeStateSchema.safeParse(stored.value);
    if (!parsed.success) return null;
    const { updatedAt: _updatedAt, ...selection } = parsed.data;
    return selection;
  } catch {
    console.warn("[coding-agents] workspace selection could not be loaded");
    return null;
  }
}

async function loadProjectWorkspace(
  summary: RuntimeSummary,
  preferred: ProjectWorkspaceSelection,
  generation: number,
  options: {
    preserveSelectionOnError?: boolean;
    preserveMissingPreferredThread?: boolean;
    preserveMissingPreferredProject?: boolean;
  } = {},
): Promise<void> {
  const preserveSelectionOnError = options.preserveSelectionOnError ?? true;
  const selectedProjectId = options.preserveMissingPreferredProject
    && preferred.selectedProjectId
    ? preferred.selectedProjectId
    : resolveSelectedProjectId(summary, preferred.selectedProjectId);
  if (!selectedProjectId) {
    const selection = {
      selectedProjectId: null,
      selectedTaskId: null,
      selectedThreadId: null,
      viewMode: preferred.viewMode,
    } satisfies ProjectWorkspaceSelection;
    if (generation !== hydrationGeneration) return;
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      workspace: null,
      error: null,
      ...selection,
    });
    persistSelection(selection);
    return;
  }

  try {
    const workspace = await invoke("runtime:get-project-workspace", {
      projectId: selectedProjectId,
    });
    if (generation !== hydrationGeneration) return;
    const selection = reconcileProjectWorkspaceSelection(workspace, {
      ...preferred,
      selectedProjectId,
    }, options.preserveMissingPreferredThread ?? false);
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      workspace,
      error: null,
      ...selection,
    });
    persistSelection(selection);
  } catch {
    if (generation !== hydrationGeneration) return;
    console.warn("[coding-agents] project workspace refresh failed");
    useCodingAgentProjectWorkspace.setState({
      status: "error",
      workspace: null,
      selectedProjectId,
      selectedTaskId: preserveSelectionOnError ? preferred.selectedTaskId : null,
      selectedThreadId: preserveSelectionOnError ? preferred.selectedThreadId : null,
      error: "Project workspace unavailable",
    });
  }
}

export const useCodingAgentProjectWorkspace = create<CodingAgentProjectWorkspaceState>()(
  (set) => ({
    status: "idle",
    runtimeId: null,
    runtimeScope: null,
    summary: null,
    workspace: null,
    error: null,
    selectedProjectId: null,
    selectedTaskId: null,
    selectedThreadId: null,
    viewMode: "conversation",

    hydrate: async (summary, runtimeScope = summary.runtime.id) => {
      const generation = ++hydrationGeneration;
      const state = useCodingAgentProjectWorkspace.getState();
      const sameScope = state.runtimeId === summary.runtime.id
        && state.runtimeScope === runtimeScope;
      set({
        status: "loading",
        runtimeId: summary.runtime.id,
        runtimeScope,
        summary,
        workspace: null,
        error: null,
      });
      const persisted = sameScope ? null : await readPersistedSelection();
      if (generation !== hydrationGeneration) return;
      const preferred = persisted ?? currentSelection(state);
      await loadProjectWorkspace(summary, preferred, generation, {
        preserveSelectionOnError: sameScope,
      });
    },

    refresh: async () => {
      const state = useCodingAgentProjectWorkspace.getState();
      if (!state.summary) return;
      const generation = ++hydrationGeneration;
      set({ status: "loading", workspace: null, error: null });
      await loadProjectWorkspace(
        state.summary,
        currentSelection(state),
        generation,
      );
    },

    selectProject: async (projectId) => {
      const state = useCodingAgentProjectWorkspace.getState();
      const summaryProject = state.summary?.projects.items.some(
        (project) => project.id === projectId,
      ) ?? false;
      const visibleWorkspaceProject = state.workspace?.project.id === projectId;
      if (!state.summary || (!summaryProject && !visibleWorkspaceProject)) return;
      const generation = ++hydrationGeneration;
      const preferred = {
        selectedProjectId: projectId,
        selectedTaskId: null,
        selectedThreadId: null,
        viewMode: state.viewMode,
      } satisfies ProjectWorkspaceSelection;
      set({
        status: "loading",
        workspace: null,
        error: null,
        ...preferred,
      });
      await loadProjectWorkspace(state.summary, preferred, generation, {
        preserveMissingPreferredProject: visibleWorkspaceProject,
      });
    },

    selectTask: (taskId) => {
      const state = useCodingAgentProjectWorkspace.getState();
      if (!state.workspace?.tasks.items.some((task) => task.id === taskId)) return;
      const selection = {
        selectedProjectId: state.workspace.project.id,
        selectedTaskId: taskId,
        selectedThreadId: null,
        viewMode: state.viewMode,
      } satisfies ProjectWorkspaceSelection;
      set(selection);
      persistSelection(selection);
    },

    selectThread: (threadId) => {
      const state = useCodingAgentProjectWorkspace.getState();
      if (!state.workspace) return;
      const thread = [
        ...state.workspace.projectThreads.items,
        ...state.workspace.taskThreads.items,
      ].find((candidate) => candidate.id === threadId);
      if (!thread) return;
      const selection = {
        selectedProjectId: state.workspace.project.id,
        selectedTaskId: thread.taskId ?? null,
        selectedThreadId: thread.id,
        viewMode: state.viewMode,
      } satisfies ProjectWorkspaceSelection;
      set(selection);
      persistSelection(selection);
    },

    focusExternalThread: async (threadId, relation) => {
      const state = useCodingAgentProjectWorkspace.getState();
      const workspaceThread = state.workspace
        ? [
            ...state.workspace.projectThreads.items,
            ...state.workspace.taskThreads.items,
          ].find((candidate) => candidate.id === threadId)
        : undefined;
      if (workspaceThread && state.workspace) {
        const selection = {
          selectedProjectId: state.workspace.project.id,
          selectedTaskId: workspaceThread.taskId ?? null,
          selectedThreadId: workspaceThread.id,
          viewMode: state.viewMode,
        } satisfies ProjectWorkspaceSelection;
        set(selection);
        persistSelection(selection);
        return;
      }

      const summaryThread = state.summary
        ? [
            ...state.summary.activeThreads.items,
            ...state.summary.attentionThreads.items,
          ].find((candidate) => candidate.id === threadId)
        : undefined;
      const projectId = relation?.projectId ?? summaryThread?.projectId;
      const taskId = relation?.taskId ?? summaryThread?.taskId ?? null;
      if (
        !state.summary
        || !projectId
      ) {
        return;
      }

      const generation = ++hydrationGeneration;
      const preferred = {
        selectedProjectId: projectId,
        selectedTaskId: taskId,
        selectedThreadId: threadId,
        viewMode: state.viewMode,
      } satisfies ProjectWorkspaceSelection;
      set({
        status: "loading",
        workspace: null,
        error: null,
        ...preferred,
      });
      await loadProjectWorkspace(state.summary, preferred, generation, {
        preserveSelectionOnError: true,
        preserveMissingPreferredThread: true,
        preserveMissingPreferredProject: true,
      });
    },

    setViewMode: (viewMode) => {
      const state = useCodingAgentProjectWorkspace.getState();
      const selection = { ...currentSelection(state), viewMode };
      set({ viewMode });
      persistSelection(selection);
    },
  }),
);
