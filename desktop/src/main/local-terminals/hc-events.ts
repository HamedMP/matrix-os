// Follows herdr-core's `events.subscribe` on its own plain-mode connection
// (spec 2706 layer 4): one snapshot, then every fact change in order. The
// Terminal window gets status as it changes instead of listing on a timer.
// A plain connection carries only JSON lines, so this never touches the framed
// client the attachments use.
import { StringDecoder } from "node:string_decoder";
import { z } from "zod/v4";
import {
  LOCAL_TERMINAL_ADDRESS_PATTERN, LOCAL_TERMINAL_FACTS_MAX, LocalTerminalStatusSchema, type LocalTerminalFact,
} from "../../shared/local-terminals";
import { describeError } from "./describe-error";
import type { HcSocket } from "./hc-client";
import { safeTerminalTitle, TERMINAL_TITLE_LABEL } from "./hc-sessions";

/** The longest line read: a snapshot of every terminal with its full argv. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
// The core sends a heartbeat every 15 s; three missed means the line is dead.
const SILENCE_MS = 45_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CHANGE_DELAY_MS = 50;
/** Herdr's label for the turn the person last looked at. */
export const HERDR_SEEN_LABEL = "herdr.seen";
/** A finished terminal the person opened after it ended. */
export const FINISHED_SEEN_LABEL = "matrix.seen.finished";
const AGENT_LABEL = "matrix.agent";
const AGENTS = new Set(["claude", "codex", "opencode", "pi"]);
// What each agent calls itself in its OSC 7501 reports.
const AGENT_APPS: Record<string, LocalTerminalFact["agent"]> = { "claude-code": "claude", claude: "claude", codex: "codex", opencode: "opencode", pi: "pi" };

const HelloSchema = z.object({ id: z.literal(1), result: z.object({ version: z.string().max(32), generation: z.number().int() }) });
const SubscribedSchema = z.object({ id: z.literal(2), result: z.object({ terminals: z.array(z.unknown()).max(LOCAL_TERMINAL_FACTS_MAX * 4) }) });
const NotificationSchema = z.object({ method: z.string().max(32), params: z.unknown().optional() });
const EventSchema = z.object({
  type: z.string().max(32),
  terminal: z.string().regex(LOCAL_TERMINAL_ADDRESS_PATTERN),
  data: z.record(z.string(), z.unknown()).catch({}),
});
// Only what a fact needs; everything else the core says is ignored.
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const StatusSchema = z.object({ state: z.string().max(32), app: z.string().max(64).optional().catch(undefined) }).nullable().optional().catch(null);
const LabelsSchema = z.record(z.string().max(128), z.string().max(1_024)).nullable().optional().catch(null);
const TerminalSchema = z.object({
  address: z.string().regex(LOCAL_TERMINAL_ADDRESS_PATTERN),
  state: z.enum(["live", "finished"]),
  title: z.string().nullable().optional().catch(null),
  name: z.string().nullable().optional().catch(null),
  parent: z.string().nullable().optional().catch(null),
  status: StatusSchema,
  status_ms: Count.nullable().optional().catch(null),
  created_ms: Count.nullable().optional().catch(null),
  finished_ms: Count.nullable().optional().catch(null),
  turn: Count.optional().catch(0),
  labels: LabelsSchema,
});

interface Tracked {
  title: string | null;
  name: string | null;
  labels: Record<string, string>;
  status: LocalTerminalFact["status"];
  app: string | undefined;
  statusAt: number | null;
  turn: number;
  finished: boolean;
  parent: string | undefined;
}

/** `vps/t4` with parent `t2` means `vps/t2`: a parent is always on its child's machine. */
function machinePrefix(address: string): string {
  const slash = address.indexOf("/");
  return slash < 0 ? "" : address.slice(0, slash + 1);
}

