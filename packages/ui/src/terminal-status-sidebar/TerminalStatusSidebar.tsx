"use client";

import { useMemo, type CSSProperties } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, LoaderCircle, Pin, PinOff, SquareTerminal, X } from "lucide-react";
import { AgentLogo } from "../agent-logo.js";
import { isAgentLogoKind } from "../agent-logo-kind.js";
import type { TerminalAgentWord } from "../terminal-agents/attention.js";
import {
  terminalSidebarOrder,
  terminalSinceLabel,
  terminalStatusSections,
  type TerminalSidebarEntry,
  type TerminalSidebarRow,
  type TerminalSidebarSection,
  type TerminalSidebarView,
} from "./model.js";

export interface TerminalStatusSidebarProps {
  rows: readonly TerminalSidebarRow[];
  view?: TerminalSidebarView;
  selectedKey?: string | null;
  onSelect(key: string): void;
  /** Section ids (and parent row keys) the person folded. */
  folded: readonly string[];
  onToggleFold(id: string): void;
  /** Narrow numbered rail instead of rows (Herdr shows it below 160 px). */
  rail?: boolean;
  /** The current time, for "time since"; the host ticks it. */
  now: number;
  /** Terminals the person pinned: listed first, in a Pinned section. */
  pinned?: readonly string[];
  /** Pin or unpin a terminal (a hover action on its row). */
  onTogglePin?(key: string): void;
  /** Close a terminal (a hover action on its row); the host confirms while a program runs. */
  onClose?(key: string): void;
  /** Open a terminal as a tab of its space (the row's ↗). */
  onOpenInTab?(key: string): void;
  /** Every row is on one machine (a machine filter), so rows leave out the machine's name. */
  oneMachine?: boolean;
}

const PRIMARY = "var(--text-primary, var(--foreground, #171717))";
const SECONDARY = "var(--text-secondary, var(--muted-foreground, #737373))";
// A clear tint in both themes, the same shape as the selected row's (some themes' --bg-hover is nearly invisible).
const HOVER_BG = "rgba(127,127,127,0.14)";
const SELECTED_BG = "var(--terminal-drawer-card-selected-bg, var(--bg-hover, rgba(127,127,127,0.18)))";
const LINE = "var(--border-default, #d4d4d4)";
const AMBER = "#d97706";
// Each row's time and status sit in fixed columns, so they line up and never move with the name's length.
const TIME_COLUMN = "w-8";
const MARK_COLUMN = "w-4";
const INDENT_PX = 14;

const COUNT_COLOR: Partial<Record<string, string>> = { "needs-you": AMBER, working: AMBER, done: "#059669" };

/** The terminal's status mark, in a fixed column: spinner, an amber dot for "needs you", a filled dot, or a ring. */
function StatusMark({ status }: { status?: TerminalAgentWord }) {
  const box = `flex ${MARK_COLUMN} shrink-0 items-center justify-center`;
  if (status === "working") {
    return <span className={box}><LoaderCircle size={12} aria-label="Working" className="animate-spin" style={{ color: AMBER }} /></span>;
  }
  if (status === "blocked" || status === "error") {
    return <span className={box}><span role="img" aria-label={status === "error" ? "Error" : "Needs you"} className="size-2 rounded-full"
      style={{ background: status === "error" ? "#dc2626" : AMBER }} /></span>;
  }
  if (status === "done") {
    return <span className={box}><span aria-label="Done" role="img" className="size-2 rounded-full" style={{ background: "#10b981" }} /></span>;
  }
  return <span className={box}><span aria-label="Idle" role="img" className="size-2 rounded-full"
    style={{ boxShadow: `inset 0 0 0 1.5px ${SECONDARY}`, opacity: 0.6 }} /></span>;
}

// Herdr-like badges for the programs a terminal commonly runs (an agent's helper processes).
const PROGRAM_BADGE: Record<string, { text: string; background: string; color: string }> = {
  bun: { text: "Bun", background: "#fbf0df", color: "#14151a" },
  node: { text: "N", background: "#5fa04e", color: "#ffffff" },
  npm: { text: "npm", background: "#cb3837", color: "#ffffff" },
  pnpm: { text: "pn", background: "#f69220", color: "#ffffff" },
  deno: { text: "D", background: "#000000", color: "#ffffff" },
  next: { text: "N", background: "#000000", color: "#ffffff" },
  "next-server": { text: "N", background: "#000000", color: "#ffffff" },
  electron: { text: "E", background: "#47848f", color: "#ffffff" },
  vite: { text: "V", background: "#646cff", color: "#ffffff" },
  python: { text: "Py", background: "#3776ab", color: "#ffd43b" },
  python3: { text: "Py", background: "#3776ab", color: "#ffd43b" },
  cargo: { text: "R", background: "#dea584", color: "#000000" },
  go: { text: "Go", background: "#00add8", color: "#ffffff" },
  docker: { text: "D", background: "#2496ed", color: "#ffffff" },
  git: { text: "G", background: "#f05032", color: "#ffffff" },
};

