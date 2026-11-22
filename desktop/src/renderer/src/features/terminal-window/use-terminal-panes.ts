// Panes in the Terminal window (spec 2706 layer 6): one terminal per pane, a
// tab per group of panes on one machine, saved per machine. Pane focus is
// the sidebar selection, so the two never disagree.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closePane, focusPane, leaves, movePane, pruneTab, resizeSplit, singlePaneTab, splitPane, swapPanes, toggleZoom,
  type PaneDirection, type PaneTab,
} from "@matrix-os/ui/terminal-pane-tree";
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";
import { tabWithTerminal, usePaneLayouts, type PaneLayouts } from "./use-pane-layouts";

export type PaneCommand =
  | { command: "split-right" | "split-down" | "close-pane" | "zoom-pane" }
  | { command: "focus-pane" | "swap-pane"; direction: PaneDirection };

export type PaneNotice = "split-limit" | "split-failed" | null;

const machineOf = (key: string) => key.slice(0, Math.max(0, key.indexOf("|")));
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function useTerminalPanes(options: {
  selectedKey: string | null;
  rows: readonly TerminalSidebarRow[];
  select(key: string): void;
  /** Starts a terminal beside this one: same machine, and the same folder when known. Returns its row key. */
  createBeside(key: string): Promise<string | null>;
  /** The machine's terminals are fully listed, so a pane whose terminal is missing is really gone. */
  listed(machineId: string): boolean;
}) {
  const { layouts, saveTab } = usePaneLayouts();
  const [notice, setNotice] = useState<PaneNotice>(null);
  const { selectedKey, rows, select, createBeside, listed } = options;
  // The latest layouts as shown (missing panes dropped) and selection, for a split that finishes after an await.
  const latest = useRef({ layouts, selectedKey });
  // Terminals a split just started: their facts can arrive after the pane does. Bounded by the tab cap.
  const starting = useRef(new Set<string>());

  // A terminal a split started no longer needs holding once it is listed.
  useEffect(() => {
    const present = new Set(rows.map((row) => row.key));
    for (const key of [...starting.current]) if (present.has(key)) starting.current.delete(key);
  }, [rows]);

  // Panes whose terminal is gone, once their machine's list is complete. Shown
  // without them now, and saved without them on the tab's next change.
  const effective = useMemo<PaneLayouts>(() => {
    const present = new Set(rows.map((row) => row.key));
    const out: PaneLayouts = {};
    for (const [machineId, tabs] of Object.entries(layouts)) {
      out[machineId] = listed(machineId)
        ? tabs.flatMap((saved) => {
          const pruned = pruneTab(saved, (terminal) => present.has(terminal) || starting.current.has(terminal));
          return pruned && pruned.root.type === "split" ? [pruned] : [];
        })
        : tabs;
    }
    return out;
  }, [layouts, listed, rows]);

  useEffect(() => { latest.current = { layouts: effective, selectedKey }; }, [effective, selectedKey]);

  /**
   * The tab on screen: the one holding the selected terminal, focused on it.
   * When the selected terminal itself is gone, its tab stays on screen with
   * the remaining panes (`orphaned`), so the person keeps them.
   */
  const tab = useMemo<{ machineId: string; tab: PaneTab; orphaned: boolean } | null>(() => {
    if (!selectedKey) return null;
    const machineId = machineOf(selectedKey);
    const saved = tabWithTerminal(effective, machineId, selectedKey);
    const focus = saved ? leaves(saved.root).find((leaf) => leaf.terminal === selectedKey)?.id : undefined;
    if (saved && focus) return { machineId, tab: { ...saved, focus, zoom: saved.zoom ? focus : null }, orphaned: false };
    const raw = tabWithTerminal(layouts, machineId, selectedKey);
    const survivor = raw ? effective[machineId]?.find((candidate) => candidate.id === raw.id) : undefined;
    return survivor ? { machineId, tab: { ...survivor, zoom: null }, orphaned: true } : null;
  }, [effective, layouts, selectedKey]);

  // The selected terminal left its tab: select a pane that remains.
  const orphanedFocus = tab?.orphaned ? leaves(tab.tab.root).find((leaf) => leaf.id === tab.tab.focus)?.terminal ?? null : null;
  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- selection lives in the window; a vanished selection must move to a surviving pane
    if (orphanedFocus) select(orphanedFocus);
  }, [orphanedFocus, select]);

  const save = useCallback((next: PaneTab | null) => {
    if (tab) saveTab(tab.machineId, tab.tab.id, next);
  }, [saveTab, tab]);

  const split = useCallback(async (side: "right" | "down") => {
    if (!selectedKey) return;
    const source = selectedKey;
    const machineId = machineOf(source);
    const before = tab?.tab ?? singlePaneTab(source, newId);
    if (!splitPane(before, before.focus, side, "pending", newId)) { setNotice("split-limit"); return; }
    const created = await createBeside(source);
    if (!created) { setNotice("split-failed"); return; }
    // Other pane changes may have landed while the terminal started: split the tab as it is now.
    const now = tabWithTerminal(latest.current.layouts, machineId, source) ?? singlePaneTab(source, newId);
    const at = leaves(now.root).find((leaf) => leaf.terminal === source)?.id ?? now.focus;
    const next = splitPane(now, at, side, created, newId);
    if (!next) { setNotice("split-limit"); return; }
    setNotice(null);
    if (starting.current.size >= 64) starting.current.clear();
    starting.current.add(created);
    saveTab(machineId, now.id, next);
    // The new pane takes focus only if the person did not choose another terminal meanwhile.
    if (latest.current.selectedKey === source) select(created);
  }, [createBeside, saveTab, select, selectedKey, tab]);

  /** Handles a pane shortcut. */
  const run = useCallback((command: PaneCommand) => {
    switch (command.command) {
      case "split-right": void split("right"); return;
      case "split-down": void split("down"); return;
      case "close-pane": {
        if (!tab) return;
        // The pane closes; its terminal keeps running and stays in the sidebar.
        const next = closePane(tab.tab, tab.tab.focus);
        save(next);
        const focus = next ? leaves(next.root).find((leaf) => leaf.id === next.focus)?.terminal : null;
        if (focus) select(focus);
        return;
      }
      case "zoom-pane": if (tab) save(toggleZoom(tab.tab)); return;
      case "focus-pane": {
        if (!tab) return;
        const next = focusPane(tab.tab, command.direction);
        const terminal = leaves(next.root).find((leaf) => leaf.id === next.focus)?.terminal;
        if (terminal && terminal !== selectedKey) select(terminal);
        return;
      }
      case "swap-pane": if (tab) save(swapPanes(tab.tab, command.direction)); return;
    }
  }, [save, select, selectedKey, split, tab]);

  const focusLeaf = useCallback((leafId: string) => {
    const terminal = tab ? leaves(tab.tab.root).find((leaf) => leaf.id === leafId)?.terminal : undefined;
    if (terminal && terminal !== selectedKey) select(terminal);
  }, [select, selectedKey, tab]);
  const resize = useCallback((splitId: string, ratio: number) => {
    if (tab) save(resizeSplit(tab.tab, splitId, ratio));
  }, [save, tab]);
  const move = useCallback((sourceId: string, targetId: string, edge: PaneDirection) => {
    if (!tab) return;
    const next = movePane(tab.tab, sourceId, targetId, edge, newId);
    if (next === tab.tab) return;
    save(next);
    const terminal = leaves(next.root).find((leaf) => leaf.id === sourceId)?.terminal;
    if (terminal) select(terminal);
  }, [save, select, tab]);

  return { tab: tab?.tab ?? null, notice, run, focusLeaf, resize, move };
}