function trackedFrom(raw: unknown): [string, Tracked] | null {
  const parsed = TerminalSchema.safeParse(raw);
  if (!parsed.success) return null;
  const terminal = parsed.data;
  const status = LocalTerminalStatusSchema.safeParse(terminal.status?.state);
  const parent = terminal.parent ? `${machinePrefix(terminal.address)}${terminal.parent}` : undefined;
  const finished = terminal.state === "finished";
  return [terminal.address, {
    title: terminal.title ?? null,
    name: terminal.name ?? null,
    labels: terminal.labels ?? {},
    status: finished || !status.success ? null : status.data,
    app: terminal.status?.app,
    statusAt: (finished ? terminal.finished_ms : terminal.status_ms) ?? terminal.created_ms ?? null,
    turn: terminal.turn ?? 0,
    finished,
    parent: parent && LOCAL_TERMINAL_ADDRESS_PATTERN.test(parent) ? parent : undefined,
  }];
}

function factFrom(id: string, tracked: Tracked): LocalTerminalFact {
  const seen = Number.parseInt(tracked.labels[HERDR_SEEN_LABEL] ?? "", 10);
  const labelled = tracked.labels[AGENT_LABEL];
  const agent = labelled && AGENTS.has(labelled) ? labelled as LocalTerminalFact["agent"] : tracked.app ? AGENT_APPS[tracked.app] : undefined;
  return {
    id,
    title: safeTerminalTitle(tracked.labels[TERMINAL_TITLE_LABEL], tracked.title, tracked.name),
    status: tracked.status,
    statusAt: tracked.statusAt,
    turn: tracked.turn,
    seenTurn: Number.isSafeInteger(seen) && seen >= 0 ? seen : null,
    finished: tracked.finished,
    ...(tracked.finished ? { finishedSeen: tracked.labels[FINISHED_SEEN_LABEL] === "1" } : {}),
    ...(tracked.parent ? { parent: tracked.parent } : {}),
    ...(agent ? { agent } : {}),
  };
}

export interface LocalTerminalEventsOptions {
  /** A new connection to the core's socket. */
  open(): HcSocket;
  expectedVersion: string;
  onChange(facts: LocalTerminalFact[]): void;
  now?: () => number;
}

