// Open task workspaces + per-task panel layouts (US3, FR-040/FR-045).
// Entries are ordered most-recently-focused first; beyond WORKSPACE_LRU_CAP
// the least-recently-focused entries drop their live resources (sockets,
// heavy views) but stay in the list so they restore on focus. Layout
// persistence is injected via configure() so this store never touches IPC —
// the UI wires it to window.operator state:get/state:set.
import { create } from "zustand";

export type PanelKind = "terminal" | "editor" | "git" | "browser" | "artifacts" | "processes" | "timeline";

export const PANEL_KINDS: readonly PanelKind[] = [
  "terminal",
  "editor",
  "git",
  "browser",
  "artifacts",
  "processes",
  "timeline",
];

export const PANEL_MIN_PCT: Record<PanelKind, number> = {
  terminal: 20,
  editor: 25,
  git: 15,
  browser: 15,
  artifacts: 15,
  processes: 15,
  timeline: 18,
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

function normalizeVisibleSizes(
  visible: Record<PanelKind, boolean>,
  sizes: Record<PanelKind, number>,
): Record<PanelKind, number> {
  const shown = PANEL_KINDS.filter((kind) => visible[kind]);
  const next = { ...sizes };
  if (shown.length === 0) return next;
  const total = shown.reduce((sum, kind) => sum + Math.max(next[kind] ?? 0, 0), 0);
  if (total <= 0) return equalSplitSizes(visible);
  for (const kind of shown) {
    next[kind] = (Math.max(next[kind] ?? 0, 0) / total) * 100;
  }
  return next;
}

function restorePanelSize(
  visible: Record<PanelKind, boolean>,
  sizes: Record<PanelKind, number>,
  panel: PanelKind,
): Record<PanelKind, number> {
  const restored = Math.max(sizes[panel] ?? 0, 0);
  if (restored <= 0) return equalSplitSizes(visible);
  const next = { ...sizes };
  const others = PANEL_KINDS.filter((kind) => kind !== panel && visible[kind]);
  if (others.length === 0) {
    next[panel] = 100;
    return next;
  }
  const panelSize = Math.min(restored, 95);
  const otherBudget = 100 - panelSize;
  const otherTotal = others.reduce((sum, kind) => sum + Math.max(next[kind] ?? 0, 0), 0);
  next[panel] = panelSize;
  if (otherTotal <= 0) {
    const share = otherBudget / others.length;
    for (const kind of others) next[kind] = share;
  } else {
    for (const kind of others) {
      next[kind] = (Math.max(next[kind] ?? 0, 0) / otherTotal) * otherBudget;
    }
  }
  return next;
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

// Migrate a (possibly older) persisted layout so it contains every current
// PanelKind — new kinds are appended to order, hidden, with zero size. Without
// this, a panel added after a layout was saved would never render (PanelStrip
// only walks layout.order).
export function normalizeLayout(layout: PanelLayout): PanelLayout {
  const order = [...layout.order.filter((k) => PANEL_KINDS.includes(k))];
  for (const kind of PANEL_KINDS) if (!order.includes(kind)) order.push(kind);
  const visible = { ...layout.visible } as Record<PanelKind, boolean>;
  const sizes = { ...layout.sizes } as Record<PanelKind, number>;
  for (const kind of PANEL_KINDS) {
    if (typeof visible[kind] !== "boolean") visible[kind] = false;
    if (typeof sizes[kind] !== "number") sizes[kind] = 0;
  }
  return { ...layout, order, visible, sizes };
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

interface WriteLayoutOptions {
  persist?: boolean;
}

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
  setPanelSizes(taskId: string, sizes: Record<PanelKind, number>, now?: number, options?: WriteLayoutOptions): void;
  movePanel(taskId: string, panel: PanelKind, direction: "left" | "right", now?: number): void;
  layoutFor(taskId: string): PanelLayout;
}

export const useWorkspace = create<WorkspaceState>()((set, get) => {
  function writeLayout(taskId: string, layout: PanelLayout, options: WriteLayoutOptions = {}): void {
    set((state) => ({ layouts: { ...state.layouts, [taskId]: layout } }));
    if (options.persist !== false) persistLayout(taskId, layout);
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
        const normalizedLoaded = loaded
          ? Object.fromEntries(
              Object.entries(loaded).map(([taskId, layout]) => [taskId, normalizeLayout(layout)]),
            )
          : null;
        // In-memory layouts win: they were touched during this session.
        set((state) => ({
          hydrated: true,
          layouts: normalizedLoaded ? { ...normalizedLoaded, ...state.layouts } : state.layouts,
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
      const layout = normalizeLayout(get().layouts[taskId] ?? defaultLayout(now));
      const visible = { ...layout.visible, [panel]: !layout.visible[panel] };
      const sizes = visible[panel]
        ? restorePanelSize(visible, layout.sizes, panel)
        : normalizeVisibleSizes(visible, layout.sizes);
      writeLayout(taskId, { ...layout, visible, sizes, touchedAt: now });
    },

    setPanelSizes: (taskId, sizes, now = Date.now(), options) => {
      const layout = normalizeLayout(get().layouts[taskId] ?? defaultLayout(now));
      const next = { ...layout.sizes };
      for (const kind of PANEL_KINDS) {
        const value = sizes[kind];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        next[kind] = layout.visible[kind]
          ? Math.max(value, PANEL_MIN_PCT[kind])
          : Math.max(value, 0);
      }
      writeLayout(taskId, { ...layout, sizes: next, touchedAt: now }, options);
    },

    movePanel: (taskId, panel, direction, now = Date.now()) => {
      const layout = normalizeLayout(get().layouts[taskId] ?? defaultLayout(now));
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

    layoutFor: (taskId) => normalizeLayout(get().layouts[taskId] ?? defaultLayout()),
  };
});
