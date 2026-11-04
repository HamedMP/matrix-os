import { describe, expect, it, vi } from "vitest";
import { nextBotRoutineFire } from "../../../packages/gateway/src/bots/routine-schedule.js";
import { createBotRoutineScheduler } from "../../../packages/gateway/src/bots/routine-scheduler.js";
const NOW = "2026-10-18T12:00:00.000Z";
const r = {
  routineId: "routine_012345678901234567890123",
  ownerId: "owner",
  botId: "bot_01234567890123456789",
  chatId: "chat_one",
  revision: 1,
  status: "active" as const,
  nextFireAt: "2026-10-18T10:00:00.000Z",
  proposal: {
    name: "Test",
    prompt: "Test",
    schedule: {
      kind: "interval" as const,
      everyMs: 60_000
    },
    selection: {
      instanceId: "matrix_chatgpt_plan" as const,
      model: "test"
    },
    authorizedEffects: ["read" as const]
  },
  createdAt: NOW,
  updatedAt: NOW
};
const f = {
  fireId: "fire_012345678901234567890123",
  ownerId: "owner",
  routineId: r.routineId,
  taskId: "task_01234567890123456789",
  scheduledFor: r.nextFireAt,
  status: "claimed" as const,
  attempts: 0,
  retryAfter: null,
  failureCode: null,
  leaseExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW
};
function fixture(outcome = {
  status: "completed" as string
}) {
  const store = {
    due: vi.fn().mockResolvedValue([r]),
    claim: vi.fn().mockResolvedValue(f),
    pending: vi.fn().mockResolvedValue([f]),
    get: vi.fn().mockResolvedValue(r),
    dispatch: vi.fn().mockResolvedValue({
      ...f,
      status: "dispatched",
      attempts: 1
    }),
    finish: vi.fn().mockResolvedValue(undefined),
    defer: vi.fn().mockResolvedValue({
      ...f
    }),
    recover: vi.fn().mockResolvedValue(0)
  };
  const run = vi.fn().mockResolvedValue(outcome);
  const authorize = vi.fn().mockResolvedValue(true);
  const scheduler = createBotRoutineScheduler({
    repository: store,
    authorize,
    run,
    now: () => new Date(NOW)
  });
  return {
    store,
    run,
    authorize,
    scheduler
  };
}
it.each(["startup", "authorization", "dispatch"] as const)("bounds shutdown while %s remains pending and starts no late work", async stage => {
  vi.useFakeTimers();
  const { scheduler, store, run, authorize } = fixture();
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(done => { enter = done; });
  const gate = new Promise<unknown>(done => { release = () => done(stage === "startup" ? 0 : stage === "authorization" ? true : { ...f, status: "dispatched", attempts: 1 }); });
  const pending = () => { enter(); return gate; };
  if (stage === "startup") store.recover.mockImplementation(pending);
  else if (stage === "authorization") authorize.mockImplementation(pending);
  else store.dispatch.mockImplementation(pending);
  const work = stage === "startup" ? scheduler.start() : scheduler.tick();
  let stopped = false;
  let stop: Promise<void> | undefined;
  try {
    await entered;
    stop = scheduler.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(10000);
    expect(stopped).toBe(true);
    release(); await work; await stop;
    expect(run).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled(); expect(store.defer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { release(); await work; await stop; vi.useRealTimers(); }
});

it.each(["accepted", "rejected"] as const)("retains pending admission fences after a bounded stop and late %s result", async outcome => {
  vi.useFakeTimers();
  const { scheduler, store, run } = fixture();
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(done => { enter = done; });
  run.mockImplementation(() => new Promise((done, reject) => {
    enter(); release = () => outcome === "accepted" ? done({ status: "accepted" }) : reject(new Error("Synthetic late admission failure"));
  }));
  const work = scheduler.tick();
  let stopped = false;
  let stop: Promise<void> | undefined;
  try {
    await entered; stop = scheduler.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(10000); expect(stopped).toBe(true);
    expect(run.mock.calls[0][2].aborted).toBe(true);
    expect(store.finish).not.toHaveBeenCalled(); expect(store.defer).not.toHaveBeenCalled();
    release(); await work; await stop; await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.finish).not.toHaveBeenCalled(); expect(store.defer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { release?.(); await work; await stop; vi.useRealTimers(); }
});
describe("routine clock and failure policy", () => {
  it("skips missed interval backlog and computes a single next future occurrence", () => {
    expect(nextBotRoutineFire(r.proposal.schedule, NOW)).toBe("2026-10-18T12:01:00.000Z");
    expect(nextBotRoutineFire({
      kind: "once",
      at: "2026-10-18T10:00:00Z"
    }, NOW)).toBeNull();
  });
  it("uses the public cron API and named timezone without leaving timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      expect(nextBotRoutineFire({
        kind: "cron",
        expr: "0 9 * * *",
        tz: "America/New_York"
      }, NOW)).toBe("2026-10-18T13:00:00.000Z");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not silently accept invalid cron or an unknown timezone", () => {
    expect(() => nextBotRoutineFire({
      kind: "cron",
      expr: "999 * * * *",
      tz: "UTC"
    }, NOW)).toThrow();
    expect(() => nextBotRoutineFire({
      kind: "cron",
      expr: "* * * * *",
      tz: "Bogus/Zone"
    }, NOW)).toThrow();
  });
  it("does not hide an unexpected timezone runtime failure as invalid user input", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("fixture runtime failure");
    });
    try {
      expect(() => nextBotRoutineFire({
        kind: "cron",
        expr: "* * * * *",
        tz: "UTC"
      }, NOW)).toThrow("fixture runtime failure");
    } finally {
      formatter.mockRestore();
    }
  });
  it("claims at most one catch-up and settles via the canonical task runner", async () => {
    const {
      scheduler,
      store,
      run
    } = fixture();
    await scheduler.tick();
    expect(store.claim).toHaveBeenCalledWith(expect.objectContaining({
      scheduledFor: r.nextFireAt,
      nextFireAt: "2026-10-18T12:01:00.000Z"
    }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed"
    }));
  });
  it("fails closed without background authority and never calls the runtime", async () => {
    const {
      scheduler,
      store,
      run,
      authorize
    } = fixture();
    authorize.mockResolvedValue(false);
    await scheduler.tick();
    expect(run).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      failureCode: "background_not_authorized"
    }));
  });
  it("bounds only explicit no-effect capacity retries; thrown/unknown outcomes never replay", async () => {
    const safe = fixture({
      status: "capacity_before_dispatch"
    });
    await safe.scheduler.tick();
    expect(safe.store.defer).toHaveBeenCalledTimes(1);
    const unknown = fixture();
    unknown.run.mockRejectedValue(new Error("ambiguous"));
    await unknown.scheduler.tick();
    expect(unknown.store.defer).not.toHaveBeenCalled();
    expect(unknown.store.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "uncertain",
      failureCode: "outcome_unknown"
    }));
    const exhausted = fixture({
      status: "capacity_before_dispatch"
    });
    exhausted.store.dispatch.mockResolvedValue({
      ...f,
      status: "dispatched",
      attempts: 3
    });
    await exhausted.scheduler.tick();
    expect(exhausted.store.defer).not.toHaveBeenCalled();
    expect(exhausted.store.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed"
    }));
  });
  it("reconciles expired dispatches on later passes after a live lease survived startup", async () => {
    const {
      scheduler,
      store
    } = fixture();
    await scheduler.tick();
    expect(store.recover).toHaveBeenCalledWith({
      before: NOW,
      now: NOW
    });
  });
  it("serializes tick calls and drains active work on stop", async () => {
    const {
      scheduler,
      run
    } = fixture();
    let finish!: () => void;
    run.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({
        status: "completed"
      });
    }));
    const first = scheduler.tick();
    while (!finish) await Promise.resolve();
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await first;
    await stop;
    expect(stopped).toBe(true);
  });
  it("rechecks pause/archive before dispatch and does not run a cancelled routine", async () => {
    const {
      scheduler,
      store,
      run
    } = fixture();
    store.get.mockResolvedValue({
      ...r,
      status: "paused"
    });
    await scheduler.tick();
    expect(run).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "cancelled"
    }));
  });
});
it("leaves an accepted canonical queued run pending its actual outcome", async () => {
  const {
    scheduler,
    store
  } = fixture({
    status: "accepted"
  });
  await scheduler.tick();
  expect(store.finish).not.toHaveBeenCalled();
  expect(store.defer).not.toHaveBeenCalled();
});
it("refreshes each cron claim clock after slow recovery and previous claims", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  try {
    const {
      store,
      authorize,
      run
    } = fixture();
    store.recover.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1500);
      return 0;
    });
    store.due.mockResolvedValue([{
      ...r,
      proposal: {
        ...r.proposal,
        schedule: {
          kind: "cron",
          expr: "* * * * *",
          tz: "UTC"
        }
      }
    }, {
      ...r,
      routineId: "rt_other_clock_fixture",
      proposal: {
        ...r.proposal,
        schedule: {
          kind: "cron",
          expr: "* * * * *",
          tz: "UTC"
        }
      }
    }]);
    store.claim.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1500);
      return f;
    });
    store.pending.mockResolvedValue([]);
    const scheduler = createBotRoutineScheduler({
      repository: store,
      authorize,
      run,
      now: () => new Date()
    });
    await scheduler.tick();
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(store.claim.mock.calls[1][0].now).toBe("2026-10-18T12:00:03.000Z");
    await scheduler.stop();
  } finally {
    vi.useRealTimers();
  }
});
