import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import type { CronJob } from "./types.js";

export interface CronStore {
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  add(job: CronJob): void;
  remove(jobId: string): boolean;
  list(): CronJob[];
  /** Record when a job's run started. Updates the cache now and persists asynchronously (atomic rename). */
  recordRun(jobId: string, startedAt: string): Promise<void>;
}

export function createCronStore(filePath: string): CronStore {
  let cache: CronJob[] | null = null;
  // Bumped on every cache change; the async flush rewrites until the file holds the latest version.
  let version = 0;
  let flushing: Promise<void> | null = null;
  // One fixed temp path for async flushes: flushes are serialized, so it is overwritten, never accumulated.
  const runTmp = filePath + ".run.tmp";
  const writeFileNow = fs.writeFileSync as (
    path: fs.PathOrFileDescriptor,
    data: string,
  ) => void;
  const renameNow = fs.renameSync as (oldPath: fs.PathLike, newPath: fs.PathLike) => void;

  function load(): CronJob[] {
    if (!existsSync(filePath)) return [];
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      cache = Array.isArray(data) ? data : [];
      return cache;
    } catch (err: unknown) {
      console.warn("[cron] Could not load cron store:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  function save(jobs: CronJob[]): void {
    const tmp = filePath + ".tmp";
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
        await writeFile(runTmp, JSON.stringify(cache ?? [], null, 2));
        await rename(runTmp, filePath);
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
    cache = jobs.map((j) => (j.id === jobId ? { ...j, lastRunAt: startedAt } : j));
    version++;
    flushing ??= flushLoop();
    return flushing;
  }

  return { load, save, add, remove, list, recordRun };
}
