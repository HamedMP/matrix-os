// How the person left the Terminal window's sidebar: folds, view, width and
// rail (spec 2706). A per-viewer convenience kept in this renderer's storage;
// every read and write survives storage being unavailable.
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import type { TerminalSidebarView } from "@matrix-os/ui/terminal-status-sidebar";

const STORAGE_KEY = "matrix.terminal-window.sidebar.v1";
/** Herdr shows the numbered rail below this width. */
export const SIDEBAR_RAIL_BELOW = 160;
export const SIDEBAR_MIN_WIDTH = 120;
export const SIDEBAR_MAX_WIDTH = 420;
const DEFAULT_WIDTH = 260;
const MAX_FOLDS = 200;
const MAX_PINNED = 50;
const MAX_SPACES = 200;
/** The colors a space's avatar can take. */
export const SPACE_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#64748b"] as const;
const SpaceStyleSchema = z.strictObject({
  name: z.string().trim().min(1).max(64).optional(),
  color: z.enum(SPACE_COLORS).optional(),
  // One emoji or a short symbol in place of the letter.
  icon: z.string().min(1).max(8).optional(),
});
export type SpaceStyle = z.infer<typeof SpaceStyleSchema>;

const PrefsSchema = z.object({
  folded: z.array(z.string().max(256)).max(MAX_FOLDS).catch([]),
  view: z.enum(["priority", "machine"]).catch("priority"),
  width: z.number().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH).catch(DEFAULT_WIDTH),
  rail: z.boolean().catch(false),
  // A machine (or one of its spaces) opened as its own tab.
  filter: z.object({ machineId: z.string().max(128), space: z.string().max(256).optional() }).nullable().catch(null),
  // Terminals pinned to the top of the agents list, by row key.
  pinned: z.array(z.string().max(512)).max(MAX_PINNED).catch([]),
  // How the person dressed each space (`machineId|space`): a display name, color and icon.
  spaceStyles: z.record(z.string().max(512), SpaceStyleSchema).refine((styles) => Object.keys(styles).length <= MAX_SPACES).catch({}),
  // The order the person dragged each machine's spaces into.
  spaceOrder: z.record(z.string().max(128), z.array(z.string().max(256)).max(MAX_SPACES)).refine((order) => Object.keys(order).length <= MAX_FOLDS).catch({}),
  // Spaces whose terminals the person listed inline under them.
  expandedSpaces: z.array(z.string().max(512)).max(MAX_SPACES).catch([]),
});
export type SidebarPrefs = z.infer<typeof PrefsSchema>;
const DEFAULTS: SidebarPrefs = { folded: [], view: "priority", width: DEFAULT_WIDTH, rail: false, filter: null, pinned: [], spaceStyles: {}, spaceOrder: {}, expandedSpaces: [] };

function read(): SidebarPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = PrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULTS;
  } catch (error: unknown) {
    console.warn("[terminal-window] sidebar preferences unreadable:", error instanceof Error ? error.name : "UnknownError");
    return DEFAULTS;
  }
}

function write(prefs: SidebarPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (error: unknown) {
    console.warn("[terminal-window] sidebar preferences not saved:", error instanceof Error ? error.name : "UnknownError");
  }
}

function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id].slice(-MAX_FOLDS);
}

export function useSidebarPrefs() {
  const [prefs, setPrefs] = useState<SidebarPrefs>(read);
  // Saved after a change commits; the first render only read what was saved.
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) write(prefs);
  }, [prefs]);
  const update = useCallback((change: (current: SidebarPrefs) => SidebarPrefs) => {
    changed.current = true;
    setPrefs(change);
  }, []);
  return {
    prefs,
    toggleFold: useCallback((id: string) => update((current) => ({ ...current, folded: toggled(current.folded, id) })), [update]),
    setView: useCallback((view: TerminalSidebarView) => update((current) => ({ ...current, view })), [update]),
    /** Dragging the edge below the rail width turns the sidebar into the rail. */
    setWidth: useCallback((width: number) => update((current) => (width < SIDEBAR_RAIL_BELOW
      ? { ...current, rail: true }
      : { ...current, rail: false, width: Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)) })), [update]),
    toggleRail: useCallback(() => update((current) => ({ ...current, rail: !current.rail })), [update]),
    setFilter: useCallback((filter: SidebarPrefs["filter"]) => update((current) => ({ ...current, filter })), [update]),
    /** Dresses a space, or puts it back as it was with `null`. */
    setSpaceStyle: useCallback((id: string, style: SpaceStyle | null) => update((current) => {
      const spaceStyles = { ...current.spaceStyles };
      if (style && Object.keys(style).length > 0) spaceStyles[id] = style;
      else delete spaceStyles[id];
      const keys = Object.keys(spaceStyles);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SPACES))) delete spaceStyles[key];
      return { ...current, spaceStyles };
    }), [update]),
    setSpaceOrder: useCallback((machineId: string, order: readonly string[]) => update((current) => ({
      ...current, spaceOrder: { ...current.spaceOrder, [machineId]: order.slice(0, MAX_SPACES) },
    })), [update]),
    toggleSpaceExpanded: useCallback((id: string) => update((current) => ({
      ...current,
      expandedSpaces: current.expandedSpaces.includes(id)
        ? current.expandedSpaces.filter((entry) => entry !== id)
        : [...current.expandedSpaces, id].slice(-MAX_SPACES),
    })), [update]),
    togglePin: useCallback((key: string) => update((current) => ({
      ...current,
      pinned: current.pinned.includes(key) ? current.pinned.filter((entry) => entry !== key) : [...current.pinned, key].slice(-MAX_PINNED),
    })), [update]),
  };
}
