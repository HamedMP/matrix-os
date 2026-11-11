import { z } from "zod/v4";
import { terminalFactsKey, type TerminalTabFacts } from "./attention.js";

const MAX_TABS = 1_024;
const TerminalIdSchema = z.string().regex(/^(tws|tt)_[0-9a-f]{32}$/);
const RefSchema = z.strictObject({ workspaceId: TerminalIdSchema, tabId: TerminalIdSchema });
const WordSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
const SeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One tab's facts as the gateway sends them; bounded, unknown fields rejected. */
const TabFactsSchema = z.strictObject({
  ref: RefSchema,
  name: z.string().max(128),
  cwd: z.string().max(4096),
  projectId: z.string().min(1).max(128).optional(),
  state: z.enum(["live", "finished"]),
  exitCode: z.number().int().nullable().optional(),
  agentStatus: WordSchema.optional(),
  statusMessage: z.string().max(200).optional(),
  statusAt: z.string().max(64).optional(),
});

const EventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("created"), ref: RefSchema, tab: TabFactsSchema }),
  z.strictObject({ kind: z.literal("removed"), ref: RefSchema }),
  z.strictObject({ kind: z.literal("finished"), ref: RefSchema, exitCode: z.number().int().nullable() }),
  z.strictObject({ kind: z.literal("status"), ref: RefSchema, status: WordSchema.nullable(), message: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal("title"), ref: RefSchema, name: z.string().max(128) }),
]);

/** Every `/ws/terminal/events` server frame, checked before anything is stored. */
export const TerminalEventsFrameSchema = z.discriminatedUnion("type", [
  // Tabs are checked one by one below: one malformed tab must not hide the others.
  z.strictObject({ type: z.literal("snapshot"), seq: SeqSchema, tabs: z.array(z.unknown()).max(MAX_TABS) }),
  z.strictObject({ type: z.literal("event"), seq: SeqSchema, event: EventSchema }),
  z.strictObject({ type: z.literal("heartbeat"), seq: SeqSchema }),
  z.strictObject({ type: z.literal("missed"), seq: SeqSchema }),
  z.strictObject({ type: z.literal("shutdown"), seq: SeqSchema }),
  z.strictObject({ type: z.literal("pong") }),
]);

export interface TerminalEventsState {
  connected: boolean;
  seq: number;
  /** Serializable: keyed by `workspaceId:tabId`. */
  tabs: Record<string, TerminalTabFacts>;
}

export const EMPTY_TERMINAL_EVENTS_STATE: TerminalEventsState = { connected: false, seq: 0, tabs: {} };

function withoutStatus(facts: TerminalTabFacts): TerminalTabFacts {
  const { agentStatus: _status, statusMessage: _message, ...rest } = facts;
  void _status; void _message;
  return rest;
}

/** Validate one tab's facts from the server; malformed input is dropped. */
export function parseTerminalTabFacts(value: unknown): TerminalTabFacts | null {
  const parsed = TabFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Apply one `/ws/terminal/events` frame. Pure: returns the same object when nothing changed. */
export function reduceTerminalEvents(state: TerminalEventsState, input: unknown): TerminalEventsState {
  const parsed = TerminalEventsFrameSchema.safeParse(input);
  if (!parsed.success) return state;
  const frame = parsed.data;
  if (frame.type === "snapshot") {
    const tabs: Record<string, TerminalTabFacts> = {};
    for (const raw of frame.tabs) {
      const facts = parseTerminalTabFacts(raw);
      if (facts) tabs[terminalFactsKey(facts.ref)] = facts;
    }
    return { connected: true, seq: frame.seq, tabs };
  }
  if (frame.type !== "event") return state;
  const { event, seq } = frame;
  const key = terminalFactsKey(event.ref);
  const current = state.tabs[key];
  switch (event.kind) {
    case "created":
      if (Object.keys(state.tabs).length >= MAX_TABS) return state;
      return { ...state, seq, tabs: { ...state.tabs, [key]: event.tab } };
    case "removed": {
      if (!current) return state;
      const { [key]: _removed, ...rest } = state.tabs;
      void _removed;
      return { ...state, seq, tabs: rest };
    }
    case "finished":
      if (!current) return state;
      return { ...state, seq, tabs: { ...state.tabs, [key]: { ...withoutStatus(current), state: "finished", exitCode: event.exitCode } } };
    case "status":
      if (!current) return state;
      return {
        ...state,
        seq,
        tabs: {
          ...state.tabs,
          [key]: {
            ...withoutStatus(current),
            ...(event.status ? { agentStatus: event.status } : {}),
            ...(event.message ? { statusMessage: event.message } : {}),
          },
        },
      };
    case "title":
      if (!current) return state;
      return { ...state, seq, tabs: { ...state.tabs, [key]: { ...current, name: event.name } } };
  }
}
