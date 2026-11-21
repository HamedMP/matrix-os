import cron from "node-cron";
import type { CronJob } from "./types.js";
import type { CronStore } from "./store.js";

export interface CronServiceConfig {
  store: CronStore;
  onTrigger: (job: CronJob) => void;
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
  // Both maps hold one entry per scheduled job in the store; clearJob removes them on removal/stop.
  const timers = new Map<string, TimerEntry>();
  const cronTasks = new Map<string, CronEntry>();
  let catchUpCheck: ReturnType<typeof setInterval> | null = null;
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
        // A past-due once job already fires as soon as it is scheduled.
        return false;
    }
  }

  /** Runs, once, every job whose expected occurrence passed without firing, then reschedules it from now. */
  function catchUpOverdue(): void {
    const overdueBefore = Date.now() - CRON_CATCH_UP_GRACE_MS;
    const overdue: string[] = [];
    for (const [id, timer] of timers) if (timer.nextAt < overdueBefore) overdue.push(id);
    for (const [id, entry] of cronTasks) if (entry.nextAt !== null && entry.nextAt < overdueBefore) overdue.push(id);
    if (overdue.length === 0) return;
    const jobs = new Map(store.list().map((job) => [job.id, job]));
    for (const id of overdue) {
      const job = jobs.get(id);
      if (job === undefined) {
        clearJob(id);
        continue;
      }
      if (job.schedule.type === "once") {
        clearJob(id);
        runJob(job);
        store.remove(id);
        continue;
      }
      // Rescheduling first drops the late timer so the occurrence cannot fire a second time.
      scheduleJob(job);
      runJob(job);
    }
  }

  function scheduleJob(job: CronJob): void {
    clearJob(job.id);

    switch (job.schedule.type) {
      case "interval": {
        const intervalMs = job.schedule.intervalMs;
        const entry: TimerEntry = {
          nextAt: Date.now() + intervalMs,
          handle: setInterval(() => {
            entry.nextAt = Date.now() + intervalMs;
            runJob(job);
          }, intervalMs),
        };
        timers.set(job.id, entry);
        break;
      }

      case "once": {
        const at = new Date(job.schedule.at).getTime();
        const safeDelay = Math.max(0, at - Date.now());
        timers.set(job.id, {
          nextAt: Number.isFinite(at) ? at : Date.now(),
          handle: setTimeout(() => {
            timers.delete(job.id);
            runJob(job);
            store.remove(job.id);
          }, safeDelay),
        });
        break;
      }

      case "cron": {
        if (!cron.validate(job.schedule.cron)) break;
        const entry: CronEntry = {
          task: cron.schedule(job.schedule.cron, () => {
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
      const now = Date.now();
      for (const job of store.list()) {
        scheduleJob(job);
        // At most one catch-up run per job, however many occurrences were missed.
        if (missedSinceLastRun(job, now)) runJob(job);
      }
      catchUpCheck = setInterval(catchUpOverdue, CRON_CATCH_UP_CHECK_MS);
      catchUpCheck.unref?.();
    },

    stop() {
      started = false;
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
