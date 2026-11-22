// The Electron Desktop Terminal window (specs/651-desktop-terminal-window,
// specs/2706-terminal-window-herdr). Herdr's layout: machines and every
// terminal by status on the left, the terminal on screen on the right.
import { useEffect, useMemo } from "react";
import { Toaster } from "sonner";
import { SquareTerminal, X } from "lucide-react";
import type { MatrixComputer } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";
import { useAppearance } from "../../stores/appearance";
import TerminalView from "../terminal/TerminalView";
import type { TerminalMachinesState } from "./use-terminal-machines";
import { localSessionName, type LocalTerminalsNotice, type LocalTerminalsState } from "./use-local-terminals";
import { LocalTerminalAttention } from "./LocalTerminalAttention";
import { TerminalWindowSidebar, type SidebarMachine } from "./TerminalWindowSidebar";
import { CloseTerminalDialog, RenameTerminalDialog, TerminalPicker } from "./TerminalWindowDialogs";
import { useTerminalWindow, type TerminalWindowView } from "./use-terminal-window";
import { computerMachineId } from "./use-terminal-status";

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
const LOCAL_NOTICE: Record<Exclude<LocalTerminalsNotice, null>, string> = {
  "create-failed": "Couldn't start a terminal. Try again.",
  "create-rate-limited": "Too many terminals started at once. Try again in a moment.",
  "rename-failed": "Couldn't rename that terminal. Try again.",
  "end-failed": "Couldn't end that terminal. Try again.",
};

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const buttonClass = "no-drag rounded-md border px-2.5 py-1 text-[12px] font-medium outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";
const outlined = { borderColor: "var(--border-default)" };

function focusMainWindow(): void {
  void invoke("terminal-window:focus-main", {}).catch((error: unknown) => {
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
        <button type="button" className={buttonClass} style={outlined} onClick={focusMainWindow}>Sign in</button>
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

function sidebarMachines(view: TerminalWindowView): SidebarMachine[] {
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
      : view.cloud.createFailed === computer.runtimeSlot
        ? { status: <p role="alert" className="px-3 pb-1 text-[12px]">Couldn't start a terminal. Try again.</p> } : {}),
  }));
  return [local, ...computers];
}

function EmptyPane({ signedIn }: { signedIn: boolean }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <SquareTerminal size={28} aria-hidden="true" style={secondaryText} />
      <h1 className="text-[15px] font-semibold">Terminals across your computers</h1>
      <p className="max-w-sm text-[13px]" style={secondaryText}>
        Pick a terminal on the left, or start one with + next to a machine. Each terminal keeps running on its computer when you close this window.
      </p>
      {signedIn ? null : <button type="button" className={buttonClass} style={outlined} onClick={focusMainWindow}>Go to main window</button>}
    </main>
  );
}

function TerminalPane({ sessionName, findRequest, ended }: {
  sessionName: string; findRequest: number; ended?: { title: string; onClose(): void } | null;
}) {
  return (
    <main aria-label="Terminal" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: "var(--bg-surface)" }}>
      <TerminalView key={sessionName} sessionName={sessionName} active findRequest={findRequest} />
      {ended ? (
        <div role="status" className="absolute right-3 top-3 flex items-center gap-2 rounded-md border px-2.5 py-1 text-[12px]"
          style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}>
          <span>{ended.title} ended</span>
          <button type="button" aria-label={`Close ${ended.title}`} onClick={ended.onClose}
            className="flex size-5 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current">
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </main>
  );
}

function ActivePane({ view }: { view: TerminalWindowView }) {
  // A session change resets the shared attach manager; the epoch remounts the
  // local pane so it attaches again instead of staying on a disposed attachment.
  if (view.localTerminal) {
    return <TerminalPane key={`local|${view.localTerminal.id}|${view.cloud.attachEpoch}`} sessionName={localSessionName(view.localTerminal.id)}
      findRequest={view.findRequest} ended={view.endedLocal ? { title: view.endedLocal.title, onClose: view.dismissEndedLocal } : null} />;
  }
  const active = view.cloud.active;
  if (active) return <TerminalPane key={`${active.slot}|${active.refKey}`} sessionName={active.refKey} findRequest={view.findRequest} />;
  return <EmptyPane signedIn={view.ready !== null} />;
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
  const machines = useMemo(() => sidebarMachines(view), [view]);
  const { prefs } = view.sidebar;

  useEffect(() => { void loadAppearance(); }, [loadAppearance]);
  useEffect(() => { document.title = "Terminal"; }, []);

  const failed = view.local.notice ?? view.computerNotice;
  const notice = failed ? <p role="alert" className="px-2 py-1 text-[12px]">{LOCAL_NOTICE[failed]}</p> : null;
  return (
    <div className="ph-no-capture flex h-screen w-screen flex-col" style={{ background: "var(--bg-app)", color: "var(--text-primary, var(--color-foreground))" }}>
      <LocalTerminalAttention state={view.local.state} activeId={view.localTerminal?.id ?? null} onOpen={(id) => view.select(`${view.here.id}|${id}`)} />
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
          machineFolded={view.machineFolded}
          onToggleMachine={(id) => view.sidebar.setMachineFolded(id, !view.machineFolded(id))}
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
        />
        <ActivePane view={view} />
      </div>
      <TerminalPicker open={view.picker.open} entries={view.order} onClose={view.picker.close}
        onPick={(key) => { view.picker.close(); view.select(key); }} />
      <RenameTerminalDialog target={view.renaming} onRename={view.rename} onClose={() => view.setRenaming(null)} />
      <CloseTerminalDialog target={view.closing} onConfirm={view.close} onClose={() => view.setClosing(null)} />
    </div>
  );
}
