// The Terminal window's left side, as in Herdr (spec 2706): Spaces (each
// machine, its projects and a `+`) above Agents (every terminal by what it
// needs from the person), Settings at the bottom. Choosing a machine or one
// of its spaces opens it as its own tab: Agents shows only its terminals.
// Below the rail width it is a numbered rail.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ListTree, PanelLeftOpen, Plus, Rows3, Settings, X } from "lucide-react";
import {
  TerminalSidebarList, TerminalStatusSidebar, type TerminalSidebarRow, type TerminalSidebarView,
} from "@matrix-os/ui/terminal-status-sidebar";
import type { LocalTerminalAgent } from "../../../../shared/local-terminals";
import { NewLocalTerminalMenu } from "./LocalTerminalActions";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, type SpaceStyle } from "./use-sidebar-prefs";
import { AllSpacesRow, SpaceList, inOrder, orderedSpaces, spaceId, type SpaceEntry } from "./SidebarSpaces";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const iconButton = "no-drag flex size-6 shrink-0 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";

export interface SidebarMachine {
  id: string;
  name: string;
  kind: "local" | "ssh" | "computer";
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
  /** An ssh machine can be forgotten; its terminals keep running there. */
  onRemove?(): void;
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
  /** Spaces whose terminals are listed inline under them. */
  expandedSpaces: readonly string[];
  onToggleSpaceExpanded(id: string): void;
  /** A terminal row's ↗: opens it as a tab of its space and makes that space active. */
  onOpenInTab(key: string): void;
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
  /** The order the person dragged the machines into. */
  machineOrder: readonly string[];
  onMachineOrder(order: readonly string[]): void;
  /** How the person dressed each space, and the order they dragged each machine's spaces into. */
  spaceStyles: Readonly<Record<string, SpaceStyle>>;
  spaceOrder: Readonly<Record<string, readonly string[]>>;
  onSpaceStyle(id: string, style: SpaceStyle | null): void;
  onSpaceOrder(machineId: string, order: readonly string[]): void;
  /** Terminals pinned to the top of the agents list. */
  pinned: readonly string[];
  onTogglePin(key: string): void;
  /** A row's close: ends the terminal, asking first while a program runs. */
  onCloseTerminal(key: string): void;
  /** Opens Add machine… (an ssh machine for this device's core). */
  onAddMachine?(): void;
}

/** A machine's projects (spaces under it) with how many terminals each has, the most used first. */
export function machineSpaces(rows: readonly TerminalSidebarRow[], machineId: string): Array<{ space: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.machine.id === machineId && row.space) counts.set(row.space, (counts.get(row.space) ?? 0) + 1);
  return [...counts].map(([space, count]) => ({ space, count })).sort((left, right) => right.count - left.count || left.space.localeCompare(right.space));
}

/** Every space in the sidebar's order, for Ctrl+1…9: each machine, then its projects. */
export function spacesInOrder(machineIds: readonly string[], rows: readonly TerminalSidebarRow[], order: Readonly<Record<string, readonly string[]>>): SidebarFilter[] {
  return machineIds.flatMap((machineId) => [
    { machineId },
    ...orderedSpaces(machineSpaces(rows, machineId), machineId, order[machineId]).map((item) => ({ machineId, space: item.space })),
  ]);
}

export function filterRows(rows: readonly TerminalSidebarRow[], filter: SidebarFilter | null): readonly TerminalSidebarRow[] {
  if (!filter) return rows;
  return rows.filter((row) => row.machine.id === filter.machineId && (!filter.space || row.space === filter.space));
}

