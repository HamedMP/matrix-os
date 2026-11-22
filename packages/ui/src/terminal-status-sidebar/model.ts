import { rollUpTerminalStatus, type TerminalAgentWord } from "../terminal-agents/attention.js";

/** A machine terminals run on: this device or a Matrix computer. */
export interface TerminalSidebarMachine {
  id: string;
  name: string;
  /** On another machine; its rows carry the machine's name. */
  remote: boolean;
}

/** One terminal as the sidebar shows it. */
export interface TerminalSidebarRow {
  key: string;
  name: string;
  machine: TerminalSidebarMachine;
  status?: TerminalAgentWord;
  /** When the status last changed (ISO time). */
  statusAt?: string;
  /** A done terminal the person has looked at since it finished. */
  seen?: boolean;
  /** The agent that started this one; it is listed under that agent. */
  parentKey?: string;
  /** The agent's program, for its icon (claude, codex, opencode, pi). */
  agent?: string;
  /** The space it belongs to on its machine (a project or workspace), as Herdr's agent rows show. */
  space?: string;
  /** What runs in it or where (the program, or a short folder), on the row's second line. */
  detail?: string;
}

export type TerminalStatusSectionId = "needs-you" | "done" | "working" | "idle";

export interface TerminalSidebarEntry extends TerminalSidebarRow {
  /** The most urgent status among this terminal and its sub-agents. */
  status?: TerminalAgentWord;
  children: TerminalSidebarEntry[];
}

export interface TerminalSidebarSection {
  /** A status section, or `machine:<id>` when grouped by machine. */
  id: TerminalStatusSectionId | `machine:${string}`;
  label: string;
  /** The most urgent status in the section, for its header when folded. */
  status?: TerminalAgentWord;
  rows: TerminalSidebarEntry[];
}

export type TerminalSidebarView = "priority" | "machine";

const SECTION_ORDER: readonly TerminalStatusSectionId[] = ["needs-you", "done", "working", "idle"];
export const TERMINAL_STATUS_SECTION_LABEL: Record<TerminalStatusSectionId, string> = {
  "needs-you": "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};
const URGENCY: Record<TerminalAgentWord, number> = { blocked: 4, error: 4, done: 3, working: 2, idle: 1 };
/** Most sub-agent levels shown; deeper ones are listed under the last level. */
const MAX_DEPTH = 4;

/** What the person sees: a done terminal they have looked at reads as idle. */
function shownStatus(row: TerminalSidebarRow): TerminalAgentWord | undefined {
  return row.status === "done" && row.seen ? "idle" : row.status;
}

function sectionOf(status: TerminalAgentWord | undefined): TerminalStatusSectionId {
  switch (status) {
    case "blocked":
    case "error": return "needs-you";
    case "done": return "done";
    case "working": return "working";
    default: return "idle";
  }
}

function changedAt(entry: TerminalSidebarEntry): number {
  const at = entry.statusAt ? Date.parse(entry.statusAt) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Most urgent first, then the most recent change, then by name. */
function compareEntries(left: TerminalSidebarEntry, right: TerminalSidebarEntry): number {
  const urgency = (right.status ? URGENCY[right.status] : 0) - (left.status ? URGENCY[left.status] : 0);
  return urgency || changedAt(right) - changedAt(left) || left.name.localeCompare(right.name);
}

/** Rows as a forest: each sub-agent under its parent, the parent taking their most urgent status. */
function buildEntries(rows: readonly TerminalSidebarRow[]): TerminalSidebarEntry[] {
  const byKey = new Map<string, TerminalSidebarEntry>();
  for (const row of rows) byKey.set(row.key, { ...row, status: shownStatus(row), children: [] });
  const roots: TerminalSidebarEntry[] = [];
  for (const entry of byKey.values()) {
    const parent = entry.parentKey ? byKey.get(entry.parentKey) : undefined;
    // A parent that is not listed (closed, or on a machine not shown) leaves its sub-agent at the top.
    if (parent && parent !== entry) parent.children.push(entry);
    else roots.push(entry);
  }
  // Every descendant below the last shown level, listed flat under it.
  const flatten = (entry: TerminalSidebarEntry, path: Set<string>, out: TerminalSidebarEntry[]) => {
    for (const child of entry.children) {
      if (path.has(child.key)) continue;
      path.add(child.key);
      out.push({ ...child, children: [] });
      flatten(child, path, out);
    }
    return out;
  };
  const settle = (entry: TerminalSidebarEntry, depth: number, path: Set<string>): TerminalSidebarEntry => {
    // A cycle in parent links (bad data) is cut where it closes.
    const children = entry.children.filter((child) => !path.has(child.key));
    const next = new Set(path).add(entry.key);
    const settled = depth >= MAX_DEPTH
      ? flatten({ ...entry, children }, next, [])
      : children.map((child) => settle(child, depth + 1, next));
    settled.sort(compareEntries);
    return { ...entry, status: rollUpTerminalStatus([entry.status, ...settled.map((child) => child.status)]), children: settled };
  };
  return roots.map((entry) => settle(entry, 1, new Set()));
}

/**
 * The sidebar's sections, as in Herdr: by what the terminal needs from the
 * person (Needs you, Done, Working, Idle), or grouped by machine. Empty
 * sections are left out.
 */
export function terminalStatusSections(
  rows: readonly TerminalSidebarRow[],
  options: { view?: TerminalSidebarView } = {},
): TerminalSidebarSection[] {
  const entries = buildEntries(rows).sort(compareEntries);
  if (options.view === "machine") {
    // Machines keep the order they are given in (this device first), as Herdr's machine headers do.
    const machines = new Map<string, TerminalSidebarSection>();
    for (const row of rows) {
      const id = `machine:${row.machine.id}` as const;
      if (!machines.has(id)) machines.set(id, { id, label: row.machine.name, rows: [] });
    }
    for (const entry of entries) {
      const id = `machine:${entry.machine.id}` as const;
      const section = machines.get(id) ?? { id, label: entry.machine.name, rows: [] };
      section.rows.push(entry);
      machines.set(id, section);
    }
    return [...machines.values()].filter((section) => section.rows.length > 0).map((section) => ({
      ...section,
      status: rollUpTerminalStatus(section.rows.map((entry) => entry.status)),
    }));
  }
  return SECTION_ORDER.flatMap((id) => {
    const sectionRows = entries.filter((entry) => sectionOf(entry.status) === id);
    if (sectionRows.length === 0) return [];
    return [{ id, label: TERMINAL_STATUS_SECTION_LABEL[id], status: rollUpTerminalStatus(sectionRows.map((entry) => entry.status)), rows: sectionRows }];
  });
}

/** Herdr's short time since a change: `<1m`, `5m`, `2h`, `3d`. */
export function terminalSinceLabel(statusAt: string | undefined, now: number): string | null {
  if (!statusAt) return null;
  const at = Date.parse(statusAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Every terminal in sidebar order, for the narrow rail and next/previous. */
export function terminalSidebarOrder(sections: readonly TerminalSidebarSection[]): TerminalSidebarEntry[] {
  const out: TerminalSidebarEntry[] = [];
  const walk = (entry: TerminalSidebarEntry) => { out.push(entry); entry.children.forEach(walk); };
  sections.forEach((section) => section.rows.forEach(walk));
  return out;
}
