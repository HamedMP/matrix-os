/** Busy state and next scheduled time for the platform idle sleeper (ENG-520). */
import { sql, type Kysely } from "kysely";
import type { RuntimeBusyReason, RuntimeLifecycleStatus } from "@matrix-os/contracts/runtime-lifecycle";
import type { ChatDatabase } from "../chat/database.js";
import { ownerBotExecutor } from "../bots/instantiation.js";
import { createBotRoutinesRepository } from "../bots/repositories/routines.js";

export const LIFECYCLE_SOURCE_TIMEOUT_MS = 2_000;
/** Server-side cap on each owner-database lifecycle read, so an abandoned read cannot hold a pooled connection. */
export const LIFECYCLE_STATEMENT_TIMEOUT_MS = 2_000;
/** Runs parked on the owner longer than this no longer keep the computer awake. */
export const WAITING_RUN_FRESH_MS = 24 * 60 * 60_000;

export interface ChatRunActivity {
  hasActiveRun(now: Date): Promise<boolean>;
}

export interface LifecycleSources {
  chatRuns?: ChatRunActivity;
  /** Messages answered through the dispatcher (`/api/message`, channels) create no chat_runs row. */
  dispatcher?: { readonly activeCount: number; readonly queueLength: number };
  terminals?: { attachedViewerCount(): number };
  backgroundAgents?: { anyRunning(): Promise<boolean> };
  routines?: {
    hasActiveFire(now: Date): Promise<boolean>;
    nextFireAt(now: Date): Promise<Date | null>;
  };
  /** The heartbeat is deliberately absent: it runs only while awake and never schedules a wake. */
  cron?: { nextRunAt(): Date | null };
  now?: () => Date;
  timeoutMs?: number;
  /** Shared across requests so a read that outlived its timeout is not started again while it is still pending. */
  readGuard?: LifecycleReadGuard;
}

