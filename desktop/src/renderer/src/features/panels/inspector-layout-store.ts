// Per-project conversation-inspector layout: whether the tools inspector is
// expanded and how wide it is. Persisted through the EXISTING
// state:set-panel-layout channel (PanelLayout envelope) under a
// `project-inspector:` taskKey prefix — no new IPC, and no schema change to
// the shared projectViews state. Recreatable UI state only: main prunes it
// with the same 90-day TTL as task workspace layouts.
import { create } from "zustand";
import { z } from "zod/v4";
import { invoke } from "../../lib/operator";

export const INSPECTOR_LAYOUT_PREFIX = "project-inspector:";
export const DEFAULT_INSPECTOR_WIDTH_PCT = 34;
export const MIN_INSPECTOR_WIDTH_PCT = 20;
export const MAX_INSPECTOR_WIDTH_PCT = 60;

const MAX_PROJECT_ID_CHARS = 238; // taskKey budget (256) minus the prefix.

const PanelLayoutSchema = z
  .object({
    order: z.array(z.string().max(32)).max(12),
    visible: z.record(z.string().max(32), z.boolean()),
    sizes: z.record(z.string().max(32), z.number().min(0).max(100)),
    touchedAt: z.number().int().nonnegative(),
  })
  .strict();

const PanelLayoutsSchema = z.record(z.string().max(256), z.unknown());

type PanelLayout = z.infer<typeof PanelLayoutSchema>;

export interface InspectorLayout {
  widthPct: number;
  collapsed: boolean;
}

const DEFAULT_LAYOUT: InspectorLayout = {
  widthPct: DEFAULT_INSPECTOR_WIDTH_PCT,
  collapsed: false,
};

interface InspectorLayoutState {
  entries: Record<string, InspectorLayout>;
  runtimeScope: string | null;
  hydrate: (runtimeScope: string) => Promise<void>;
  layoutFor: (projectId: string) => InspectorLayout;
  setWidthPct: (projectId: string, widthPct: number) => void;
  setCollapsed: (projectId: string, collapsed: boolean) => void;
}

function clampWidthPct(widthPct: number): number {
  if (!Number.isFinite(widthPct)) return DEFAULT_INSPECTOR_WIDTH_PCT;
  return Math.min(MAX_INSPECTOR_WIDTH_PCT, Math.max(MIN_INSPECTOR_WIDTH_PCT, Math.round(widthPct)));
}

function taskKeyFor(projectId: string): string {
  return `${INSPECTOR_LAYOUT_PREFIX}${projectId.slice(0, MAX_PROJECT_ID_CHARS)}`;
}

function projectIdFromTaskKey(taskKey: string): string | null {
  return taskKey.startsWith(INSPECTOR_LAYOUT_PREFIX)
    ? taskKey.slice(INSPECTOR_LAYOUT_PREFIX.length)
    : null;
}

function envelopeFor(entry: InspectorLayout, now: number): PanelLayout {
  const widthPct = clampWidthPct(entry.widthPct);
  return {
    order: ["conversation", "inspector"],
    visible: { conversation: true, inspector: !entry.collapsed },
    sizes: { conversation: 100 - widthPct, inspector: widthPct },
    touchedAt: now,
  };
}

// Defensive read: a corrupt or hand-edited envelope falls back to defaults
// rather than poisoning the split.
function entryFromEnvelope(layout: PanelLayout): InspectorLayout | null {
  const widthPct = layout.sizes.inspector;
  if (typeof widthPct !== "number" || !Number.isFinite(widthPct)) return null;
  return {
    widthPct: clampWidthPct(widthPct),
    collapsed: layout.visible.inspector === false,
  };
}

function persistEntry(projectId: string, entry: InspectorLayout): void {
  void invoke("state:set-panel-layout", {
    taskKey: taskKeyFor(projectId),
    layout: envelopeFor(entry, Date.now()),
  }).catch(() => {
    console.warn("[inspector-layout] layout could not be saved");
  });
}

export function clearInspectorLayoutRuntime(): void {
  useInspectorLayout.setState({ entries: {}, runtimeScope: null });
}

export const useInspectorLayout = create<InspectorLayoutState>()((set, get) => ({
  entries: {},
  runtimeScope: null,

  hydrate: async (runtimeScope) => {
    if (get().runtimeScope === runtimeScope) return;
    // Set the scope up front so writes landing during the read still persist.
    set({ runtimeScope });
    let persisted: Record<string, InspectorLayout> = {};
    try {
      const stored = await invoke("state:get", { key: "panelLayouts" });
      const parsed = PanelLayoutsSchema.safeParse(stored.value);
      if (parsed.success) {
        // Validate per entry so one hand-edited or stale layout cannot drop
        // every project's inspector state.
        for (const [taskKey, rawLayout] of Object.entries(parsed.data)) {
          const projectId = projectIdFromTaskKey(taskKey);
          if (projectId === null) continue;
          const layout = PanelLayoutSchema.safeParse(rawLayout);
          if (!layout.success) continue;
          const entry = entryFromEnvelope(layout.data);
          if (entry) persisted[projectId] = entry;
        }
      }
    } catch (err: unknown) {
      console.warn(
        "[inspector-layout] layout could not be loaded:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (get().runtimeScope !== runtimeScope) return;
    // In-memory entries were written after launch — they are newer and win.
    set((state) => ({ entries: { ...persisted, ...state.entries } }));
  },

  layoutFor: (projectId) => get().entries[projectId] ?? DEFAULT_LAYOUT,

  setWidthPct: (projectId, widthPct) => {
    const current = get().entries[projectId] ?? DEFAULT_LAYOUT;
    const next: InspectorLayout = { ...current, widthPct: clampWidthPct(widthPct) };
    set((state) => ({ entries: { ...state.entries, [projectId]: next } }));
    persistEntry(projectId, next);
  },

  setCollapsed: (projectId, collapsed) => {
    const current = get().entries[projectId] ?? DEFAULT_LAYOUT;
    if (current.collapsed === collapsed) return;
    const next: InspectorLayout = { ...current, collapsed };
    set((state) => ({ entries: { ...state.entries, [projectId]: next } }));
    persistEntry(projectId, next);
  },
}));
