/** Busy state and next scheduled time for the platform idle sleeper (ENG-520). */
import { sql, type Kysely } from "kysely";
import type { RuntimeBusyReason, RuntimeLifecycleStatus } from "@matrix-os/contracts/runtime-lifecycle";
import type { ChatDatabase } from "../chat/database.js";
import { ownerBotExecutor } from "../bots/instantiation.js";
import { createBotRoutinesRepository } from "../bots/repositories/routines.js";

export const LIFECYCLE_SOURCE_TIMEOUT_MS = 2_000;
/** Runs parked on the owner longer than this no longer keep the computer awake. */
export const WAITING_RUN_FRESH_MS = 24 * 60 * 60_000;

export interface ChatRunActivity {
  hasActiveRun(now: Date): Promise<boolean>;
}

export interface LifecycleSources {
  chatRuns?: ChatRunActivity;
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
      const row = await db.selectFrom("chat_runs").select(sql<number>`1`.as("one"))
        .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
        .where((eb) => eb.or([
          eb("status", "in", ["accepted", "running"]),
          eb("updated_at", ">", freshAfter),
        ]))
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

/**
 * Compose the gateway's live sources per request. The owner database and bot
 * services start after route registration, so callers pass their current values.
 * Routine tables exist only once bot services bootstrapped them.
 */
export function gatewayLifecycleSources(deps: {
  chatDb: Kysely<ChatDatabase> | null;
  routinesEnabled: boolean;
  terminals: LifecycleSources["terminals"];
  backgroundAgents: LifecycleSources["backgroundAgents"];
  cron: LifecycleSources["cron"];
}): LifecycleSources {
  const { chatDb } = deps;
  const routines = chatDb && deps.routinesEnabled ? createBotRoutinesRepository(ownerBotExecutor(chatDb)) : undefined;
  return {
    ...(chatDb ? { chatRuns: createChatRunActivity(chatDb) } : {}),
    ...(routines ? {
      routines: {
        hasActiveFire: (now: Date) => routines.hasActiveFire(now.toISOString()),
        nextFireAt: (now: Date) => routines.nextFireAt(now.toISOString()),
      },
    } : {}),
    terminals: deps.terminals,
    backgroundAgents: deps.backgroundAgents,
    cron: deps.cron,
  };
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
  const { chatRuns, terminals, backgroundAgents, routines, cron } = sources;

  const busyChecks: Array<[RuntimeBusyReason, (() => boolean | Promise<boolean>) | undefined]> = [
    ["chat_run", chatRuns && (() => chatRuns.hasActiveRun(now))],
    ["terminal_attached", terminals && (() => terminals.attachedViewerCount() > 0)],
    ["background_agent", backgroundAgents && (() => backgroundAgents.anyRunning())],
    ["routine", routines && (() => routines.hasActiveFire(now))],
  ];
  const scheduleChecks: Array<[string, (() => Date | null | Promise<Date | null>) | undefined]> = [
    ["cron", cron && (() => cron.nextRunAt())],
    ["routine schedule", routines && (() => routines.nextFireAt(now))],
  ];

  const [busyResults, scheduleResults] = await Promise.all([
    Promise.allSettled(busyChecks.map(([, check]) => check ? bounded(check, timeoutMs) : Promise.resolve(false))),
    Promise.allSettled(scheduleChecks.map(([, check]) => check ? bounded(check, timeoutMs) : Promise.resolve(null))),
  ]);

  const busyReasons: RuntimeBusyReason[] = [];
  let unknown = false;
  busyResults.forEach((result, index) => {
    const [reason] = busyChecks[index]!;
    if (result.status === "fulfilled") {
      if (result.value) busyReasons.push(reason);
      return;
    }
    unknown = true;
    logSourceFailure(reason, result.reason);
  });
  if (unknown) busyReasons.push("unknown");

  let scheduleFailed = false;
  let earliest: number | null = null;
  scheduleResults.forEach((result, index) => {
    if (result.status === "rejected") {
      scheduleFailed = true;
      logSourceFailure(scheduleChecks[index]![0], result.reason);
      return;
    }
    const at = result.value?.getTime();
    // Past times are either firing now or held (for example awaiting review); neither is a wake time.
    if (at === undefined || !Number.isFinite(at) || at <= now.getTime()) return;
    if (earliest === null || at < earliest) earliest = at;
  });

  return {
    busy: busyReasons.length > 0,
    busyReasons,
    nextScheduledAt: earliest === null ? null : new Date(earliest).toISOString(),
    // A partial minimum could fall after a job that was not read, so the caller must not suspend on it.
    scheduleComplete: !scheduleFailed,
  };
}
