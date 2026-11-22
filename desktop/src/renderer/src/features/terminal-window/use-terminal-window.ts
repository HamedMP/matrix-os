// Everything the Terminal window shows and does (spec 651, spec 2706): the
// inventories, live status rows, the one terminal on screen, and Herdr's
// shortcuts. Kept apart from the view so the rules stay testable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  terminalSidebarOrder,
  terminalStatusSections,
  type TerminalSidebarEntry,
  type TerminalSidebarRow,
} from "@matrix-os/ui/terminal-status-sidebar";
import type { TerminalEventsState } from "@matrix-os/ui/terminal-agents";
import { onEvent } from "../../lib/operator";
import { terminalRefKey } from "../../lib/terminal-workspaces";
import type { LocalTerminalAgent } from "../../../../shared/local-terminals";
import type { TerminalWindowCommand } from "../../../../shared/terminal-window";
import { closeComputerTab, renameComputerTab } from "./computer-terminals";
import { useComputerTerminals } from "./use-computer-terminals";
import { useLocalTerminals } from "./use-local-terminals";
import { useSidebarPrefs } from "./use-sidebar-prefs";
import { useTerminalMachines } from "./use-terminal-machines";
import {
  computerMachineId, localMachine, terminalRowTarget, useTerminalStatus, type LocalTerminalFactsState,
} from "./use-terminal-status";

const CLOCK_MS = 30_000;

