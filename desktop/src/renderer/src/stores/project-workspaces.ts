// Per-project coding-agent workspace cache. Each project tab's Chats view
// reads its own entry, so several open project tabs never clobber each other
// (the old single-selection workspace store could only serve one project).
// Bounded to MAX_PROJECT_WORKSPACE_ENTRIES with least-recently-fetched
// eviction; refreshes are stale-while-revalidate so a failed reload keeps the
// last projection visible with an explicit error.
import type { ProjectAgentWorkspace } from "@matrix-os/contracts";
import { create } from "zustand";
import {
  reconcileProjectChatSelection,
  resolveNewChatRelation,
} from "../features/coding-agents/project-workspace-model";
import { invoke } from "../lib/operator";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "./runtime-generation";
import { useCodingAgentWorkspace } from "./coding-agent-workspace";
import { useProjectView } from "./project-view";

export type ProjectWorkspaceStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectWorkspaceEntry {
  status: ProjectWorkspaceStatus;
  workspace: ProjectAgentWorkspace | null;
  error: string | null;
  fetchedAt: number;
}

export const MAX_PROJECT_WORKSPACE_ENTRIES = 12;

export interface ProjectWorkspaceRefreshOptions {
  preserveEmptySelection?: boolean;
}

interface ProjectWorkspacesState {
  entries: Record<string, ProjectWorkspaceEntry>;
  // Identity this cache belongs to. Project ids are board slugs, so two
  // accounts can hold the same id ("website", "api"); without a scope the
  // cached projection survives an account change and renders the previous
  // owner's chats under the new one with no race required.
  runtimeScope: string | null;
  ensureRuntimeScope: (scope: string) => void;
  ensure: (projectId: string) => Promise<void>;
  refresh: (projectId: string, options?: ProjectWorkspaceRefreshOptions) => Promise<void>;
  resolveNewChatTarget: (
    projectId: string,
    taskId?: string,
  ) => Promise<{ projectId: string; taskId?: string } | null>;
}

// Per-project load generations: a load that settles after a newer load for the
// same project started is stale and must be dropped.
const loadGenerations: Record<string, number> = {};
// Tracks only currently running loads and deletes each entry on settlement.
// ensure() joins the authoritative in-flight request instead of treating a
// transient `loading` projection as either success or failure.
const activeLoadPromises: Record<string, Promise<void> | undefined> = {};


function nextGeneration(projectId: string): number {
  const generation = (loadGenerations[projectId] ?? 0) + 1;
  loadGenerations[projectId] = generation;
  return generation;
}

export function clearProjectWorkspaces(): void {
  for (const key of Object.keys(loadGenerations)) delete loadGenerations[key];
  for (const key of Object.keys(activeLoadPromises)) delete activeLoadPromises[key];
  useProjectWorkspaces.setState({ entries: {}, runtimeScope: null });
}

export function clearProjectWorkspace(projectId: string): void {
  nextGeneration(projectId);
  delete activeLoadPromises[projectId];
  useProjectWorkspaces.setState((state) => {
    if (!(projectId in state.entries)) return state;
    const entries = { ...state.entries };
    delete entries[projectId];
    return { entries };
  });
}

function capEntries(
  entries: Record<string, ProjectWorkspaceEntry>,
  keepProjectId: string,
): Record<string, ProjectWorkspaceEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_PROJECT_WORKSPACE_ENTRIES) return entries;
  const evictable = keys
    .filter((key) => key !== keepProjectId && entries[key]?.status !== "loading")
    .sort((left, right) => (entries[left]?.fetchedAt ?? 0) - (entries[right]?.fetchedAt ?? 0));
  const capped = { ...entries };
  for (const key of evictable.slice(0, keys.length - MAX_PROJECT_WORKSPACE_ENTRIES)) {
    delete capped[key];
  }
  return capped;
}

function summaryThreadIdsFor(projectId: string): ReadonlySet<string> {
  const summary = useCodingAgentWorkspace.getState().summary;
  if (!summary) return new Set();
  const ids = new Set<string>();
  for (const thread of [...summary.activeThreads.items, ...summary.attentionThreads.items]) {
    if (thread.projectId === projectId) ids.add(thread.id);
  }
  return ids;
}

// Two orthogonal guards, matching stores/sessions.ts and stores/git.ts:
//   - identity: the shared runtime generation, which advances whenever the
//     selected computer or signed-in account changes;
//   - ordering: the per-project load sequence, so a newer load for the same
//     project wins.
// Both must still hold, or the settled response belongs to a computer/account
// the user has left and must never reach the cache.
function isStaleLoad(projectId: string, runtimeGeneration: number, generation: number): boolean {
  return !isCurrentRuntimeGeneration(runtimeGeneration) || loadGenerations[projectId] !== generation;
}

