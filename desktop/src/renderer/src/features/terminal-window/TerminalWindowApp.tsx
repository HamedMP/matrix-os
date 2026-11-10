// The Electron Desktop Terminal window (specs/651-desktop-terminal-window).
// Slice 1: window shell and machine sections. Matrix computers show their
// availability only; tabs arrive with per-computer credentials.
import { useEffect } from "react";
import { Cloud, Laptop, SquareTerminal } from "lucide-react";
import type { MatrixComputer } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";
import { useAppearance } from "../../stores/appearance";
import { useTerminalMachines, type TerminalMachinesState } from "./use-terminal-machines";

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
const buttonClass = "no-drag rounded-md border px-2.5 py-1 text-[12px] font-medium outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current";

function MachineRow({ machine, icon, label, detail, dotColor }: {
  machine: string; icon: React.ReactNode; label: string; detail: string; dotColor?: string;
}) {
  return (
    <li data-machine={machine} className="flex items-center gap-2.5 rounded-md px-2.5 py-2">
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center" style={secondaryText}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        <span className="flex items-center gap-1.5 text-[11px]" style={secondaryText}>
          {dotColor ? <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: dotColor }} /> : null}
          {detail}
        </span>
      </span>
    </li>
  );
}

function MatrixSection({ state, onRetry, onSignIn }: {
  state: TerminalMachinesState; onRetry: () => void; onSignIn: () => void;
}) {
  if (state.status === "loading") {
    return <p role="status" className="px-2.5 py-2 text-[12px]" style={secondaryText}>Loading your computers…</p>;
  }
  if (state.status === "signed-out") {
    return (
      <div className="flex flex-col items-start gap-2 px-2.5 py-2">
        <p className="text-[13px] font-medium">Sign in to see your Matrix computers</p>
        <p className="text-[12px]" style={secondaryText}>Your cloud terminals appear here once you sign in from the main window.</p>
        <button type="button" className={buttonClass} style={{ borderColor: "var(--border-default)" }} onClick={onSignIn}>Sign in</button>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-2.5 py-2">
        <p className="text-[12px]">Couldn't load your computers.</p>
        <button type="button" className={buttonClass} style={{ borderColor: "var(--border-default)" }} onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (state.computers.length === 0) {
    return <p className="px-2.5 py-2 text-[12px]" style={secondaryText}>No Matrix computers yet.</p>;
  }
  return <>{state.computers.map((computer) => (
    <MachineRow key={computer.runtimeSlot} machine={computer.runtimeSlot} icon={<Cloud size={15} />}
      label={computer.label} detail={`${computer.handle} · ${AVAILABILITY_LABEL[computer.availability]}`}
      dotColor={AVAILABILITY_COLOR[computer.availability]} />
  ))}</>;
}

export default function TerminalWindowApp() {
  const loadAppearance = useAppearance((state) => state.load);
  const { state, retry } = useTerminalMachines();

  useEffect(() => { void loadAppearance(); }, [loadAppearance]);
  useEffect(() => { document.title = "Terminal"; }, []);

  const signIn = () => {
    void invoke("terminal-window:focus-main", {}).catch((error: unknown) => {
      console.warn("[terminal-window] sign-in handoff failed:", error instanceof Error ? error.name : "UnknownError");
    });
  };

  return (
    <div className="ph-no-capture flex h-screen w-screen flex-col" style={{ background: "var(--bg-app)", color: "var(--text-primary, var(--color-foreground))" }}>
      <header className="titlebar-drag flex shrink-0 items-center justify-center border-b text-[12px] font-medium"
        style={{ height: "var(--titlebar-height)", borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
        Terminal
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Machines" className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
          <ul className="flex flex-col gap-0.5">
            <MachineRow machine="local" icon={<Laptop size={15} />} label="This Computer"
              detail="Local terminals are not available in this version" />
            <li aria-hidden="true" className="mx-2.5 my-1 h-px" role="presentation" style={{ background: "var(--border-subtle)" }} />
            <MatrixSection state={state} onRetry={retry} onSignIn={signIn} />
          </ul>
        </nav>
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <SquareTerminal size={28} aria-hidden="true" style={secondaryText} />
          <h1 className="text-[15px] font-semibold">Terminals across your computers</h1>
          <p className="max-w-sm text-[13px]" style={secondaryText}>
            This window will show the terminals on this computer and on every Matrix computer you own.
            For now, open the Terminal app in the main window to work on your selected computer.
          </p>
          <button type="button" className={buttonClass} style={{ borderColor: "var(--border-default)" }} onClick={signIn}>
            Go to main window
          </button>
        </main>
      </div>
    </div>
  );
}