function RowIcon({ entry }: { entry: TerminalSidebarEntry }) {
  if (entry.agent && isAgentLogoKind(entry.agent)) return <AgentLogo kind={entry.agent} label={entry.agent} size={16} />;
  const badge = entry.program ? PROGRAM_BADGE[entry.program.toLowerCase()] : undefined;
  if (badge) {
    return <span role="img" aria-label={entry.program} title={entry.program}
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] px-0.5 text-[8px] font-bold leading-none"
      style={{ background: badge.background, color: badge.color }}>{badge.text}</span>;
  }
  return <SquareTerminal size={14} aria-hidden="true" className="shrink-0" style={{ color: SECONDARY }} />;
}

/** Herdr's first line: the project in bold, then " · title" muted; a terminal with no project shows its title. */
function RowTitle({ entry }: { entry: TerminalSidebarEntry }) {
  if (!entry.space) return <span className="min-w-0 flex-1 truncate">{entry.name}</span>;
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="font-semibold">{entry.space}</span>
      <span style={{ color: SECONDARY }}> · {entry.name}</span>
    </span>
  );
}

/** The second line: the machine (only where rows from several machines mix), what runs there, and "Needs you". */
function RowDetail({ entry, showMachine }: { entry: TerminalSidebarEntry; showMachine: boolean }) {
  const parts = [showMachine && entry.machine.remote ? entry.machine.name : null, entry.detail].filter(Boolean);
  const attention = entry.status === "blocked" || entry.status === "error";
  if (parts.length === 0 && !attention) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: SECONDARY }}>
      <span className="min-w-0 flex-1 truncate">{parts.join(" · ")}</span>
      {attention ? (
        <span className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
          style={{ background: "rgba(245,158,11,0.16)", color: "#b45309" }}>{entry.status === "error" ? "Error" : "Needs you"}</span>
      ) : null}
    </span>
  );
}

