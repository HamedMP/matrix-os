// The Electron Desktop Terminal window (specs/651-desktop-terminal-window).
// Machines on the left, one attached terminal on the right. Every Matrix
// computer is reached with its own credential, held by the trusted core.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Cloud, Laptop, Plus, SquareTerminal } from "lucide-react";
import type { MatrixComputer } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";
import { useAppearance } from "../../stores/appearance";
import TerminalView from "../terminal/TerminalView";
import { useTerminalMachines, type TerminalMachinesState } from "./use-terminal-machines";
import { useComputerTerminals, type ActiveTerminal, type ComputerTerminalsState } from "./use-computer-terminals";

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

const EMPTY_SLOTS: Record<string, boolean> = {};

export default function TerminalWindowApp() {
  const loadAppearance = useAppearance((state) => state.load);
  const { state, retry } = useTerminalMachines();
  const ready = state.status === "ready" ? state : null;
  const sessionKey = ready?.sessionKey ?? "";
  const { terminals, active, creating, createFailed, load, open, create } = useComputerTerminals(ready?.platformHost ?? null, sessionKey);
  // Which computers are open, for one signed-in session: a new session starts
  // collapsed, because its listings are fetched only when a computer is opened.
  const [expansion, setExpansion] = useState<{ sessionKey: string; slots: Record<string, boolean> }>({ sessionKey, slots: {} });
  const expanded = expansion.sessionKey === sessionKey ? expansion.slots : EMPTY_SLOTS;

  useEffect(() => { void loadAppearance(); }, [loadAppearance]);
  useEffect(() => { document.title = "Terminal"; }, []);

  const focusMain = () => {
    void invoke("terminal-window:focus-main", {}).catch((error: unknown) => {
      console.warn("[terminal-window] main window handoff failed:", error instanceof Error ? error.name : "UnknownError");
    });
  };
  const toggle = (slot: string) => {
    const next = !expanded[slot];
    setExpansion({ sessionKey, slots: { ...expanded, [slot]: next } });
    // Credentials and listings are fetched only for computers the user opens.
    if (next) void load(slot);
  };
  const activeComputer = active ? ready?.computers.find((computer) => computer.runtimeSlot === active.slot) : undefined;
  const activeTab = active && terminals[active.slot]?.status === "ready"
    ? (terminals[active.slot] as { tabs: Array<{ refKey: string; name: string }> }).tabs.find((tab) => tab.refKey === active.refKey)
    : undefined;

  return (
    <div className="ph-no-capture flex h-screen w-screen flex-col" style={{ background: "var(--bg-app)", color: "var(--text-primary, var(--color-foreground))" }}>
      <header className="titlebar-drag flex shrink-0 items-center justify-center border-b text-[12px] font-medium"
        style={{ height: "var(--titlebar-height)", borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
        {activeComputer && activeTab ? `${activeTab.name} — ${activeComputer.label}` : "Terminal"}
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Machines" className="flex w-64 shrink-0 flex-col overflow-y-auto border-r p-2"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
          <ul className="flex flex-col gap-0.5">
            <li data-machine="local" className="flex items-center gap-2.5 rounded-md px-2.5 py-2">
              <MachineLabel icon={<Laptop size={15} />} label="This Computer" detail="Local terminals are not available in this version" />
            </li>
            <li aria-hidden="true" role="presentation" className="mx-2.5 my-1 h-px" style={{ background: "var(--border-subtle)" }} />
            {!ready ? <MatrixSection state={state as Exclude<TerminalMachinesState, { status: "ready" }>} onRetry={retry} onSignIn={focusMain} /> : null}
            {ready && ready.computers.length === 0
              ? <li className="px-2.5 py-2 text-[12px]" style={secondaryText}>No Matrix computers yet.</li> : null}
            {ready?.computers.map((computer) => {
              const slot = computer.runtimeSlot;
              const detail = `${computer.handle} · ${AVAILABILITY_LABEL[computer.availability]}`;
              const label = <MachineLabel icon={<Cloud size={15} />} label={computer.label} detail={detail} dotColor={AVAILABILITY_COLOR[computer.availability]} />;
              if (computer.availability !== "available") {
                return <li key={slot} data-machine={slot} className="flex items-center gap-2.5 rounded-md px-2.5 py-2 opacity-70">{label}</li>;
              }
              const isOpen = expanded[slot] === true;
              return (
                <li key={slot} data-machine={slot}>
                  <button type="button" aria-expanded={isOpen} className={rowClass} onClick={() => toggle(slot)}>
                    {label}
                    {isOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  </button>
                  {isOpen ? (
                    <ComputerTabs computer={computer} state={terminals[slot]} active={active} creating={creating === slot}
                      busy={creating !== null} createFailed={createFailed === slot}
                      onOpen={(refKey) => open(slot, refKey)} onCreate={() => { void create(slot); }} onRetry={() => { void load(slot); }} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </nav>
        {active ? (
          <main aria-label="Terminal" className="flex min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: "var(--bg-surface)" }}>
            <TerminalView key={`${active.slot}|${active.refKey}`} sessionName={active.refKey} active />
          </main>
        ) : (
          <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <SquareTerminal size={28} aria-hidden="true" style={secondaryText} />
            <h1 className="text-[15px] font-semibold">Terminals across your computers</h1>
            <p className="max-w-sm text-[13px]" style={secondaryText}>
              Open a computer on the left to see its terminals, or start a new one. Each terminal keeps running on its computer when you close this window.
            </p>
            {!ready ? <button type="button" className={buttonClass} style={outlined} onClick={focusMain}>Go to main window</button> : null}
          </main>
        )}
      </div>
    </div>
  );
}
