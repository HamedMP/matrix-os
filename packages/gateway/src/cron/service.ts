import cron from "node-cron";
import type { CronJob } from "./types.js";
import type { CronStore } from "./store.js";

export interface CronServiceConfig {
  store: CronStore;
  onTrigger: (job: CronJob) => void;
  /**
   * Startup catch-up runs and due one-shots wait for this to settle (for example channel adapters
   * starting), so a reminder is not sent into a channel that cannot deliver it yet.
   */
  catchUpAfter?: Promise<unknown>;
}

export interface CronService {
  start(): void;
  stop(): void;
  addJob(job: CronJob): void;
  removeJob(jobId: string): boolean;
  listJobs(): CronJob[];
  /** Earliest upcoming run across scheduled jobs, or null when none is scheduled or the service is stopped. */
  nextRunAt(): Date | null;
}

/** How often a running service looks for occurrences that came due without firing (e.g. after a VM resume). */
export const CRON_CATCH_UP_CHECK_MS = 30_000;
/** An occurrence counts as missed only once it is this far overdue, so a timer that is merely firing late is not doubled. */
export const CRON_CATCH_UP_GRACE_MS = 30_000;
/** Wall-clock advance beyond the monotonic clock between two checks that counts as a resume from sleep. */
export const CRON_CLOCK_JUMP_TOLERANCE_MS = 5_000;

interface TimerEntry {
  handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  /** Epoch ms of the next run; interval entries advance on every tick. */
  nextAt: number;
}

interface CronEntry {
  task: cron.ScheduledTask;
  /** Epoch ms of the occurrence expected next, captured when scheduled and after every run. */
  nextAt: number | null;
}

interface CronTimeMatcher {
  getNextMatch(date: Date): Date;
}

/** node-cron 4 keeps its matcher as a public field on the task; the ScheduledTask type does not declare it. */
function cronMatcher(task: cron.ScheduledTask): CronTimeMatcher | null {
  const matcher: unknown = (task as unknown as { timeMatcher?: unknown }).timeMatcher;
  if (typeof matcher !== "object" || matcher === null) return null;
  if (typeof (matcher as { getNextMatch?: unknown }).getNextMatch !== "function") return null;
  return matcher as CronTimeMatcher;
}

function epochMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function createCronService(config: CronServiceConfig): CronService {
  const { store, onTrigger } = config;
  let catchUpGateOpen = config.catchUpAfter === undefined;
  const catchUpGate = config.catchUpAfter?.then(
    () => { catchUpGateOpen = true; },
    (err: unknown) => {
      catchUpGateOpen = true;
      console.warn("[cron] catch-up gate failed; running catch-up anyway:", err instanceof Error ? err.name : "UnknownError");
    },
  );
  // Incremented on every start/stop so a deferred catch-up from an earlier start never runs.
  let generation = 0;
  // Both maps hold one entry per scheduled job in the store; clearJob removes them on removal/stop.
  const timers = new Map<string, TimerEntry>();
  const cronTasks = new Map<string, CronEntry>();
  let catchUpCheck: ReturnType<typeof setInterval> | null = null;
  // Wall and monotonic readings at the previous check, used to detect a resume from a memory snapshot.
  let lastCheckWall = 0;
  let lastCheckMono = 0;
  let started = false;

  /** Starts one run: records lastRunAt (persisted asynchronously), then triggers. */
  function runJob(job: CronJob): void {
    void store.recordRun(job.id, new Date().toISOString());
    try {
      onTrigger(job);
    } catch (err: unknown) {
      console.warn(`[cron] Job ${job.id} trigger failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  function runOnce(job: CronJob, entry: TimerEntry): void {
    if (!catchUpGateOpen || timers.get(job.id) !== entry) return;
    clearJob(job.id);
    runJob(job);
    store.remove(job.id);
  }

  /** True when an occurrence came due after the job's persisted lastRunAt. A job that never ran is never due. */
  function missedSinceLastRun(job: CronJob, now: number): boolean {
    const lastRunAt = epochMs(job.lastRunAt);
    if (lastRunAt === null) return false;
    switch (job.schedule.type) {
      case "interval":
        return lastRunAt + job.schedule.intervalMs <= now;
      case "cron": {
        const entry = cronTasks.get(job.id);
        const matcher = entry ? cronMatcher(entry.task) : null;
        if (matcher === null) return false;
        const next = epochMs(matcher.getNextMatch(new Date(lastRunAt)));
        return next !== null && next <= now;
      }
      case "once":
        // One-shots use their scheduled time rather than lastRunAt.
        return false;
    }
  }

  /**
   * Periodic check. Normally it runs, once, any job more than the grace period past its expected
   * occurrence. When the wall clock advanced well beyond the monotonic clock since the last check
   * (a memory-snapshot resume), every pending timer is late by the pause, so every job is
   * rescheduled from now at once: upcoming occurrences fire on time and overdue ones run once.
   */
  function checkSchedules(): void {
    const wall = Date.now();
    const mono = performance.now();
    const jumped = wall - lastCheckWall - (mono - lastCheckMono) > CRON_CLOCK_JUMP_TOLERANCE_MS;
    lastCheckWall = wall;
    lastCheckMono = mono;
    const overdueBefore = jumped ? wall : wall - CRON_CATCH_UP_GRACE_MS;

    for (const job of store.list()) {
      const timer = timers.get(job.id);
      const nextAt = timer?.nextAt ?? cronTasks.get(job.id)?.nextAt ?? null;
      const overdue = nextAt !== null && nextAt <= overdueBefore;
      if (!overdue && !jumped) continue;
      if (job.schedule.type === "once") {
        if (overdue && timer) runOnce(job, timer);
        else scheduleJob(job);
        continue;
      }
      if (!overdue) {
        // Keep the expected time; only the late timer is replaced.
        scheduleJob(job, nextAt ?? undefined);
        continue;
      }
      // Rescheduling first drops the late timer so the occurrence cannot fire a second time.
      scheduleJob(job, job.schedule.type === "interval" ? wall + job.schedule.intervalMs : undefined);
      runJob(job);
    }
  }

  /** `intervalFirstAt` (epoch ms) overrides an interval job's first fire; otherwise lastRunAt + interval, or now + interval. */
  function scheduleJob(job: CronJob, intervalFirstAt?: number): void {
    clearJob(job.id);

    switch (job.schedule.type) {
      case "interval": {
        const intervalMs = job.schedule.intervalMs;
        const now = Date.now();
        const afterLastRun = (epochMs(job.lastRunAt) ?? Number.NaN) + intervalMs;
        const firstAt = intervalFirstAt ?? (afterLastRun > now ? afterLastRun : now + intervalMs);
        const tick = (): void => {
          if (timers.get(job.id) !== entry) return;
          entry.nextAt = Date.now() + intervalMs;
          runJob(job);
        };
        const entry: TimerEntry = {
          nextAt: firstAt,
          handle: setTimeout(() => {
            if (timers.get(job.id) !== entry) return;
            entry.handle = setInterval(tick, intervalMs);
            tick();
          }, Math.max(0, firstAt - now)),
        };
        timers.set(job.id, entry);
        break;
      }

      case "once": {
        const at = new Date(job.schedule.at).getTime();
        const safeDelay = Math.max(0, at - Date.now());
        const entry: TimerEntry = {
          nextAt: Number.isFinite(at) ? at : Date.now(),
          handle: setTimeout(() => runOnce(job, entry), safeDelay),
        };
        timers.set(job.id, entry);
        break;
      }

      case "cron": {
        if (!cron.validate(job.schedule.cron)) break;
        const entry: CronEntry = {
          task: cron.schedule(job.schedule.cron, () => {
            // node-cron runs this from a queued inner timeout that task.stop() does not cancel,
            // so a callback from a task replaced by a reschedule must not run the job again.
            if (cronTasks.get(job.id) !== entry) return;
            entry.nextAt = epochMs(entry.task.getNextRun());
            runJob(job);
          }),
          nextAt: null,
        };
        entry.nextAt = epochMs(entry.task.getNextRun());
        cronTasks.set(job.id, entry);
        break;
      }
    }
  }

  function clearJob(jobId: string): void {
    const timer = timers.get(jobId);
    if (timer !== undefined) {
      clearInterval(timer.handle as ReturnType<typeof setInterval>);
      clearTimeout(timer.handle as ReturnType<typeof setTimeout>);
      timers.delete(jobId);
    }
    const entry = cronTasks.get(jobId);
    if (entry) {
      entry.task.stop();
      cronTasks.delete(jobId);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      generation += 1;
      const startGeneration = generation;
      const now = Date.now();
      const missed: CronJob[] = [];
      // Re-read cron.json: the gateway restarts the service when another writer changes it.
      store.load();
      for (const job of store.list()) {
        scheduleJob(job);
        // At most one catch-up run per job, however many occurrences were missed.
        if (missedSinceLastRun(job, now)) missed.push(job);
      }
      if (catchUpGateOpen || !catchUpGate) {
        for (const job of missed) runJob(job);
      } else {
        void catchUpGate.then(() => {
          if (generation !== startGeneration) return;
          // Re-read: a job removed or already run since start must not run again.
          const nowAfter = Date.now();
          for (const job of store.list()) {
            if (job.schedule.type === "once") {
              const entry = timers.get(job.id);
              if (entry && entry.nextAt <= nowAfter) runOnce(job, entry);
            } else if (missed.some((m) => m.id === job.id) && missedSinceLastRun(job, nowAfter)) {
              runJob(job);
            }
          }
        });
      }
      lastCheckWall = Date.now();
      lastCheckMono = performance.now();
      catchUpCheck = setInterval(checkSchedules, CRON_CATCH_UP_CHECK_MS);
      catchUpCheck.unref?.();
    },

    stop() {
      started = false;
      generation += 1;
      if (catchUpCheck !== null) {
        clearInterval(catchUpCheck);
        catchUpCheck = null;
      }
      for (const [id] of timers) clearJob(id);
      for (const [id] of cronTasks) clearJob(id);
      timers.clear();
      cronTasks.clear();
    },

    addJob(job: CronJob) {
      store.add(job);
      if (started) scheduleJob(job);
    },

    removeJob(jobId: string): boolean {
      clearJob(jobId);
      return store.remove(jobId);
    },

    listJobs(): CronJob[] {
      return store.list();
    },

    nextRunAt(): Date | null {
      if (!started) return null;
      let earliest: number | null = null;
      for (const timer of timers.values()) {
        if (earliest === null || timer.nextAt < earliest) earliest = timer.nextAt;
      }
      for (const { task } of cronTasks.values()) {
        const next = task.getNextRun()?.getTime();
        if (next !== undefined && Number.isFinite(next) && (earliest === null || next < earliest)) earliest = next;
      }
      return earliest === null ? null : new Date(earliest);
    },
  };
}