/** Pin and close, shown over the time column while the row is hovered or has focus. */
function RowActions({ entry, pinned, props }: { entry: TerminalSidebarEntry; pinned: boolean; props: TerminalStatusSidebarProps }) {
  if (!props.onTogglePin && !props.onClose && !props.onOpenInTab) return null;
  const button = "flex size-5 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current";
  return (
    <span role="group" aria-label={`${entry.name} actions`}
      className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
      {props.onOpenInTab ? (
        <button type="button" aria-label="Open in a tab" title="Open in a tab of its space"
          onClick={() => props.onOpenInTab?.(entry.key)} className={button} style={{ color: SECONDARY }}>
          <ArrowUpRight size={11} aria-hidden="true" />
        </button>
      ) : null}
      {props.onTogglePin ? (
        <button type="button" aria-label={pinned ? "Unpin terminal" : "Pin terminal"} title={pinned ? "Unpin" : "Pin"}
          onClick={() => props.onTogglePin?.(entry.key)} className={button} style={{ color: SECONDARY }}>
          {pinned ? <PinOff size={11} aria-hidden="true" /> : <Pin size={11} aria-hidden="true" />}
        </button>
      ) : null}
      {props.onClose ? (
        <button type="button" aria-label="Close terminal" title="Close"
          onClick={() => props.onClose?.(entry.key)} className={button} style={{ color: SECONDARY }}>
          <X size={11} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/** A fixed slot before the icon: the fold chevron for a terminal with sub-agents, so every name starts in line. */
function FoldSlot({ entry, folded, onToggle }: { entry: TerminalSidebarEntry; folded: boolean; onToggle(): void }) {
  if (entry.children.length === 0) return <span aria-hidden="true" className="w-3.5 shrink-0" />;
  return (
    <button type="button" aria-expanded={!folded}
      aria-label={`${folded ? "Show" : "Hide"} ${entry.children.length} sub-agents of ${entry.name}`}
      onClick={onToggle} className="flex w-3.5 shrink-0 items-center justify-center self-start rounded pt-1.5 outline-none focus-visible:ring-2 focus-visible:ring-current"
      style={{ color: SECONDARY }}>
      {folded ? <ChevronRight size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
    </button>
  );
}

function Row({ entry, depth, inset, props }: {
  entry: TerminalSidebarEntry; depth: number; inset: boolean; props: TerminalStatusSidebarProps;
}) {
  const selected = props.selectedKey === entry.key;
  const folded = props.folded.includes(entry.key);
  const pinned = props.pinned?.includes(entry.key) ?? false;
  const since = terminalSinceLabel(entry.statusAt, props.now);
  const indent = depth * INDENT_PX + (inset ? INDENT_PX : 0);
  const actions = Boolean(props.onTogglePin || props.onClose || props.onOpenInTab);
  const rowStyle = {
    paddingLeft: 2 + indent,
    background: selected ? SELECTED_BG : undefined,
    "--sidebar-row-hover": selected ? SELECTED_BG : HOVER_BG,
  } as CSSProperties;
  return <li className="relative">
    {depth > 0 ? (
      // The sub-agent's connector: a tick off its parent's line.
      <span aria-hidden="true" className="pointer-events-none absolute top-3 h-px w-2" style={{ left: indent - INDENT_PX + 9, background: LINE }} />
    ) : null}
    <div className="group relative flex items-start rounded-md hover:bg-[var(--sidebar-row-hover)]" data-selected={selected || undefined} style={rowStyle}>
      <FoldSlot entry={entry} folded={folded} onToggle={() => props.onToggleFold(entry.key)} />
      <button type="button" aria-current={selected ? "true" : undefined} onClick={() => props.onSelect(entry.key)}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md py-1 pl-1 pr-1 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-current"
        style={{ color: PRIMARY }}>
        <span className="mt-0.5 flex w-4 shrink-0 justify-center"><RowIcon entry={entry} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <RowTitle entry={entry} />
            {/* While the row's actions show, they take the time and mark's place. */}
            <span className={`${actions ? "group-hover:invisible group-focus-within:invisible " : ""}flex shrink-0 items-center`}>
              <span className={`${TIME_COLUMN} shrink-0 text-right text-[11px] tabular-nums`} style={{ color: SECONDARY }}>{since ?? ""}</span>
              <StatusMark status={entry.status} />
            </span>
          </span>
          <RowDetail entry={entry} showMachine={!inset && !props.oneMachine} />
        </span>
      </button>
      <RowActions entry={entry} pinned={pinned} props={props} />
    </div>
    {entry.children.length > 0 && !folded ? (
      <ul className="relative">
        {/* The line the sub-agents hang from. */}
        <span aria-hidden="true" className="pointer-events-none absolute bottom-3 top-0 w-px" style={{ left: indent + 9, background: LINE }} />
        {entry.children.map((child) => <Row key={child.key} entry={child} depth={depth + 1} inset={inset} props={props} />)}
      </ul>
    ) : null}
  </li>;
}

function Section({ section, props }: { section: TerminalSidebarSection; props: TerminalStatusSidebarProps }) {
  const folded = props.folded.includes(section.id);
  // Inside a machine's own group its rows are inset under it and do not repeat its name.
  const inset = section.id.startsWith("machine:");
  return <section aria-label={section.label} data-section={section.id}>
    <button type="button" aria-expanded={!folded} onClick={() => props.onToggleFold(section.id)}
      className="flex w-full items-center gap-1.5 rounded-md px-2 pb-1 pt-2.5 text-left text-[11px] font-medium uppercase tracking-wide outline-none hover:bg-[var(--bg-hover,rgba(127,127,127,0.12))] focus-visible:ring-2 focus-visible:ring-current"
      style={{ color: SECONDARY }}>
      {folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
      <span className="tabular-nums" style={{ color: COUNT_COLOR[section.id] ?? SECONDARY }}>{section.rows.length}</span>
      {folded && inset ? <StatusMark status={section.status} /> : null}
    </button>
    {folded ? null : <ul className="px-1">{section.rows.map((entry) => <Row key={entry.key} entry={entry} depth={0} inset={inset} props={props} />)}</ul>}
  </section>;
}

/**
 * One machine's terminals as plain rows (no sections), most urgent first, as
 * under a machine in the sidebar's machines list.
 */
export function TerminalSidebarList(props: Omit<TerminalStatusSidebarProps, "view" | "rail"> & { label: string }) {
  const entries = useMemo(() => terminalStatusSections(props.rows).flatMap((section) => section.rows), [props.rows]);
  if (entries.length === 0) return null;
  return <ul aria-label={props.label} className="px-1 pb-1">
    {entries.map((entry) => <Row key={entry.key} entry={entry} depth={0} inset props={{ ...props, view: "priority" }} />)}
  </ul>;
}

/**
 * Herdr's agents sidebar: pinned terminals first, then terminals by what they
 * need from the person (Needs you, Done, Working, Idle) or by machine, each
 * section foldable, sub-agents hanging under their parent. Shared so Web can
 * adopt it; the host owns fold, pin state, selection and the clock.
 */
export function TerminalStatusSidebar(props: TerminalStatusSidebarProps) {
  const sections = useMemo(
    () => terminalStatusSections(props.rows, { view: props.view, pinned: props.pinned }),
    [props.rows, props.view, props.pinned],
  );
  if (props.rail) {
    const ordered = terminalSidebarOrder(sections);
    return <nav aria-label="Terminals" className="flex flex-col items-center gap-1 py-2">
      {ordered.map((entry, index) => {
        const selected = props.selectedKey === entry.key;
        return <button key={entry.key} type="button" title={entry.name} aria-label={entry.name}
          aria-current={selected ? "true" : undefined} onClick={() => props.onSelect(entry.key)}
          className="relative flex size-8 items-center justify-center rounded-md text-[12px] tabular-nums hover:bg-[var(--bg-hover,rgba(127,127,127,0.12))]"
          style={{ background: selected ? SELECTED_BG : undefined, color: PRIMARY }}>
          {index + 1}
          <span className="absolute -right-1 -top-0.5"><StatusMark status={entry.status} /></span>
        </button>;
      })}
    </nav>;
  }
  return <nav aria-label="Terminals" className="flex min-h-0 flex-col">
    {sections.map((section) => <Section key={section.id} section={section} props={props} />)}
  </nav>;
}
