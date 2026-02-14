import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCronStore } from "../../../packages/gateway/src/cron/store.js";
import { createCronService, type CronService } from "../../../packages/gateway/src/cron/service.js";
import type { CronJob } from "../../../packages/gateway/src/cron/types.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "cron-svc-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `cron_${Math.random().toString(36).slice(2, 8)}`,
    name: "test-job",
    message: "Hello from cron",
    schedule: { type: "interval", intervalMs: 1000 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("T120a: Cron service", () => {
  let homePath: string;
  let service: CronService;
  let onTrigger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    homePath = tmpHome();
    const store = createCronStore(join(homePath, "system", "cron.json"));
    onTrigger = vi.fn();
    service = createCronService({ store, onTrigger });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    rmSync(homePath, { recursive: true, force: true });
  });

  it("adds a job and lists it", () => {
    const job = makeJob({ id: "j1" });
    service.addJob(job);
    expect(service.listJobs()).toHaveLength(1);
    expect(service.listJobs()[0].id).toBe("j1");
  });

  it("removes a job", () => {
    service.addJob(makeJob({ id: "j1" }));
    service.addJob(makeJob({ id: "j2" }));
    expect(service.removeJob("j1")).toBe(true);
    expect(service.listJobs()).toHaveLength(1);
  });

  it("interval job fires on schedule", () => {
    service.addJob(makeJob({
      id: "j1",
      schedule: { type: "interval", intervalMs: 5000 },
    }));
    service.start();

    vi.advanceTimersByTime(5000);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("once job fires and is auto-removed", () => {
    const future = new Date(Date.now() + 3000).toISOString();
    service.addJob(makeJob({
      id: "j1",
      schedule: { type: "once", at: future },
    }));
    service.start();

    vi.advanceTimersByTime(3000);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(service.listJobs()).toHaveLength(0);
  });

  it("once job with past time fires immediately", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    service.addJob(makeJob({
      id: "j1",
      schedule: { type: "once", at: past },
    }));
    service.start();

    vi.advanceTimersByTime(0);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("stop() clears all timers", () => {
    service.addJob(makeJob({
      id: "j1",
      schedule: { type: "interval", intervalMs: 1000 },
    }));
    service.start();
    service.stop();

    vi.advanceTimersByTime(5000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("deduplicates job IDs", () => {
    service.addJob(makeJob({ id: "j1", message: "v1" }));
    service.addJob(makeJob({ id: "j1", message: "v2" }));
    expect(service.listJobs()).toHaveLength(1);
    expect(service.listJobs()[0].message).toBe("v2");
  });

  it("persists jobs to store", () => {
    const store = createCronStore(join(homePath, "system", "cron.json"));
    service.addJob(makeJob({ id: "j1" }));

    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("j1");
  });

  it("loads existing jobs from store on start", () => {
    const store = createCronStore(join(homePath, "system", "cron.json"));
    store.add(makeJob({
      id: "j1",
      schedule: { type: "interval", intervalMs: 2000 },
    }));

    const svc2 = createCronService({ store, onTrigger });
    svc2.start();

    vi.advanceTimersByTime(2000);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    svc2.stop();
  });
});
