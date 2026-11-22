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

const PrefsSchema = z.object({
  folded: z.array(z.string().max(256)).max(MAX_FOLDS).catch([]),
  // A machine's own terminal list, folded (true) or open (false) by the person; absent means the default.
  machineFolds: z.record(z.string().max(128), z.boolean()).refine((folds) => Object.keys(folds).length <= MAX_FOLDS).catch({}),
  view: z.enum(["priority", "machine"]).catch("priority"),
  width: z.number().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH).catch(DEFAULT_WIDTH),
  rail: z.boolean().catch(false),
});
export type SidebarPrefs = z.infer<typeof PrefsSchema>;
const DEFAULTS: SidebarPrefs = { folded: [], machineFolds: {}, view: "priority", width: DEFAULT_WIDTH, rail: false };

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
    /** Folds or opens a machine's own list; `folded` is how it shows now (its default included). */
    setMachineFolded: useCallback((id: string, folded: boolean) => update((current) => {
      const machineFolds = { ...current.machineFolds, [id]: folded };
      const keys = Object.keys(machineFolds);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FOLDS))) delete machineFolds[key];
      return { ...current, machineFolds };
    }), [update]),
    setView: useCallback((view: TerminalSidebarView) => update((current) => ({ ...current, view })), [update]),
    /** Dragging the edge below the rail width turns the sidebar into the rail. */
    setWidth: useCallback((width: number) => update((current) => (width < SIDEBAR_RAIL_BELOW
      ? { ...current, rail: true }
      : { ...current, rail: false, width: Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)) })), [update]),
    toggleRail: useCallback(() => update((current) => ({ ...current, rail: !current.rail })), [update]),
  };
}