export function createLocalTerminalEvents(options: LocalTerminalEventsOptions) {
  const now = options.now ?? Date.now;
  // Bounded: replaced by each snapshot, trimmed to LOCAL_TERMINAL_FACTS_MAX (live first).
  let terminals = new Map<string, Tracked>();
  let socket: HcSocket | null = null;
  let running = false;
  let backoff = RECONNECT_MIN_MS;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let silence: ReturnType<typeof setTimeout> | null = null;
  let changed: ReturnType<typeof setTimeout> | null = null;

  const facts = (): LocalTerminalFact[] => {
    const all = [...terminals].map(([id, tracked]) => factFrom(id, tracked));
    const live = all.filter((fact) => !fact.finished);
    const finished = all.filter((fact) => fact.finished).sort((left, right) => (right.statusAt ?? 0) - (left.statusAt ?? 0));
    return [...live, ...finished].slice(0, LOCAL_TERMINAL_FACTS_MAX);
  };

  const announce = () => {
    if (changed || !running) return;
    changed = setTimeout(() => {
      changed = null;
      if (running) options.onChange(facts());
    }, CHANGE_DELAY_MS);
  };

  const clearTimers = () => {
    if (silence) clearTimeout(silence);
    silence = null;
  };

  const drop = (opened: HcSocket, delay: number) => {
    if (socket !== opened) return;
    socket = null;
    clearTimers();
    opened.destroy();
    if (!running || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, delay);
    if (delay > 0) backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  const apply = (event: z.infer<typeof EventSchema>) => {
    const { type, terminal: id, data } = event;
    if (type === "created") {
      const entry = trackedFrom(data);
      if (entry && entry[0] === id) terminals.set(id, entry[1]);
      return;
    }
    if (type === "removed") { terminals.delete(id); return; }
    const tracked = terminals.get(id);
    if (!tracked) return;
    switch (type) {
      case "status": {
        const status = StatusSchema.parse(data.status);
        const word = LocalTerminalStatusSchema.safeParse(status?.state);
        terminals.set(id, { ...tracked, status: word.success ? word.data : null, app: status?.app ?? tracked.app, statusAt: now() });
        return;
      }
      case "turn": {
        const turn = Count.safeParse(data.turn);
        if (turn.success) terminals.set(id, { ...tracked, turn: turn.data });
        return;
      }
      case "labels":
        terminals.set(id, { ...tracked, labels: LabelsSchema.parse(data.labels) ?? {} });
        return;
      case "title": {
        const title = z.string().nullable().catch(null).parse(data.title);
        terminals.set(id, { ...tracked, title });
        return;
      }
      case "finished": {
        const at = Count.nullable().catch(null).parse(data.finished_ms);
        terminals.set(id, { ...tracked, finished: true, status: null, statusAt: at ?? now() });
        return;
      }
      default:
        return;
    }
  };

  function connect(): void {
    if (!running || socket) return;
    let opened: HcSocket;
    try {
      opened = options.open();
    } catch (error: unknown) {
      console.warn("[local-terminals] events connect failed:", describeError(error));
      retry = setTimeout(() => { retry = null; connect(); }, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      return;
    }
    socket = opened;
    let buffered = "";
    // A character can be split across reads.
    const decoder = new StringDecoder("utf8");
    let stage: "hello" | "subscribe" | "events" = "hello";
    const quiet = (ms: number) => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => {
        console.warn("[local-terminals] events went silent; reconnecting");
        drop(opened, backoff);
      }, ms);
    };
    quiet(HANDSHAKE_TIMEOUT_MS);

    const onLine = (line: string) => {
      const message: unknown = JSON.parse(line);
      if (stage === "hello") {
        const hello = HelloSchema.safeParse(message);
        if (!hello.success || hello.data.result.generation !== 1 || hello.data.result.version !== options.expectedVersion) {
          throw new Error("local terminal runtime refused for events");
        }
        stage = "subscribe";
        opened.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events.subscribe", params: {} })}\n`);
        return;
      }
      if (stage === "subscribe") {
        const subscribed = SubscribedSchema.safeParse(message);
        if (!subscribed.success) throw new Error("local terminal events refused");
        stage = "events";
        backoff = RECONNECT_MIN_MS;
        const next = new Map<string, Tracked>();
        for (const raw of subscribed.data.result.terminals) {
          const entry = trackedFrom(raw);
          if (entry) next.set(entry[0], entry[1]);
        }
        terminals = next;
        quiet(SILENCE_MS);
        announce();
        return;
      }
      const notification = NotificationSchema.safeParse(message);
      if (!notification.success) return;
      quiet(SILENCE_MS);
      if (notification.data.method === "missed") {
        // A fresh subscription brings a fresh snapshot.
        drop(opened, 0);
        return;
      }
      if (notification.data.method !== "event") return;
      const event = EventSchema.safeParse(notification.data.params);
      if (!event.success) return;
      apply(event.data);
      if (terminals.size > LOCAL_TERMINAL_FACTS_MAX * 2) {
        terminals = new Map(facts().map((fact) => [fact.id, terminals.get(fact.id)!]));
      }
      announce();
    };

    opened.on("data", (chunk) => {
      if (socket !== opened) return;
      try {
        buffered += decoder.write(chunk);
        let newline = buffered.indexOf("\n");
        while (newline >= 0 && socket === opened) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim()) onLine(line);
          newline = buffered.indexOf("\n");
        }
        if (buffered.length > MAX_LINE_BYTES) throw new Error("local terminal event line too long");
      } catch (error: unknown) {
        console.warn("[local-terminals] events failed:", describeError(error));
        drop(opened, backoff);
      }
    });
    opened.on("error", (error) => {
      console.warn("[local-terminals] events connection error:", describeError(error));
      drop(opened, backoff);
    });
    opened.on("close", () => drop(opened, backoff));
    opened.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: {} })}\n`);
  }

  return {
    /** Starts following, if not already. */
    start(): void {
      if (running) return;
      running = true;
      backoff = RECONNECT_MIN_MS;
      connect();
    },
    /** Stops following and forgets every fact. */
    stop(): void {
      running = false;
      if (retry) clearTimeout(retry);
      if (changed) clearTimeout(changed);
      retry = null;
      changed = null;
      clearTimers();
      const open = socket;
      socket = null;
      open?.destroy();
      terminals = new Map();
    },
    facts,
    /** The facts of one terminal, if listed. */
    fact(id: string): LocalTerminalFact | undefined {
      const tracked = terminals.get(id);
      return tracked ? factFrom(id, tracked) : undefined;
    },
  };
}

export type LocalTerminalEvents = ReturnType<typeof createLocalTerminalEvents>;
