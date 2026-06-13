// Open task workspaces + per-task panel layouts (US3, FR-040/FR-045).
// Entries are ordered most-recently-focused first; beyond WORKSPACE_LRU_CAP
// the least-recently-focused entries drop their live resources (sockets,
// heavy views) but stay in the list so they restore on focus. Layout
// persistence is injected via configure() so this store never touches IPC —
// the UI wires it to window.operator state:get/state:set.
import { create } from "zustand";

export type PanelKind = "terminal" | "editor" | "git" | "browser" | "artifacts" | "processes";

export const PANEL_KINDS: readonly PanelKind[] = [
  "terminal",
  "editor",
  "git",
  "browser",
  "artifacts",
  "processes",
];

export const PANEL_MIN_PCT: Record<PanelKind, number> = {
  terminal: 20,
  editor: 25,
  git: 15,
  browser: 15,
  artifacts: 15,
  processes: 15,
};

export interface PanelLayout {
  order: PanelKind[];
  visible: Record<PanelKind, boolean>;
  sizes: Record<PanelKind, number>;
  touchedAt: number;
}

function equalSplitSizes(visible: Record<PanelKind, boolean>): Record<PanelKind, number> {
  const shown = PANEL_KINDS.filter((kind) => visible[kind]);
  const share = shown.length > 0 ? 100 / shown.length : 0;
  const sizes = {} as Record<PanelKind, number>;
  for (const kind of PANEL_KINDS) {
    sizes[kind] = visible[kind] ? share : 0;
  }
  return sizes;
}

export function defaultLayout(now: number = Date.now()): PanelLayout {
  const visible = {} as Record<PanelKind, boolean>;
  for (const kind of PANEL_KINDS) {
    visible[kind] = kind === "terminal";
  }
  return {
    order: [...PANEL_KINDS],
    visible,
    sizes: equalSplitSizes(visible),
    touchedAt: now,
  };
}

export interface WorkspaceEntry {
  taskId: string;
  lastFocusedAt: number;
  live: boolean;
}

export const WORKSPACE_LRU_CAP = 8;

interface WorkspacePersistence {
  loadLayouts(): Promise<Record<string, PanelLayout> | null>;
  saveLayout(taskKey: string, layout: PanelLayout): Promise<void>;
}

let persistence: WorkspacePersistence | null = null;

function persistLayout(taskId: string, layout: PanelLayout): void {
  if (!persistence) return;
  persistence.saveLayout(taskId, layout).catch((err: unknown) => {
    console.warn("[workspace] Failed to persist panel layout:", err);
  });
}

interface WorkspaceState {
  entries: WorkspaceEntry[];
  layouts: Record<string, PanelLayout>;
  hydrated: boolean;
  configure(p: WorkspacePersistence): void;
  hydrate(): Promise<void>;
  openTask(taskId: string, now?: number): { evicted: string[] };
  focusTask(taskId: string, now?: number): void;
  closeTask(taskId: string): void;
  togglePanel(taskId: string, panel: PanelKind, now?: number): void;
  setPanelSizes(taskId: string, sizes: Record<PanelKind, number>, now?: number): void;
  movePanel(taskId: string, panel: PanelKind, direction: "left" | "right", now?: number): void;
  layoutFor(taskId: string): PanelLayout;
}

export const useWorkspace = create<WorkspaceState>()((set, get) => {
  function writeLayout(taskId: string, layout: PanelLayout): void {
    set((state) => ({ layouts: { ...state.layouts, [taskId]: layout } }));
    persistLayout(taskId, layout);
  }

  return {
    entries: [],
    layouts: {},
    hydrated: false,

    configure: (p) => {
      persistence = p;
    },

    hydrate: async () => {
      if (get().hydrated) return;
      if (!persistence) {
        set({ hydrated: true });
        return;
      }
      try {
        const loaded = await persistence.loadLayouts();
        // In-memory layouts win: they were touched during this session.
        set((state) => ({
          hydrated: true,
          layouts: loaded ? { ...loaded, ...state.layouts } : state.layouts,
        }));
      } catch (err: unknown) {
        console.warn("[workspace] Failed to load persisted layouts:", err);
        set({ hydrated: true });
      }
    },

    openTask: (taskId, now = Date.now()) => {
      const rest = get().entries.filter((entry) => entry.taskId !== taskId);
      const reordered: WorkspaceEntry[] = [{ taskId, lastFocusedAt: now, live: true }, ...rest];
      const evicted: string[] = [];
      const entries = reordered.map((entry, index) => {
        if (index < WORKSPACE_LRU_CAP || !entry.live) return entry;
        evicted.push(entry.taskId);
        return { ...entry, live: false };
      });
      set({ entries });
      return { evicted };
    },

    focusTask: (taskId, now = Date.now()) => {
      const prior = get().entries;
      const existing = prior.find((entry) => entry.taskId === taskId);
      if (!existing) return;
      set({
        entries: [
          { ...existing, lastFocusedAt: now, live: true },
          ...prior.filter((entry) => entry.taskId !== taskId),
        ],
      });
    },

    closeTask: (taskId) => {
      // Layout intentionally survives close: it persists per task (FR-040).
      set((state) => ({ entries: state.entries.filter((entry) => entry.taskId !== taskId) }));
    },

    togglePanel: (taskId, panel, now = Date.now()) => {
      const layout = get().layouts[taskId] ?? defaultLayout(now);
      const visible = { ...layout.visible, [panel]: !layout.visible[panel] };
      // A newly shown panel with no size triggers an equal re-split; a panel
      // that kept a size from a previous show restores it untouched.
      const sizes =
        visible[panel] && (layout.sizes[panel] ?? 0) <= 0
          ? equalSplitSizes(visible)
          : { ...layout.sizes };
      writeLayout(taskId, { ...layout, visible, sizes, touchedAt: now });
    },

    setPanelSizes: (taskId, sizes, now = Date.now()) => {
      const layout = get().layouts[taskId] ?? defaultLayout(now);
      const next = { ...layout.sizes };
      for (const kind of PANEL_KINDS) {
        const value = sizes[kind];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        next[kind] = layout.visible[kind]
          ? Math.max(value, PANEL_MIN_PCT[kind])
          : Math.max(value, 0);
      }
      writeLayout(taskId, { ...layout, sizes: next, touchedAt: now });
    },

    movePanel: (taskId, panel, direction, now = Date.now()) => {
      const layout = get().layouts[taskId] ?? defaultLayout(now);
      const index = layout.order.indexOf(panel);
      if (index === -1) return;
      const target = direction === "left" ? index - 1 : index + 1;
      if (target < 0 || target >= layout.order.length) return;
      const order = [...layout.order];
      const swapped = order[target]!;
      order[target] = order[index]!;
      order[index] = swapped;
      writeLayout(taskId, { ...layout, order, touchedAt: now });
    },

    layoutFor: (taskId) => get().layouts[taskId] ?? defaultLayout(),
  };
});
