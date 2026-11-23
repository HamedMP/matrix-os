// The Terminal window's top tab bar (spec 2706): Herdr's workspaces as tabs.
// Each terminal the person opens joins the bar; terminals that share a pane
// tab show as one tab. Closing a tab only takes it off the bar; its
// terminals keep running and stay in the sidebar. Kept in this renderer's
// storage as a per-viewer convenience that survives storage being unavailable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v4";
import { MAX_PANES_PER_TAB } from "@matrix-os/ui/terminal-pane-tree";

const STORAGE_KEY = "matrix.terminal-window.tabs.v1";
export const MAX_OPEN_TABS = 24;
// The bar holds at most MAX_OPEN_TABS tabs; a tab may hold a full pane tree.
const MAX_OPEN_TERMINALS = MAX_OPEN_TABS * MAX_PANES_PER_TAB;
const OpenSchema = z.array(z.string().min(1).max(256)).max(MAX_OPEN_TERMINALS);

export interface OpenTab {
  /** The pane tab's id, or the terminal's key for a terminal on its own. */
  id: string;
  /** The terminal the tab opens to: the selected one when it is in this tab. */
  key: string;
  terminals: string[];
}

/** Opened terminals grouped by the pane tab they share, in the order first opened. */
export function openTabGroups(
  opened: readonly string[],
  groupOf: (key: string) => { id: string; terminals: string[] },
  selectedKey: string | null,
): OpenTab[] {
  const tabs = new Map<string, OpenTab>();
  for (const key of opened) {
    const group = groupOf(key);
    const existing = tabs.get(group.id);
    if (!existing) tabs.set(group.id, { id: group.id, key, terminals: group.terminals });
    if (key === selectedKey) tabs.set(group.id, { id: group.id, key, terminals: group.terminals });
  }
  return [...tabs.values()];
}

/**
 * The opened terminals with `key` added. Past MAX_OPEN_TABS tabs, the oldest
 * whole tabs leave the bar (never the one `key` joins), so a big pane tab never
 * pushes out unrelated tabs one terminal at a time.
 */
export function openTerminal(
  current: readonly string[],
  key: string,
  groupOf: (key: string) => { id: string },
): readonly string[] {
  const next = current.includes(key) ? current : [...current, key];
  const groups = [...new Set(next.map((entry) => groupOf(entry).id))];
  if (groups.length <= MAX_OPEN_TABS && next.length <= MAX_OPEN_TERMINALS) return next;
  const keep = groupOf(key).id;
  const dropping = new Set(groups.filter((id) => id !== keep).slice(0, Math.max(1, groups.length - MAX_OPEN_TABS)));
  return next.filter((entry) => !dropping.has(groupOf(entry).id)).slice(-MAX_OPEN_TERMINALS);
}

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = OpenSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch (error: unknown) {
    console.warn("[terminal-window] open tabs unreadable:", error instanceof Error ? error.name : "UnknownError");
    return [];
  }
}

export function useOpenTabs(options: {
  selectedKey: string | null;
  groupOf(key: string): { id: string; terminals: string[] };
  /** Whether a terminal still exists, or `null` while its machine's list is incomplete. */
  exists(key: string): boolean | null;
}) {
  const { selectedKey, groupOf, exists } = options;
  const [opened, setOpened] = useState<readonly string[]>(read);
  const changed = useRef(false);
  const groupOfRef = useRef(groupOf);
  useEffect(() => { groupOfRef.current = groupOf; }, [groupOf]);

  // The selected terminal joins the bar.
  useEffect(() => {
    if (!selectedKey) return;
    // At worst this saves an unchanged list once.
    changed.current = true;
    setOpened((current) => openTerminal(current, selectedKey, groupOfRef.current));
  }, [selectedKey]);

  useEffect(() => {
    if (!changed.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(opened));
    } catch (error: unknown) {
      console.warn("[terminal-window] open tabs not saved:", error instanceof Error ? error.name : "UnknownError");
    }
  }, [opened]);

  // Terminals that are gone leave the bar once their machine is fully listed.
  const live = useMemo(() => opened.filter((key) => exists(key) !== false), [exists, opened]);
  const tabs = useMemo(() => openTabGroups(live, groupOf, selectedKey), [groupOf, live, selectedKey]);

  /** Takes a tab off the bar. Returns the tab that takes its place, if any. */
  const closeTab = useCallback((id: string): OpenTab | null => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const closing = tabs[index];
    if (!closing) return null;
    const leaving = new Set([...closing.terminals, closing.key]);
    changed.current = true;
    setOpened((current) => current.filter((key) => !leaving.has(key)));
    return tabs[index + 1] ?? tabs[index - 1] ?? null;
  }, [tabs]);

  /** Takes one terminal off the bar, as when its pane is closed. */
  const forget = useCallback((key: string) => {
    changed.current = true;
    setOpened((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : current));
  }, []);

  return { tabs, closeTab, forget };
}
