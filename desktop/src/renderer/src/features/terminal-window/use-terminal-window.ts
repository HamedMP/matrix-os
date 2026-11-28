// Everything the Terminal window shows and does (spec 651, spec 2706): the
// inventories, live status rows, the one terminal on screen, and Herdr's
// shortcuts. Kept apart from the view so the rules stay testable.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  terminalSidebarOrder,
  terminalStatusSections,
  type TerminalSidebarEntry,
  type TerminalSidebarRow,
} from "@matrix-os/ui/terminal-status-sidebar";
import type { TerminalEventsState } from "@matrix-os/ui/terminal-agents";
import { onEvent } from "../../lib/operator";
import { terminalRefKey } from "../../lib/terminal-workspaces";
import type { LocalTerminalAgent, SshOptions } from "../../../../shared/local-terminals";
import type { TerminalWindowCommand } from "../../../../shared/terminal-window";
import { closeComputerTab, createComputerTab, renameComputerTab } from "./computer-terminals";
import { friendlyTerminalName } from "./terminal-friendly-name";
import { useTerminalPanes } from "./use-terminal-panes";
import { useOpenTabs } from "./use-open-tabs";
import { leaves } from "@matrix-os/ui/terminal-pane-tree";
import type { PaneButton } from "./TerminalPaneTree";
import { useSshMachines } from "./use-ssh-machines";
import { useComputerTerminals } from "./use-computer-terminals";
import { useLocalTerminals } from "./use-local-terminals";
import { useSidebarPrefs } from "./use-sidebar-prefs";
import { filterRows, spacesInOrder, type SidebarFilter } from "./TerminalWindowSidebar";
import { inOrder } from "./SidebarSpaces";
import { useTerminalMachines } from "./use-terminal-machines";
import { useTerminalWindowKeys } from "./use-terminal-window-keys";
import {
  computerMachineId, localMachine, localRowKey, sshMachineId, terminalRowTarget, useTerminalStatus, type LocalTerminalFactsState,
} from "./use-terminal-status";

const CLOCK_MS = 30_000;