async function performWorkspaceLoad(
  projectId: string,
  options: ProjectWorkspaceRefreshOptions = {},
): Promise<void> {
  const runtimeGeneration = captureRuntimeGeneration();
  const generation = nextGeneration(projectId);
  const selectionAtLoadStart = useProjectView.getState().entries[projectId]?.selectedThreadId;
  useProjectWorkspaces.setState((state) => ({
    entries: {
      ...state.entries,
      [projectId]: {
        status: "loading",
        // Stale-while-revalidate: keep the previous projection visible.
        workspace: state.entries[projectId]?.workspace ?? null,
        error: null,
        fetchedAt: state.entries[projectId]?.fetchedAt ?? 0,
      },
    },
  }));
  try {
    const workspace = await invoke("runtime:get-project-workspace", { projectId });
    if (isStaleLoad(projectId, runtimeGeneration, generation)) return;
    useProjectWorkspaces.setState((state) => ({
      entries: capEntries({
        ...state.entries,
        [projectId]: { status: "ready", workspace, error: null, fetchedAt: Date.now() },
      }, projectId),
    }));
    // Reconcile the persisted chat selection against the fresh projection.
    const projectView = useProjectView.getState();
    const currentSelection = projectView.selectedThreadFor(projectId);
    const selectedNewChatDuringLoad = selectionAtLoadStart !== undefined
      && selectionAtLoadStart !== null
      && currentSelection === null;
    if ((options.preserveEmptySelection || selectedNewChatDuringLoad) && currentSelection === null) {
      return;
    }
    const selected = reconcileProjectChatSelection(
      workspace,
      currentSelection,
      summaryThreadIdsFor(projectId),
    );
    if (selected !== currentSelection) {
      projectView.setSelectedThread(projectId, selected);
    }
  } catch (error: unknown) {
    if (isStaleLoad(projectId, runtimeGeneration, generation)) return;
    console.warn(
      "[project-workspaces] workspace load failed",
      error instanceof Error ? error.name : "Unknown error",
    );
    // Error entries are capped too. Opening distinct projects while the runtime
    // is unavailable would otherwise grow the cache past its stated bound,
    // since only the success path used to enforce it.
    useProjectWorkspaces.setState((state) => ({
      entries: capEntries({
        ...state.entries,
        [projectId]: {
          status: "error",
          workspace: state.entries[projectId]?.workspace ?? null,
          error: "Project workspace unavailable",
          fetchedAt: state.entries[projectId]?.fetchedAt ?? 0,
        },
      }, projectId),
    }));
  }
}

function loadWorkspace(
  projectId: string,
  options?: ProjectWorkspaceRefreshOptions,
): Promise<void> {
  const pending = performWorkspaceLoad(projectId, options).finally(() => {
    if (activeLoadPromises[projectId] === pending) {
      delete activeLoadPromises[projectId];
    }
  });
  activeLoadPromises[projectId] = pending;
  return pending;
}

export const useProjectWorkspaces = create<ProjectWorkspacesState>()((set, get) => ({
  entries: {},
  runtimeScope: null,

  ensureRuntimeScope: (scope) => {
    if (get().runtimeScope === scope) return;
    // Drop the previous owner's projections before anything new loads, and
    // reset the per-project sequences so the new scope starts clean.
    for (const key of Object.keys(loadGenerations)) delete loadGenerations[key];
    for (const key of Object.keys(activeLoadPromises)) delete activeLoadPromises[key];
    set({ runtimeScope: scope, entries: {} });
  },

  ensure: async (projectId) => {
    const entry = get().entries[projectId];
    if (entry?.status === "ready") return;
    let joinedLoad = activeLoadPromises[projectId];
    if (!joinedLoad) {
      await loadWorkspace(projectId);
      return;
    }
    while (joinedLoad) {
      await joinedLoad;
      const authoritativeLoad = activeLoadPromises[projectId];
      if (!authoritativeLoad || authoritativeLoad === joinedLoad) return;
      joinedLoad = authoritativeLoad;
    }
  },

  refresh: async (projectId, options) => {
    await loadWorkspace(projectId, options);
  },

  resolveNewChatTarget: async (projectId, taskId) => {
    const attempt = (): { projectId: string; taskId?: string } | null =>
      resolveNewChatRelation(get().entries[projectId]?.workspace ?? null, projectId, taskId);
    const immediate = attempt();
    if (immediate) return immediate;
    // The snapshot may not be loaded yet or its task page may be stale; refresh
    // once and retry, but never loop.
    const runtimeGeneration = captureRuntimeGeneration();
    await loadWorkspace(projectId);
    // The load may have been dropped as stale. Reading the cache anyway would
    // return a relation from the previous account's workspace, which callers
    // then persist as a chat selection or bind a new thread to.
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return null;
    return attempt();
  },
}));