export function useTerminalWindow() {
  const machines = useTerminalMachines();
  const ready = machines.state.status === "ready" ? machines.state : null;
  const cloud = useComputerTerminals(ready?.platformHost ?? null, ready?.sessionKey ?? "");
  const local = useLocalTerminals();
  const sidebar = useSidebarPrefs();
  const here = useMemo(() => localMachine(), []);
  const localFacts = useMemo<LocalTerminalFactsState>(
    () => (local.state.status === "ready" ? { status: "ready", terminals: local.state.facts } : local.state),
    [local.state],
  );
  const computers = useMemo(() => ready?.computers ?? [], [ready]);
  const status = useTerminalStatus({
    local: localFacts, platformHost: ready?.platformHost ?? null, sessionKey: ready?.sessionKey ?? "", computers,
  });
  // A local terminal and a cloud terminal are never attached at once. The
  // title is kept so the pane can stay, labelled, after its program exits.
  const [localOpen, setLocalOpen] = useState<{ id: string; title: string } | null>(null);
  const [findRequest, setFindRequest] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const [closing, setClosing] = useState<{ key: string; name: string } | null>(null);
  // The last computer action that did not take effect, shown until the next one.
  const [computerNotice, setComputerNotice] = useState<"rename-failed" | "end-failed" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const localTerminals = useMemo(() => (local.state.status === "ready" ? local.state.terminals : []), [local.state]);
  // Counts the person's choices. A terminal that finishes starting is opened only if nothing was chosen since.
  const localChoice = useRef(0);
  const listedLocal = localTerminals.find((terminal) => terminal.id === localOpen?.id);
  // Still running here or on an added machine (`vps/t5`): only a terminal no longer live has ended.
  const liveLocal = local.state.status === "ready" && local.state.facts.some((fact) => fact.id === localOpen?.id && !fact.finished);
  const endedLocal = localOpen && !liveLocal && local.state.status === "ready" ? localOpen : null;
  const localTerminal = listedLocal ?? localOpen ?? undefined;
  const { clearActive, open, create } = cloud;
  const cloudActive = useRef(cloud.active);
  useEffect(() => { cloudActive.current = cloud.active; }, [cloud.active]);

  const selectedKey = localOpen ? `${here.id}|${localOpen.id}`
    : cloud.active ? `${computerMachineId(cloud.active.slot)}|${cloud.active.refKey}` : null;
  const visibleRows = status.rows;
  const order = useMemo(
    () => terminalSidebarOrder(terminalStatusSections(visibleRows, { view: sidebar.prefs.view })),
    [visibleRows, sidebar.prefs.view],
  );
  const selectedRow: TerminalSidebarRow | undefined = status.rows.find((row) => row.key === selectedKey);
  const { markSeen } = status;

  // Done since the person last looked: looking at it now counts, in this window and theirs elsewhere.
  useEffect(() => {
    if (!selectedRow || selectedRow.status !== "done" || selectedRow.seen) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    markSeen(selectedRow.key);
  }, [markSeen, selectedRow]);
  useEffect(() => onEvent("window:focus-changed", ({ focused }) => {
    if (focused && selectedRow?.status === "done" && !selectedRow.seen) markSeen(selectedRow.key);
  }), [markSeen, selectedRow]);

  const openLocal = useCallback((id: string, title?: string) => {
    localChoice.current += 1;
    clearActive();
    setLocalOpen({ id, title: title ?? localTerminals.find((terminal) => terminal.id === id)?.title ?? "Terminal" });
  }, [clearActive, localTerminals]);
  const openCloud = useCallback((slot: string, refKey: string) => {
    localChoice.current += 1;
    setLocalOpen(null);
    open(slot, refKey);
  }, [open]);

  const select = useCallback((key: string) => {
    const target = terminalRowTarget(key);
    if (!target) return;
    const name = status.rows.find((row) => row.key === key)?.name;
    if (target.kind === "local") openLocal(target.id, name);
    else openCloud(target.slot, terminalRefKey(target.ref));
    markSeen(key);
  }, [markSeen, openCloud, openLocal, status.rows]);

  const createLocal = useCallback((launch: { agent?: LocalTerminalAgent } = {}) => {
    const chosen = localChoice.current;
    const cloudChosen = cloud.active;
    void local.create(launch).then((id) => {
      // Opened only if the person did not pick another terminal meanwhile.
      if (!id || localChoice.current !== chosen || cloudActive.current !== cloudChosen) return;
      localChoice.current += 1;
      clearActive();
      setLocalOpen({ id, title: "Terminal" });
    });
  }, [clearActive, cloud.active, local]);
  const createCloud = useCallback((slot: string) => {
    localChoice.current += 1;
    setLocalOpen(null);
    void create(slot);
  }, [create]);

  const rename = useCallback((key: string, name: string) => {
    const target = terminalRowTarget(key);
    if (!target) return;
    if (target.kind === "local") {
      void local.rename(target.id, name).then((renamed) => {
        if (renamed) setLocalOpen((current) => (current?.id === target.id ? { ...current, title: name } : current));
      });
      return;
    }
    const api = cloud.api(target.slot);
    if (!api) { setComputerNotice("rename-failed"); return; }
    void renameComputerTab(api, target.ref, name).then(() => setComputerNotice(null), (error: unknown) => {
      console.warn("[terminal-window] rename failed:", error instanceof Error ? error.name : "UnknownError");
      setComputerNotice("rename-failed");
    });
  }, [cloud, local]);

  /** Ends a live terminal or removes a finished one; the pane stays until that is confirmed. */
  const close = useCallback((key: string) => {
    const target = terminalRowTarget(key);
    if (!target) return;
    if (target.kind === "local") {
      const finished = local.state.status === "ready" && local.state.facts.some((fact) => fact.id === target.id && fact.finished);
      const ending = finished ? local.remove(target.id) : local.end(target.id);
      void ending.then((done) => { if (done) setLocalOpen((current) => (current?.id === target.id ? null : current)); });
      return;
    }
    const api = cloud.api(target.slot);
    if (!api) { setComputerNotice("end-failed"); return; }
    void closeComputerTab(api, target.ref).then(() => {
      setComputerNotice(null);
      if (cloudActive.current?.refKey === terminalRefKey(target.ref)) clearActive();
    }, (error: unknown) => {
      console.warn("[terminal-window] close failed:", error instanceof Error ? error.name : "UnknownError");
      setComputerNotice("end-failed");
    });
  }, [clearActive, cloud, local]);

  const step = useCallback((offset: number) => {
    if (order.length === 0) return;
    const index = order.findIndex((entry) => entry.key === selectedKey);
    const next = index < 0 ? (offset > 0 ? 0 : order.length - 1) : (index + offset + order.length) % order.length;
    select(order[next]!.key);
  }, [order, select, selectedKey]);

  const run = useCallback((command: TerminalWindowCommand) => {
    switch (command.command) {
      case "new-terminal": {
        const target = selectedKey ? terminalRowTarget(selectedKey) : null;
        if (target?.kind === "computer") createCloud(target.slot);
        else createLocal({});
        return;
      }
      case "close-terminal":
        if (!selectedRow) return;
        // A finished terminal goes at once; ending a running program asks first.
        if (isFinished(selectedRow.key, local.state, status.states)) close(selectedRow.key);
        else setClosing({ key: selectedRow.key, name: selectedRow.name });
        return;
      case "select": {
        const entry = order[command.index - 1];
        if (entry) select(entry.key);
        return;
      }
      case "next": step(1); return;
      case "previous": step(-1); return;
      case "rename":
        if (selectedRow) setRenaming({ key: selectedRow.key, name: selectedRow.name });
        return;
      case "toggle-sidebar": sidebar.toggleRail(); return;
      case "picker": setPickerOpen(true); return;
      case "find": setFindRequest((request) => request + 1); return;
    }
  }, [close, createCloud, createLocal, local.state, order, select, selectedKey, selectedRow, sidebar, status.states, step]);
  useEffect(() => onEvent("terminal-window:command", run), [run]);

  return {
    machines, ready, cloud, local, here, sidebar, status, now, computerNotice,
    /** This Mac and the machine on screen start open; others start folded, unless the person chose. */
    machineFolded: (id: string) => sidebar.prefs.machineFolds[id] ?? !(id === here.id || (selectedKey?.startsWith(`${id}|`) ?? false)),
    localTerminal, endedLocal, selectedKey, selectedRow, order: order as TerminalSidebarEntry[], findRequest,
    picker: { open: pickerOpen, close: () => setPickerOpen(false) },
    renaming, setRenaming, closing, setClosing,
    select, createLocal, createCloud, rename, close,
    dismissEndedLocal: () => { localChoice.current += 1; setLocalOpen(null); },
  };
}

/** A terminal whose program has ended, as opposed to one that only reports `done`. */
function isFinished(
  key: string,
  local: ReturnType<typeof useLocalTerminals>["state"],
  computers: Readonly<Record<string, TerminalEventsState>>,
): boolean {
  const target = terminalRowTarget(key);
  if (!target) return false;
  if (target.kind === "local") return local.status === "ready" && local.facts.some((fact) => fact.id === target.id && fact.finished);
  return computers[target.slot]?.tabs[terminalRefKey(target.ref)]?.state === "finished";
}

export type TerminalWindowView = ReturnType<typeof useTerminalWindow>;
