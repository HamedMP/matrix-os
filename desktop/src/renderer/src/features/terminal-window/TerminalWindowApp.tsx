// The Electron Desktop Terminal window (specs/651-desktop-terminal-window,
// specs/2706-terminal-window-herdr). Herdr's layout: machines and every
// terminal by status on the left, the terminal on screen on the right.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster } from "sonner";
import { Button } from "@matrix-os/ui";
import { SquareTerminal, X } from "lucide-react";
import type { MatrixComputer } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";
import { useAppearance } from "../../stores/appearance";
import TerminalView from "../terminal/TerminalView";
import { createPaneAttachManager } from "../terminal/terminal-runtime";
import type { AttachManager } from "../terminal/attach-manager";
import { DesktopTerminalAgentLogo } from "../terminal/DesktopTerminalAgentLogo";
import { TERMINAL_AGENT_OPTIONS, type TerminalAgentId } from "../terminal/terminal-agent-options";
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";
import type { TerminalMachinesState } from "./use-terminal-machines";
import { localSessionName, type LocalTerminalsNotice, type LocalTerminalsState } from "./use-local-terminals";
import { LocalTerminalAttention } from "./LocalTerminalAttention";
import { TerminalWindowSidebar, filterRows, type SidebarMachine } from "./TerminalWindowSidebar";
import { CloseTerminalDialog, RenameTerminalDialog, TerminalPicker } from "./TerminalWindowDialogs";
import { useTerminalWindow, type TerminalWindowView } from "./use-terminal-window";
import { computerMachineId, localRowKey, sshMachineId, terminalRowTarget } from "./use-terminal-status";
import { AddMachineDialog, RemoveMachineDialog } from "./AddMachineDialog";
import { compareCoreVersions, LOCAL_TERMINAL_VERSION, type LocalCreateFailure, type LocalMachine } from "../../../../shared/local-terminals";
import { TerminalPaneTree, type PaneInfo } from "./TerminalPaneTree";
import { TerminalTabBar, type ActiveSpaceChip } from "./TerminalTabBar";
import { TerminalOverview } from "./TerminalOverview";
import { useTerminalPreviews } from "./use-terminal-previews";
import { defaultSpaceColor, spaceId } from "./SidebarSpaces";
import { createFailureText } from "./computer-terminals";
import { terminalRefKey } from "../../lib/terminal-workspaces";
import type { PaneTab } from "@matrix-os/ui/terminal-pane-tree";
import type { TerminalPaneAction } from "@matrix-os/contracts";

const AVAILABILITY_LABEL: Record<MatrixComputer["availability"], string> = {
  available: "Available",
  starting: "Starting",
  unavailable: "Unavailable",
};
const AVAILABILITY_COLOR: Record<MatrixComputer["availability"], string> = {
  available: "var(--color-success)",
  starting: "var(--color-warning)",
  unavailable: "var(--text-tertiary, var(--color-muted-foreground))",
};
// Why a terminal on this device did not start, as the main process classified it.
const LOCAL_CREATE_FAILURE: Record<LocalCreateFailure, string> = {
  timeout: "Couldn't start a terminal: this device's terminal service did not answer. Try again.",
  busy: "Couldn't start a terminal: this device's terminal service is busy. Try again.",
  disconnected: "Couldn't start a terminal: this device's terminal service stopped. Try again.",
  refused: "Couldn't start a terminal: this device's terminal service refused it. Try again.",
  protocol: "Couldn't start a terminal: this device's terminal service answered unexpectedly. Restart the app.",
  folder: "Couldn't start a terminal: that folder is not in your home folder.",
  unknown: "Couldn't start a terminal. Try again.",
};

const LOCAL_NOTICE: Record<Exclude<LocalTerminalsNotice, null>, string> = {
  "create-failed": "Couldn't start a terminal. Try again.",
  "create-rate-limited": "Too many terminals started at once. Try again in a moment.",
  "rename-failed": "Couldn't rename that terminal. Try again.",
  "end-failed": "Couldn't end that terminal. Try again.",
};

const PANE_NOTICE = {
  "split-limit": "A tab holds at most 16 panes.",
  "split-failed": "Couldn't start a terminal for the new pane. Try again.",
} as const;

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const buttonClass = "no-drag rounded-md border px-2.5 py-1 text-[12px] font-medium outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";
const outlined = { borderColor: "var(--border-default)" };