/** Runs `operation` inside a transaction whose statements the server cancels after LIFECYCLE_STATEMENT_TIMEOUT_MS. */
async function withStatementTimeout<DB, T>(db: Kysely<DB>, operation: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL statement_timeout = ${sql.lit(LIFECYCLE_STATEMENT_TIMEOUT_MS)}`.execute(trx);
    return operation(trx);
  });
}

class LifecycleSourcePendingError extends Error {
  constructor() {
    super("Lifecycle source read still pending");
    this.name = "LifecycleSourcePendingError";
  }
}

export interface LifecycleReadGuard {
  run<T>(key: string, operation: () => T | Promise<T>): Promise<T>;
}

/**
 * Single-flight per source key. A key whose previous read is still running (even after the caller
 * stopped waiting on it) rejects at once, so repeated polls cannot stack reads on the owner pool.
 * Keys are the fixed busy/schedule source names, so the record stays bounded.
 */
export function createLifecycleReadGuard(): LifecycleReadGuard {
  const pending: Record<string, true> = {};
  return {
    run(key, operation) {
      if (pending[key]) return Promise.reject(new LifecycleSourcePendingError());
      pending[key] = true;
      const result = Promise.resolve().then(operation);
      const clear = () => { delete pending[key]; };
      result.then(clear, clear);
      return result;
    },
  };
}

/**
 * `accepted`/`running` always count. Waiting runs count only while fresh, so an
 * abandoned approval cannot pin a computer awake. Bounded to one row; the
 * status predicate matches the partial index idx_chat_runs_one_active.
 */
export function createChatRunActivity(db: Kysely<ChatDatabase>): ChatRunActivity {
  return {
    async hasActiveRun(now) {
      const freshAfter = new Date(now.getTime() - WAITING_RUN_FRESH_MS).toISOString();
      const row = await withStatementTimeout(db, (trx) => trx.selectFrom("chat_runs").select(sql<number>`1`.as("one"))
        .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
        .where((eb) => eb.or([
          eb("status", "in", ["accepted", "running"]),
          eb("updated_at", ">", freshAfter),
        ]))
        .limit(1)
        .executeTakeFirst());
      return row !== undefined;
    },
  };
}

/** A configured source whose service has not started (or failed to start); reading it reports unknown. */
export class LifecycleSourceNotReadyError extends Error {
  constructor() {
    super("Lifecycle source not ready");
    this.name = "LifecycleSourceNotReadyError";
  }
}

const notReady = (): Promise<never> => Promise.reject(new LifecycleSourceNotReadyError());

/**
 * Compose the gateway's live sources per request. The owner database and bot
 * services start after route registration, so callers pass their current values.
 * Each owner-database source is tri-state:
 * - ready: read it;
 * - not applicable (no owner database configured, or bot services started without routines): omit it;
 * - not ready (configured but not started yet, or failed to start): a source that rejects, so the
 *   status reports busy `unknown` and, for routines, an incomplete schedule.
 */
export function gatewayLifecycleSources(deps: {
  /** DATABASE_URL is set, so chat runs and routines are expected to exist. */
  ownerDatabaseConfigured: boolean;
  chatDb: Kysely<ChatDatabase> | null;
  /** null until bot services have started; then whether they include routines. */
  bots: { routines: boolean } | null;
  terminals: LifecycleSources["terminals"];
  backgroundAgents: LifecycleSources["backgroundAgents"];
  cron: LifecycleSources["cron"];
  dispatcher: LifecycleSources["dispatcher"];
  readGuard?: LifecycleReadGuard;
}): LifecycleSources {
  const { chatDb, bots, ownerDatabaseConfigured } = deps;
  const sources: LifecycleSources = {
    terminals: deps.terminals, backgroundAgents: deps.backgroundAgents, cron: deps.cron, dispatcher: deps.dispatcher,
  };
  if (deps.readGuard) sources.readGuard = deps.readGuard;
  if (chatDb) sources.chatRuns = createChatRunActivity(chatDb);
  else if (ownerDatabaseConfigured) sources.chatRuns = { hasActiveRun: notReady };
  if (chatDb && bots?.routines) {
    // Bot services bootstrap the routine tables before they are assigned, so the repository is safe to read.
    const read = <T>(operation: (routines: ReturnType<typeof createBotRoutinesRepository>) => Promise<T>) =>
      withStatementTimeout(chatDb, (trx) => operation(createBotRoutinesRepository(ownerBotExecutor(trx))));
    sources.routines = {
      hasActiveFire: (now: Date) => read((routines) => routines.hasActiveFire(now.toISOString())),
      nextFireAt: (now: Date) => read((routines) => routines.nextFireAt(now.toISOString())),
    };
  } else if (ownerDatabaseConfigured && (bots === null || !chatDb)) {
    sources.routines = { hasActiveFire: notReady, nextFireAt: notReady };
  }
  return sources;
}

class LifecycleSourceTimeoutError extends Error {
  constructor() {
    super("Lifecycle source timed out");
    this.name = "LifecycleSourceTimeoutError";
  }
}

async function bounded<T>(operation: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LifecycleSourceTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function logSourceFailure(source: string, error: unknown): void {
  console.warn(`[lifecycle] ${source} unavailable:`, error instanceof Error ? error.name : "UnknownError");
}

/** Never throws: a failed busy source reports `unknown` (stay awake); a failed schedule source clears `scheduleComplete`. */
export async function readLifecycleStatus(sources: LifecycleSources): Promise<RuntimeLifecycleStatus> {
  const now = (sources.now ?? (() => new Date()))();
  const timeoutMs = sources.timeoutMs ?? LIFECYCLE_SOURCE_TIMEOUT_MS;
  const { chatRuns, dispatcher, terminals, backgroundAgents, routines, cron, readGuard } = sources;
  const guarded = <T>(key: string, check: () => T | Promise<T>) => () => readGuard ? readGuard.run(key, check) : check();

  const busyChecks: Array<[RuntimeBusyReason, (() => boolean | Promise<boolean>) | undefined]> = [
    ["chat_run", chatRuns && (() => chatRuns.hasActiveRun(now))],
    ["chat_run", dispatcher && (() => dispatcher.activeCount > 0 || dispatcher.queueLength > 0)],
    ["terminal_attached", terminals && (() => terminals.attachedViewerCount() > 0)],
    ["background_agent", backgroundAgents && (() => backgroundAgents.anyRunning())],
    ["routine", routines && (() => routines.hasActiveFire(now))],
  ];
  const scheduleChecks: Array<[string, (() => Date | null | Promise<Date | null>) | undefined]> = [
    ["cron", cron && (() => cron.nextRunAt())],
    ["routine schedule", routines && (() => routines.nextFireAt(now))],
  ];

  const [busyResults, scheduleResults] = await Promise.all([
    Promise.allSettled(busyChecks.map(([reason, check], index) =>
      check ? bounded(guarded(`busy:${index}:${reason}`, check), timeoutMs) : Promise.resolve(false))),
    Promise.allSettled(scheduleChecks.map(([name, check]) =>
      check ? bounded(guarded(`schedule:${name}`, check), timeoutMs) : Promise.resolve(null))),
  ]);

  const busyReasons: RuntimeBusyReason[] = [];
  let unknown = false;
  busyResults.forEach((result, index) => {
    const [reason] = busyChecks[index]!;
    if (result.status === "fulfilled") {
      if (result.value && !busyReasons.includes(reason)) busyReasons.push(reason);
      return;
    }
    unknown = true;
    logSourceFailure(reason, result.reason);
  });
  if (unknown) busyReasons.push("unknown");

  let scheduleIncomplete = false;
  let earliest: number | null = null;
  scheduleResults.forEach((result, index) => {
    const [name] = scheduleChecks[index]!;
    if (result.status === "rejected") {
      scheduleIncomplete = true;
      logSourceFailure(name, result.reason);
      return;
    }
    const at = result.value?.getTime();
    if (at === undefined || !Number.isFinite(at)) return;
    if (at <= now.getTime()) {
      // A due cron job can hide later deadlines until the scheduler handles it.
      if (name === "cron") scheduleIncomplete = true;
      return;
    }
    if (earliest === null || at < earliest) earliest = at;
  });

  return {
    busy: busyReasons.length > 0,
    busyReasons,
    nextScheduledAt: earliest === null ? null : new Date(earliest).toISOString(),
    // A partial minimum could fall after a job that was not read, so the caller must not suspend on it.
    scheduleComplete: !scheduleIncomplete,
  };
}
