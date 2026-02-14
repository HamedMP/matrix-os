import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
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

  function load(): CronJob[] {
    if (!existsSync(filePath)) return [];
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      cache = Array.isArray(data) ? data : [];
      return cache;
    } catch {
      return [];
    }
  }

  function save(jobs: CronJob[]): void {
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    renameSync(tmp, filePath);
    cache = jobs;
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
