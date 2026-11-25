// The Terminal window's pane layouts, one small record per machine (spec
// 2706 layer 6), kept in this renderer's storage and restored when the window
// opens. A per-viewer convenience: every read and write survives storage
// being unavailable, and anything unreadable starts empty.
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { leaves, MAX_PANES_PER_TAB, pruneTab, type PaneNode, type PaneTab } from "@matrix-os/ui/terminal-pane-tree";

const STORAGE_KEY = "matrix.terminal-window.panes.v1";
const MAX_MACHINES = 64;
const MAX_TABS_PER_MACHINE = 64;
const MAX_DEPTH = MAX_PANES_PER_TAB;
const Id = z.string().min(1).max(64);
const Terminal = z.string().min(1).max(256);

const NodeSchema: z.ZodType<PaneNode> = z.lazy(() => z.union([
  z.strictObject({ type: z.literal("leaf"), id: Id, terminal: Terminal }),
  z.strictObject({
    type: z.literal("split"), id: Id, axis: z.enum(["row", "column"]), ratio: z.number().min(0.1).max(0.9),
    first: NodeSchema, second: NodeSchema,
  }),
]));

function depth(node: PaneNode): number {
  return node.type === "leaf" ? 1 : 1 + Math.max(depth(node.first), depth(node.second));
}

const TabSchema = z.strictObject({ id: Id, root: NodeSchema, focus: Id, zoom: Id.nullable() })
  .refine((tab) => depth(tab.root) <= MAX_DEPTH && leaves(tab.root).length <= MAX_PANES_PER_TAB
    && leaves(tab.root).some((leaf) => leaf.id === tab.focus));
const LayoutsSchema = z.record(z.string().max(128), z.array(TabSchema).max(MAX_TABS_PER_MACHINE))
  .refine((layouts) => Object.keys(layouts).length <= MAX_MACHINES);

export type PaneLayouts = Record<string, PaneTab[]>;

function read(): PaneLayouts {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = LayoutsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch (error: unknown) {
    console.warn("[terminal-window] pane layouts unreadable:", error instanceof Error ? error.name : "UnknownError");
    return {};
  }
}

function write(layouts: PaneLayouts): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts));
  } catch (error: unknown) {
    console.warn("[terminal-window] pane layouts not saved:", error instanceof Error ? error.name : "UnknownError");
  }
}

/** The tab on this machine that holds this terminal, if any. */
export function tabWithTerminal(layouts: PaneLayouts, machineId: string, terminal: string): PaneTab | undefined {
  return layouts[machineId]?.find((tab) => leaves(tab.root).some((leaf) => leaf.terminal === terminal));
}

export function usePaneLayouts() {
  const [layouts, setLayouts] = useState<PaneLayouts>(read);
  // Saved after a change commits; the first render only read what was saved.
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) write(layouts);
  }, [layouts]);

  /** Replaces a tab (matched by id), adds it, or removes it with `null`. A one-pane tab is not kept. */
  const saveTab = useCallback((machineId: string, tabId: string, next: PaneTab | null) => {
    changed.current = true;
    setLayouts((current) => {
      const tabs = (current[machineId] ?? []).filter((tab) => tab.id !== tabId);
      // A terminal lives in at most one tab: a tab that takes it over removes it from the others.
      const taken = new Set(next ? leaves(next.root).map((leaf) => leaf.terminal) : []);
      const kept = tabs.flatMap((tab) => {
        const pruned = pruneTab(tab, (terminal) => !taken.has(terminal));
        return pruned && pruned.root.type === "split" ? [pruned] : [];
      });
      const updated = next && next.root.type === "split" ? [...kept, next].slice(-MAX_TABS_PER_MACHINE) : kept;
      const machines = { ...current, [machineId]: updated };
      if (updated.length === 0) delete machines[machineId];
      return Object.keys(machines).length > MAX_MACHINES ? current : machines;
    });
  }, []);

  return { layouts, saveTab };
}
