"use client";

import { useMemo } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, SquareTerminal } from "lucide-react";
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
}

const SECONDARY = "var(--text-secondary, var(--muted-foreground, #737373))";

/** The terminal's status mark: spinner, "Needs you", a filled dot, or a ring. */
function StatusMark({ status }: { status?: TerminalAgentWord }) {
  if (status === "working") {
    return <LoaderCircle size={12} aria-label="Working" className="shrink-0 animate-spin" style={{ color: SECONDARY }} />;
  }
  if (status === "blocked" || status === "error") {
    return <span className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
      style={{ background: "rgba(245,158,11,0.16)", color: "#b45309" }}>{status === "error" ? "Error" : "Needs you"}</span>;
  }
  if (status === "done") {
    return <span aria-label="Done" role="img" className="size-2 shrink-0 rounded-full" style={{ background: "#10b981" }} />;
  }
  return <span aria-label="Idle" role="img" className="size-2 shrink-0 rounded-full"
    style={{ boxShadow: `inset 0 0 0 1.5px ${SECONDARY}`, opacity: 0.6 }} />;
}

function RowIcon({ entry }: { entry: TerminalSidebarEntry }) {
  if (entry.agent && isAgentLogoKind(entry.agent)) return <AgentLogo kind={entry.agent} label={entry.agent} size={16} />;
  return <SquareTerminal size={14} aria-hidden="true" className="shrink-0" style={{ color: SECONDARY }} />;
}

function Row({ entry, depth, props }: { entry: TerminalSidebarEntry; depth: number; props: TerminalStatusSidebarProps }) {
  const selected = props.selectedKey === entry.key;
  const folded = props.folded.includes(entry.key);
  const since = terminalSinceLabel(entry.statusAt, props.now);
  return <li>
    <div className="group flex items-center rounded-md" data-selected={selected || undefined}
      style={{ paddingLeft: 4 + depth * 14, background: selected ? "var(--terminal-drawer-card-selected-bg, var(--bg-hover, rgba(127,127,127,0.18)))" : undefined }}>
      <button type="button" aria-current={selected ? "true" : undefined} onClick={() => props.onSelect(entry.key)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px]"
        style={{ color: "var(--text-primary, var(--foreground, #171717))" }}>
        <RowIcon entry={entry} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.machine.remote ? <span className="max-w-[40%] shrink truncate text-[11px]" style={{ color: SECONDARY }}>{entry.machine.name}</span> : null}
        {since ? <span className="shrink-0 text-[11px] tabular-nums" style={{ color: SECONDARY }}>{since}</span> : null}
        <StatusMark status={entry.status} />
      </button>
      {entry.children.length > 0 ? <button type="button" aria-expanded={!folded}
        aria-label={`${folded ? "Show" : "Hide"} ${entry.children.length} sub-agents of ${entry.name}`}
        onClick={() => props.onToggleFold(entry.key)} className="mr-1 flex shrink-0 items-center gap-0.5 rounded px-1 text-[11px]"
        style={{ color: SECONDARY }}>
        {folded ? entry.children.length : null}{folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button> : null}
    </div>
    {entry.children.length > 0 && !folded
      ? <ul>{entry.children.map((child) => <Row key={child.key} entry={child} depth={depth + 1} props={props} />)}</ul>
      : null}
  </li>;
}

function Section({ section, props }: { section: TerminalSidebarSection; props: TerminalStatusSidebarProps }) {
  const folded = props.folded.includes(section.id);
  return <section aria-label={section.label} data-section={section.id}>
    <button type="button" aria-expanded={!folded} onClick={() => props.onToggleFold(section.id)}
      className="flex w-full items-center gap-1.5 px-2 pb-1 pt-2.5 text-left text-[11px] font-medium uppercase tracking-wide"
      style={{ color: SECONDARY }}>
      {folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
      {folded ? <span className="tabular-nums">{section.rows.length}</span> : null}
      {folded && section.id.startsWith("machine:") ? <StatusMark status={section.status} /> : null}
    </button>
    {folded ? null : <ul className="px-1">{section.rows.map((entry) => <Row key={entry.key} entry={entry} depth={0} props={props} />)}</ul>}
  </section>;
}

/**
 * Herdr's agents sidebar: terminals by what they need from the person (Needs
 * you, Done, Working, Idle) or by machine, each section foldable, sub-agents
 * under their parent. Shared so Web can adopt it; the host owns fold state,
 * selection and the clock.
 */
export function TerminalStatusSidebar(props: TerminalStatusSidebarProps) {
  const sections = useMemo(() => terminalStatusSections(props.rows, { view: props.view }), [props.rows, props.view]);
  if (props.rail) {
    const ordered = terminalSidebarOrder(sections);
    return <nav aria-label="Terminals" className="flex flex-col items-center gap-1 py-2">
      {ordered.map((entry, index) => {
        const selected = props.selectedKey === entry.key;
        return <button key={entry.key} type="button" title={entry.name} aria-label={entry.name}
          aria-current={selected ? "true" : undefined} onClick={() => props.onSelect(entry.key)}
          className="relative flex size-8 items-center justify-center rounded-md text-[12px] tabular-nums"
          style={{ background: selected ? "var(--bg-hover, rgba(127,127,127,0.18))" : undefined, color: "var(--text-primary, var(--foreground, #171717))" }}>
          {index + 1}
          <span className="absolute -right-0.5 -top-0.5"><StatusMark status={entry.status} /></span>
        </button>;
      })}
    </nav>;
  }
  return <nav aria-label="Terminals" className="flex min-h-0 flex-col">
    {sections.map((section) => <Section key={section.id} section={section} props={props} />)}
  </nav>;
}
