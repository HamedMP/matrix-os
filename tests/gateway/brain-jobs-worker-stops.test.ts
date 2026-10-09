/**
 * The job worker's stops: a refresh that cannot progress, a cancel told to this gateway's worker, and a run that waits
 * behind another run of the project. The same PGlite harness as brain-jobs-worker.test.ts.
 */
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainJobStore, bootstrapBrainJobsDatabase, createBrainJobSteps, createBrainJobWorker, type BrainJobStep,
  type BrainJobSteps, type BrainJobView, type BrainJobWorker, type BrainJobWorkerLimits,
} from "../../packages/gateway/src/brain/jobs/index.js";
import { createBrainHarness, scopeA, scopeB, type BrainHarness } from "./helpers/brain-store-helpers.js";

let harness: BrainHarness;
let store: BrainJobStore;
let worker: BrainJobWorker | null = null;
const FAST: Partial<BrainJobWorkerLimits> = {
  pollMs: 10_000, heartbeatMs: 10_000, stepPauseMs: 0, retryDelayMs: 1, stopWaitMs: 200,
};

// PGlite is one connection: every database call of this file runs one at a time.
let chain: Promise<unknown> = Promise.resolve();
function serialized(target: BrainJobStore): BrainJobStore {
  return new Proxy(target, {
    get(object, prop, receiver) {
      const value: unknown = Reflect.get(object, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const run = chain.then(() => (value as (...a: unknown[]) => Promise<unknown>).apply(object, args));
        chain = run.then(() => undefined, () => undefined);
        return run;
      };
    },
  });
}

beforeAll(async () => {
  harness = await createBrainHarness();
  await bootstrapBrainJobsDatabase(harness.db);
  store = serialized(new BrainJobStore(harness.db, { now: harness.now }));
});
afterAll(async () => { await harness.destroy(); });
beforeEach(async () => { await sql`DELETE FROM brain_jobs`.execute(harness.db); });
afterEach(async () => {
  await worker?.stop();
  worker = null;
  vi.restoreAllMocks();
});

function start(steps: BrainJobSteps, limits: Partial<BrainJobWorkerLimits> = {}): BrainJobWorker {
  worker = createBrainJobWorker({ store, ownerId: "owner_a", steps, limits: { ...FAST, ...limits }, workerId: "w_test" });
  worker.start();
  return worker;
}

async function settled(jobId: string, status: BrainJobView["status"] = "succeeded") {
  let view: BrainJobView | null = null;
  await vi.waitFor(async () => {
    view = await store.get(scopeA, jobId);
    expect(view?.status).toBe(status);
  }, { timeout: 4_000, interval: 5 });
  return view!;
}

