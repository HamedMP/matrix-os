/**
 * Company Brain change hooks: the in-process bus that tells the derived features (search, graph, brief) that a
 * scope's documents or claims changed or that the scope was erased. emit never throws and never waits; events queue
 * per scope and coalesce (ids merge, an overflow becomes null); one worker runs the queued scopes one at a time,
 * after the emitting request has its result, calling listeners in BRAIN_HOOK_REACTIONS order, each bounded by
 * BRAIN_HOOK_LISTENER_BUDGET_MS. A hook is only a nudge: a lost or failed one is repaired by the next refresh, and an
 * event emitted after close (a sync that commits while the gateway shuts down) is repaired by the next start's index
 * catch-up (api/index-repair.ts).
 */
import {
  BRAIN_HOOK_DOCUMENT_IDS_MAX, BRAIN_HOOK_LISTENER_BUDGET_MS, BRAIN_HOOK_QUEUE_MAX_SCOPES, BRAIN_HOOK_REACTIONS,
  type BrainChangeEvent, type BrainChangeHooks, type BrainChangeListener, type BrainChangeListenerName,
} from "./contracts.js";
import type { BrainScopeKey } from "./types.js";

/** Queued scopes past which a new scope's change events are dropped (an erase is always kept). */
export const BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES = BRAIN_HOOK_QUEUE_MAX_SCOPES * 8;

export interface BrainChangeHooksDeps {
  readonly listeners: readonly BrainChangeListener[];
  /** Tests only: per-listener budget; default BRAIN_HOOK_LISTENER_BUDGET_MS. */
  readonly listenerBudgetMs?: number;
}

type ChangeEvent = Exclude<BrainChangeEvent, { readonly type: "scope_erased" }>;

interface ScopeQueue {
  /** At most one event per type: an erase first (it supersedes what came before it), then documents and claims. */
  events: BrainChangeEvent[];
}

function scopeKey(scope: BrainScopeKey): string {
  return JSON.stringify([scope.ownerId, scope.scopeId]);
}

function boundedIds(ids: readonly string[] | null): readonly string[] | null {
  if (ids === null) return null;
  const unique = [...new Set(ids)];
  return unique.length > BRAIN_HOOK_DOCUMENT_IDS_MAX ? null : unique;
}

function mergeIds(a: readonly string[] | null, b: readonly string[] | null): readonly string[] | null {
  return a === null || b === null ? null : boundedIds([...a, ...b]);
}

function merge(older: ChangeEvent, newer: ChangeEvent): ChangeEvent {
  const documentIds = mergeIds(older.documentIds, newer.documentIds);
  if (older.type === "documents_changed" && newer.type === "documents_changed") {
    const sourceId = older.sourceId === newer.sourceId ? newer.sourceId : null;
    return { ...newer, sourceId, documentIds };
  }
  return { ...newer, documentIds };
}

/** The same event with its ids dropped to null: listeners then run a bounded catch-up. */
function collapse(event: BrainChangeEvent): BrainChangeEvent {
  return event.type === "scope_erased" ? event : { ...event, documentIds: null };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createBrainChangeHooks(deps: BrainChangeHooksDeps): BrainChangeHooks {
  const listeners = new Map<BrainChangeListenerName, BrainChangeListener>();
  for (const listener of deps.listeners) {
    if (listeners.has(listener.name)) throw new Error(`Duplicate brain change listener: ${listener.name}`);
    listeners.set(listener.name, listener);
  }
  const budgetMs = deps.listenerBudgetMs ?? BRAIN_HOOK_LISTENER_BUDGET_MS;
  const queue = new Map<string, ScopeQueue>();
  const stop = new AbortController();
  let closed = false;
  let worker: Promise<void> | null = null;

  async function runListener(listener: BrainChangeListener, event: BrainChangeEvent): Promise<void> {
    const signal = AbortSignal.any([AbortSignal.timeout(budgetMs), stop.signal]);
    // A listener that throws before returning its promise is a failure like any other, never a stalled queue.
    const run = Promise.resolve().then(() => listener.handle(event, signal)).catch((error: unknown) => {
      console.error(`[brain-hooks] ${listener.name} failed:`, errorName(error));
    });
    // A listener that ignores its signal is left behind at the budget instead of holding up the queue. The signal is
    // never aborted yet here: drain checks the stop signal first and the budget starts with this call.
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      void run.then(resolve);
    });
  }

  /** Runs queued scopes until the queue is empty; worker is cleared in the same step, so no emit is ever missed. */
  async function drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      const next = queue.entries().next();
      if (next.done === true || stop.signal.aborted) {
        worker = null;
        return;
      }
      const [key, entry] = next.value;
      queue.delete(key);
      for (const event of entry.events) {
        for (const name of BRAIN_HOOK_REACTIONS[event.type]) {
          const listener = listeners.get(name);
          if (listener === undefined || stop.signal.aborted) continue;
          await runListener(listener, event);
        }
      }
    }
  }

  /** Starts the worker unless one runs; emit is the only caller and stops calling once closed. */
  function schedule(): void {
    if (worker === null) worker = drain();
  }

  function enqueue(event: BrainChangeEvent): boolean {
    const key = scopeKey(event.scope);
    let entry = queue.get(key);
    if (entry === undefined) {
      if (queue.size >= BRAIN_HOOK_QUEUE_HARD_MAX_SCOPES && event.type !== "scope_erased") return false;
      if (queue.size >= BRAIN_HOOK_QUEUE_MAX_SCOPES) {
        for (const oldest of queue.values()) {
          oldest.events = oldest.events.map(collapse);
          break;
        }
      }
      entry = { events: [] };
      queue.set(key, entry);
    }
    if (event.type === "scope_erased") {
      entry.events = [event];
      return true;
    }
    const index = entry.events.findIndex((queued) => queued.type === event.type);
    const bounded: ChangeEvent = { ...event, documentIds: boundedIds(event.documentIds) };
    if (index === -1) entry.events.push(bounded);
    else entry.events[index] = merge(entry.events[index] as ChangeEvent, bounded);
    return true;
  }

  return {
    emit(event) {
      if (closed) {
        console.warn("[brain-hooks] event after close dropped:", event.type);
        return;
      }
      if (!enqueue(event)) {
        console.warn("[brain-hooks] queue full; event dropped until the next refresh:", event.type);
        return;
      }
      schedule();
    },
    async close(deadlineMs) {
      closed = true;
      const deadline = new Promise<"deadline">((resolve) => {
        const timer = setTimeout(() => resolve("deadline"), Math.max(0, deadlineMs));
        timer.unref();
      });
      while (worker !== null) {
        const current = worker;
        if (await Promise.race([current.then(() => "done" as const), deadline]) === "deadline") break;
      }
      if (queue.size > 0 || worker !== null) {
        console.warn("[brain-hooks] closed before the queue drained; the next refresh repairs it");
      }
      stop.abort();
      queue.clear();
    },
  };
}

/** Erases one scope's core rows, then tells the features to drop their scope-level rows. */
export async function eraseBrainScope(
  repository: { eraseScope(scope: BrainScopeKey): Promise<void> },
  hooks: BrainChangeHooks,
  scope: BrainScopeKey,
  now: () => Date = () => new Date(),
): Promise<void> {
  await repository.eraseScope(scope);
  hooks.emit({ type: "scope_erased", scope, at: now().toISOString() });
}
