// The Electron Desktop Terminal window (specs/651-desktop-terminal-window).
// Machines on the left, one attached terminal on the right. Every Matrix
// computer is reached with its own credential, held by the trusted core.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Cloud, Laptop, Plus, SquareTerminal, X } from "lucide-react";
import type { MatrixComputer } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";
import { useAppearance } from "../../stores/appearance";
import TerminalView from "../terminal/TerminalView";
import { useTerminalMachines, type TerminalMachinesState } from "./use-terminal-machines";
import { useComputerTerminals, type ActiveTerminal, type ComputerTerminalsState } from "./use-computer-terminals";
import { localSessionName, useLocalTerminals, type LocalTerminalsNotice, type LocalTerminalsState } from "./use-local-terminals";
import type { LocalTerminal } from "../../../../shared/local-terminals";

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

// Status is whatever the program in the terminal reported about itself.
const LOCAL_STATUS_LABEL = { working: "Working", done: "Done", blocked: "Needs you", error: "Error" } as const;
const LOCAL_STATUS_COLOR = {
  working: "var(--text-secondary, var(--color-muted-foreground))",
  done: "var(--color-success)",
  blocked: "var(--color-warning)",
  error: "var(--color-danger)",
} as const;

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const buttonClass = "no-drag rounded-md border px-2.5 py-1 text-[12px] font-medium outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";
const rowClass = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current";
const outlined = { borderColor: "var(--border-default)" };

function MachineLabel({ icon, label, detail, dotColor }: {
  icon: React.ReactNode; label: string; detail: string; dotColor?: string;
}) {
  return (
    <>
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center" style={secondaryText}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        <span className="flex items-center gap-1.5 text-[11px]" style={secondaryText}>
          {dotColor ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: dotColor }} /> : null}
          <span className="truncate">{detail}</span>
        </span>
      </span>
    </>
  );
}

