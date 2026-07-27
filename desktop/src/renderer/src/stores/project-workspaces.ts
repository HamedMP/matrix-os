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

interface ProjectWorkspacesState {
  entries: Record<string, ProjectWorkspaceEntry>;
  ensure: (projectId: string) => Promise<void>;
  refresh: (projectId: string) => Promise<void>;
  resolveNewChatTarget: (
    projectId: string,
    taskId?: string,
  ) => Promise<{ projectId: string; taskId?: string } | null>;
}

// Per-project load generations: a load that settles after a newer load for the
// same project started is stale and must be dropped.
const loadGenerations: Record<string, number> = {};

// Monotonic runtime epoch, bumped every time the desktop claims a different
// runtime. Generations alone cannot survive a runtime switch: clearing their
// counters lets the superseded runtime's in-flight load and the new runtime's
// load both hold generation 1, so the old response passes the staleness check
// and overwrites the new runtime's cache with another account's project data.
// The epoch only ever increases, so a superseded load can never match again.
let runtimeEpoch = 0;

function nextGeneration(projectId: string): number {
  const generation = (loadGenerations[projectId] ?? 0) + 1;
  loadGenerations[projectId] = generation;
  return generation;
}

export function clearProjectWorkspaces(): void {
  runtimeEpoch += 1;
  for (const key of Object.keys(loadGenerations)) delete loadGenerations[key];
  useProjectWorkspaces.setState({ entries: {} });
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

// A load is stale if a newer load for the same project started, or if the
// desktop switched runtimes while this one was in flight.
function isStaleLoad(projectId: string, epoch: number, generation: number): boolean {
  return runtimeEpoch !== epoch || loadGenerations[projectId] !== generation;
}

async function loadWorkspace(projectId: string): Promise<void> {
  const epoch = runtimeEpoch;
  const generation = nextGeneration(projectId);
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
    if (isStaleLoad(projectId, epoch, generation)) return;
    useProjectWorkspaces.setState((state) => ({
      entries: capEntries({
        ...state.entries,
        [projectId]: { status: "ready", workspace, error: null, fetchedAt: Date.now() },
      }, projectId),
    }));
    // Reconcile the persisted chat selection against the fresh projection.
    const projectView = useProjectView.getState();
    const selected = reconcileProjectChatSelection(
      workspace,
      projectView.selectedThreadFor(projectId),
      summaryThreadIdsFor(projectId),
    );
    if (selected !== projectView.selectedThreadFor(projectId)) {
      projectView.setSelectedThread(projectId, selected);
    }
  } catch {
    if (isStaleLoad(projectId, epoch, generation)) return;
    console.warn("[project-workspaces] workspace load failed");
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

export const useProjectWorkspaces = create<ProjectWorkspacesState>()((set, get) => ({
  entries: {},

  ensure: async (projectId) => {
    const entry = get().entries[projectId];
    if (entry && (entry.status === "ready" || entry.status === "loading")) return;
    await loadWorkspace(projectId);
  },

  refresh: async (projectId) => {
    await loadWorkspace(projectId);
  },

  resolveNewChatTarget: async (projectId, taskId) => {
    const attempt = (): { projectId: string; taskId?: string } | null =>
      resolveNewChatRelation(get().entries[projectId]?.workspace ?? null, projectId, taskId);
    const immediate = attempt();
    if (immediate) return immediate;
    // The snapshot may not be loaded yet or its task page may be stale; refresh
    // once and retry, but never loop.
    await loadWorkspace(projectId);
    return attempt();
  },
}));
