// Per-project shell view state: which view (Board | Chats) a project tab shows
// and which chat is selected in the Chats view. Persisted under the
// `projectViews` local-state key, scoped to the current runtime so another
// computer's selections never leak in. Bounded to MAX_PROJECT_VIEW_ENTRIES
// with least-recently-touched eviction.
import { create } from "zustand";
import {
  ProjectViewsStateSchema,
  type ProjectView,
  type ProjectViewEntry,
  type ProjectViewsState,
} from "../../../shared/project-views";
import { invoke } from "../lib/operator";

export type { ProjectView } from "../../../shared/project-views";

export const MAX_PROJECT_VIEW_ENTRIES = 50;

const DEFAULT_VIEW: ProjectView = "board";

interface ProjectViewState {
  entries: Record<string, ProjectViewEntry>;
  runtimeScope: string | null;
  hydrate: (runtimeScope: string) => Promise<void>;
  viewFor: (projectId: string) => ProjectView;
  selectedThreadFor: (projectId: string) => string | null;
  setView: (projectId: string, view: ProjectView) => void;
  setSelectedThread: (projectId: string, threadId: string | null) => void;
}

function persistEntries(entries: Record<string, ProjectViewEntry>, runtimeScope: string | null): void {
  if (!runtimeScope) return;
  const value: ProjectViewsState = { runtimeScope, views: entries };
  void invoke("state:set", { key: "projectViews", value }).catch(() => {
    console.warn("[project-view] view state could not be saved");
  });
}

function upsertEntry(
  entries: Record<string, ProjectViewEntry>,
  projectId: string,
  patch: Partial<Pick<ProjectViewEntry, "view" | "selectedThreadId">>,
  now: number,
): Record<string, ProjectViewEntry> {
  const existing = entries[projectId];
  const next: ProjectViewEntry = {
    view: patch.view ?? existing?.view ?? DEFAULT_VIEW,
    selectedThreadId: patch.selectedThreadId !== undefined
      ? patch.selectedThreadId
      : existing?.selectedThreadId ?? null,
    touchedAt: now,
  };
  const merged = { ...entries, [projectId]: next };
  const keys = Object.keys(merged);
  if (keys.length <= MAX_PROJECT_VIEW_ENTRIES) return merged;
  // Evict the coldest entries first; the just-touched project always survives.
  const coldest = keys
    .filter((key) => key !== projectId)
    .sort((left, right) => (merged[left]?.touchedAt ?? 0) - (merged[right]?.touchedAt ?? 0));
  const capped = { ...merged };
  for (const key of coldest.slice(0, keys.length - MAX_PROJECT_VIEW_ENTRIES)) {
    delete capped[key];
  }
  return capped;
}

export function clearProjectViewRuntime(): void {
  useProjectView.setState({ entries: {}, runtimeScope: null });
}

export const useProjectView = create<ProjectViewState>()((set, get) => ({
  entries: {},
  runtimeScope: null,

  hydrate: async (runtimeScope) => {
    if (get().runtimeScope === runtimeScope) return;
    // Set the scope up front so writes that land while the persisted state is
    // being read still persist afterwards.
    set({ runtimeScope });
    let persisted: Record<string, ProjectViewEntry> = {};
    try {
      const stored = await invoke("state:get", { key: "projectViews" });
      const parsed = ProjectViewsStateSchema.safeParse(stored.value);
      if (parsed.success && parsed.data.runtimeScope === runtimeScope) {
        persisted = parsed.data.views;
      }
    } catch (err: unknown) {
      console.warn(
        "[project-view] view state could not be loaded:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (get().runtimeScope !== runtimeScope) return;
    // In-memory entries were written after launch (e.g. a notification routed
    // a chat open before the read settled) — they are newer and always win.
    const merged = { ...persisted, ...get().entries };
    const keys = Object.keys(merged);
    const capped = keys.length <= MAX_PROJECT_VIEW_ENTRIES
      ? merged
      : Object.fromEntries(
          keys
            .sort((left, right) => (merged[right]?.touchedAt ?? 0) - (merged[left]?.touchedAt ?? 0))
            .slice(0, MAX_PROJECT_VIEW_ENTRIES)
            .map((key) => [key, merged[key]!] as const),
        );
    set({ entries: capped });
    persistEntries(capped, runtimeScope);
  },

  viewFor: (projectId) => get().entries[projectId]?.view ?? DEFAULT_VIEW,

  selectedThreadFor: (projectId) => get().entries[projectId]?.selectedThreadId ?? null,

  setView: (projectId, view) => {
    const entries = upsertEntry(get().entries, projectId, { view }, Date.now());
    set({ entries });
    persistEntries(entries, get().runtimeScope);
  },

  setSelectedThread: (projectId, threadId) => {
    const entries = upsertEntry(get().entries, projectId, { selectedThreadId: threadId }, Date.now());
    set({ entries });
    persistEntries(entries, get().runtimeScope);
  },
}));
