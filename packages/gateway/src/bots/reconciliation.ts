/**
 * Startup and periodic reconciliation of bot creations (spec 536). Each tick
 * takes a bounded batch of operations that stopped before `active` and were
 * last touched a while ago, and finishes them with their fixed IDs. After
 * repeated failures an operation is left for a retried request instead of
 * being retried forever. Ticks never overlap, and stopping clears the timer
 * and waits for a tick in progress.
 */
import type { BotInstantiation } from "./instantiation.js";
import type { BotOperation, BotOperationsRepository } from "./repositories/operations.js";

const DEFAULT_INTERVAL_MS = 60_000;
/** Leaves operations a live request may still be finishing. */
const DEFAULT_STALE_AFTER_MS = 60_000;
const BATCH = 25;
const MAX_ATTEMPTS = 5;

export function createBotOperationReconciler(deps: {
  operations: Pick<BotOperationsRepository, "listUnfinished">;
  instantiation: Pick<BotInstantiation, "resume">;
  now?: () => Date;
  intervalMs?: number;
  staleAfterMs?: number;
}) {
  const now = () => deps.now?.() ?? new Date();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  async function reconcile(operation: BotOperation): Promise<void> {
    try {
      await deps.instantiation.resume(operation);
    } catch (error: unknown) {
      console.warn("[bots] creation reconciliation failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  async function tick(): Promise<void> {
    const olderThan = new Date(now().getTime() - (deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)).toISOString();
    const unfinished = await deps.operations.listUnfinished({ olderThan, limit: BATCH, maxAttempts: MAX_ATTEMPTS });
    for (const operation of unfinished) {
      if (stopped) return;
      await reconcile(operation);
    }
  }

  function runOnce(): Promise<void> {
    running ??= tick().catch((error: unknown) => {
      console.warn("[bots] creation reconciliation unavailable:", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { running = undefined; });
    return running;
  }

  return {
    /** Runs one pass now, then on an interval. */
    async start(): Promise<void> {
      stopped = false;
      await runOnce();
      if (stopped || timer) return;
      timer = setInterval(() => { void runOnce(); }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref();
    },
    runOnce,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

export type BotOperationReconciler = ReturnType<typeof createBotOperationReconciler>;
