import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import type { TerminalAgentStatusSource } from "./status-source.js";
import { terminalRefKey } from "./status-source.js";
import type { TerminalSeenStore } from "./seen-store.js";
import type { TerminalAgentStatus } from "./verbs.js";

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;
const MAX_SUBSCRIBERS = 64;
const MAX_BACKLOG_BYTES = 1024 * 1024;
/**
 * Most finished tabs a snapshot carries. Every live tab is always included (the
 * runtime bounds how many can run); finished history fills what is left.
 */
export const TERMINAL_EVENTS_MAX_TABS = 1_024;
/** Longest working folder a stream entry carries (about 1 KiB per tab at most). */
export const MAX_STREAM_CWD_CHARS = 256;

/** A snapshot's tabs: all live ones, then finished history up to the cap. */
function snapshotTabs(facts: Map<string, TerminalTabFacts>): TerminalTabFacts[] {
  const all = [...facts.values()];
  const live = all.filter((entry) => entry.state === "live");
  const finished = all.filter((entry) => entry.state === "finished");
  return [...live, ...finished.slice(0, Math.max(0, TERMINAL_EVENTS_MAX_TABS - live.length))];
}

export interface TerminalTabFacts {
  ref: TerminalRef;
  name: string;
  cwd: string;
  projectId?: string;
  state: "live" | "finished";
  exitCode?: number | null;
  agentStatus?: TerminalAgentStatus;
  statusMessage?: string;
  statusAt?: string;
}

export type TerminalEvent =
  | { kind: "created"; ref: TerminalRef; tab: TerminalTabFacts }
  | { kind: "removed"; ref: TerminalRef }
  | { kind: "finished"; ref: TerminalRef; exitCode: number | null }
  | { kind: "status"; ref: TerminalRef; status: TerminalAgentStatus | null; message?: string }
  | { kind: "title"; ref: TerminalRef; name: string };

/** A done tab (finished, or reporting `done`): when it became done and whether it was opened since. */
export interface TerminalTabAttention {
  doneAt: string;
  seen: boolean;
}

export type TerminalEventFrame =
  | { type: "snapshot"; seq: number; tabs: TerminalTabFacts[] }
  /**
   * Every done tab by ref key, sent after each snapshot and whenever it changes.
   * Clients that predate it ignore an unknown frame type.
   */
  | { type: "attention"; seq: number; tabs: Record<string, TerminalTabAttention> }
  | { type: "event"; seq: number; event: TerminalEvent }
  | { type: "heartbeat"; seq: number }
  | { type: "missed"; seq: number }
  | { type: "shutdown"; seq: number };

export interface TerminalEventSubscriber {
  send(frame: TerminalEventFrame): void;
  close(): void;
  /** Bytes queued on the transport; above 1 MiB the subscriber misses events and resnapshots. */
  backlog?(): number;
}

interface SubscriberState extends TerminalEventSubscriber {
  lastTouched: number;
  needsSnapshot: boolean;
  missed: boolean;
}

export interface TerminalEventSubscription {
  touch(): void;
  close(): void;
  /** The person opened this tab: every subscriber learns it is seen. False for a tab the stream does not list. */
  markSeen(ref: TerminalRef): boolean;
}

export interface TerminalEventHub {
  subscribe(subscriber: TerminalEventSubscriber): TerminalEventSubscription;
  tick(): Promise<void>;
  size(): number;
  shutdown(): void;
}

interface DoneTab {
  /** When it became done (ISO): its latest `done` report, or (for an ended tab) its last saved change. */
  at: string;
  /** Its program ended; it is done for good. */
  finished: boolean;
}

interface Listed {
  facts: Map<string, TerminalTabFacts>;
  /** Every done tab. Never sent as a fact. */
  done: Map<string, DoneTab>;
}

function factsFrom(workspaces: TerminalWorkspace[], statuses: ReadonlyMap<string, {
  status: TerminalAgentStatus; message?: string; reportedAt: string;
}>): Listed {
  const facts = new Map<string, TerminalTabFacts>();
  const done = new Map<string, DoneTab>();
  // Every owner tab, so lifecycle changes (an exit and its code) are diffed before any
  // history is trimmed; only snapshots trim finished history.
  const ordered = workspaces.flatMap((workspace) => workspace.tabs.map((tab) => ({ workspace, tab })))
    .filter(({ tab }) => tab.accessScope === "owner");
  for (const { workspace, tab } of ordered) {
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const finished = tab.status === "exited" || tab.status === "failed";
    const status = finished ? undefined : statuses.get(terminalRefKey(ref));
    if (finished) done.set(terminalRefKey(ref), { at: tab.updatedAt, finished: true });
    else if (status?.status === "done") done.set(terminalRefKey(ref), { at: status.reportedAt, finished: false });
    facts.set(terminalRefKey(ref), {
      ref,
      name: tab.name,
      // Bounded so a snapshot of every live tab stays small; full folders come from `get`.
      cwd: tab.cwd.slice(0, MAX_STREAM_CWD_CHARS),
      ...(workspace.scope === "project" ? { projectId: workspace.projectId } : {}),
      state: finished ? "finished" : "live",
      ...(finished ? { exitCode: tab.exitCode ?? null } : {}),
      ...(status ? { agentStatus: status.status, statusAt: status.reportedAt } : {}),
      ...(status?.message ? { statusMessage: status.message } : {}),
    });
  }
  return { facts, done };
}