/** A machine as a space: its row, and its projects (if it has any) behind its chevron. */
function machineEntry(machine: SidebarMachine, props: TerminalWindowSidebarProps, local?: ReactNode): SpaceEntry {
  const { filter, onFilter } = props;
  const projects = machine.available ? orderedSpaces(machineSpaces(props.rows, machine.id), machine.id, props.spaceOrder[machine.id]) : [];
  const remove = machine.onRemove ? (
    <button type="button" aria-label={`Remove ${machine.name}`} title="Remove machine" onClick={machine.onRemove}
      className="no-drag flex size-5 shrink-0 items-center justify-center rounded opacity-0 outline-none hover:bg-black/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-current group-hover:opacity-100"
      style={secondaryText}>
      <X size={11} aria-hidden="true" />
    </button>
  ) : null;
  const add = local ?? (machine.onCreate && machine.available ? (
    <button type="button" aria-label={`New terminal on ${machine.name}`} title="New terminal" disabled={machine.creating}
      onClick={machine.onCreate} className="no-drag flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50"
      style={secondaryText}>
      <Plus size={12} aria-hidden="true" />
    </button>
  ) : null);
  const projectEntries = projects.map((item): SpaceEntry => ({
    id: item.id,
    name: item.space,
    count: item.count,
    selected: filter?.machineId === machine.id && filter.space === item.space,
    available: true,
    onSelect: () => onFilter({ machineId: machine.id, space: item.space }),
    // A project's chevron lists its terminals right there; choosing it is the name's job.
    expansion: {
      label: `${item.space} terminals`,
      content: (
        <div className="pl-9">
          <TerminalSidebarList label={`${item.space} terminals`} rows={filterRows(props.rows, { machineId: machine.id, space: item.space })}
            selectedKey={props.selectedKey} onSelect={props.onSelect} folded={props.folded} onToggleFold={props.onToggleFold}
            now={props.now} onOpenInTab={props.onOpenInTab} oneMachine />
        </div>
      ),
    },
  }));
  return {
    id: machine.id,
    name: machine.name,
    count: props.rows.filter((row) => row.machine.id === machine.id).length,
    detail: machine.detail,
    ...(machine.dotColor ? { dotColor: machine.dotColor } : {}),
    actions: <>{remove}{add}</>,
    selected: filter?.machineId === machine.id && !filter.space,
    available: machine.available,
    onSelect: () => onFilter({ machineId: machine.id }),
    ...(projectEntries.length > 0 ? {
      expansion: {
        label: `${machine.name} projects`,
        content: (
          <SpaceList label={`${machine.name} spaces`} entries={projectEntries} styles={props.spaceStyles} indent
            expanded={props.expandedSpaces} onToggleExpanded={props.onToggleSpaceExpanded}
            onStyle={props.onSpaceStyle} onReorder={(ids) => {
              // Ids are `machineId|space`; the order is kept by project name.
              const byId = new Map(projects.map((item) => [item.id, item.space]));
              props.onSpaceOrder(machine.id, ids.flatMap((id) => byId.get(id) ?? []));
            }} />
        ),
      },
    } : {}),
    ...(machine.status ? { status: machine.status } : {}),
  };
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
  const [local, ...others] = props.machines;
  const usable = [
    ...(local ? [machineEntry(local, props, local.available ? <NewLocalTerminalMenu compact creating={props.localCreating} onCreate={props.onCreateLocal} /> : null)] : []),
    ...others.filter((machine) => !machine.dormant).map((machine) => machineEntry(machine, props)),
  ];
  const entries = inOrder(usable, (entry) => entry.id, props.machineOrder);
  return (
    // Its own scroll past 40% of the window, so the terminals below stay in view.
    <div className="flex max-h-[40vh] shrink-0 flex-col overflow-y-auto">
      <AllSpacesRow chosen={props.filter === null} count={props.rows.length} onChoose={() => props.onFilter(null)} />
      <SpaceList label="Machines" entries={entries} styles={props.spaceStyles}
        expanded={props.expandedSpaces} onToggleExpanded={props.onToggleSpaceExpanded}
        onStyle={props.onSpaceStyle} onReorder={props.onMachineOrder} />
      {/* Machines that cannot be used now wait, compact, under one fold at the end. */}
      <ul aria-label="Unavailable machines list"><UnavailableMachines machines={others.filter((machine) => machine.dormant)} /></ul>
      {props.machinesStatus ? <ul aria-label="Computers status">{props.machinesStatus}</ul> : null}
      {props.onAddMachine ? (
        <ul aria-label="Add machine"><li>
          <button type="button" onClick={props.onAddMachine}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current"
            style={secondaryText}>
            <Plus size={12} aria-hidden="true" className="shrink-0" />
            Add machine…
          </button>
        </li></ul>
      ) : null}
    </div>
  );
}

function FilterChip({ props }: { props: TerminalWindowSidebarProps }) {
  if (!props.filter) return null;
  const { machineId, space } = props.filter;
  const machine = props.machines.find((candidate) => candidate.id === machineId);
  // The names the person gave them, if any.
  const label = [
    props.spaceStyles[machineId]?.name ?? machine?.name ?? "Machine",
    space ? props.spaceStyles[spaceId(machineId, space)]?.name ?? space : null,
  ].filter(Boolean).join(" · ");
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
          folded={props.folded} onToggleFold={props.onToggleFold} now={props.now} pinned={props.pinned} rail />
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
              pinned={props.pinned} onTogglePin={props.onTogglePin} onClose={props.onCloseTerminal} onOpenInTab={props.onOpenInTab}
              oneMachine={props.filter !== null} />}
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