export function useTerminalWindow() {
  const machines = useTerminalMachines();
  const ready = machines.state.status === "ready" ? machines.state : null;
  const cloud = useComputerTerminals(ready?.platformHost ?? null, ready?.sessionKey ?? "");
  const local = useLocalTerminals();
  const ssh = useSshMachines();
  // The ssh target whose login terminal did not start, shown on its machine row.
  const [sshLoginFailed, setSshLoginFailed] = useState<string | null>(null);
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
  // Each Cmd+F belongs to the terminal it was pressed on.
  const [find, setFind] = useState<{ request: number; key: string | null }>({ request: 0, key: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  // The overview of every terminal in the active space, in place of the panes.
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  // A terminal about to be ended: its friendly name, and whether it is one pane of a split.
  const [closing, setClosing] = useState<{ key: string; name: string; pane: boolean } | null>(null);
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

  const selectedKey = localOpen ? localRowKey(localOpen.id)
    : cloud.active ? `${computerMachineId(cloud.active.slot)}|${cloud.active.refKey}` : null;
  // Next, previous and numbers follow the agents list as shown, with a machine opened as its own tab.
  const visibleRows = useMemo(() => filterRows(status.rows, sidebar.prefs.filter), [status.rows, sidebar.prefs.filter]);
  const order = useMemo(
    // The order the agents list shows, pinned terminals first, so Cmd+] / Cmd+[ and the picker follow it.
    () => terminalSidebarOrder(terminalStatusSections(visibleRows, { view: sidebar.prefs.view, pinned: sidebar.prefs.pinned })),
    [visibleRows, sidebar.prefs.view, sidebar.prefs.pinned],
  );
  // The signed-in session now, for work that finishes after it may have changed.
  const sessionRef = useRef(ready?.sessionKey ?? "");
  useEffect(() => { sessionRef.current = ready?.sessionKey ?? ""; }, [ready?.sessionKey]);
  const selectedRow: TerminalSidebarRow | undefined = status.rows.find((row) => row.key === selectedKey);
  // The selection when an end finishes, which may differ from when it started.
  const selectedRef = useRef(selectedKey);
  useEffect(() => { selectedRef.current = selectedKey; }, [selectedKey]);
  const { markSeen } = status;

  // Done since the person last looked: looking at it now counts, in this window and theirs elsewhere.
  // The overview hides the selected terminal, so it is not looked at until the overview gives way.
  useEffect(() => {
    if (overviewOpen || !selectedRow || selectedRow.status !== "done" || selectedRow.seen) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    markSeen(selectedRow.key);
  }, [markSeen, overviewOpen, selectedRow]);
  useEffect(() => onEvent("window:focus-changed", ({ focused }) => {
    if (focused && !overviewOpen && selectedRow?.status === "done" && !selectedRow.seen) markSeen(selectedRow.key);
  }), [markSeen, overviewOpen, selectedRow]);

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

  const createLocal = useCallback((launch: { agent?: LocalTerminalAgent; machine?: string } = {}) => {
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
  /** Opens the terminal running `ssh <target>`, for a host key or password only the person can answer. */
  /** Shows a login terminal unless the person chose another terminal while it started. */
  const showLogin = useCallback((id: string, title: string, chosen: number, cloudChosen: typeof cloud.active) => {
    if (localChoice.current !== chosen || cloudActive.current !== cloudChosen) return;
    localChoice.current += 1;
    clearActive();
    setLocalOpen({ id, title });
  }, [clearActive]);
  const openSshLogin = useCallback(async (target: string, options?: SshOptions): Promise<boolean> => {
    const chosen = localChoice.current;
    const cloudChosen = cloudActive.current;
    const id = await ssh.sshLogin(target, options);
    setSshLoginFailed(id ? null : target);
    if (!id) return false;
    showLogin(id, `ssh ${target}`, chosen, cloudChosen);
    return true;
  }, [showLogin, ssh]);
  /** Open in terminal from a machine row: ssh there with the options it was added with. */
  const openMachineLogin = useCallback(async (name: string): Promise<boolean> => {
    const chosen = localChoice.current;
    const cloudChosen = cloudActive.current;
    const id = await ssh.machineLogin(name);
    setSshLoginFailed(id ? null : name);
    if (!id) return false;
    showLogin(id, `ssh ${name}`, chosen, cloudChosen);
    return true;
  }, [showLogin, ssh]);
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

  // The machines whose spaces the sidebar lists, in the person's order: this device, its ssh machines, then every usable computer.
  const sshMachines = ssh.state.status === "ready" ? ssh.state.machines : null;
  const spaceMachines = useMemo(() => inOrder([
    here.id,
    ...(sshMachines ?? []).map((machine) => sshMachineId(machine.name)),
    ...computers.filter((computer) => computer.availability === "available").map((computer) => computerMachineId(computer.runtimeSlot)),
  ], (id) => id, sidebar.prefs.machineOrder), [computers, here.id, sidebar.prefs.machineOrder, sshMachines]);
  const spaces = useMemo(() => spacesInOrder(spaceMachines, status.rows, sidebar.prefs.spaceOrder), [sidebar.prefs.spaceOrder, spaceMachines, status.rows]);

  /** A terminal's ↗: show it, as a tab of its own space (its project, or its machine), and make that space active. */
  const openInTab = useCallback((key: string) => {
    const row = status.rows.find((candidate) => candidate.key === key);
    if (row) sidebar.setFilter(row.space ? { machineId: row.machine.id, space: row.space } : { machineId: row.machine.id });
    select(key);
  }, [select, sidebar, status.rows]);

  const step = useCallback((offset: number) => {
    if (order.length === 0) return;
    const index = order.findIndex((entry) => entry.key === selectedKey);
    const next = index < 0 ? (offset > 0 ? 0 : order.length - 1) : (index + offset + order.length) % order.length;
    select(order[next]!.key);
  }, [order, select, selectedKey]);

  const createBeside = useCallback(async (key: string): Promise<string | null> => {
    const machineId = key.slice(0, Math.max(0, key.indexOf("|")));
    if (machineId === here.id || machineId.startsWith("ssh:")) {
      const machine = machineId.startsWith("ssh:") ? machineId.slice("ssh:".length) : undefined;
      const id = await local.create(machine ? { machine } : {});
      return id ? localRowKey(id) : null;
    }
    const target = terminalRowTarget(key);
    if (target?.kind !== "computer") return null;
    const api = cloud.api(target.slot);
    if (!api) return null;
    // In the same workspace and folder; a folder the stream had to shorten is not guessed at.
    const cwd = status.states[target.slot]?.tabs[terminalRefKey(target.ref)]?.cwd ?? "";
    try {
      return `${machineId}|${await createComputerTab(api, "Terminal", { workspaceId: target.ref.workspaceId, cwd: cwd.length < 256 ? cwd : "" })}`;
    } catch (error: unknown) {
      console.warn("[terminal-window] pane terminal failed:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, [cloud, here.id, local, status.states]);
  const listed = useCallback((machineId: string) => {
    if (machineId === here.id) return local.state.status === "ready";
    // An ssh machine's terminals are listed only while the core is connected to it.
    if (machineId.startsWith("ssh:")) {
      return local.state.status === "ready" && ssh.state.status === "ready"
        && ssh.state.machines.some((machine) => sshMachineId(machine.name) === machineId && machine.state === "connected");
    }
    return status.states[machineId.slice("computer:".length)]?.connected === true;
  }, [here.id, local.state.status, ssh.state, status.states]);
  const panes = useTerminalPanes({ selectedKey, rows: status.rows, select, createBeside, listed });
  const { dropTerminal } = panes;

  const rowKeys = useMemo(() => new Set(status.rows.map((row) => row.key)), [status.rows]);
  const exists = useCallback((key: string) => {
    if (rowKeys.has(key)) return true;
    return listed(key.slice(0, Math.max(0, key.indexOf("|")))) ? false : null;
  }, [listed, rowKeys]);
  const openTabs = useOpenTabs({ selectedKey, groupOf: panes.groupOf, exists });
  const { forget: forgetTab } = openTabs;
  // With a space (or machine) chosen, the tab bar shows only its tabs, as the agents list does.
  const shownTabs = useMemo(() => {
    if (!sidebar.prefs.filter) return openTabs.tabs;
    const shown = new Set(visibleRows.map((row) => row.key));
    return openTabs.tabs.filter((tab) => tab.terminals.some((key) => shown.has(key)));
  }, [openTabs.tabs, sidebar.prefs.filter, visibleRows]);

  /** A new terminal beside one of the active space's (same machine, workspace and folder), then shown. */
  const createInSpace = useCallback((neighbour: string) => {
    const chosen = localChoice.current;
    const session = sessionRef.current;
    void createBeside(neighbour).then((created) => {
      // Shown only if the person chose nothing else meanwhile and is still signed in to the same session.
      if (created && localChoice.current === chosen && sessionRef.current === session) select(created);
    });
  }, [createBeside, select]);

  /** Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab in the tab bar, wrapping around. */
  const stepTab = useCallback((offset: number) => {
    const tabs = shownTabs;
    if (tabs.length === 0) return;
    const index = tabs.findIndex((tab) => selectedKey !== null && tab.terminals.includes(selectedKey));
    const next = index < 0 ? (offset > 0 ? 0 : tabs.length - 1) : (index + offset + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (tab && tab.key !== selectedKey) select(tab.key);
  }, [shownTabs, select, selectedKey]);


  /**
   * Ends a live terminal or removes a finished one. Its pane stays until that
   * is confirmed, then leaves its tab, and the pane beside it takes focus.
   */
  const close = useCallback((key: string) => {
    const target = terminalRowTarget(key);
    if (!target) return;
    const ended = () => {
      forgetTab(key);
      const successor = dropTerminal(key);
      if (successor && selectedRef.current === key) select(successor);
      return successor;
    };
    if (target.kind === "local") {
      const finished = local.state.status === "ready" && local.state.facts.some((fact) => fact.id === target.id && fact.finished);
      // Closing a running terminal's pane ends it and takes it off the list, as Herdr does.
      const ending = finished ? local.remove(target.id) : local.close(target.id);
      void ending.then((done) => {
        if (!done) return;
        if (!ended()) setLocalOpen((current) => (current?.id === target.id ? null : current));
      });
      return;
    }
    const api = cloud.api(target.slot);
    if (!api) { setComputerNotice("end-failed"); return; }
    void closeComputerTab(api, target.ref).then(() => {
      setComputerNotice(null);
      if (!ended() && cloudActive.current?.refKey === terminalRefKey(target.ref)) clearActive();
    }, (error: unknown) => {
      console.warn("[terminal-window] close failed:", error instanceof Error ? error.name : "UnknownError");
      setComputerNotice("end-failed");
    });
  }, [clearActive, cloud, dropTerminal, forgetTab, local, select]);

  /** Closes a terminal's pane by ending it: a finished one goes at once, a running program asks first. */
  const requestClose = useCallback((key: string) => {
    if (isFinished(key, local.state, status.states)) { close(key); return; }
    setClosing({
      key, name: friendlyTerminalName(status.rows.find((row) => row.key === key)), pane: panes.groupOf(key).terminals.length > 1,
    });
  }, [close, local.state, panes, status.rows, status.states]);

  /** Shows nothing: the last tab on the bar was closed. */
  const deselect = useCallback(() => {
    localChoice.current += 1;
    setLocalOpen(null);
    clearActive();
  }, [clearActive]);

  /**
   * Makes a space active (null is All). The terminal on screen stays when it is
   * in that space; otherwise the space's first open tab shows, or nothing.
   */
  const chooseSpace = useCallback((filter: SidebarFilter | null) => {
    // A new choice: a terminal still starting elsewhere does not take the screen afterwards.
    localChoice.current += 1;
    sidebar.setFilter(filter);
    if (!filter) return;
    const inSpace = new Set(filterRows(status.rows, filter).map((row) => row.key));
    if (selectedKey && inSpace.has(selectedKey)) return;
    const first = openTabs.tabs.find((tab) => tab.terminals.some((key) => inSpace.has(key)));
    if (first) select(first.terminals.find((key) => inSpace.has(key)) ?? first.key);
    else deselect();
  }, [deselect, openTabs.tabs, select, selectedKey, sidebar, status.rows]);

  /** Takes a tab off the bar (its terminals keep running); the tab beside it opens when it was on screen. */
  const closeTab = useCallback((id: string) => {
    const index = shownTabs.findIndex((tab) => tab.id === id);
    const wasOnScreen = shownTabs[index]?.terminals.includes(selectedKey ?? "") ?? false;
    openTabs.closeTab(id);
    if (!wasOnScreen) return;
    // The tab beside it in the bar as shown (the active space), or nothing when the space has no other tab.
    const next = shownTabs[index + 1] ?? shownTabs[index - 1];
    if (next) select(next.key);
    else deselect();
  }, [deselect, openTabs, select, selectedKey, shownTabs]);

  /** A pane header button. */
  const paneButton = useCallback((leafId: string, button: PaneButton) => {
    if (button !== "close") { panes.headerAction(leafId, button === "zoom" ? "zoom" : button); return; }
    const terminal = panes.tab ? leaves(panes.tab.root).find((leaf) => leaf.id === leafId)?.terminal : undefined;
    if (terminal) requestClose(terminal);
  }, [panes, requestClose]);

  const run = useCallback((command: TerminalWindowCommand) => {
    switch (command.command) {
      // Actions on a pane show the panes: the overview gives way so the result is in view.
      case "split-right": case "split-down": case "close-pane": case "zoom-pane":
        setOverviewOpen(false);
        panes.run({ command: command.command });
        return;
      case "focus-pane": case "swap-pane":
        setOverviewOpen(false);
        panes.run({ command: command.command, direction: command.direction });
        return;
      case "new-terminal": {
        setOverviewOpen(false);
        // Cmd+T / Cmd+N start the terminal in the active space: in a project, beside one of its terminals
        // (same workspace and folder); on a machine, on that machine.
        const space = sidebar.prefs.filter;
        if (space) {
          const neighbour = space.space ? visibleRows[0] : undefined;
          if (neighbour) { createInSpace(neighbour.key); return; }
          if (space.machineId.startsWith("computer:")) { createCloud(space.machineId.slice("computer:".length)); return; }
          // An ssh machine's home space starts the terminal on that machine.
          if (space.machineId.startsWith("ssh:")) { createLocal({ machine: space.machineId.slice("ssh:".length) }); return; }
          createLocal({});
          return;
        }
        const target = selectedKey ? terminalRowTarget(selectedKey) : null;
        if (target?.kind === "computer") createCloud(target.slot);
        else if (target?.id.includes("/")) createLocal({ machine: target.id.slice(0, target.id.indexOf("/")) });
        else createLocal({});
        return;
      }
      case "close-terminal":
        // Cmd+W closes the focused pane, ending its terminal; the pane comes into view first.
        setOverviewOpen(false);
        if (selectedKey) requestClose(selectedKey);
        return;
      case "space": {
        // Ctrl+0 is All; Ctrl+1…9 the spaces in the sidebar's order.
        if (command.index === 0) { chooseSpace(null); return; }
        const space = spaces[command.index - 1];
        if (space) chooseSpace(space);
        return;
      }
      case "select": {
        // Cmd+1…9: that tab of the active space, in tab-bar order.
        const tab = shownTabs[command.index - 1];
        if (tab) { setOverviewOpen(false); select(tab.key); }
        return;
      }
      case "next": setOverviewOpen(false); step(1); return;
      case "previous": setOverviewOpen(false); step(-1); return;
      case "next-tab": setOverviewOpen(false); stepTab(1); return;
      case "previous-tab": setOverviewOpen(false); stepTab(-1); return;
      case "rename":
        if (selectedRow) setRenaming({ key: selectedRow.key, name: selectedRow.name });
        return;
      case "toggle-sidebar": sidebar.toggleRail(); return;
      case "picker": setPickerOpen(true); return;
      case "overview": setOverviewOpen((open) => !open); return;
      case "find":
        // Find searches the focused terminal, which the overview covers.
        setOverviewOpen(false);
        setFind((current) => ({ request: current.request + 1, key: selectedKey }));
        return;
    }
  }, [chooseSpace, createCloud, createInSpace, createLocal, panes, requestClose, select, selectedKey, selectedRow, shownTabs, sidebar, spaces, step, stepTab, visibleRows]);
  // One listener for the window's life that runs the handler of the last commit: a shortcut pressed
  // right after a selection change must act on the new selection, not wait for a passive effect.
  const latestRun = useRef(run);
  useLayoutEffect(() => { latestRun.current = run; }, [run]);
  useEffect(() => onEvent("terminal-window:command", (command) => latestRun.current(command)), []);

  // What the person opens or starts themselves is shown: the overview gives way to it.
  const show = useCallback((key: string) => { setOverviewOpen(false); select(key); }, [select]);
  const showInTab = useCallback((key: string) => { setOverviewOpen(false); openInTab(key); }, [openInTab]);
  const startLocal = useCallback((launch?: Parameters<typeof createLocal>[0]) => { setOverviewOpen(false); createLocal(launch); }, [createLocal]);
  const startCloud = useCallback((slot: string) => { setOverviewOpen(false); createCloud(slot); }, [createCloud]);

  const reservedKeys = useTerminalWindowKeys();

  return {
    reservedKeys,
    machines, ready, cloud, local, here, sidebar, status, now, computerNotice, panes, ssh, openSshLogin, openMachineLogin, sshLoginFailed,
    localTerminal, endedLocal, selectedKey, selectedRow, order: order as TerminalSidebarEntry[],
    /** The find request for this terminal: only the one it was made on sees it. */
    findRequestFor: (key: string | null) => (key && find.key === key ? find.request : 0),
    picker: { open: pickerOpen, close: () => setPickerOpen(false) },
    renaming, setRenaming, closing, setClosing,
    select: show, createLocal: startLocal, createCloud: startCloud, rename, close, requestClose, openInTab: showInTab, paneButton,
    tabs: shownTabs, closeTab, chooseSpace,
    overview: {
      open: overviewOpen,
      toggle: () => setOverviewOpen((open) => !open),
      /** A card's click: show that terminal and leave the overview. */
      openTerminal: show,
    },
    /** The bar's +: a new terminal on the machine on screen. */
    newTerminal: () => run({ command: "new-terminal" }),
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
