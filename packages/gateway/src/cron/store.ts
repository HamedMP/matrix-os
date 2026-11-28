import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CronJob } from "./types.js";

export interface CronStore {
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  add(job: CronJob): void;
  remove(jobId: string): boolean;
  list(): CronJob[];
  /**
   * Record when a job's run started. Updates memory now and persists asynchronously (atomic rename)
   * to the run-state file, never to cron.json: other writers (the kernel's manage_cron tool) own that
   * file, and the gateway restarts every job whenever it changes.
   */
  recordRun(jobId: string, startedAt: string): Promise<void>;
}

/** Run times live beside the job definitions, in `cron-state.json`. */
export function cronStatePath(filePath: string): string {
  return join(dirname(filePath), "cron-state.json");
}

export function createCronStore(filePath: string): CronStore {
  let cache: CronJob[] | null = null;
  // jobId -> ISO start of its latest run. Pruned to the current jobs on every load, save and flush.
  let runs: Record<string, string> | null = null;
  // Bumped on every run-state change; the async flush rewrites until the file holds the latest version.
  let version = 0;
  let flushing: Promise<void> | null = null;
  const statePath = cronStatePath(filePath);
  // One fixed temp path for async flushes: flushes are serialized, so it is overwritten, never accumulated.
  const stateTmp = statePath + ".tmp";
  const writeFileNow = fs.writeFileSync as (
    path: fs.PathOrFileDescriptor,
    data: string,
  ) => void;
  const renameNow = fs.renameSync as (oldPath: fs.PathLike, newPath: fs.PathLike) => void;

  function loadRuns(): Record<string, string> {
    if (runs !== null) return runs;
    runs = {};
    if (!existsSync(statePath)) return runs;
    try {
      const data: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        for (const [id, at] of Object.entries(data as Record<string, unknown>)) {
          if (typeof at === "string" && Number.isFinite(Date.parse(at))) runs[id] = at;
        }
      }
    } catch (err: unknown) {
      console.warn("[cron] Could not load cron run state:", err instanceof Error ? err.message : String(err));
    }
    return runs;
  }

  /** Jobs as stored, with the run-state time (when newer state exists) as `lastRunAt`. */
  function withRuns(jobs: CronJob[]): CronJob[] {
    const known = loadRuns();
    return jobs.map((job) => (known[job.id] ? { ...job, lastRunAt: known[job.id] } : job));
  }

  function load(): CronJob[] {
    if (!existsSync(filePath)) return [];
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      const jobs: CronJob[] = Array.isArray(data) ? data : [];
      loadRuns();
      pruneRuns(jobs);
      cache = withRuns(jobs);
      return cache;
    } catch (err: unknown) {
      console.warn("[cron] Could not load cron store:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /** Drops run times of jobs no longer defined, so the record holds at most one entry per current job. */
  function pruneRuns(jobs: CronJob[]): void {
    if (runs === null) return;
    const ids = new Set(jobs.map((job) => job.id));
    for (const id of Object.keys(runs)) if (!ids.has(id)) delete runs[id];
  }

  function save(jobs: CronJob[]): void {
    const tmp = filePath + ".tmp";
    pruneRuns(jobs);
    cache = jobs;
    version++;
    try {
      writeFileNow(tmp, JSON.stringify(jobs, null, 2));
      renameNow(tmp, filePath);
    } catch (err: unknown) {
      console.warn("[cron] Could not persist cron store:", err instanceof Error ? err.message : String(err));
    }
  }

  function list(): CronJob[] {
    if (cache !== null) return cache;
    return load();
  }

  function add(job: CronJob): void {
    const jobs = list().filter((j) => j.id !== job.id);
    jobs.push(job);
    save(jobs);
  }

  function remove(jobId: string): boolean {
    const jobs = list();
    const filtered = jobs.filter((j) => j.id !== jobId);
    if (filtered.length === jobs.length) return false;
    save(filtered);
    return true;
  }

  async function flushLoop(): Promise<void> {
    let written = -1;
    try {
      while (written !== version) {
        const snapshot = version;
        pruneRuns(list());
        await writeFile(stateTmp, JSON.stringify(loadRuns(), null, 2));
        await rename(stateTmp, statePath);
        written = snapshot;
      }
    } catch (err: unknown) {
      console.warn("[cron] Could not persist cron run time:", err instanceof Error ? err.message : String(err));
    } finally {
      // Cleared in the same tick the loop exits, so a later change always starts a new flush.
      flushing = null;
    }
  }

  function recordRun(jobId: string, startedAt: string): Promise<void> {
    const jobs = list();
    if (!jobs.some((j) => j.id === jobId)) return Promise.resolve();
    loadRuns()[jobId] = startedAt;
    cache = jobs.map((j) => (j.id === jobId ? { ...j, lastRunAt: startedAt } : j));
    version++;
    flushing ??= flushLoop();
    return flushing;
  }

  return { load, save, add, remove, list, recordRun };
}
