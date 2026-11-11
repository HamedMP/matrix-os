import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import type { TerminalAgentStatusSource } from "./status-source.js";
import { terminalRefKey } from "./status-source.js";
import type { TerminalAgentStatus } from "./verbs.js";

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;
const MAX_SUBSCRIBERS = 64;
const MAX_BACKLOG_BYTES = 1024 * 1024;

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

export type TerminalEventFrame =
  | { type: "snapshot"; seq: number; tabs: TerminalTabFacts[] }
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

export interface TerminalEventHub {
  subscribe(subscriber: TerminalEventSubscriber): { touch(): void; close(): void };
  tick(): Promise<void>;
  size(): number;
  shutdown(): void;
}

function factsFrom(workspaces: TerminalWorkspace[], statuses: ReadonlyMap<string, {
  status: TerminalAgentStatus; message?: string; reportedAt: string;
}>): Map<string, TerminalTabFacts> {
  const facts = new Map<string, TerminalTabFacts>();
  for (const workspace of workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.accessScope !== "owner") continue;
      const ref = { workspaceId: workspace.id, tabId: tab.id };
      const finished = tab.status === "exited" || tab.status === "failed";
      const status = finished ? undefined : statuses.get(terminalRefKey(ref));
      facts.set(terminalRefKey(ref), {
        ref,
        name: tab.name,
        cwd: tab.cwd,
        ...(workspace.scope === "project" ? { projectId: workspace.projectId } : {}),
        state: finished ? "finished" : "live",
        ...(finished ? { exitCode: tab.exitCode ?? null } : {}),
        ...(status ? { agentStatus: status.status, statusAt: status.reportedAt } : {}),
        ...(status?.message ? { statusMessage: status.message } : {}),
      });
    }
  }
  return facts;
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
}): TerminalEventHub {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const subscribers = new Set<SubscriberState>();
  let facts: Map<string, TerminalTabFacts> | null = null;
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
  }

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
    const next = factsFrom(workspaces, statuses);
    const events = facts ? diff(facts, next) : [];
    facts = next;
    const frames = events.map((event): TerminalEventFrame => ({ type: "event", seq: ++seq, event }));
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
        if (!deliver(subscriber, { type: "snapshot", seq: ++seq, tabs: [...next.values()] })) dead.push(subscriber);
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