function focusMainWindow(to?: "settings"): void {
  void invoke("terminal-window:focus-main", to ? { to } : {}).catch((error: unknown) => {
    console.warn("[terminal-window] main window handoff failed:", error instanceof Error ? error.name : "UnknownError");
  });
}

/** Why this device's terminals cannot be listed, or nothing when they can. */
function LocalStatus({ state, onRetry }: { state: LocalTerminalsState; onRetry(): void }) {
  if (state.status === "ready") return null;
  if (state.status === "unavailable") {
    return (
      <div role="alert" className="flex flex-col items-start gap-1.5 px-3 pb-1.5">
        <p className="text-[12px]">Local terminals couldn't start.</p>
        <button type="button" className={buttonClass} style={outlined} onClick={onRetry}>Retry</button>
      </div>
    );
  }
  const text = state.status === "loading" ? "Loading terminals…"
    : state.status === "not-installed" ? "Local terminals are not included in this build."
      : "Local terminals were started by a different version of Matrix OS. They keep running, but this version cannot show them or start new ones.";
  return <p role={state.status === "loading" ? "status" : "alert"} className="px-3 pb-1 text-[12px]" style={secondaryText}>{text}</p>;
}

function MatrixStatus({ state, onRetry }: { state: TerminalMachinesState; onRetry(): void }) {
  if (state.status === "ready") {
    return state.computers.length === 0 ? <li className="px-3 py-1 text-[12px]" style={secondaryText}>No Matrix computers yet.</li> : null;
  }
  if (state.status === "loading") {
    return <li className="px-3 py-1 text-[12px]" style={secondaryText}><span role="status">Loading your computers…</span></li>;
  }
  if (state.status === "signed-out") {
    return (
      <li className="flex flex-col items-start gap-2 px-3 py-2">
        <p className="text-[13px] font-medium">Sign in to see your Matrix computers</p>
        <p className="text-[12px]" style={secondaryText}>Your cloud terminals appear here once you sign in from the main window.</p>
        <button type="button" className={buttonClass} style={outlined} onClick={() => focusMainWindow()}>Sign in</button>
      </li>
    );
  }
  return (
    <li role="alert" className="flex flex-col items-start gap-2 px-3 py-2">
      <p className="text-[12px]">Couldn't load your computers.</p>
      <button type="button" className={buttonClass} style={outlined} onClick={onRetry}>Retry</button>
    </li>
  );
}

function ComputerFailure({ reason, onRetry }: { reason: "reconnect" | "unavailable"; onRetry(): void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-1.5 px-3 pb-1.5 pl-9">
      <p className="text-[12px]">{reason === "reconnect" ? "This computer needs you to reconnect." : "Couldn't reach this computer."}</p>
      <button type="button" className={buttonClass} style={outlined} onClick={onRetry}>{reason === "reconnect" ? "Reconnect" : "Retry"}</button>
    </div>
  );
}

const SSH_STATE_LABEL: Record<LocalMachine["state"], string> = {
  connecting: "Connecting…",
  connected: "Connected",
  needs_login: "Needs login",
  unreachable: "Unreachable",
};
const SSH_STATE_COLOR: Record<LocalMachine["state"], string> = {
  connecting: "var(--color-warning)",
  connected: "var(--color-success)",
  needs_login: "var(--color-warning)",
  unreachable: "var(--text-tertiary, var(--color-muted-foreground))",
};

/** What to do about an ssh machine the core cannot use now: log in or check its key in a terminal, or dial again. */
/** The line under a machine about its core: why the last update did not run, or how old it is. */
function coreStatusText(state: { unsupported: boolean; changed: boolean; failed: boolean; version?: string }): string {
  if (state.unsupported) return "Not updated: the app can't update the core on this machine (Windows). Update it there.";
  if (state.changed) return "Not updated: this name now belongs to a different machine. Check it, then try again.";
  if (state.failed) return "Couldn't update its core.";
  return `Its core is ${state.version}; this app has ${LOCAL_TERMINAL_VERSION}.`;
}

