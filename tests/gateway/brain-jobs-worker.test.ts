import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_JOB_WORKER_CEILINGS, BRAIN_JOB_WORKER_DEFAULTS, BrainJobStore, bootstrapBrainJobsDatabase, brainJobErrorCode,
  clipBrainJobSummary, createBrainJobWorker, resolveBrainJobWorkerLimits, type BrainJobStep, type BrainJobSteps,
  type BrainJobView, type BrainJobWorker, type BrainJobWorkerLimits,
} from "../../packages/gateway/src/brain/jobs/index.js";
import { createBrainHarness, scopeA, scopeB, type BrainHarness } from "./helpers/brain-store-helpers.js";

let harness: BrainHarness;
let store: BrainJobStore;
let worker: BrainJobWorker | null = null;
const FAST: Partial<BrainJobWorkerLimits> = {
  pollMs: 10_000, heartbeatMs: 10_000, stepPauseMs: 0, retryDelayMs: 1, stopWaitMs: 200,
};

// PGlite is one connection: interleaved transactions would share it, so every database call of this file runs one at
// a time through `locked` (real pools need no such guard; brain-jobs-postgres.test.ts runs without it).
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}
function serialized(target: BrainJobStore): BrainJobStore {
  return new Proxy(target, {
    get(object, prop, receiver) {
      const value: unknown = Reflect.get(object, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => locked(() => (value as (...a: unknown[]) => Promise<unknown>).apply(object, args));
    },
  });
}
const exec = (query: { execute(db: BrainHarness["db"]): Promise<unknown> }) => locked(() => query.execute(harness.db));

beforeAll(async () => {
  harness = await createBrainHarness();
  await bootstrapBrainJobsDatabase(harness.db);
  store = serialized(new BrainJobStore(harness.db, { now: harness.now }));
});
afterAll(async () => {
  await harness.destroy();
});
beforeEach(async () => {
  await exec(sql`DELETE FROM brain_jobs`);
});
afterEach(async () => {
  await worker?.stop();
  worker = null;
  vi.restoreAllMocks();
});

function start(steps: BrainJobSteps, limits: Partial<BrainJobWorkerLimits> = {}, workerId = "w_test"): BrainJobWorker {
  worker = createBrainJobWorker({ store, ownerId: "owner_a", steps, limits: { ...FAST, ...limits }, workerId });
  worker.start();
  return worker;
}

async function settled(jobId: string, status: BrainJobView["status"] = "succeeded", scope = scopeA) {
  let view: BrainJobView | null = null;
  await vi.waitFor(async () => {
    view = await store.get(scope, jobId);
    expect(view?.status).toBe(status);
  }, { timeout: 4_000, interval: 5 });
  return view!;
}

/** A step that waits until its signal aborts, then throws the abort reason. */
const blocking: BrainJobStep = ({ signal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
/** A step that ignores its signal and never ends. */
const hung: BrainJobStep = () => new Promise(() => undefined);
const queue = (kind: "sync" | "graph_refresh" | "search_refresh" = "sync", scope = scopeA) =>
  store.enqueue(scope, "proj_a", { kind }).then((result) => result.job.jobId);

describe("brain job worker", () => {
  it("re-runs the step until it is caught up and records progress", async () => {
    let calls = 0;
    const seen: number[] = [];
    const jobId = await queue();
    start({ sync: async ({ step, request, projectId, scope }) => {
      calls += 1;
      seen.push(step);
      expect({ request, projectId, scope }).toEqual({ request: { kind: "sync" }, projectId: "proj_a", scope: scopeA });
      return { caughtUp: calls === 3, stopCode: null, summary: { written: calls, "bad key": 1 } };
    } });
    const view = await settled(jobId);
    expect(view).toMatchObject({ steps: 3, attempts: 1, errorCode: null, result: { written: 3 } });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("fails on stop codes, step errors, unknown kinds and the step cap", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ids = [await queue("sync"), await queue("graph_refresh"), await queue("search_refresh"), await queue("sync", scopeB)];
    let syncCalls = 0;
    start({
      sync: async ({ scope }) => {
        if (scope.scopeId === scopeB.scopeId) return { caughtUp: false, stopCode: "Bad Code", summary: {} };
        syncCalls += 1;
        return { caughtUp: false, stopCode: syncCalls === 2 ? "fix_source" : null, summary: {} };
      },
      graph_refresh: async () => {
        throw Object.assign(new Error("x"), { code: "project_not_found" });
      },
    }, { concurrency: 4 });
    expect(await settled(ids[0]!, "failed")).toMatchObject({ errorCode: "fix_source", steps: 2 });
    expect(await settled(ids[1]!, "failed")).toMatchObject({ errorCode: "project_not_found", steps: 0 });
    expect(await settled(ids[2]!, "failed")).toMatchObject({ errorCode: "job_kind_unavailable" });
    expect(await settled(ids[3]!, "failed", scopeB)).toMatchObject({ errorCode: "step_failed", steps: 1 });
    await worker!.stop();
    const capped = await queue("sync");
    start({ sync: async () => { throw new TypeError("boom"); } });
    expect(await settled(capped, "failed")).toMatchObject({ errorCode: "step_failed" });
    expect(error).toHaveBeenCalledWith("[brain-jobs] Step failed:", "TypeError");
    await worker!.stop();
    const limited = await queue("graph_refresh");
    start({ graph_refresh: async () => ({ caughtUp: false, stopCode: null, summary: {} }) }, { maxSteps: 3 });
    expect(await settled(limited, "failed")).toMatchObject({ errorCode: "step_limit", steps: 3 });
  });

  it("keeps trying busy answers until the time cap, then fails with the busy code", async () => {
    let calls = 0;
    const first = await queue("sync");
    start({ sync: async () => {
      calls += 1;
      if (calls <= 8) throw Object.assign(new Error("busy"), { code: "sync_in_progress" });
      return { caughtUp: true, stopCode: null, summary: {} };
    } });
    // The step's own summary replaces the waiting note once it runs.
    expect(await settled(first)).toMatchObject({ steps: 1, attempts: 1, result: {} });
    expect(calls).toBe(9);
    await worker!.stop();
    const second = await queue("sync");
    start({ sync: async () => { throw Object.assign(new Error("busy"), { code: "extraction_in_progress" }); } },
      { retryDelayMs: 60_000, jobWallClockMs: 30 });
    expect(await settled(second, "failed")).toMatchObject({ errorCode: "extraction_in_progress", steps: 0 });
  });

  it("ends a run at the time cap, on cancel and on stop even when its step ignores the signal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timed = await queue("sync");
    start({ sync: hung }, { jobWallClockMs: 30 });
    expect(await settled(timed, "failed")).toMatchObject({ errorCode: "time_limit", steps: 0 });
    await worker!.stop();
    const cancelled = await queue("graph_refresh");
    let fail: (error: unknown) => void = () => undefined;
    start({ graph_refresh: () => new Promise((_, reject) => { fail = reject; }) }, { heartbeatMs: 10 });
    await settled(cancelled, "running");
    await store.cancel(scopeA, cancelled);
    expect(await settled(cancelled, "cancelled")).toMatchObject({ cancelRequested: true, steps: 0 });
    fail(new TypeError("late"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[brain-jobs] Step failed after its run stopped:", "TypeError"));
    await worker!.stop();
    const stopped = await queue("search_refresh");
    const w = start({ search_refresh: hung }, { stopWaitMs: 5_000 });
    await settled(stopped, "running");
    await w.stop();
    expect(await store.get(scopeA, stopped)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("stops at the wall-clock cap and on cancel", async () => {
    const timed = await queue("sync");
    start({ sync: blocking }, { jobWallClockMs: 30 });
    expect(await settled(timed, "failed")).toMatchObject({ errorCode: "time_limit" });
    await worker!.stop();
    const slow = await queue("search_refresh");
    start({ search_refresh: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { caughtUp: false, stopCode: null, summary: {} };
    } }, { jobWallClockMs: 30 });
    const slowView = await settled(slow, "failed");
    expect(slowView.errorCode).toBe("time_limit");
    expect(slowView.steps).toBeGreaterThanOrEqual(1);
    await worker!.stop();
    const cancelled = await queue("sync");
    start({ sync: blocking }, { heartbeatMs: 10 });
    await settled(cancelled, "running");
    await store.cancel(scopeA, cancelled);
    expect(await settled(cancelled, "cancelled")).toMatchObject({ cancelRequested: true, errorCode: null });
    await worker!.stop();
    const between = await queue("graph_refresh");
    let calls = 0;
    start({ graph_refresh: async () => {
      calls += 1;
      if (calls === 1) await store.cancel(scopeA, between);
      return { caughtUp: false, stopCode: null, summary: { calls } };
    } });
    expect(await settled(between, "cancelled")).toMatchObject({ steps: 1, result: { calls: 1 } });
  });

  it("gives up a job whose lease another worker took, without writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blocked = await queue("sync");
    let seen: AbortSignal | null = null;
    start({ sync: (context) => {
      seen = context.signal;
      return blocking(context);
    } }, { heartbeatMs: 10 });
    await settled(blocked, "running");
    await exec(sql`UPDATE brain_jobs SET lease_owner = 'w_other' WHERE job_id = ${blocked}`);
    await vi.waitFor(() => expect(seen?.reason).toBe("lease_lost"));
    expect(await store.get(scopeA, blocked)).toMatchObject({ status: "running", steps: 0 });
    await worker!.stop();
    await exec(sql`DELETE FROM brain_jobs`);
    const stolen = await queue("graph_refresh");
    start({ graph_refresh: async () => {
      await exec(sql`UPDATE brain_jobs SET lease_owner = 'w_other' WHERE job_id = ${stolen}`);
      return { caughtUp: false, stopCode: null, summary: {} };
    } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await store.get(scopeA, stolen)).toMatchObject({ status: "running", steps: 0 });
    await worker!.stop();
    await exec(sql`DELETE FROM brain_jobs`);
    const erased = await queue("search_refresh");
    start({ search_refresh: async () => {
      await store.eraseScope(scopeA);
      return { caughtUp: true, stopCode: null, summary: {} };
    } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[brain-jobs] Job lease lost before its result was written"));
    expect(await store.get(scopeA, erased)).toBeNull();
  });

  it("runs at most `concurrency` jobs at once and picks up the rest", async () => {
    let active = 0;
    let peak = 0;
    const ids = [await queue("sync"), await queue("graph_refresh"), await queue("search_refresh")];
    const step: BrainJobStep = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { caughtUp: true, stopCode: null, summary: {} };
    };
    start({ sync: step, graph_refresh: step, search_refresh: step }, { concurrency: 2 });
    for (const id of ids) await settled(id);
    expect(peak).toBe(2);
  });

  it("recovers expired leases of a crashed gateway and wakes on enqueue", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const crashed = await queue("sync");
    await store.claim("owner_a", "w_dead", 1_000);
    harness.tick(2_000);
    start({ sync: async () => ({ caughtUp: true, stopCode: null, summary: {} }) });
    expect(await settled(crashed)).toMatchObject({ attempts: 2 });
    expect(warn).toHaveBeenCalledWith("[brain-jobs] Expired leases: 1 queued again, 0 closed");
    const later = await queue("sync");
    worker!.wake();
    worker!.wake();
    await settled(later);
  });

  it("hands running jobs back on stop and bounds the wait", async () => {
    const jobId = await queue("sync");
    const w = start({ sync: blocking });
    w.start();
    await settled(jobId, "running");
    await w.stop();
    expect(await store.get(scopeA, jobId)).toMatchObject({ status: "queued", attempts: 0 });
    w.wake();
    await w.stop();
    const stuck = await queue("graph_refresh");
    let hold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { hold = resolve; });
    const release = vi.spyOn(store, "release").mockImplementationOnce(async () => {
      await held;
      return true;
    });
    const slow = start({ graph_refresh: hung }, { stopWaitMs: 20 });
    await settled(stuck, "running");
    const began = Date.now();
    await slow.stop();
    expect(Date.now() - began).toBeLessThan(1_000);
    hold();
    expect(release).toHaveBeenCalledTimes(1);
    worker = null;
  });

  it("hands back a job whose claim was in flight when stop() ran, and never runs it", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const raw = new BrainJobStore(harness.db, { now: harness.now });
    const claim = vi.spyOn(store, "claim").mockImplementationOnce(async (ownerId, workerId, leaseMs) => {
      await gate;
      return raw.claim(ownerId, workerId, leaseMs);
    });
    const jobId = await queue("sync");
    let calls = 0;
    const w = start({ sync: async () => {
      calls += 1;
      return { caughtUp: true, stopCode: null, summary: {} };
    } });
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    const stopping = w.stop();
    open();
    await stopping;
    expect(await store.get(scopeA, jobId)).toMatchObject({ status: "queued", attempts: 0, steps: 0 });
    expect(calls).toBe(0);
  });

  it("warns when a job claimed as stop() ran was taken by another worker before it went back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const raw = new BrainJobStore(harness.db, { now: harness.now });
    const claim = vi.spyOn(store, "claim").mockImplementationOnce(async (ownerId, workerId, leaseMs) => {
      await gate;
      const job = await raw.claim(ownerId, workerId, leaseMs);
      await sql`UPDATE brain_jobs SET lease_owner = 'w_other'`.execute(harness.db);
      return job;
    });
    const jobId = await queue("sync");
    const w = start({ sync: async () => ({ caughtUp: true, stopCode: null, summary: {} }) });
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    const stopping = w.stop();
    open();
    await stopping;
    expect(warn).toHaveBeenCalledWith("[brain-jobs] Job lease lost before its result was written");
    expect(await store.get(scopeA, jobId)).toMatchObject({ status: "running", steps: 0 });
  });

  it("hands a job back when the worker stops as its step starts", async () => {
    const jobId = await queue("sync");
    const stopped: { done?: Promise<void> } = {};
    let calls = 0;
    const w = start({ sync: async () => {
      calls += 1;
      stopped.done = w.stop();
      return { caughtUp: true, stopCode: null, summary: {} };
    } });
    await vi.waitFor(() => expect(stopped.done).toBeDefined());
    await stopped.done;
    await vi.waitFor(async () => expect(await store.get(scopeA, jobId))
      .toMatchObject({ status: "queued", attempts: 0, steps: 0 }));
    expect(calls).toBe(1);
  });

  it("sends no timed heartbeat once its run has stopped", async () => {
    const jobId = await queue("sync");
    let seen: AbortSignal | null = null;
    let beats = 0;
    const late: number[] = [];
    const watched = new Proxy(store, {
      get(object, prop, receiver) {
        const value: unknown = Reflect.get(object, prop, receiver);
        if (prop !== "heartbeat" || typeof value !== "function") return value;
        return async (...args: Parameters<BrainJobStore["heartbeat"]>) => {
          if (args[3] === undefined) {
            beats += 1;
            if (seen?.aborted) late.push(beats);
          } else {
            // The step's own heartbeat is slow, so the time cap stops the run while it is in flight.
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
          return (value as BrainJobStore["heartbeat"]).apply(object, args);
        };
      },
    });
    worker = createBrainJobWorker({
      store: watched, ownerId: "owner_a", workerId: "w_test", limits: { ...FAST, heartbeatMs: 10, jobWallClockMs: 30 },
      steps: { sync: async ({ signal }) => {
        seen = signal;
        return { caughtUp: false, stopCode: null, summary: {} };
      } },
    });
    worker.start();
    expect(await settled(jobId, "failed")).toMatchObject({ errorCode: "time_limit", steps: 1 });
    expect(seen!.aborted).toBe(true);
    expect(late).toEqual([]);
  });

  it("ends a poll that was woken again once the worker stops", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recover = vi.spyOn(store, "recover").mockImplementationOnce(async () => {
      await gate;
      return { requeued: 0, closed: 0 };
    });
    const claim = vi.spyOn(store, "claim");
    const w = start({});
    w.wake();
    const stopping = w.stop();
    release();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it("logs poll, heartbeat and run failures without stopping", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const claim = vi.spyOn(store, "claim").mockRejectedValueOnce(new RangeError("db down"));
    const jobId = await queue("sync");
    let calls = 0;
    const heartbeat = vi.spyOn(store, "heartbeat");
    heartbeat.mockImplementationOnce(() => Promise.reject(new SyntaxError("beat")));
    start({ sync: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { caughtUp: true, stopCode: null, summary: {} };
    } }, { heartbeatMs: 10, pollMs: 15 });
    await settled(jobId);
    expect(error).toHaveBeenCalledWith("[brain-jobs] Poll failed:", "RangeError");
    expect(error).toHaveBeenCalledWith("[brain-jobs] Heartbeat failed:", "SyntaxError");
    claim.mockRestore();
    await worker!.stop();
    const finish = vi.spyOn(store, "finish").mockRejectedValueOnce("not an error");
    const failing = await queue("graph_refresh");
    start({ graph_refresh: async () => ({ caughtUp: true, stopCode: null, summary: {} }) });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("[brain-jobs] Job run failed:", "UnknownError"));
    finish.mockRestore();
    expect(await store.get(scopeA, failing)).toMatchObject({ status: "running" });
    expect(calls).toBe(1);
  });
});

describe("brain job worker helpers", () => {
  it("clamps limits to their floors and ceilings", () => {
    expect(resolveBrainJobWorkerLimits()).toEqual(BRAIN_JOB_WORKER_DEFAULTS);
    const resolved = resolveBrainJobWorkerLimits({
      concurrency: 0, stepPauseMs: -5, retryDelayMs: -1, leaseMs: Number.POSITIVE_INFINITY, maxSteps: 1e9, pollMs: 2.7,
    });
    expect(resolved).toMatchObject({
      concurrency: 1, stepPauseMs: 0, retryDelayMs: 1, leaseMs: BRAIN_JOB_WORKER_DEFAULTS.leaseMs,
      maxSteps: BRAIN_JOB_WORKER_CEILINGS.maxSteps, pollMs: 2,
    });
  });

  it("clips summaries and reads error codes", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(clipBrainJobSummary(many))).toHaveLength(16);
    expect(clipBrainJobSummary({
      ok: "x".repeat(300), n: Number.NaN, ["a".repeat(41)]: 1, "1x": 2, flag: true, none: null,
    })).toEqual({ ok: "x".repeat(200), flag: true, none: null });
    expect(brainJobErrorCode(Object.assign(new Error("e"), { code: "sync_in_progress" }))).toBe("sync_in_progress");
    expect(brainJobErrorCode(Object.assign(new Error("e"), { code: "Bad" }))).toBe("step_failed");
    expect(brainJobErrorCode({ code: 7 })).toBe("step_failed");
    expect(brainJobErrorCode(null)).toBe("step_failed");
    expect(brainJobErrorCode("text")).toBe("step_failed");
  });

  it("uses a random worker id and default limits when none are given", async () => {
    const own = createBrainJobWorker({ store, ownerId: "owner_a", steps: {} });
    expect(own.name).toBe("brain-jobs");
    await own.stop();
  });
});
