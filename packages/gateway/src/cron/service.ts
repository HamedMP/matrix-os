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
}

export function createCronService(config: CronServiceConfig): CronService {
  const { store, onTrigger } = config;
  const timers = new Map<string, ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
  const cronTasks = new Map<string, cron.ScheduledTask>();
  let started = false;

  function scheduleJob(job: CronJob): void {
    clearJob(job.id);

    switch (job.schedule.type) {
      case "interval":
        timers.set(
          job.id,
          setInterval(() => onTrigger(job), job.schedule.intervalMs),
        );
        break;

      case "once": {
        const delay = new Date(job.schedule.at).getTime() - Date.now();
        const safeDelay = Math.max(0, delay);
        timers.set(
          job.id,
          setTimeout(() => {
            onTrigger(job);
            timers.delete(job.id);
            store.remove(job.id);
          }, safeDelay),
        );
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
      clearInterval(timer as ReturnType<typeof setInterval>);
      clearTimeout(timer as ReturnType<typeof setTimeout>);
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
  };
}
