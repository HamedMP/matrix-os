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

interface TimerEntry {
  handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  /** Epoch ms of the next run; interval entries advance on every tick. */
  nextAt: number;
}

export function createCronService(config: CronServiceConfig): CronService {
  const { store, onTrigger } = config;
  // Both maps hold one entry per scheduled job in the store; clearJob removes them on removal/stop.
  const timers = new Map<string, TimerEntry>();
  const cronTasks = new Map<string, cron.ScheduledTask>();
  let started = false;

  function scheduleJob(job: CronJob): void {
    clearJob(job.id);

    switch (job.schedule.type) {
      case "interval": {
        const intervalMs = job.schedule.intervalMs;
        const entry: TimerEntry = {
          nextAt: Date.now() + intervalMs,
          handle: setInterval(() => {
            entry.nextAt = Date.now() + intervalMs;
            onTrigger(job);
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
            onTrigger(job);
            timers.delete(job.id);
            store.remove(job.id);
          }, safeDelay),
        });
        break;
      }

      case "cron": {
        if (!cron.validate(job.schedule.cron)) break;
        const task = cron.schedule(job.schedule.cron, () => onTrigger(job));
        cronTasks.set(job.id, task);
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
    const task = cronTasks.get(jobId);
    if (task) {
      task.stop();
      cronTasks.delete(jobId);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      for (const job of store.list()) {
        scheduleJob(job);
      }
    },

    stop() {
      started = false;
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
      for (const task of cronTasks.values()) {
        const next = task.getNextRun()?.getTime();
        if (next !== undefined && Number.isFinite(next) && (earliest === null || next < earliest)) earliest = next;
      }
      return earliest === null ? null : new Date(earliest);
    },
  };
}
