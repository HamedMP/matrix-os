import { terminalFactsKey, type TerminalAgentWord, type TerminalTabFacts } from "./attention.js";

const MAX_TABS = 1_024;
const WORDS = new Set<TerminalAgentWord>(["idle", "working", "done", "blocked", "error"]);
const TERMINAL_ID = /^(tws|tt)_[0-9a-f]{32}$/;

export interface TerminalEventsState {
  connected: boolean;
  seq: number;
  /** Serializable: keyed by `workspaceId:tabId`. */
  tabs: Record<string, TerminalTabFacts>;
}

export const EMPTY_TERMINAL_EVENTS_STATE: TerminalEventsState = { connected: false, seq: 0, tabs: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRef(value: unknown) {
  if (!isRecord(value) || typeof value.workspaceId !== "string" || typeof value.tabId !== "string") return null;
  if (!TERMINAL_ID.test(value.workspaceId) || !TERMINAL_ID.test(value.tabId)) return null;
  return { workspaceId: value.workspaceId, tabId: value.tabId };
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function word(value: unknown): TerminalAgentWord | undefined {
  return typeof value === "string" && WORDS.has(value as TerminalAgentWord) ? value as TerminalAgentWord : undefined;
}

/** Validate one tab's facts from the server; unknown or malformed input is dropped. */
export function parseTerminalTabFacts(value: unknown): TerminalTabFacts | null {
  if (!isRecord(value)) return null;
  const ref = parseRef(value.ref);
  const name = text(value.name, 128);
  if (!ref || name === undefined || (value.state !== "live" && value.state !== "finished")) return null;
  const agentStatus = word(value.agentStatus);
  const statusMessage = text(value.statusMessage, 200);
  const projectId = text(value.projectId, 128);
  const statusAt = text(value.statusAt, 64);
  return {
    ref, name, cwd: text(value.cwd, 4096) ?? "", state: value.state,
    ...(projectId ? { projectId } : {}),
    ...(typeof value.exitCode === "number" || value.exitCode === null ? { exitCode: value.exitCode as number | null } : {}),
    ...(agentStatus ? { agentStatus } : {}),
    ...(statusMessage ? { statusMessage } : {}),
    ...(statusAt ? { statusAt } : {}),
  };
}

/** Apply one `/ws/terminal/events` frame. Pure: returns the same object when nothing changed. */
export function reduceTerminalEvents(state: TerminalEventsState, frame: unknown): TerminalEventsState {
  if (!isRecord(frame) || typeof frame.type !== "string") return state;
  const seq = typeof frame.seq === "number" ? frame.seq : state.seq;
  if (frame.type === "snapshot" && Array.isArray(frame.tabs)) {
    const tabs: Record<string, TerminalTabFacts> = {};
    for (const raw of frame.tabs.slice(0, MAX_TABS)) {
      const facts = parseTerminalTabFacts(raw);
      if (facts) tabs[terminalFactsKey(facts.ref)] = facts;
    }
    return { connected: true, seq, tabs };
  }
  if (frame.type !== "event" || !isRecord(frame.event)) return state;
  const event = frame.event;
  const ref = parseRef(event.ref);
  if (!ref) return state;
  const key = terminalFactsKey(ref);
  const current = state.tabs[key];
  switch (event.kind) {
    case "created": {
      const facts = parseTerminalTabFacts(event.tab);
      if (!facts || Object.keys(state.tabs).length >= MAX_TABS) return state;
      return { ...state, seq, tabs: { ...state.tabs, [key]: facts } };
    }
    case "removed": {
      if (!current) return state;
      const { [key]: _removed, ...rest } = state.tabs;
      void _removed;
      return { ...state, seq, tabs: rest };
    }
    case "finished": {
      if (!current) return state;
      const { agentStatus: _status, statusMessage: _message, ...facts } = current;
      void _status; void _message;
      const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
      return { ...state, seq, tabs: { ...state.tabs, [key]: { ...facts, state: "finished", exitCode } } };
    }
    case "status": {
      if (!current) return state;
      const { agentStatus: _status, statusMessage: _message, ...facts } = current;
      void _status; void _message;
      const next = word(event.status);
      const message = text(event.message, 200);
      return { ...state, seq, tabs: { ...state.tabs, [key]: { ...facts, ...(next ? { agentStatus: next } : {}), ...(message ? { statusMessage: message } : {}) } } };
    }
    case "title": {
      const name = text(event.name, 128);
      if (!current || name === undefined) return state;
      return { ...state, seq, tabs: { ...state.tabs, [key]: { ...current, name } } };
    }
    default:
      return state;
  }
}