/** The machine's core is older than the app's: offer to bring it up to date (spec 2706 layer 8). */
function MachineCoreStatus({ machine, view }: { machine: LocalMachine; view: TerminalWindowView }) {
  const busy = view.ssh.coreBusy.includes(machine.name);
  const failed = view.ssh.coreFailed.includes(machine.name);
  const changed = view.ssh.coreChanged.includes(machine.name);
  const unsupported = view.ssh.coreUnsupported.includes(machine.name);
  const older = machine.version ? (compareCoreVersions(machine.version, LOCAL_TERMINAL_VERSION) ?? 0) < 0 : false;
  if (!busy && !failed && !older) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5 pl-9 text-[12px]">
      {busy ? <span>Updating its core…</span> : (
        <>
          <span>{coreStatusText({ unsupported, changed, failed, version: machine.version })}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => { void view.ssh.update(machine); }}>
            {failed ? "Try again" : "Update core"}
          </Button>
        </>
      )}
    </div>
  );
}

function SshMachineStatus({ machine, view }: { machine: LocalMachine; view: TerminalWindowView }) {
  if (machine.state === "connected" || machine.state === "connecting") return <MachineCoreStatus machine={machine} view={view} />;
  // A failed core update stays visible next to the connection actions.
  return (
    <>
    <MachineCoreStatus machine={machine} view={view} />
    <div role="status" className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5 pl-9">
      <button type="button" className={buttonClass} style={outlined} onClick={() => { void view.openMachineLogin(machine.name); }}>Open in terminal</button>
      {view.sshLoginFailed === machine.name ? <span role="alert" className="text-[12px]">Couldn't open a terminal. Try again.</span> : null}
      <button type="button" className={buttonClass} style={outlined} onClick={() => { void view.ssh.connect(machine.name); }}>Retry</button>
    </div>
    </>
  );
}

function sidebarMachines(view: TerminalWindowView, onRemove: (name: string) => void): SidebarMachine[] {
  const local: SidebarMachine = {
    id: view.here.id, name: view.here.name, kind: "local", detail: "Terminals on this device",
    available: view.local.state.status === "ready" || view.local.state.status === "loading",
    status: <LocalStatus state={view.local.state} onRetry={view.local.retry} />,
  };
  const computers = (view.ready?.computers ?? []).map((computer): SidebarMachine => ({
    id: computerMachineId(computer.runtimeSlot),
    // Led by its own name; the kind (Main, Preview, Additional) is the detail.
    name: computer.handle,
    kind: "computer",
    // An available computer whose stream has not connected says so, instead of looking empty.
    detail: `${computer.label} · ${computer.availability === "available" && !view.status.states[computer.runtimeSlot]?.connected
      ? "Connecting…" : AVAILABILITY_LABEL[computer.availability]}`,
    dotColor: AVAILABILITY_COLOR[computer.availability],
    available: computer.availability === "available",
    dormant: computer.availability === "unavailable",
    creating: view.cloud.creating === computer.runtimeSlot,
    onCreate: () => view.createCloud(computer.runtimeSlot),
    ...(view.cloud.terminals[computer.runtimeSlot]?.status === "failed"
      // A refused credential or an unreachable computer, from starting a terminal there.
      ? { status: <ComputerFailure reason={(view.cloud.terminals[computer.runtimeSlot] as { reason: "reconnect" | "unavailable" }).reason}
          onRetry={() => { void view.cloud.load(computer.runtimeSlot); }} /> }
      : view.cloud.createFailed?.slot === computer.runtimeSlot
        ? { status: <p role="alert" className="px-3 pb-1 text-[12px]">{createFailureText(view.cloud.createFailed.failure)}</p> } : {}),
  }));
  const ssh = (view.ssh.state.status === "ready" ? view.ssh.state.machines : []).map((machine): SidebarMachine => ({
    id: sshMachineId(machine.name),
    name: machine.name,
    kind: "ssh",
    detail: `${machine.target} · ${SSH_STATE_LABEL[machine.state]}${machine.version ? ` · core ${machine.version}` : ""}`,
    dotColor: SSH_STATE_COLOR[machine.state],
    available: true,
    onCreate: () => view.createLocal({ machine: machine.name }),
    onRemove: () => onRemove(machine.name),
    status: <SshMachineStatus machine={machine} view={view} />,
  }));
  return [local, ...ssh, ...computers];
}

function EmptyPane({ signedIn }: { signedIn: boolean }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <SquareTerminal size={28} aria-hidden="true" style={secondaryText} />
      <h1 className="text-[15px] font-semibold">Terminals across your computers</h1>
      <p className="max-w-sm text-[13px]" style={secondaryText}>
        Pick a terminal on the left, or start one with + next to a machine. Each terminal keeps running on its computer when you close this window.
      </p>
      {signedIn ? null : <button type="button" className={buttonClass} style={outlined} onClick={() => focusMainWindow()}>Go to main window</button>}
    </main>
  );
}