/** Most attention entries sent: as many tabs as a client keeps (live tabs plus finished history). */
export const TERMINAL_ATTENTION_MAX_TABS = 10_240;

/**
 * Every done tab a client can show, from a snapshot or a later event, so each
 * can be marked seen: live ones first, then the most recently done. An ended
 * tab is seen once it was opened after its program ended; a tab reporting
 * `done` once it was opened since that report.
 */
function attentionFrom(facts: Map<string, TerminalTabFacts>, done: ReadonlyMap<string, DoneTab>, seen: TerminalSeenStore | undefined): Record<string, TerminalTabAttention> {
  const entries = [...done].filter(([key]) => facts.has(key))
    .map(([key, entry]) => ({ key, entry, time: Date.parse(entry.at) }))
    .sort((left, right) => Number(left.entry.finished) - Number(right.entry.finished) || (right.time || 0) - (left.time || 0))
    .slice(0, TERMINAL_ATTENTION_MAX_TABS);
  const tabs: Record<string, TerminalTabAttention> = {};
  for (const { key, entry, time } of entries) {
    const opened = seen?.get(key);
    tabs[key] = {
      doneAt: entry.at,
      seen: opened !== undefined && (entry.finished ? opened.finished : Number.isFinite(time) && opened.at >= time),
    };
  }
  return tabs;
}

function diff(previous: Map<string, TerminalTabFacts>, next: Map<string, TerminalTabFacts>): TerminalEvent[] {
  const events: TerminalEvent[] = [];
  for (const [key, tab] of next) {
    const before = previous.get(key);
    if (!before) {
      events.push({ kind: "created", ref: tab.ref, tab });
      continue;
    }
    if (before.name !== tab.name) events.push({ kind: "title", ref: tab.ref, name: tab.name });
    if (before.agentStatus !== tab.agentStatus || before.statusMessage !== tab.statusMessage) {
      if (tab.state === "live") {
        events.push({
          kind: "status", ref: tab.ref, status: tab.agentStatus ?? null,
          ...(tab.statusMessage ? { message: tab.statusMessage } : {}),
        });
      }
    }
    if (before.state === "live" && tab.state === "finished") {
      events.push({ kind: "finished", ref: tab.ref, exitCode: tab.exitCode ?? null });
    }
  }
  for (const [key, tab] of previous) {
    if (!next.has(key)) events.push({ kind: "removed", ref: tab.ref });
  }
  return events;
}

/**
 * Herdr's `events.subscribe` for canonical terminals: a snapshot, then ordered
 * fact changes, a heartbeat, and `missed` + resnapshot for a slow subscriber.
 * One shared poll serves every subscriber; it runs only while someone listens.
 */