/** A step that waits until its signal aborts, then throws the abort reason. */
const blocking: BrainJobStep = ({ signal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const queue = (kind: "sync" | "graph_refresh" | "search_refresh" = "sync") =>
  store.enqueue(scopeA, "proj_a", { kind }).then((result) => result.job.jobId);

describe("brain job worker stops", () => {
  it("stops a refresh that makes no progress after one step instead of re-running it", async () => {
    // The real refresh steps over an index whose embedding provider keeps failing (a 401, a 429 or the network).
    const refresh = vi.fn(async () => ({ processed: 0, removed: 0, caughtUp: false, stopReason: "embedding_unavailable" as const }));
    const steps = createBrainJobSteps({
      project: {} as never, search: { name: "search", refresh, freshness: vi.fn(), handle: vi.fn() } as never,
      graph: { name: "graph", refresh: vi.fn(async () => ({ processed: 0, removed: 0, caughtUp: false,
        stopReason: "graph_capacity" as const })), freshness: vi.fn(), handle: vi.fn() } as never,
    });
    start(steps);
    const search = await queue("search_refresh");
    const graph = await queue("graph_refresh");
    expect(await settled(search, "failed")).toMatchObject({
      errorCode: "embedding_unavailable", steps: 1, result: { stopCode: "embedding_unavailable" },
    });
    expect(await settled(graph, "failed")).toMatchObject({ errorCode: "graph_capacity", steps: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops a running job at once when told of its cancel, long before the next heartbeat", async () => {
    const job = await queue("sync");
    const w = start({ sync: blocking }, { heartbeatMs: 300_000 });
    await settled(job, "running");
    expect(w.cancel(scopeB, job)).toBe(false);
    await store.cancel(scopeA, job);
    const asked = Date.now();
    expect(w.cancel(scopeA, job)).toBe(true);
    expect(w.cancel(scopeA, job)).toBe(false);
    expect(await settled(job, "cancelled")).toMatchObject({ cancelRequested: true, errorCode: null });
    expect(Date.now() - asked).toBeLessThan(2_000);
    expect(w.cancel(scopeA, `job_${"0".repeat(32)}`)).toBe(false);
  });

  it("never starts the step of a run cancelled between its claim and its launch", async () => {
    const job = (await store.enqueue(scopeA, "proj_a", { kind: "extract", extractor: "model" })).job.jobId;
    // An unserialized store on the same database: the claim below already holds this file's one-at-a-time slot.
    const raw = new BrainJobStore(harness.db, { now: harness.now });
    let told: boolean | null = null;
    vi.spyOn(store, "claim").mockImplementation(async (ownerId, workerId, leaseMs) => {
      const claimed = await raw.claim(ownerId, workerId, leaseMs);
      if (claimed !== null) {
        // The cancel commits after the claim and reaches the worker before launch registers the run.
        await raw.cancel(claimed.scope, claimed.jobId);
        told = worker!.cancel(claimed.scope, claimed.jobId);
      }
      return claimed;
    });
    const extract = vi.fn(blocking);
    start({ extract }, { heartbeatMs: 300_000 });
    expect(await settled(job, "cancelled")).toMatchObject({
      cancelRequested: true, errorCode: null, attempts: 1, steps: 0,
    });
    expect(told).toBe(false);
    expect(extract).not.toHaveBeenCalled();
  });

  it("stops its old run of a job it claims again after the lease expired, and cancels only the new run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const job = await queue("sync");
    const signals: AbortSignal[] = [];
    const w = start({ sync: (context) => {
      signals.push(context.signal);
      return blocking(context);
    } }, { concurrency: 2 });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    // The heartbeats were missed (a stalled database): this worker's next poll recovers the lease and claims it again.
    harness.tick(60_001);
    w.wake();
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.reason).toBe("lease_lost");
    expect(signals[1]!.aborted).toBe(false);
    expect(await store.get(scopeA, job)).toMatchObject({ status: "running", attempts: 2, steps: 0 });
    // The old run has ended by now; its end must not drop the new run from cancel.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.cancel(scopeA, job);
    expect(w.cancel(scopeA, job)).toBe(true);
    expect(await settled(job, "cancelled")).toMatchObject({ attempts: 2, steps: 0, cancelRequested: true });
    expect(warn).toHaveBeenCalledWith("[brain-jobs] Expired leases: 1 queued again, 0 closed");
  });

  it("ends a run cancelled when the cancel lands while its last step completes", async () => {
    const job = await queue("graph_refresh");
    start({ graph_refresh: async () => {
      await store.cancel(scopeA, job);
      return { caughtUp: true, stopCode: null, summary: { processed: 3 } };
    } });
    expect(await settled(job, "cancelled")).toMatchObject({
      cancelRequested: true, errorCode: null, steps: 1, result: { processed: 3 },
    });
  });

  it("ends a busy run whose wait note finds it cancelled or gone, without retrying", async () => {
    const cancelled = await queue("graph_refresh");
    let calls = 0;
    start({ graph_refresh: async () => {
      calls += 1;
      await store.cancel(scopeA, cancelled);
      throw Object.assign(new Error("busy"), { code: "extraction_in_progress" });
    } }, { retryDelayMs: 60_000 });
    expect(await settled(cancelled, "cancelled")).toMatchObject({ cancelRequested: true });
    expect(calls).toBe(1);
    await worker!.stop();
    const gone = await queue("search_refresh");
    start({ search_refresh: async () => {
      await store.eraseScope(scopeA);
      throw Object.assign(new Error("busy"), { code: "sync_in_progress" });
    } }, { retryDelayMs: 60_000 });
    await vi.waitFor(async () => expect(await store.get(scopeA, gone)).toBeNull(), { timeout: 4_000, interval: 5 });
    await worker!.stop();
    expect(await store.get(scopeA, gone)).toBeNull();
  });

  it("says a busy run is waiting, once per wait, and sees a cancel while it waits", async () => {
    const waiting = await queue("graph_refresh");
    const heartbeat = vi.spyOn(store, "heartbeat");
    start({ graph_refresh: async () => { throw Object.assign(new Error("busy"), { code: "extraction_in_progress" }); } },
      { retryDelayMs: 5 });
    await vi.waitFor(async () => expect((await store.get(scopeA, waiting))?.result)
      .toEqual({ waiting: "extraction_in_progress" }), { timeout: 4_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heartbeat.mock.calls.filter((call) => call[2] !== undefined)).toHaveLength(1);
    await store.cancel(scopeA, waiting);
    worker!.cancel(scopeA, waiting);
    expect(await settled(waiting, "cancelled")).toMatchObject({ result: { waiting: "extraction_in_progress" } });
  });
});