/**
 * A pane's terminal, with an attachment of its own so every visible pane
 * streams live, not only the focused one. Disposed with its pane.
 */
// Memoized: the window redraws on every status event, and a terminal must not redraw with it.
const PaneTerminal = memo(function PaneTerminal({ sessionName, focused, findRequest, onPaneAction, reservedKeys }: {
  sessionName: string; focused: boolean; findRequest: number; onPaneAction(action: TerminalPaneAction): void;
  reservedKeys(event: KeyboardEvent): boolean;
}) {
  const [manager, setManager] = useState<AttachManager | null>(null);
  useEffect(() => {
    const created = createPaneAttachManager();
    // react-doctor-disable-next-line react-doctor/no-derived-state-effect -- an external resource made and disposed with the pane
    setManager(created);
    return () => created.dispose();
  }, []);
  if (!manager) return null;
  return <TerminalView sessionName={sessionName} attachManager={manager} active focused={focused} findRequest={findRequest}
    onPaneAction={onPaneAction} reservedKeys={reservedKeys}
    // The pane header holds the pane buttons, so the terminal's own controls bar is not repeated.
    controlsHost={null} />;
});

function EndedNotice({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <div role="status" className="absolute right-3 top-3 flex items-center gap-2 rounded-md border px-2.5 py-1 text-[12px]"
      style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}>
      <span>{title} ended</span>
      <button type="button" aria-label={`Close ${title}`} onClick={onClose}
        className="flex size-5 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current">
        <X size={11} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The terminal a pane shows, by its sidebar row key. */
function paneSessionName(key: string): string | null {
  const target = terminalRowTarget(key);
  if (!target) return null;
  return target.kind === "local" ? localSessionName(target.id) : terminalRefKey(target.ref);
}

function isAgentId(agent: string | undefined): agent is TerminalAgentId {
  return TERMINAL_AGENT_OPTIONS.some((option) => option.id === agent);
}

/** A pane header: the agent's icon, the terminal's name, and where it runs. */
export function paneInfoFor(row: TerminalSidebarRow | undefined, fallback: string): PaneInfo {
  if (!row) return { title: fallback, icon: <SquareTerminal size={13} aria-hidden="true" style={secondaryText} /> };
  const where = [row.machine.name, row.space ?? row.detail].filter(Boolean).join(" · ");
  return {
    title: row.name,
    detail: where,
    working: row.status === "working",
    icon: isAgentId(row.agent) ? <DesktopTerminalAgentLogo agent={row.agent} compact /> : <SquareTerminal size={13} aria-hidden="true" style={secondaryText} />,
  };
}

function Panes({ view, tab }: { view: TerminalWindowView; tab: PaneTab }) {
  const rows = new Map(view.status.rows.map((row) => [row.key, row]));
  // One callback for every pane's terminal that always runs the latest handler, so status updates leave panes alone.
  const latestPaneAction = useRef(view.panes.paneAction);
  useEffect(() => { latestPaneAction.current = view.panes.paneAction; }, [view.panes.paneAction]);
  const paneAction = useCallback((action: TerminalPaneAction) => latestPaneAction.current(action), []);
  const ended = view.endedLocal;
  return (
    <TerminalPaneTree tab={tab}
      paneInfo={(leaf) => paneInfoFor(rows.get(leaf.terminal), leaf.terminal === view.selectedKey && view.localTerminal ? view.localTerminal.title : "Terminal")}
      onPaneButton={view.paneButton}
      onFocus={view.panes.focusLeaf} onResize={view.panes.resize} onMove={view.panes.move}
      renderPane={(leaf, focused) => {
        const sessionName = paneSessionName(leaf.terminal);
        if (!sessionName) return null;
        // A session change remounts each pane so it attaches again with the new credentials.
        return (
          <>
            {/* Not focused while the overview covers it, so uncovering hands the keyboard back without reattaching. */}
            <PaneTerminal key={`${sessionName}|${view.cloud.attachEpoch}`} sessionName={sessionName} focused={focused && !view.overview.open}
              findRequest={view.findRequestFor(leaf.terminal)} onPaneAction={paneAction} reservedKeys={view.reservedKeys} />
            {ended && leaf.terminal === view.selectedKey ? <EndedNotice title={ended.title} onClose={view.dismissEndedLocal} /> : null}
          </>
        );
      }} />
  );
}

function ActivePane({ view }: { view: TerminalWindowView }) {
  // A terminal on its own is a one-pane tab, so every terminal has a header and buttons.
  if (view.panes.tab) return <Panes view={view} tab={view.panes.tab} />;
  return <EmptyPane signedIn={view.ready !== null} />;
}

/** Herdr's status bar: the machine on screen, how many agents work or need you, and the command picker. */
function StatusBar({ view }: { view: TerminalWindowView }) {
  const row = view.selectedRow;
  const working = view.status.rows.filter((entry) => entry.status === "working").length;
  const waiting = view.status.rows.filter((entry) => entry.status === "blocked" || entry.status === "error").length;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px]"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)", ...secondaryText }}>
      <span className="truncate">{row ? row.machine.name : view.here.name}</span>
      {row?.space ? <span className="truncate">{row.space}</span> : null}
      {row?.detail ? <span className="min-w-0 truncate">{row.detail}</span> : null}
      <span className="ml-auto tabular-nums">{view.status.rows.length} agents · {working} working{waiting ? ` · ${waiting} need you` : ""}</span>
      <span aria-hidden="true">⌘⇧P commands</span>
    </footer>
  );
}