export function createTerminalEventHub(options: {
  runtime: { listWorkspaces(): Promise<TerminalWorkspace[]> };
  status: TerminalAgentStatusSource;
  now?: () => number;
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  autoStart?: boolean;
  /** When each tab was last opened. Without it the hub sends no attention frames and accepts no marks. */
  seen?: TerminalSeenStore;
}): TerminalEventHub {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const subscribers = new Set<SubscriberState>();
  let facts: Map<string, TerminalTabFacts> | null = null;
  let done: Map<string, DoneTab> = new Map();
  let attention: { tabs: Record<string, TerminalTabAttention>; json: string } | null = null;
  let seq = 0;
  let pollTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;
  let stopped = false;

  function deliver(subscriber: SubscriberState, frame: TerminalEventFrame): boolean {
    try {
      subscriber.send(frame);
      return true;
    } catch (error: unknown) {
      console.warn("[gateway] terminal event send failed", error instanceof Error ? error.name : "unknown_error");
      return false;
    }
  }

  function evict(subscriber: SubscriberState) {
    subscribers.delete(subscriber);
    try { subscriber.close(); }
    catch (error: unknown) { console.warn("[gateway] terminal event close failed", error instanceof Error ? error.name : "unknown_error"); }
    if (subscribers.size === 0) stopTimers();
  }

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
    facts = null;
    done = new Map();
    attention = null;
  }

  /** Recomputes attention; true when it changed. */
  function refreshAttention(): boolean {
    const tabs = facts ? attentionFrom(facts, done, options.seen) : {};
    const json = JSON.stringify(tabs);
    if (attention?.json === json) return false;
    attention = { tabs, json };
    return true;
  }

  const attentionFrame = (): TerminalEventFrame => ({ type: "attention", seq: ++seq, tabs: attention?.tabs ?? {} });

  function startTimers() {
    if (options.autoStart === false || pollTimer) return;
    pollTimer = setInterval(() => { void tick(); }, options.pollMs ?? DEFAULT_POLL_MS);
    pollTimer.unref();
    heartbeatTimer = setInterval(() => {
      const dead = [...subscribers].filter((subscriber) => !deliver(subscriber, { type: "heartbeat", seq }));
      dead.forEach(evict);
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    heartbeatTimer.unref();
  }

  async function tickNow() {
    for (const subscriber of [...subscribers]) {
      if (now() - subscriber.lastTouched > staleMs) evict(subscriber);
    }
    if (subscribers.size === 0) return;
    const [workspaces, statuses] = await Promise.all([options.runtime.listWorkspaces(), options.status.list()]);
    const listed = factsFrom(workspaces, statuses);
    const next = listed.facts;
    const events = facts ? diff(facts, next) : [];
    facts = next;
    done = listed.done;
    options.seen?.retain(new Set(next.keys()));
    const frames = events.map((event): TerminalEventFrame => ({ type: "event", seq: ++seq, event }));
    if (options.seen && refreshAttention()) frames.push(attentionFrame());
    const dead: SubscriberState[] = [];
    for (const subscriber of subscribers) {
      const backedUp = (subscriber.backlog?.() ?? 0) > MAX_BACKLOG_BYTES;
      if (backedUp) {
        if (!subscriber.missed && frames.length > 0) {
          subscriber.missed = true;
          if (!deliver(subscriber, { type: "missed", seq: ++seq })) dead.push(subscriber);
        }
        continue;
      }
      if (subscriber.needsSnapshot || subscriber.missed) {
        subscriber.needsSnapshot = false;
        subscriber.missed = false;
        if (!deliver(subscriber, { type: "snapshot", seq: ++seq, tabs: snapshotTabs(next) })
          || (options.seen && !deliver(subscriber, attentionFrame()))) dead.push(subscriber);
        continue;
      }
      for (const frame of frames) {
        if (!deliver(subscriber, frame)) {
          dead.push(subscriber);
          break;
        }
      }
    }
    dead.forEach(evict);
  }

  function tick(): Promise<void> {
    ticking ??= tickNow().catch((error: unknown) => {
      console.warn("[gateway] terminal event poll failed", error instanceof Error ? error.name : "unknown_error");
    }).finally(() => { ticking = null; });
    return ticking;
  }

  return {
    subscribe(subscriber) {
      if (stopped) throw new Error("Terminal events are shutting down");
      if (subscribers.size >= MAX_SUBSCRIBERS) throw new Error("Terminal event capacity reached");
      const state: SubscriberState = { ...subscriber, lastTouched: now(), needsSnapshot: true, missed: false };
      subscribers.add(state);
      startTimers();
      void tick();
      return {
        touch: () => { state.lastTouched = now(); },
        close: () => { if (subscribers.delete(state) && subscribers.size === 0) stopTimers(); },
        markSeen: (ref) => {
          const key = terminalRefKey(ref);
          if (!options.seen || !facts?.has(key)) return false;
          options.seen.mark(key, now(), done.get(key)?.finished === true);
          if (refreshAttention()) {
            const frame = attentionFrame();
            const dead: SubscriberState[] = [];
            for (const subscriber of subscribers) {
              if (subscriber.needsSnapshot || subscriber.missed) continue;
              // A backed-up subscriber gets a fresh snapshot (and attention) once it drains.
              if ((subscriber.backlog?.() ?? 0) > MAX_BACKLOG_BYTES) subscriber.missed = true;
              else if (!deliver(subscriber, frame)) dead.push(subscriber);
            }
            dead.forEach(evict);
          }
          return true;
        },
      };
    },
    tick,
    size: () => subscribers.size,
    shutdown() {
      stopped = true;
      for (const subscriber of [...subscribers]) {
        deliver(subscriber, { type: "shutdown", seq: ++seq });
        evict(subscriber);
      }
      stopTimers();
    },
  };
}
