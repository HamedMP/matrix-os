import { terminalFactsKey, type TerminalAgentWord } from "../terminal-agents/attention.js";
import type { TerminalEventsState } from "../terminal-agents/events-state.js";
import type { TerminalSidebarMachine, TerminalSidebarRow } from "./model.js";

/** A row key that is unique across machines: the machine, then the terminal there. */
export function terminalRowKey(machineId: string, terminalId: string): string {
  return `${machineId}|${terminalId}`;
}

/**
 * One terminal on this device as the Terminal window's trusted core reports it
 * from herdr-core's `events.subscribe` (spec 2706 layer 4).
 */
export interface LocalTerminalFact {
  id: string;
  title: string;
  /** What the program last reported (OSC 7501), or null. */
  status: TerminalAgentWord | null;
  /** When the status last changed, or when the program exited (ms since the epoch). */
  statusAt: number | null;
  /** herdr-core's turn: it goes up each time the status leaves `working`. */
  turn: number;
  /** The turn the person last looked at (Herdr's `herdr.seen` label), or null. */
  seenTurn: number | null;
  finished: boolean;
  /** A finished terminal the person opened after it ended. */
  finishedSeen?: boolean;
  /** The terminal that started it, on the same machine. */
  parent?: string;
  /** The agent's program, for its icon. */
  agent?: string;
  /** What runs in it now (the foreground program's name). */
  program?: string;
  /** Its folder, shortened for display. */
  folder?: string;
}

/** Local terminals as sidebar rows: a finished one reads as done until opened. */
export function localSidebarRows(facts: readonly LocalTerminalFact[], machine: TerminalSidebarMachine): TerminalSidebarRow[] {
  return facts.map((fact) => {
    const status = fact.finished ? "done" : fact.status ?? undefined;
    const seen = fact.finished
      ? fact.finishedSeen === true
      : status === "done" && fact.seenTurn !== null && fact.seenTurn >= fact.turn;
    return {
      key: terminalRowKey(machine.id, fact.id),
      name: fact.title,
      machine,
      ...(status ? { status } : {}),
      ...(fact.statusAt !== null && Number.isFinite(fact.statusAt) ? { statusAt: new Date(fact.statusAt).toISOString() } : {}),
      ...(status === "done" ? { seen } : {}),
      ...(fact.parent ? { parentKey: terminalRowKey(machine.id, fact.parent) } : {}),
      ...(fact.agent ? { agent: fact.agent } : {}),
      ...(fact.program || fact.folder ? { detail: [fact.program, fact.folder].filter(Boolean).join(" · ") } : {}),
    };
  });
}

/**
 * A Matrix computer's tabs from its `/ws/terminal/events` stream: a finished
 * tab reads as done, and the gateway's attention frame says when it became done
 * and whether the person opened it since, on any window or device.
 */
export function computerSidebarRows(state: TerminalEventsState, machine: TerminalSidebarMachine): TerminalSidebarRow[] {
  return Object.values(state.tabs).map((tab) => {
    const key = terminalFactsKey(tab.ref);
    const status: TerminalAgentWord | undefined = tab.state === "finished" ? "done" : tab.agentStatus;
    const attention = status === "done" ? state.attention?.[key] : undefined;
    const statusAt = attention?.doneAt ?? tab.statusAt;
    return {
      key: terminalRowKey(machine.id, key),
      name: tab.name,
      machine,
      ...(status ? { status } : {}),
      ...(statusAt ? { statusAt } : {}),
      ...(status === "done" ? { seen: attention?.seen === true } : {}),
      space: tab.projectId ?? "main",
      ...(tab.cwd ? { detail: `~/${tab.cwd}` } : {}),
    };
  });
}
