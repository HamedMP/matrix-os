import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCronStore, type CronStore } from "../../packages/gateway/src/cron/store.js";
import { createCronService, type CronService } from "../../packages/gateway/src/cron/service.js";
import type { CronJob } from "../../packages/gateway/src/cron/types.js";

// Outcome: a free-tier VM that slept (process stopped, or paused and resumed)
// still runs a scheduled job it missed, exactly once, instead of silently
// skipping it. Fault detected: missed occurrences dropped, or replayed as a burst.

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job",
    name: "test-job",
    message: "Hello from cron",
    schedule: { type: "cron", cron: "0 * * * *" },
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function triggersFor(onTrigger: ReturnType<typeof vi.fn>, id: string): number {
  return onTrigger.mock.calls.filter(([job]) => (job as CronJob).id === id).length;
}

describe("cron catch-up of missed runs", () => {
  let homePath: string;
  let storePath: string;
  let store: CronStore;
  let service: CronService;
  let onTrigger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    homePath = resolve(mkdtempSync(join(tmpdir(), "cron-catch-up-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    storePath = join(homePath, "system", "cron.json");
    onTrigger = vi.fn();
  });

  afterEach(() => {
    service?.stop();
    vi.useRealTimers();
    rmSync(homePath, { recursive: true, force: true });
  });

  function startWith(jobs: CronJob[]): void {
    createCronStore(storePath).save(jobs);
    store = createCronStore(storePath);
    service = createCronService({ store, onTrigger });
    service.start();
  }

  it("a cron job whose occurrence passed while stopped runs once on start", () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    startWith([makeJob({ lastRunAt: "2026-11-21T11:00:00.010Z" })]);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not catch up a cron job that already ran for the previous occurrence", () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    startWith([makeJob({ lastRunAt: "2026-11-21T12:00:00.010Z" })]);
    vi.advanceTimersByTime(60_000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("two missed occurrences still run only once", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    startWith([makeJob({ lastRunAt: "2026-11-21T09:00:00.010Z" })]);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    // node-cron starts the run 1 ms after the matching second.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("an interval job missed while stopped runs once on start", () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    startWith([makeJob({
      schedule: { type: "interval", intervalMs: 10 * 60_000 },
      lastRunAt: "2026-11-21T12:00:00.000Z",
    })]);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("a job never run before does not run on start", () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    startWith([
      makeJob({ id: "cron" }),
      makeJob({ id: "interval", schedule: { type: "interval", intervalMs: 10 * 60_000 } }),
    ]);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("a resumed process whose wall clock jumped past occurrences runs each missed job once", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:30.000Z"));
    startWith([
      makeJob({ id: "cron" }),
      makeJob({ id: "interval", schedule: { type: "interval", intervalMs: 60 * 60_000 } }),
    ]);

    // Memory-snapshot restore: wall clock moves forward, pending timers do not.
    vi.setSystemTime(new Date("2026-11-21T15:10:00.000Z"));
    vi.advanceTimersByTime(60_000);
    expect(triggersFor(onTrigger, "cron")).toBe(1);
    expect(triggersFor(onTrigger, "interval")).toBe(1);

    vi.advanceTimersByTime(5 * 60_000);
    expect(onTrigger).toHaveBeenCalledTimes(2);

    // The next regular occurrences still fire on schedule, without a duplicate.
    // Now 15:16:00; the rescheduled cron task fires at 16:00, the interval at 16:10:30.
    await vi.advanceTimersByTimeAsync(44 * 60_000 + 1_000);
    expect(triggersFor(onTrigger, "cron")).toBe(2);
    expect(triggersFor(onTrigger, "interval")).toBe(1);
  });

  it("does not check for missed runs after stop", () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:30.000Z"));
    startWith([makeJob()]);
    service.stop();
    vi.setSystemTime(new Date("2026-11-21T15:10:00.000Z"));
    vi.advanceTimersByTime(5 * 60_000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("persists lastRunAt when a run starts", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    startWith([makeJob({ schedule: { type: "interval", intervalMs: 60_000 } })]);
    vi.advanceTimersByTime(60_000);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(store.list()[0]?.lastRunAt).toBe("2026-11-21T12:01:00.000Z");
    await vi.waitFor(() => {
      expect(createCronStore(storePath).load()[0]?.lastRunAt).toBe("2026-11-21T12:01:00.000Z");
    });
  });
});