function ComputerTabs({ computer, state, active, creating, busy, createFailed, onOpen, onCreate, onRetry }: {
  computer: MatrixComputer; state: ComputerTerminalsState | undefined; active: ActiveTerminal | null;
  /** This computer is starting a terminal; `busy` is true while any computer is. */
  creating: boolean; busy: boolean; createFailed: boolean;
  onOpen(refKey: string): void; onCreate(): void; onRetry(): void;
}) {
  if (!state || state.status === "loading") {
    return <p role="status" className="py-1.5 pl-10 text-[12px]" style={secondaryText}>Loading terminals…</p>;
  }
  if (state.status === "failed") {
    return (
      <div role="alert" className="flex flex-col items-start gap-1.5 py-1.5 pl-10 pr-2">
        <p className="text-[12px]">
          {state.reason === "reconnect" ? "This computer needs you to reconnect." : "Couldn't reach this computer."}
        </p>
        <button type="button" className={buttonClass} style={outlined} onClick={onRetry}>
          {state.reason === "reconnect" ? "Reconnect" : "Retry"}
        </button>
      </div>
    );
  }
  return (
    <ul aria-label={`${computer.label} terminals`} className="flex flex-col gap-0.5 pb-1 pl-8">
      {state.tabs.length === 0
        ? <li className="px-2 py-1 text-[12px]" style={secondaryText}>No terminals yet.</li>
        : state.tabs.map((tab) => {
          const current = active?.slot === computer.runtimeSlot && active.refKey === tab.refKey;
          return (
            <li key={tab.refKey}>
              <button type="button" aria-current={current ? "true" : undefined} onClick={() => onOpen(tab.refKey)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current"
                style={current ? { background: "var(--bg-selected)" } : undefined}>
                <SquareTerminal size={12} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                <span className="shrink-0 text-[10px]" style={secondaryText}>{tab.ended ? "ended" : tab.group}</span>
              </button>
            </li>
          );
        })}
      {createFailed ? <li role="alert" className="px-2 py-1 text-[12px]">Couldn't start a terminal. Try again.</li> : null}
      <li>
        <button type="button" disabled={busy} onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50"
          style={secondaryText}>
          <Plus size={12} aria-hidden="true" className="shrink-0" />
          {creating ? "Starting…" : "New terminal"}
        </button>
      </li>
    </ul>
  );
}

const LOCAL_NOTICE: Record<Exclude<LocalTerminalsNotice, null>, string> = {
  "create-failed": "Couldn't start a terminal. Try again.",
  "create-rate-limited": "Too many terminals started at once. Try again in a moment.",
  "end-failed": "Couldn't end that terminal. Try again.",
};

function LocalTabs({ state, activeId, ended, creating, notice, onOpen, onCreate, onEnd, onDismissEnded, onRetry }: {
  state: LocalTerminalsState; activeId: string | null; creating: boolean; notice: LocalTerminalsNotice;
  /** The open terminal, when its program has exited: its pane stays until dismissed. */
  ended: { id: string; title: string } | null;
  onOpen(id: string): void; onCreate(): void; onEnd(id: string): void; onDismissEnded(): void; onRetry(): void;
}) {
  if (state.status === "loading") {
    return <p role="status" className="py-1.5 pl-10 text-[12px]" style={secondaryText}>Loading terminals…</p>;
  }
  if (state.status === "not-installed") {
    return <p className="py-1.5 pl-10 pr-2 text-[12px]" style={secondaryText}>Local terminals are not included in this build.</p>;
  }
  if (state.status === "unavailable") {
    return (
      <div role="alert" className="flex flex-col items-start gap-1.5 py-1.5 pl-10 pr-2">
        <p className="text-[12px]">Local terminals couldn't start.</p>
        <button type="button" className={buttonClass} style={outlined} onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (state.status === "version-mismatch") {
    return (
      <p role="alert" className="py-1.5 pl-10 pr-2 text-[12px]">
        Local terminals were started by a different version of Matrix OS. They keep running, but this version cannot show them or start new ones.
      </p>
    );
  }
  return (
    <ul aria-label="This Computer terminals" className="flex flex-col gap-0.5 pb-1 pl-8">
      {state.terminals.length === 0 && !ended
        ? <li className="px-2 py-1 text-[12px]" style={secondaryText}>No terminals yet.</li>
        : state.terminals.map((terminal) => {
          const current = activeId === terminal.id;
          return (
            <li key={terminal.id} className="group flex items-center rounded-md hover:bg-black/5"
              style={current ? { background: "var(--bg-selected)" } : undefined}>
              <button type="button" aria-current={current ? "true" : undefined} onClick={() => onOpen(terminal.id)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-current">
                <SquareTerminal size={12} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{terminal.title}</span>
                {terminal.status && terminal.status !== "idle" ? (
                  <span className="shrink-0 text-[10px]" style={{ color: LOCAL_STATUS_COLOR[terminal.status] }}>{LOCAL_STATUS_LABEL[terminal.status]}</span>
                ) : null}
              </button>
              <button type="button" aria-label={`End ${terminal.title}`} title="End terminal" onClick={() => onEnd(terminal.id)}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded opacity-0 outline-none hover:bg-black/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-current group-hover:opacity-100">
                <X size={11} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      {ended ? (
        <li className="group flex items-center rounded-md" style={{ background: "var(--bg-selected)" }}>
          <span aria-current="true" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-[12px]">
            <SquareTerminal size={12} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{ended.title}</span>
            <span className="shrink-0 text-[10px]" style={secondaryText}>ended</span>
          </span>
          <button type="button" aria-label={`Close ${ended.title}`} title="Close" onClick={onDismissEnded}
            className="mr-1 flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current">
            <X size={11} aria-hidden="true" />
          </button>
        </li>
      ) : null}
      {notice ? <li role="alert" className="px-2 py-1 text-[12px]">{LOCAL_NOTICE[notice]}</li> : null}
      <li>
        <button type="button" disabled={creating} onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50"
          style={secondaryText}>
          <Plus size={12} aria-hidden="true" className="shrink-0" />
          {creating ? "Starting…" : "New terminal"}
        </button>
      </li>
    </ul>
  );
}

function MatrixSection({ state, onRetry, onSignIn }: {
  state: Exclude<TerminalMachinesState, { status: "ready" }>; onRetry: () => void; onSignIn: () => void;
}) {
  if (state.status === "loading") {
    return <li className="px-2.5 py-2 text-[12px]" style={secondaryText}><span role="status">Loading your computers…</span></li>;
  }
  if (state.status === "signed-out") {
    return (
      <li className="flex flex-col items-start gap-2 px-2.5 py-2">
        <p className="text-[13px] font-medium">Sign in to see your Matrix computers</p>
        <p className="text-[12px]" style={secondaryText}>Your cloud terminals appear here once you sign in from the main window.</p>
        <button type="button" className={buttonClass} style={outlined} onClick={onSignIn}>Sign in</button>
      </li>
    );
  }
  return (
    <li role="alert" className="flex flex-col items-start gap-2 px-2.5 py-2">
      <p className="text-[12px]">Couldn't load your computers.</p>
      <button type="button" className={buttonClass} style={outlined} onClick={onRetry}>Retry</button>
    </li>
  );
}

function NeedsAttention({ terminals, onOpen }: { terminals: LocalTerminal[]; onOpen(id: string): void }) {
  if (terminals.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="mb-2 rounded-md border p-1.5" style={outlined}>
      <h2 className="px-1 pb-1 text-[11px] font-medium" style={secondaryText}>Needs attention</h2>
      <ul className="flex flex-col gap-0.5">
        {terminals.map((terminal) => (
          <li key={terminal.id}>
            <button type="button" onClick={() => onOpen(terminal.id)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current">
              <span className="min-w-0 flex-1 truncate">{terminal.title}</span>
              <span className="shrink-0 text-[10px]" style={secondaryText}>This Computer</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Disclosure({ open }: { open: boolean }) {
  return open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />;
}

function ComputerMachine({ computer, open, onToggle, children }: {
  computer: MatrixComputer; open: boolean; onToggle(): void; children: React.ReactNode;
}) {
  const detail = `${computer.handle} · ${AVAILABILITY_LABEL[computer.availability]}`;
  const label = <MachineLabel icon={<Cloud size={15} />} label={computer.label} detail={detail} dotColor={AVAILABILITY_COLOR[computer.availability]} />;
  if (computer.availability !== "available") {
    return <li data-machine={computer.runtimeSlot} className="flex items-center gap-2.5 rounded-md px-2.5 py-2 opacity-70">{label}</li>;
  }
  return (
    <li data-machine={computer.runtimeSlot}>
      <button type="button" aria-expanded={open} className={rowClass} onClick={onToggle}>
        {label}
        <Disclosure open={open} />
      </button>
      {open ? children : null}
    </li>
  );
}

function EmptyPane({ signedIn, onFocusMain }: { signedIn: boolean; onFocusMain(): void }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <SquareTerminal size={28} aria-hidden="true" style={secondaryText} />
      <h1 className="text-[15px] font-semibold">Terminals across your computers</h1>
      <p className="max-w-sm text-[13px]" style={secondaryText}>
        Open a computer on the left to see its terminals, or start a new one. Each terminal keeps running on its computer when you close this window.
      </p>
      {signedIn ? null : <button type="button" className={buttonClass} style={outlined} onClick={onFocusMain}>Go to main window</button>}
    </main>
  );
}

function TerminalPane({ sessionName }: { sessionName: string }) {
  return (
    <main aria-label="Terminal" className="flex min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: "var(--bg-surface)" }}>
      <TerminalView key={sessionName} sessionName={sessionName} active />
    </main>
  );
}

function focusMainWindow(): void {
  void invoke("terminal-window:focus-main", {}).catch((error: unknown) => {
    console.warn("[terminal-window] main window handoff failed:", error instanceof Error ? error.name : "UnknownError");
  });
}

function tabName(state: ComputerTerminalsState | undefined, refKey: string): string | undefined {
  return state?.status === "ready" ? state.tabs.find((tab) => tab.refKey === refKey)?.name : undefined;
}

const EMPTY_SLOTS: Record<string, boolean> = {};

/** Everything the window shows: both inventories, and the one attached terminal. */
function useTerminalWindow() {
  const machines = useTerminalMachines();
  const ready = machines.state.status === "ready" ? machines.state : null;
  const cloud = useComputerTerminals(ready?.platformHost ?? null, ready?.sessionKey ?? "");
  const local = useLocalTerminals();
  // A local terminal and a cloud terminal are never attached at once.
  // The title is kept so the pane can stay, labelled, after its program exits
  // and the terminal leaves the listing.
  const [localOpen, setLocalOpen] = useState<{ id: string; title: string } | null>(null);
  const localActive = localOpen?.id ?? null;
  // Which computers are open, for one signed-in session: a new session starts
  // collapsed, because its listings are fetched only when a computer is opened.
  const sessionKey = ready?.sessionKey ?? "";
  const [expansion, setExpansion] = useState<{ sessionKey: string; slots: Record<string, boolean> }>({ sessionKey, slots: {} });
  const expanded = expansion.sessionKey === sessionKey ? expansion.slots : EMPTY_SLOTS;

  const localTerminals = local.state.status === "ready" ? local.state.terminals : [];
  const listedLocal = localTerminals.find((terminal) => terminal.id === localActive);
  // Still open, but no longer running: shown as ended until the user closes it.
  const endedLocal = localOpen && !listedLocal && local.state.status === "ready" ? localOpen : null;
  const localTerminal = listedLocal ?? localOpen ?? undefined;
  const { clearActive, open, create, load } = cloud;

  return {
    machines, ready, cloud, local, localActive, localTerminal, endedLocal, expanded,
    dismissEndedLocal: () => setLocalOpen(null),
    needsAttention: localTerminals.filter((terminal) => terminal.status === "blocked" || terminal.status === "error"),
    openLocal: (id: string) => {
      clearActive();
      setLocalOpen({ id, title: localTerminals.find((terminal) => terminal.id === id)?.title ?? "Terminal" });
    },
    // The pane stays until the trusted core confirms the terminal ended.
    endLocal: (id: string) => {
      void local.end(id).then((ended) => { if (ended) setLocalOpen((current) => (current?.id === id ? null : current)); });
    },
    openCloud: (slot: string, refKey: string) => { setLocalOpen(null); open(slot, refKey); },
    createCloud: (slot: string) => { setLocalOpen(null); void create(slot); },
    toggle: (slot: string) => {
      const next = !expanded[slot];
      setExpansion({ sessionKey, slots: { ...expanded, [slot]: next } });
      // Credentials and listings are fetched only for computers the user opens.
      if (next) void load(slot);
    },
  };
}

type TerminalWindow = ReturnType<typeof useTerminalWindow>;

function windowTitle(view: TerminalWindow): string {
  if (view.localTerminal) return `${view.localTerminal.title} — This Computer`;
  const active = view.cloud.active;
  if (!active) return "Terminal";
  const computer = view.ready?.computers.find((candidate) => candidate.runtimeSlot === active.slot);
  const name = tabName(view.cloud.terminals[active.slot], active.refKey);
  return computer && name ? `${name} — ${computer.label}` : "Terminal";
}

function LocalMachine({ view }: { view: TerminalWindow }) {
  const [open, setOpen] = useState(true);
  const { local } = view;
  return (
    <li data-machine="local">
      <button type="button" aria-expanded={open} className={rowClass} onClick={() => setOpen((shown) => !shown)}>
        <MachineLabel icon={<Laptop size={15} />} label="This Computer" detail="Terminals on this device" />
        <Disclosure open={open} />
      </button>
      {open ? (
        <LocalTabs state={local.state} activeId={view.localActive} ended={view.endedLocal} onDismissEnded={view.dismissEndedLocal} creating={local.creating} notice={local.notice} onOpen={view.openLocal}
          onCreate={() => { void local.create().then((id) => { if (id) view.openLocal(id); }); }}
          onEnd={view.endLocal} onRetry={() => { void local.refresh(); }} />
      ) : null}
    </li>
  );
}

function MatrixMachines({ view }: { view: TerminalWindow }) {
  const { ready, cloud } = view;
  if (!ready) {
    return <MatrixSection state={view.machines.state as Exclude<TerminalMachinesState, { status: "ready" }>} onRetry={view.machines.retry} onSignIn={focusMainWindow} />;
  }
  if (ready.computers.length === 0) {
    return <li className="px-2.5 py-2 text-[12px]" style={secondaryText}>No Matrix computers yet.</li>;
  }
  return <>{ready.computers.map((computer) => {
    const slot = computer.runtimeSlot;
    return (
      <ComputerMachine key={slot} computer={computer} open={view.expanded[slot] === true} onToggle={() => view.toggle(slot)}>
        <ComputerTabs computer={computer} state={cloud.terminals[slot]} active={cloud.active} creating={cloud.creating === slot}
          busy={cloud.creating !== null} createFailed={cloud.createFailed === slot}
          onOpen={(refKey) => view.openCloud(slot, refKey)} onCreate={() => view.createCloud(slot)} onRetry={() => { void cloud.load(slot); }} />
      </ComputerMachine>
    );
  })}</>;
}

function ActivePane({ view }: { view: TerminalWindow }) {
  // A session change resets the shared attach manager; the epoch remounts the
  // local pane so it attaches again instead of staying on a disposed attachment.
  if (view.localTerminal) {
    return <TerminalPane key={`local|${view.localTerminal.id}|${view.cloud.attachEpoch}`} sessionName={localSessionName(view.localTerminal.id)} />;
  }
  const active = view.cloud.active;
  if (active) return <TerminalPane key={`${active.slot}|${active.refKey}`} sessionName={active.refKey} />;
  return <EmptyPane signedIn={view.ready !== null} onFocusMain={focusMainWindow} />;
}

export default function TerminalWindowApp() {
  const loadAppearance = useAppearance((state) => state.load);
  const view = useTerminalWindow();

  useEffect(() => { void loadAppearance(); }, [loadAppearance]);
  useEffect(() => { document.title = "Terminal"; }, []);

  return (
    <div className="ph-no-capture flex h-screen w-screen flex-col" style={{ background: "var(--bg-app)", color: "var(--text-primary, var(--color-foreground))" }}>
      <header className="titlebar-drag flex shrink-0 items-center justify-center border-b text-[12px] font-medium"
        style={{ height: "var(--titlebar-height)", borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
        {windowTitle(view)}
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Machines" className="flex w-64 shrink-0 flex-col overflow-y-auto border-r p-2"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
          <NeedsAttention terminals={view.needsAttention} onOpen={view.openLocal} />
          <ul className="flex flex-col gap-0.5">
            <LocalMachine view={view} />
            <li aria-hidden="true" role="presentation" className="mx-2.5 my-1 h-px" style={{ background: "var(--border-subtle)" }} />
            <MatrixMachines view={view} />
          </ul>
        </nav>
        <ActivePane view={view} />
      </div>
    </div>
  );
}