function windowTitle(view: TerminalWindowView): string {
  const row = view.selectedRow;
  if (row) return `${row.name} — ${row.machine.name}`;
  if (view.localTerminal) return `${view.localTerminal.title} — ${view.here.name}`;
  return "Terminal";
}

export default function TerminalWindowApp() {
  const loadAppearance = useAppearance((state) => state.load);
  const view = useTerminalWindow();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const machines = useMemo(() => sidebarMachines(view, setRemoving), [view]);
  const rowsByKey = useMemo(() => new Map(view.status.rows.map((row) => [row.key, row])), [view.status.rows]);
  const { prefs } = view.sidebar;
  const overviewRows = useMemo(() => filterRows(view.status.rows, prefs.filter), [prefs.filter, view.status.rows]);
  const previews = useTerminalPreviews({ rows: overviewRows, enabled: view.overview.open, api: view.cloud.api });
  const activeSpace = useMemo<ActiveSpaceChip | null>(() => {
    const filter = prefs.filter;
    if (!filter) return null;
    // A machine is a space itself; a project is a space under it.
    const machineName = prefs.spaceStyles[filter.machineId]?.name ?? machines.find((machine) => machine.id === filter.machineId)?.name ?? "";
    const style = prefs.spaceStyles[filter.space ? spaceId(filter.machineId, filter.space) : filter.machineId];
    const label = style?.name ?? filter.space ?? machineName;
    return {
      label,
      machine: machineName,
      color: style?.color ?? defaultSpaceColor(label),
      ...(style?.icon ? { icon: style.icon } : {}),
    };
  }, [machines, prefs.filter, prefs.spaceStyles]);

  useEffect(() => { void loadAppearance(); }, [loadAppearance]);
  useEffect(() => { document.title = "Terminal"; }, []);

  const failed = view.local.notice ?? view.computerNotice;
  const noticeText = failed === "create-failed" && view.local.notice === "create-failed" && view.local.createFailure
    ? LOCAL_CREATE_FAILURE[view.local.createFailure]
    : failed ? LOCAL_NOTICE[failed] : view.panes.notice ? PANE_NOTICE[view.panes.notice] : null;
  const notice = noticeText ? <p role="alert" className="px-2 py-1 text-[12px]">{noticeText}</p> : null;
  return (
    <div className="ph-no-capture flex h-screen w-screen flex-col" style={{ background: "var(--bg-app)", color: "var(--text-primary, var(--color-foreground))" }}>
      <LocalTerminalAttention state={view.local.state} activeId={view.localTerminal?.id ?? null} onOpen={(id) => view.select(localRowKey(id))} />
      {/* This window's one toast host, configured like the main window's. */}
      <Toaster position="bottom-right" toastOptions={{ style: {
        background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border-default)",
      } }} />
      <header className="titlebar-drag flex shrink-0 items-center justify-center border-b text-[12px] font-medium"
        style={{ height: "var(--titlebar-height)", borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
        {windowTitle(view)}
      </header>
      <div className="flex min-h-0 flex-1">
        <TerminalWindowSidebar
          machines={machines}
          machinesStatus={<MatrixStatus state={view.machines.state} onRetry={view.machines.retry} />}
          expandedSpaces={prefs.expandedSpaces}
          onToggleSpaceExpanded={view.sidebar.toggleSpaceExpanded}
          onOpenInTab={view.openInTab}
          filter={prefs.filter}
          onFilter={view.chooseSpace}
          onSettings={() => focusMainWindow("settings")}
          machineOrder={prefs.machineOrder}
          onMachineOrder={view.sidebar.setMachineOrder}
          spaceStyles={prefs.spaceStyles}
          spaceOrder={prefs.spaceOrder}
          onSpaceStyle={view.sidebar.setSpaceStyle}
          onSpaceOrder={view.sidebar.setSpaceOrder}
          pinned={prefs.pinned}
          onTogglePin={view.sidebar.togglePin}
          onCloseTerminal={view.requestClose}
          localCreating={view.local.creating}
          onCreateLocal={view.createLocal}
          rows={view.status.rows}
          selectedKey={view.selectedKey}
          onSelect={view.select}
          view={prefs.view}
          onSetView={view.sidebar.setView}
          folded={prefs.folded}
          onToggleFold={view.sidebar.toggleFold}
          now={view.now}
          rail={prefs.rail}
          onToggleRail={view.sidebar.toggleRail}
          width={prefs.width}
          onResize={view.sidebar.setWidth}
          notices={notice}
          onAddMachine={view.local.state.status === "ready" ? () => setAdding(true) : undefined}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TerminalTabBar space={activeSpace} overview={{ open: view.overview.open, onToggle: view.overview.toggle }} tabs={view.tabs} selectedKey={view.selectedKey} row={(key) => rowsByKey.get(key)}
            icon={(row) => paneInfoFor(row, "Terminal").icon} onSelect={view.select} onClose={view.closeTab} onNew={view.newTerminal} />
          {/* The overview covers the panes instead of replacing them: their terminals stay attached and
              keep their output (a finished terminal cannot be attached again), but take no input. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={view.overview.open} data-covered={view.overview.open ? "" : undefined}>
              <ActivePane view={view} />
            </div>
            {view.overview.open ? (
              <div className="absolute inset-0 flex min-h-0 min-w-0">
                <TerminalOverview rows={overviewRows} previews={previews} selectedKey={view.selectedKey} now={view.now}
                  spaceLabel={activeSpace?.label ?? null} onOpen={view.overview.openTerminal} onRename={view.rename} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <StatusBar view={view} />
      <TerminalPicker open={view.picker.open} entries={view.order} onClose={view.picker.close}
        onPick={(key) => { view.picker.close(); view.select(key); }} />
      <RenameTerminalDialog target={view.renaming} onRename={view.rename} onClose={() => view.setRenaming(null)} />
      <CloseTerminalDialog target={view.closing} onConfirm={view.close} onClose={() => view.setClosing(null)} />
      <AddMachineDialog open={adding} onAdd={view.ssh.add} onOpenSsh={view.openSshLogin} loadPeers={view.ssh.tailscalePeers}
        onInstall={view.ssh.install} onClose={() => setAdding(false)} />
      <RemoveMachineDialog name={removing} onConfirm={view.ssh.remove} onClose={() => setRemoving(null)} />
    </div>
  );
}
