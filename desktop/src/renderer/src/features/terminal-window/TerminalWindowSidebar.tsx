// The Terminal window's left side, as in Herdr (spec 2706): machines on top,
// each foldable with a `+`, then every terminal by what it needs from the
// person. Below the rail width it is a numbered rail.
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Cloud, Laptop, ListTree, PanelLeftOpen, Plus, Rows3 } from "lucide-react";
import { TerminalStatusSidebar, type TerminalSidebarRow, type TerminalSidebarView } from "@matrix-os/ui/terminal-status-sidebar";
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
  /** A computer's `+`: starts a shell there. This device uses the agent menu instead. */
  onCreate?(): void;
  creating?: boolean;
  /** Shown under the machine: a failure, a retry or a sign-in hand-off. */
  status?: ReactNode;
}

export interface TerminalWindowSidebarProps {
  machines: readonly SidebarMachine[];
  /** Shown below the machines: the Matrix computers' loading, sign-in or error state. */
  machinesStatus?: ReactNode;
  foldedMachines: readonly string[];
  onToggleMachine(id: string): void;
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
}

function MachineRow({ machine, folded, onToggle, local }: {
  machine: SidebarMachine; folded: boolean; onToggle(): void; local?: ReactNode;
}) {
  const icon = machine.kind === "local" ? <Laptop size={14} /> : <Cloud size={14} />;
  return (
    <li data-machine={machine.id}>
      <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-black/5">
        <button type="button" aria-expanded={!folded} disabled={!machine.available} onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-current disabled:opacity-70">
          <span aria-hidden="true" style={secondaryText}>{folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
          <span aria-hidden="true" style={secondaryText}>{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{machine.name}</span>
            <span className="flex items-center gap-1.5 text-[11px]" style={secondaryText}>
              {machine.dotColor ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: machine.dotColor }} /> : null}
              <span className="truncate">{machine.detail}</span>
            </span>
          </span>
        </button>
        {local ?? (machine.onCreate && machine.available ? (
          <button type="button" aria-label={`New terminal on ${machine.name}`} title="New terminal" disabled={machine.creating}
            onClick={machine.onCreate} className={iconButton} style={secondaryText}>
            <Plus size={13} aria-hidden="true" />
          </button>
        ) : null)}
      </div>
      {machine.status ?? null}
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

export function TerminalWindowSidebar(props: TerminalWindowSidebarProps) {
  const foldedMachines = new Set(props.foldedMachines);
  const visibleRows = props.rows.filter((row) => !foldedMachines.has(row.machine.id));
  const shell = { borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" };
  if (props.rail) {
    return (
      <div className="flex w-12 shrink-0 flex-col items-center overflow-y-auto border-r" style={shell}>
        <button type="button" aria-label="Show sidebar" title="Show sidebar (⌘B)" onClick={props.onToggleRail}
          className={`${iconButton} mt-2`} style={secondaryText}>
          <PanelLeftOpen size={14} aria-hidden="true" />
        </button>
        <TerminalStatusSidebar rows={visibleRows} view={props.view} selectedKey={props.selectedKey} onSelect={props.onSelect}
          folded={props.folded} onToggleFold={props.onToggleFold} now={props.now} rail />
      </div>
    );
  }
  const [local, ...computers] = props.machines;
  return (
    <div className="relative flex shrink-0 flex-col border-r" style={{ ...shell, width: props.width }}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
        <h2 className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide" style={secondaryText}>Machines</h2>
        <ul aria-label="Machines" className="flex flex-col gap-0.5">
          {local ? (
            <MachineRow machine={local} folded={foldedMachines.has(local.id)} onToggle={() => props.onToggleMachine(local.id)}
              local={local.available ? <NewLocalTerminalMenu compact creating={props.localCreating} onCreate={props.onCreateLocal} /> : null} />
          ) : null}
          {computers.map((machine) => (
            <MachineRow key={machine.id} machine={machine} folded={foldedMachines.has(machine.id)}
              onToggle={() => props.onToggleMachine(machine.id)} />
          ))}
          {props.machinesStatus ?? null}
        </ul>
        <div className="mt-2 flex items-center gap-1 px-2 pb-0.5 pt-1">
          <h2 className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide" style={secondaryText}>Terminals</h2>
          <button type="button" aria-label={props.view === "priority" ? "Group by machine" : "Group by status"}
            title={props.view === "priority" ? "Group by machine" : "Group by status"}
            onClick={() => props.onSetView(props.view === "priority" ? "machine" : "priority")} className={iconButton} style={secondaryText}>
            {props.view === "priority" ? <ListTree size={13} aria-hidden="true" /> : <Rows3 size={13} aria-hidden="true" />}
          </button>
        </div>
        {visibleRows.length === 0
          ? <p className="px-2 py-1 text-[12px]" style={secondaryText}>No terminals yet. Start one with + next to a machine.</p>
          : <TerminalStatusSidebar rows={visibleRows} view={props.view} selectedKey={props.selectedKey} onSelect={props.onSelect}
              folded={props.folded} onToggleFold={props.onToggleFold} now={props.now} />}
        {props.notices ?? null}
      </div>
      <ResizeEdge width={props.width} onResize={props.onResize} />
    </div>
  );
}
