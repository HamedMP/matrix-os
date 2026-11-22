// The Terminal window's left side, as in Herdr (spec 2706): Spaces (each
// machine, its projects and a `+`) above Agents (every terminal by what it
// needs from the person), Settings at the bottom. Choosing a machine or one
// of its spaces opens it as its own tab: Agents shows only its terminals.
// Below the rail width it is a numbered rail.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Cloud, Laptop, ListTree, PanelLeftOpen, Plus, Rows3, Settings, X } from "lucide-react";
import {
  TerminalStatusSidebar, type TerminalSidebarRow, type TerminalSidebarView,
} from "@matrix-os/ui/terminal-status-sidebar";
import type { LocalTerminalAgent } from "../../../../shared/local-terminals";
import { NewLocalTerminalMenu } from "./LocalTerminalActions";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./use-sidebar-prefs";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const iconButton = "no-drag flex size-6 shrink-0 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";

export interface SidebarMachine {
  id: string;
  name: string;
  kind: "local" | "computer";
  detail: string;
  dotColor?: string;
  /** Terminals can be listed and started there now. */
  available: boolean;
  /** Unavailable for now (not starting): listed compactly under one fold at the end. */
  dormant?: boolean;
  /** A computer's `+`: starts a shell there. This device uses the agent menu instead. */
  onCreate?(): void;
  creating?: boolean;
  /** Shown under the machine: a failure, a retry or a sign-in hand-off. */
  status?: ReactNode;
}

/** Agents shown only for one machine, or one space on it (Herdr's spaces; a computer opened as its own tab). */
export interface SidebarFilter {
  machineId: string;
  space?: string;
}

export interface TerminalWindowSidebarProps {
  machines: readonly SidebarMachine[];
  /** Shown below the machines: the Matrix computers' loading, sign-in or error state. */
  machinesStatus?: ReactNode;
  /** Whether a machine's spaces are folded. */
  machineFolded(id: string): boolean;
  onToggleMachine(id: string): void;
  filter: SidebarFilter | null;
  onFilter(filter: SidebarFilter | null): void;
  localCreating: boolean;
  onCreateLocal(launch: { agent?: LocalTerminalAgent }): void;
  rows: readonly TerminalSidebarRow[];
  selectedKey: string | null;
  onSelect(key: string): void;
  view: TerminalSidebarView;
  onSetView(view: TerminalSidebarView): void;
  folded: readonly string[];
  onToggleFold(id: string): void;
  now: number;
  rail: boolean;
  onToggleRail(): void;
  width: number;
  onResize(width: number): void;
  notices?: ReactNode;
  /** The footer's Settings: the main window's settings. */
  onSettings(): void;
  /** Terminals pinned to the top of the agents list. */
  pinned: readonly string[];
  onTogglePin(key: string): void;
  /** A row's close: ends the terminal, asking first while a program runs. */
  onCloseTerminal(key: string): void;
}

/** A machine's spaces (projects or workspaces) with how many terminals each has, most first. */
export function machineSpaces(rows: readonly TerminalSidebarRow[], machineId: string): Array<{ space: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.machine.id === machineId && row.space) counts.set(row.space, (counts.get(row.space) ?? 0) + 1);
  return [...counts].map(([space, count]) => ({ space, count })).sort((left, right) => right.count - left.count || left.space.localeCompare(right.space));
}

export function filterRows(rows: readonly TerminalSidebarRow[], filter: SidebarFilter | null): readonly TerminalSidebarRow[] {
  if (!filter) return rows;
  return rows.filter((row) => row.machine.id === filter.machineId && (!filter.space || row.space === filter.space));
}

