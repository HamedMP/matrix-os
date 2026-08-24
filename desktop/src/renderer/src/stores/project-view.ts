// Per-project shell view state: which view (Overview | Board | Chats) a project tab shows
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
import { diagnosticErrorKind } from "../lib/errors";

export type { ProjectView } from "../../../shared/project-views";

export const MAX_PROJECT_VIEW_ENTRIES = 50;

export const DEFAULT_PROJECT_VIEW: ProjectView = "overview";

// Hydration merges two independently mutable fields. Track which field the
// operator actually changed while the async state read was pending so an
// automatic chat selection cannot accidentally masquerade as an explicit
// switch from a persisted Board view (and vice versa). These records are
// pruned with the bounded entry cache.
let fieldMutationRevision = 0;
const viewMutationRevisions: Record<string, number | undefined> = {};
const selectionMutationRevisions: Record<string, number | undefined> = {};

function clearFieldMutationRevisions(): void {
  for (const key of Object.keys(viewMutationRevisions)) delete viewMutationRevisions[key];
  for (const key of Object.keys(selectionMutationRevisions)) delete selectionMutationRevisions[key];
}

function pruneFieldMutationRevisions(entries: Record<string, ProjectViewEntry>): void {
  const retained = new Set(Object.keys(entries));
  for (const key of Object.keys(viewMutationRevisions)) {
    if (!retained.has(key)) delete viewMutationRevisions[key];
  }
  for (const key of Object.keys(selectionMutationRevisions)) {
    if (!retained.has(key)) delete selectionMutationRevisions[key];
  }
}
interface ProjectViewState {
  entries: Record<string, ProjectViewEntry>;
  selectionRevisions: Record<string, number>;
  runtimeScope: string | null;
  hydrate: (runtimeScope: string) => Promise<void>;
  viewFor: (projectId: string) => ProjectView;
  selectedThreadFor: (projectId: string) => string | null;
  selectionRevisionFor: (projectId: string) => number;
  setView: (projectId: string, view: ProjectView) => void;
  setSelectedThread: (projectId: string, threadId: string | null) => void;
}

function retainSelectionRevisions(
  revisions: Record<string, number>,
  entries: Record<string, ProjectViewEntry>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(revisions).filter(([projectId]) => projectId in entries),
  );
}

function persistEntries(entries: Record<string, ProjectViewEntry>, runtimeScope: string | null): void {
  if (!runtimeScope) return;
  const value: ProjectViewsState = { runtimeScope, views: entries };
  void Promise.resolve()
    .then(() => invoke("state:set", { key: "projectViews", value }))
    .catch(() => {
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
    view: patch.view ?? existing?.view ?? DEFAULT_PROJECT_VIEW,
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
  clearFieldMutationRevisions();
  useProjectView.setState({ entries: {}, selectionRevisions: {}, runtimeScope: null });
}

export function clearProjectView(projectId: string): void {
  const state = useProjectView.getState();
  if (!(projectId in state.entries)) return;
  const entries = { ...state.entries };
  delete entries[projectId];
  delete viewMutationRevisions[projectId];
  delete selectionMutationRevisions[projectId];
  const selectionRevisions = { ...state.selectionRevisions };
  delete selectionRevisions[projectId];
  useProjectView.setState({ entries, selectionRevisions });
  persistEntries(entries, state.runtimeScope);
}

export const useProjectView = create<ProjectViewState>()((set, get) => ({
  entries: {},
  selectionRevisions: {},
  runtimeScope: null,

  hydrate: async (runtimeScope) => {
    const previousScope = get().runtimeScope;
    if (previousScope === runtimeScope) return;
    const entriesBeforeHydration = previousScope === null ? get().entries : {};
    if (previousScope !== null) clearFieldMutationRevisions();
    const hydrationRevision = fieldMutationRevision;
    // Set the scope up front so writes that land while the persisted state is
    // being read still persist afterwards. Entries created before the first
    // hydration are unscoped launch intents and must survive; entries owned by
    // a different established scope must be cleared before the async read so
    // one account can never overwrite another account's persisted views.
    set({
      runtimeScope,
      ...(previousScope === null ? {} : { entries: {}, selectionRevisions: {} }),
    });
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
        diagnosticErrorKind(err),
      );
    }
    if (get().runtimeScope !== runtimeScope) return;
    // Pre-hydration launch intents still win as complete entries. For entries
    // first created while the read was pending, merge each field independently:
    // workspace auto-selection changes only selectedThreadId, while a click on
    // the Board/Chats switch changes only view.
    const currentEntries = get().entries;
    const merged = { ...persisted };
    for (const [projectId, current] of Object.entries(currentEntries)) {
      const stored = persisted[projectId];
      if (!stored || projectId in entriesBeforeHydration) {
        merged[projectId] = current;
        continue;
      }
      merged[projectId] = {
        view: (viewMutationRevisions[projectId] ?? 0) > hydrationRevision
          ? current.view
          : stored.view,
        selectedThreadId: (selectionMutationRevisions[projectId] ?? 0) > hydrationRevision
          ? current.selectedThreadId
          : stored.selectedThreadId,
        touchedAt: Math.max(stored.touchedAt, current.touchedAt),
      };
    }
    const keys = Object.keys(merged);
    const capped = keys.length <= MAX_PROJECT_VIEW_ENTRIES
      ? merged
      : Object.fromEntries(
          keys
            .sort((left, right) => (merged[right]?.touchedAt ?? 0) - (merged[left]?.touchedAt ?? 0))
            .slice(0, MAX_PROJECT_VIEW_ENTRIES)
            .map((key) => [key, merged[key]!] as const),
        );
    set({
      entries: capped,
      selectionRevisions: retainSelectionRevisions(get().selectionRevisions, capped),
    });
    pruneFieldMutationRevisions(capped);
    persistEntries(capped, runtimeScope);
  },

  viewFor: (projectId) => get().entries[projectId]?.view ?? DEFAULT_PROJECT_VIEW,

  selectedThreadFor: (projectId) => get().entries[projectId]?.selectedThreadId ?? null,

  selectionRevisionFor: (projectId) => get().selectionRevisions[projectId] ?? 0,

  setView: (projectId, view) => {
    fieldMutationRevision += 1;
    viewMutationRevisions[projectId] = fieldMutationRevision;
    const entries = upsertEntry(get().entries, projectId, { view }, Date.now());
    set({
      entries,
      selectionRevisions: retainSelectionRevisions(get().selectionRevisions, entries),
    });
    pruneFieldMutationRevisions(entries);
    persistEntries(entries, get().runtimeScope);
  },

  setSelectedThread: (projectId, threadId) => {
    fieldMutationRevision += 1;
    selectionMutationRevisions[projectId] = fieldMutationRevision;
    const entries = upsertEntry(
      get().entries,
      projectId,
      { selectedThreadId: threadId },
      Date.now(),
    );
    const selectionRevisions = retainSelectionRevisions(
      {
        ...get().selectionRevisions,
        [projectId]: (get().selectionRevisions[projectId] ?? 0) + 1,
      },
      entries,
    );
    set({ entries, selectionRevisions });
    pruneFieldMutationRevisions(entries);
    persistEntries(entries, get().runtimeScope);
  },
}));
