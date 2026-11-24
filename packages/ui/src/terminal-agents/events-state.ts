import { ProjectIdSchema, SafeDisplayStringSchema, TeamTerminalOwnerEntrySchema, TerminalTabIdSchema, TerminalWorkspaceIdSchema, type TeamTerminalOwnerEntry } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { terminalFactsKey, type TerminalTabFacts } from "./attention.js";

// Every live tab plus bounded finished history, as the gateway sends; the runtime
// allows at most 10 000 tabs.
const MAX_TABS = 10_240;
// Beyond twice the cap a snapshot is not a valid stream.
const MAX_SNAPSHOT_ENTRIES = 2 * MAX_TABS;
// The gateway's own schemas, so both ends accept exactly the same values.
const RefSchema = z.strictObject({ workspaceId: TerminalWorkspaceIdSchema, tabId: TerminalTabIdSchema });
const WordSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
const SeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One tab's facts as the gateway sends them; bounded, unknown fields rejected. */
const TabFactsSchema = z.strictObject({
  ref: RefSchema,
  name: SafeDisplayStringSchema,
  cwd: z.string().max(4096),
  projectId: ProjectIdSchema.optional(),
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
  z.strictObject({ kind: z.literal("title"), ref: RefSchema, name: SafeDisplayStringSchema }),
]);

// A done tab's attention as the gateway sends it (spec 2706): ref key, when it
// became done, and whether the person opened it since.
const AttentionKeySchema = z.string().regex(/^tws_[0-9a-f]{32}:tt_[0-9a-f]{32}$/);
const AttentionSchema = z.strictObject({ doneAt: z.string().max(64), seen: z.boolean() });
// The gateway sends attention only for tabs its snapshot carries.
const MAX_ATTENTION = MAX_SNAPSHOT_ENTRIES;
const MAX_TEAM_TABS = 64;

/** Every `/ws/terminal/events` server frame, checked before anything is stored. */
export const TerminalEventsFrameSchema = z.discriminatedUnion("type", [
  // Tabs are checked one by one below: one malformed tab must not hide the others.
  // A larger snapshot is still read; the client keeps its live tabs within MAX_TABS.
  z.strictObject({ type: z.literal("snapshot"), seq: SeqSchema, tabs: z.array(z.unknown()).max(MAX_SNAPSHOT_ENTRIES) }),
  z.strictObject({ type: z.literal("event"), seq: SeqSchema, event: EventSchema }),
  z.strictObject({
    type: z.literal("attention"), seq: SeqSchema,
    tabs: z.record(AttentionKeySchema, AttentionSchema).refine((tabs) => Object.keys(tabs).length <= MAX_ATTENTION),
  }),
  // Spec 2710: who watches and types in each shared tab; at most the 64 a computer shares.
  z.strictObject({
    type: z.literal("team"), seq: SeqSchema,
    tabs: z.record(AttentionKeySchema, TeamTerminalOwnerEntrySchema).refine((tabs) => Object.keys(tabs).length <= MAX_TEAM_TABS),
  }),
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
  /**
   * Done tabs and whether the person opened them since (spec 2706), keyed like
   * `tabs`. Absent until the gateway sends one: an older gateway does not.
   */
  attention?: Record<string, TerminalTabAttention>;
  /** Spec 2710: shared tabs someone is watching, keyed like `tabs`. Absent from older gateways. */
  team?: Record<string, TeamTerminalOwnerEntry>;
}

export interface TerminalTabAttention {
  /** When the tab became done (ISO). */
  doneAt: string;
  seen: boolean;
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
    const parsed = frame.tabs.map(parseTerminalTabFacts).filter((facts): facts is TerminalTabFacts => facts !== null);
    // Live tabs first, so a long finished history never pushes out a working agent.
    parsed.sort((left, right) => Number(left.state === "finished") - Number(right.state === "finished"));
    const tabs: Record<string, TerminalTabFacts> = {};
    for (const facts of parsed.slice(0, MAX_TABS)) tabs[terminalFactsKey(facts.ref)] = facts;
    // A new connection's attention comes in its own frame right after; the old one must not
    // outlive it (a gateway that sends none would otherwise keep stale seen marks).
    const { attention: _previous, team: _team, ...rest } = state;
    void _previous; void _team;
    return { ...rest, connected: true, seq: frame.seq, tabs };
  }
  if (frame.type === "attention") return { ...state, seq: frame.seq, attention: frame.tabs };
  if (frame.type === "team") return { ...state, seq: frame.seq, team: frame.tabs };
  if (frame.type !== "event") return state;
  const { event, seq } = frame;
  const key = terminalFactsKey(event.ref);
  const current = state.tabs[key];
  switch (event.kind) {
    case "created": {
      if (Object.keys(state.tabs).length < MAX_TABS) return { ...state, seq, tabs: { ...state.tabs, [key]: event.tab } };
      // At the cap, finished history makes room; a live tab is never dropped for history.
      const evict = Object.entries(state.tabs).find(([, facts]) => facts.state === "finished")?.[0];
      if (!evict || event.tab.state === "finished") return state;
      const { [evict]: _evicted, ...rest } = state.tabs;
      void _evicted;
      return { ...state, seq, tabs: { ...rest, [key]: event.tab } };
    }
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