function MachineRow({ machine, folded, onToggle, local, spaces, filter, onFilter }: {
  machine: SidebarMachine; folded: boolean; onToggle(): void; local?: ReactNode;
  spaces: Array<{ space: string; count: number }>;
  filter: SidebarFilter | null;
  onFilter(filter: SidebarFilter | null): void;
}) {
  const icon = machine.kind === "local" ? <Laptop size={14} /> : <Cloud size={14} />;
  const chosen = filter?.machineId === machine.id && !filter.space;
  return (
    <li data-machine={machine.id}>
      <div className="group flex items-center gap-0.5 rounded-md pr-1 hover:bg-black/5"
        style={chosen ? { background: "var(--bg-hover, rgba(127,127,127,0.18))" } : undefined}>
        <button type="button" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} ${machine.name} spaces`}
          disabled={!machine.available || spaces.length === 0} onClick={onToggle} className={iconButton} style={secondaryText}>
          {folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>
        {/* Opens the machine as its own tab: the agents list shows only its terminals. */}
        <button type="button" aria-pressed={chosen} disabled={!machine.available} onClick={() => onFilter(chosen ? null : { machineId: machine.id })}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-current disabled:opacity-70">
          <span aria-hidden="true" style={secondaryText}>{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{machine.name}</span>
            <span className="block truncate text-[11px]" style={secondaryText}>{machine.detail}</span>
          </span>
          {machine.dotColor ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: machine.dotColor }} /> : null}
        </button>
        {local ?? (machine.onCreate && machine.available ? (
          <button type="button" aria-label={`New terminal on ${machine.name}`} title="New terminal" disabled={machine.creating}
            onClick={machine.onCreate} className={iconButton} style={secondaryText}>
            <Plus size={13} aria-hidden="true" />
          </button>
        ) : null)}
      </div>
      {machine.status ?? null}
      {folded || spaces.length === 0 ? null : (
        <ul aria-label={`${machine.name} spaces`} className="flex flex-col pl-7">
          {spaces.map(({ space, count }) => {
            const on = filter?.machineId === machine.id && filter.space === space;
            return (
              <li key={space}>
                <button type="button" aria-pressed={on} onClick={() => onFilter(on ? null : { machineId: machine.id, space })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-0.5 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current"
                  style={on ? { background: "var(--bg-hover, rgba(127,127,127,0.18))" } : secondaryText}>
                  <span className="min-w-0 flex-1 truncate">{space}</span>
                  <span className="tabular-nums">{count}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function ResizeEdge({ width, onResize }: { width: number; onResize(width: number): void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onResize(start.current.width + event.clientX - start.current.x);
  };
  const onPointerUp = () => { start.current = null; };
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH} aria-valuenow={width} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onResize(width - 16);
        if (event.key === "ArrowRight") onResize(width + 16);
      }}
      className="no-drag absolute inset-y-0 -right-1 w-2 cursor-col-resize outline-none focus-visible:bg-[var(--border-default)]" />
  );
}

function UnavailableMachines({ machines }: { machines: readonly SidebarMachine[] }) {
  const [open, setOpen] = useState(false);
  if (machines.length === 0) return null;
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current"
        style={secondaryText}>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        Unavailable ({machines.length})
      </button>
      {open ? (
        <ul aria-label="Unavailable machines" className="flex flex-col pl-5">
          {machines.map((machine) => (
            <li key={machine.id} data-machine={machine.id} className="truncate px-2 py-0.5 text-[12px] opacity-70" style={secondaryText}>
              {machine.name} · {machine.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function MachinesList({ props }: { props: TerminalWindowSidebarProps }) {
  const machineRow = (machine: SidebarMachine, local?: ReactNode) => (
    <MachineRow key={machine.id} machine={machine} folded={props.machineFolded(machine.id)}
      onToggle={() => props.onToggleMachine(machine.id)} local={local} spaces={machineSpaces(props.rows, machine.id)}
      filter={props.filter} onFilter={props.onFilter} />
  );
  const [local, ...others] = props.machines;
  return (
    // Its own scroll past a third of the window, so the terminals below stay in view.
    <ul aria-label="Machines" className="flex max-h-[33vh] shrink-0 flex-col gap-0.5 overflow-y-auto">
      {local
        ? machineRow(local, local.available ? <NewLocalTerminalMenu compact creating={props.localCreating} onCreate={props.onCreateLocal} /> : null)
        : null}
      {others.filter((machine) => !machine.dormant).map((machine) => machineRow(machine))}
      {/* Machines that cannot be used now wait, compact, under one fold at the end. */}
      <UnavailableMachines machines={others.filter((machine) => machine.dormant)} />
      {props.machinesStatus ?? null}
    </ul>
  );
}

function FilterChip({ props }: { props: TerminalWindowSidebarProps }) {
  if (!props.filter) return null;
  const machine = props.machines.find((candidate) => candidate.id === props.filter?.machineId);
  const label = [machine?.name ?? "Machine", props.filter.space].filter(Boolean).join(" · ");
  return (
    <button type="button" aria-label={`Show all machines (now ${label})`} onClick={() => props.onFilter(null)}
      className="flex max-w-[60%] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-current"
      style={{ borderColor: "var(--border-default)" }}>
      <span className="truncate">{label}</span>
      <X size={11} aria-hidden="true" />
    </button>
  );
}

export function TerminalWindowSidebar(props: TerminalWindowSidebarProps) {
  const shell = { borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" };
  const rows = filterRows(props.rows, props.filter);
  if (props.rail) {
    return (
      <div className="flex w-12 shrink-0 flex-col items-center overflow-y-auto border-r" style={shell}>
        <button type="button" aria-label="Show sidebar" title="Show sidebar (⌘B)" onClick={props.onToggleRail}
          className={`${iconButton} mt-2`} style={secondaryText}>
          <PanelLeftOpen size={14} aria-hidden="true" />
        </button>
        <TerminalStatusSidebar rows={rows} view={props.view} selectedKey={props.selectedKey} onSelect={props.onSelect}
          folded={props.folded} onToggleFold={props.onToggleFold} now={props.now} rail />
      </div>
    );
  }
  const heading = "px-2 text-[11px] font-medium uppercase tracking-wide";
  return (
    <div className="relative flex shrink-0 flex-col border-r" style={{ ...shell, width: props.width }}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
        <h2 className={`${heading} pb-1 pt-1`} style={secondaryText}>Spaces</h2>
        <MachinesList props={props} />
        <div className="mt-3 flex items-center gap-1 px-0 pb-0.5 pt-1">
          <h2 className={`${heading} min-w-0 flex-1`} style={secondaryText}>Agents</h2>
          <FilterChip props={props} />
          <button type="button" aria-label={props.view === "priority" ? "Group by machine" : "Group by status"}
            title={props.view === "priority" ? "Group by machine" : "Group by status"}
            onClick={() => props.onSetView(props.view === "priority" ? "machine" : "priority")} className={iconButton} style={secondaryText}>
            {props.view === "priority" ? <ListTree size={13} aria-hidden="true" /> : <Rows3 size={13} aria-hidden="true" />}
          </button>
        </div>
        {rows.length === 0
          ? <p className="px-2 py-1 text-[12px]" style={secondaryText}>{props.filter ? "No terminals here yet." : "No terminals yet. Start one with + next to a machine."}</p>
          : <TerminalStatusSidebar rows={rows} view={props.view} selectedKey={props.selectedKey} onSelect={props.onSelect}
              folded={props.folded} onToggleFold={props.onToggleFold} now={props.now}
              pinned={props.pinned} onTogglePin={props.onTogglePin} onClose={props.onCloseTerminal} oneMachine={props.filter !== null} />}
        {props.notices ?? null}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5" style={{ borderColor: "var(--border-subtle)" }}>
        <button type="button" onClick={props.onSettings}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current"
          style={secondaryText}>
          <Settings size={13} aria-hidden="true" /> Settings
        </button>
      </div>
      <ResizeEdge width={props.width} onResize={props.onResize} />
    </div>
  );
}
