import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import type { CronJob } from "./types.js";

export interface CronStore {
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  add(job: CronJob): void;
  remove(jobId: string): boolean;
  list(): CronJob[];
}

export function createCronStore(filePath: string): CronStore {
  let cache: CronJob[] | null = null;
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

  return { load, save, add, remove, list };
}
