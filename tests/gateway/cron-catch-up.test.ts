import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    createdAt: new Date().toISOString(),
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

  it("waits for the channels to start before running startup catch-up", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    createCronStore(storePath).save([makeJob({ lastRunAt: "2026-11-21T11:00:00.010Z" })]);
    store = createCronStore(storePath);
    let channelsStarted: () => void = () => undefined;
    const channelsReady = new Promise<void>((resolve) => { channelsStarted = resolve; });
    service = createCronService({ store, onTrigger, catchUpAfter: channelsReady });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(service.nextRunAt()).not.toBeNull();
    channelsStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("keeps overdue one-shot reminders until channels can deliver them exactly once", async () => {
    const now = new Date("2026-11-21T12:30:00.000Z");
    vi.setSystemTime(now);
    const jobs = [
      makeJob({
        id: "already-overdue",
        schedule: { type: "once", at: new Date(now.getTime() - 60_000).toISOString() },
      }),
      makeJob({
        id: "due-during-startup",
        schedule: { type: "once", at: new Date(now.getTime() + 1_000).toISOString() },
      }),
    ];
    store = createCronStore(storePath);
    store.save(jobs);
    const recordRun = vi.spyOn(store, "recordRun");
    let channelStarted = false;
    let openGate: () => void = () => undefined;
    const channelsReady = new Promise<void>((resolve) => {
      openGate = () => {
        channelStarted = true;
        resolve();
      };
    });
    const delivered: string[] = [];
    onTrigger.mockImplementation((job: CronJob) => {
      if (channelStarted) delivered.push(job.id);
    });
    service = createCronService({ store, onTrigger, catchUpAfter: channelsReady });
    service.start();

    await vi.advanceTimersByTimeAsync(65_000);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(createCronStore(storePath).load()).toEqual(jobs);

    openGate();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["already-overdue", "due-during-startup"]);
    expect(createCronStore(storePath).load()).toEqual([]);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(onTrigger).toHaveBeenCalledTimes(2);
    await Promise.all(recordRun.mock.results.map((result) => result.value));
  });

  it.each([
    { type: "interval", intervalMs: 1_000 },
    { type: "cron", cron: "* * * * *" },
  ] satisfies CronJob["schedule"][])("delivers a $type reminder once after startup even when its timer came due earlier", async (schedule) => {
    vi.setSystemTime(new Date("2026-11-21T12:29:59.000Z"));
    const lastRunAt = "2026-11-21T12:25:00.000Z";
    const jobs = [
      makeJob({ id: "missed-before-startup", schedule, lastRunAt }),
      makeJob({ id: "first-run-during-startup", schedule }),
    ];
    store = createCronStore(storePath);
    store.save(jobs);
    const recordRun = vi.spyOn(store, "recordRun");
    const channelsReady = Promise.withResolvers<void>();
    service = createCronService({ store, onTrigger, catchUpAfter: channelsReady.promise });
    service.start();

    try {
      await vi.advanceTimersByTimeAsync(1_100);
      expect(onTrigger).not.toHaveBeenCalled();
      expect(store.list()).toEqual(jobs);

      channelsReady.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(triggersFor(onTrigger, "missed-before-startup")).toBe(1);
      expect(triggersFor(onTrigger, "first-run-during-startup")).toBe(1);
      expect(recordRun).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(900);
      expect(onTrigger).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      await Promise.all(recordRun.mock.results.map((result) => result.value));
    }
  });

  it("drops a deferred startup catch-up when the service stopped before the channels started", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    createCronStore(storePath).save([makeJob({ lastRunAt: "2026-11-21T11:00:00.010Z" })]);
    store = createCronStore(storePath);
    let channelsStarted: () => void = () => undefined;
    const channelsReady = new Promise<void>((resolve) => { channelsStarted = resolve; });
    service = createCronService({ store, onTrigger, catchUpAfter: channelsReady });
    service.start();
    service.stop();
    service.start();
    channelsStarted();
    await vi.advanceTimersByTimeAsync(0);
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

  it("waits a full interval after catching up when channels become ready shortly before an existing timer", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    store = createCronStore(storePath);
    store.save([makeJob({
      schedule: { type: "interval", intervalMs: 60_000 },
      lastRunAt: "2026-11-21T12:00:00.000Z",
    })]);
    const recordRun = vi.spyOn(store, "recordRun");
    const channelsReady = Promise.withResolvers<void>();
    service = createCronService({ store, onTrigger, catchUpAfter: channelsReady.promise });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(onTrigger).not.toHaveBeenCalled();
      channelsReady.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(onTrigger).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(service.nextRunAt()?.toISOString()).toBe("2026-11-21T12:31:59.000Z");
      await vi.advanceTimersByTimeAsync(1);
      expect(onTrigger).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      await Promise.all(recordRun.mock.results.map((result) => result.value));
    }
  });

  it("a newly created job does not run on start", () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    startWith([
      makeJob({ id: "cron" }),
      makeJob({ id: "interval", schedule: { type: "interval", intervalMs: 10 * 60_000 } }),
    ]);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("catches up the first cron occurrence once after channels start", async () => {
    vi.setSystemTime(new Date("2026-11-21T08:00:00.000Z"));
    startWith([makeJob({ schedule: { type: "cron", cron: "0 9 * * *" } })]);
    const firstRunAt = service.nextRunAt()!;
    // Restart just after the first occurrence, with no run recorded on disk.
    service.stop();
    vi.setSystemTime(firstRunAt.getTime() + 60 * 60_000);

    const channelsReady = Promise.withResolvers<void>();
    store = createCronStore(storePath);
    const recordRun = vi.spyOn(store, "recordRun");
    service = createCronService({ store, onTrigger, catchUpAfter: channelsReady.promise });
    try {
      service.start();
      expect(store.list()[0]?.lastRunAt).toBeUndefined();
      expect(onTrigger).not.toHaveBeenCalled();

      channelsReady.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(service.nextRunAt()?.getTime()).toBe(firstRunAt.getTime() + 24 * 60 * 60_000);
      await Promise.all(recordRun.mock.results.map((result) => result.value));

      service.stop();
      service.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    } finally {
      service.stop();
      await Promise.all(recordRun.mock.results.map((result) => result.value));
    }
  });

  it.each([
    { restartAt: "11:58", untilDue: 2 * 60_000, deliveredAt: "12:00" },
    { restartAt: "12:00", untilDue: 0, deliveredAt: "12:00" },
    { restartAt: "12:02", untilDue: 0, deliveredAt: "12:02" },
  ])("keeps a first interval run due at noon across a restart at $restartAt", async ({ restartAt, untilDue, deliveredAt }) => {
    vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
    const intervalMs = 2 * 60 * 60_000;
    startWith([makeJob({ schedule: { type: "interval", intervalMs } })]);
    expect(service.nextRunAt()?.toISOString()).toBe("2026-11-21T12:00:00.000Z");
    service.stop();
    vi.setSystemTime(new Date(`2026-11-21T${restartAt}:00.000Z`));

    const recordRun = vi.spyOn(store, "recordRun");
    try {
      service.start();
      if (untilDue > 0) {
        expect(service.nextRunAt()?.toISOString()).toBe("2026-11-21T12:00:00.000Z");
        await vi.advanceTimersByTimeAsync(untilDue - 1);
        expect(onTrigger).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(onTrigger).toHaveBeenCalledTimes(1);
      const firstRun = `2026-11-21T${deliveredAt}:00.000Z`;
      expect(store.list()[0]?.lastRunAt).toBe(firstRun);
      expect(service.nextRunAt()?.getTime()).toBe(Date.parse(firstRun) + intervalMs);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(recordRun.mock.results.map((result) => result.value));
    }
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

  it("a run never rewrites cron.json, so a job added there by another writer survives it", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    startWith([makeJob({ id: "frequent", schedule: { type: "interval", intervalMs: 60_000 } })]);
    // Another writer (the kernel's manage_cron tool) adds a job straight to the file.
    const external = makeJob({ id: "external", schedule: { type: "interval", intervalMs: 60 * 60_000 } });
    const before = JSON.parse(readFileSync(storePath, "utf-8")) as CronJob[];
    writeFileSync(storePath, JSON.stringify([...before, external], null, 2));
    const written = readFileSync(storePath, "utf-8");

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(triggersFor(onTrigger, "frequent")).toBe(3);
    await vi.waitFor(() => {
      expect(createCronStore(storePath).load().find((j) => j.id === "frequent")?.lastRunAt).toBe("2026-11-21T12:03:00.000Z");
    });
    expect(readFileSync(storePath, "utf-8")).toBe(written);
  });

  it("a more frequent job's runs do not delay an interval job's first run", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    startWith([
      makeJob({ id: "frequent", schedule: { type: "interval", intervalMs: 60_000 } }),
      makeJob({ id: "slow", schedule: { type: "interval", intervalMs: 10 * 60_000 } }),
    ]);
    const original = readFileSync(storePath, "utf-8");
    // Stand-in for the gateway's cron.json watcher: any rewrite of the file restarts every job.
    for (let minute = 1; minute <= 10; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      const ranAt = new Date(Date.UTC(2026, 10, 21, 12, minute)).toISOString();
      // Let the run's own persistence land before the "watcher" looks at the file.
      await vi.waitFor(() => {
        expect(createCronStore(storePath).load().find((j) => j.id === "frequent")?.lastRunAt).toBe(ranAt);
      });
      if (readFileSync(storePath, "utf-8") !== original) {
        service.stop();
        service.start();
      }
    }
    expect(triggersFor(onTrigger, "frequent")).toBe(10);
    expect(triggersFor(onTrigger, "slow")).toBe(1);
  });

  it("picks up jobs another writer added to cron.json when the service restarts", () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    startWith([makeJob({ id: "frequent", schedule: { type: "interval", intervalMs: 60_000 } })]);
    const before = JSON.parse(readFileSync(storePath, "utf-8")) as CronJob[];
    writeFileSync(storePath, JSON.stringify([...before, makeJob({ id: "external", schedule: { type: "interval", intervalMs: 5 * 60_000 } })]));
    service.stop();
    service.start();
    expect(service.listJobs().map((j) => j.id).sort()).toEqual(["external", "frequent"]);
  });

  it("an interval job restarted before its next run fires at lastRunAt + interval", () => {
    vi.setSystemTime(new Date("2026-11-21T12:30:00.000Z"));
    // Woken 60 s before the next run is due.
    startWith([makeJob({
      schedule: { type: "interval", intervalMs: 10 * 60_000 },
      lastRunAt: "2026-11-21T12:21:00.000Z",
    })]);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(service.nextRunAt()?.toISOString()).toBe("2026-11-21T12:31:00.000Z");
    vi.advanceTimersByTime(60_000 - 1);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(service.nextRunAt()?.toISOString()).toBe("2026-11-21T12:41:00.000Z");
    vi.advanceTimersByTime(10 * 60_000);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("a memory-restore wake shortly before an occurrence runs it on time, once", async () => {
    const runTimes: string[] = [];
    onTrigger.mockImplementation(() => runTimes.push(new Date().toISOString()));
    vi.setSystemTime(new Date("2026-11-21T12:00:30.000Z"));
    startWith([makeJob()]);

    // Paused at 12:00:30, restored at 12:59:00 (60 s before the 13:00 run): timers resume late.
    vi.setSystemTime(new Date("2026-11-21T12:59:00.000Z"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(runTimes).toHaveLength(1);
    const lateness = new Date(runTimes[0]!).getTime() - Date.parse("2026-11-21T13:00:00.000Z");
    expect(lateness).toBeGreaterThanOrEqual(0);
    expect(lateness).toBeLessThanOrEqual(1_000);
  });

  it("a superseded cron task's queued callback does not run the job again", async () => {
    vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    startWith([makeJob({ schedule: { type: "cron", cron: "* * * * *" } })]);
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(onTrigger).not.toHaveBeenCalled();

    // Resume lands on a still-matching second: the late heartbeat queues a run and the
    // catch-up check, due in the same timer batch, reschedules the overdue job.
    vi.setSystemTime(new Date("2026-11-21T12:01:59.999Z"));
    await vi.advanceTimersByTimeAsync(10);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
