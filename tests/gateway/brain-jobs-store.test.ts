import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_JOB_INTERRUPTED_CODE, BRAIN_JOB_LIMITS, BrainJobError, BrainJobStore, bootstrapBrainJobsDatabase, brainJobTarget,
  clipBrainJobSummary, type BrainJobRequest, type BrainJobSummary,
} from "../../packages/gateway/src/brain/jobs/index.js";
import { createBrainHarness, scopeA, scopeB, scopeOtherOwner, type BrainHarness } from "./helpers/brain-store-helpers.js";

let harness: BrainHarness;
let store: BrainJobStore;
const W = "w_one";
const LEASE = 60_000;
const sync: BrainJobRequest = { kind: "sync" };

async function insertRows(count: number, values: (i: number) => string): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => values(i)).join(",");
  await sql.raw(`INSERT INTO brain_jobs (owner_id, scope_id, job_id, project_id, kind, target, request, status,
    created_at, updated_at, finished_at) VALUES ${rows}`).execute(harness.db);
}
const hex = (i: number) => i.toString(16).padStart(32, "0");

beforeEach(async () => {
  harness = await createBrainHarness();
  await bootstrapBrainJobsDatabase(harness.db);
  store = new BrainJobStore(harness.db, { now: harness.now });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.destroy();
});

describe("brain job store", () => {
  it("bootstraps idempotently and derives dedupe targets", async () => {
    await bootstrapBrainJobsDatabase(harness.db);
    expect(brainJobTarget({ kind: "sync" })).toBe("git");
    expect(brainJobTarget({ kind: "sync", sourceId: `src_${hex(1)}` })).toBe(`src_${hex(1)}`);
    expect(brainJobTarget({ kind: "extract", extractor: "model" })).toBe("model");
    expect(brainJobTarget({ kind: "brief", window: "week" })).toBe("week");
    expect(brainJobTarget({ kind: "graph_refresh" })).toBe("");
    expect(new BrainJobStore(harness.db)).toBeInstanceOf(BrainJobStore);
  });

  it("queues a job once per (scope, kind, target) and keeps scopes apart", async () => {
    const first = await store.enqueue(scopeA, "proj_a", sync);
    expect(first.created).toBe(true);
    expect(first.job).toMatchObject({
      projectId: "proj_a", kind: "sync", request: { kind: "sync" }, status: "queued", attempts: 0, steps: 0,
      cancelRequested: false, errorCode: null, result: null, startedAt: null, heartbeatAt: null, finishedAt: null,
      createdAt: harness.iso(), updatedAt: harness.iso(),
    });
    expect(first.job.jobId).toMatch(/^job_[a-f0-9]{32}$/);
    const again = await store.enqueue(scopeA, "proj_a", sync);
    expect(again).toEqual({ job: first.job, created: false });
    expect((await store.enqueue(scopeA, "proj_a", { kind: "sync", sourceId: `src_${hex(2)}` })).created).toBe(true);
    expect((await store.enqueue(scopeB, "proj_b", sync)).created).toBe(true);
    expect(await store.get(scopeA, first.job.jobId)).toEqual(first.job);
    expect(await store.get(scopeB, first.job.jobId)).toBeNull();
    expect(await store.get(scopeOtherOwner, first.job.jobId)).toBeNull();
    harness.tick();
    const brief = await store.enqueue(scopeA, "proj_a", { kind: "brief", window: "day" });
    const listed = await store.list(scopeA, 10);
    expect(listed.map((job) => job.jobId)[0]).toBe(brief.job.jobId);
    expect(listed).toHaveLength(3);
    expect(await store.list(scopeA, 1)).toHaveLength(1);
    expect(await store.list(scopeA, Number.NaN)).toHaveLength(1);
    expect(await store.list(scopeA, 999)).toHaveLength(3);
  });

  it("refuses past the active cap per owner and prunes finished jobs per scope", async () => {
    await insertRows(BRAIN_JOB_LIMITS.activePerOwner, (i) =>
      `('owner_a', 'scope_${i}', 'job_${hex(i)}', 'p', 'sync', 'git', '{"kind":"sync"}', 'queued', now(), now(), NULL)`);
    await expect(store.enqueue(scopeA, "proj_a", sync)).rejects.toEqual(new BrainJobError("jobs_full"));
    expect((await store.enqueue(scopeOtherOwner, "proj_a", sync)).created).toBe(true);
    await sql`DELETE FROM brain_jobs`.execute(harness.db);
    const keep = BRAIN_JOB_LIMITS.finishedPerScope;
    await insertRows(keep + 5, (i) => `('owner_a', 'scope_a', 'job_${hex(i)}', 'p', 'brief', 'day',
      '{"kind":"brief","window":"day"}', 'succeeded', now(), now(), now() - interval '${i} minutes')`);
    await insertRows(3, (i) => `('owner_a', 'scope_b', 'job_${hex(100 + i)}', 'p', 'brief', 'day',
      '{"kind":"brief","window":"day"}', 'failed', now(), now(), now())`);
    await store.enqueue(scopeA, "proj_a", sync);
    const { rows } = await sql<{ scope_id: string; n: number }>`
      SELECT scope_id, count(*)::int AS n FROM brain_jobs WHERE finished_at IS NOT NULL GROUP BY scope_id
      ORDER BY scope_id`.execute(harness.db);
    expect(rows).toEqual([{ scope_id: "scope_a", n: keep }, { scope_id: "scope_b", n: 3 }]);
    const gone = await sql<{ n: number }>`SELECT count(*)::int AS n FROM brain_jobs
      WHERE job_id IN (${`job_${hex(keep + 4)}`}, ${`job_${hex(keep)}`})`.execute(harness.db);
    expect(gone.rows[0]!.n).toBe(0);
  });

  it("claims the oldest queued job with a lease and fences worker writes by the lease", async () => {
    const older = await store.enqueue(scopeA, "proj_a", sync);
    harness.tick();
    const newer = await store.enqueue(scopeB, "proj_b", { kind: "extract", extractor: "model" });
    expect(await store.claim("owner_b", W, LEASE)).toBeNull();
    const job = (await store.claim("owner_a", W, LEASE))!;
    expect(job).toEqual({
      scope: scopeA, jobId: older.job.jobId, projectId: "proj_a", request: { kind: "sync" }, attempts: 1, steps: 0,
    });
    const view = (await store.get(scopeA, job.jobId))!;
    expect(view).toMatchObject({ status: "running", attempts: 1, startedAt: harness.iso(), heartbeatAt: harness.iso() });
    const second = (await store.claim("owner_a", "w_two", LEASE))!;
    expect(second.jobId).toBe(newer.job.jobId);
    expect(second.request).toEqual({ kind: "extract", extractor: "model" });
    expect(await store.claim("owner_a", W, LEASE)).toBeNull();

    harness.tick(5_000);
    expect(await store.heartbeat(job, W, LEASE)).toEqual({ owned: true, cancelRequested: false });
    expect(await store.heartbeat(job, "w_two", LEASE)).toEqual({ owned: false, cancelRequested: false });
    expect(await store.heartbeat(job, W, LEASE, { steps: 2, result: { written: 3 } }))
      .toEqual({ owned: true, cancelRequested: false });
    expect(await store.get(scopeA, job.jobId)).toMatchObject({ steps: 2, result: { written: 3 }, heartbeatAt: harness.iso() });
    expect(await store.finish(job, "w_two", { status: "failed", errorCode: "x", steps: 2, result: null })).toBe(false);
    expect(await store.release(job, "w_two", { steps: 2, result: null })).toBe(false);
    expect(await store.finish(job, W, { status: "succeeded", errorCode: null, steps: 3, result: { done: true } }))
      .toBe(true);
    expect(await store.get(scopeA, job.jobId)).toMatchObject({
      status: "succeeded", steps: 3, result: { done: true }, finishedAt: harness.iso(), errorCode: null,
    });
    expect(await store.finish(job, W, { status: "failed", errorCode: "x", steps: 3, result: null })).toBe(false);
    expect((await store.enqueue(scopeA, "proj_a", sync)).created).toBe(true);
  });

  it("fences worker writes by the claim, even when the same worker claims the job again", async () => {
    await store.enqueue(scopeA, "proj_a", sync);
    const stale = (await store.claim("owner_a", W, LEASE))!;
    harness.tick(LEASE + 1);
    expect(await store.recover("owner_a", 3)).toEqual({ requeued: 1, closed: 0 });
    const fresh = (await store.claim("owner_a", W, LEASE))!;
    expect(fresh).toMatchObject({ jobId: stale.jobId, attempts: 2 });
    expect(await store.heartbeat(stale, W, LEASE, { steps: 9, result: { stale: true } }))
      .toEqual({ owned: false, cancelRequested: false });
    expect(await store.finish(stale, W, { status: "failed", errorCode: "x", steps: 9, result: null })).toBe(false);
    expect(await store.release(stale, W, { steps: 9, result: null })).toBe(false);
    expect(await store.get(scopeA, fresh.jobId)).toMatchObject({ status: "running", attempts: 2, steps: 0, result: null });
    expect(await store.heartbeat(fresh, W, LEASE, { steps: 1, result: { n: 1 } }))
      .toEqual({ owned: true, cancelRequested: false });
    expect(await store.finish(fresh, W, { status: "succeeded", errorCode: null, steps: 1, result: { n: 1 } })).toBe(true);
    expect(await store.get(scopeA, fresh.jobId)).toMatchObject({ status: "succeeded", attempts: 2, steps: 1 });
  });

  it("releases a job without counting the claim, keeping the stored result when none is given", async () => {
    await store.enqueue(scopeA, "proj_a", sync);
    const job = (await store.claim("owner_a", W, LEASE))!;
    expect(await store.release(job, W, { steps: 4, result: null })).toBe(true);
    expect(await store.get(scopeA, job.jobId)).toMatchObject({ status: "queued", attempts: 0, steps: 4, result: null });
    const again = (await store.claim("owner_a", W, LEASE))!;
    expect(await store.release(again, W, { steps: 5, result: { written: 2 } })).toBe(true);
    const third = (await store.claim("owner_a", W, LEASE))!;
    expect(await store.release(third, W, { steps: 5, result: null })).toBe(true);
    expect(await store.get(scopeA, job.jobId)).toMatchObject({ status: "queued", steps: 5, result: { written: 2 } });
  });

  it("closes a released job as cancelled when a cancel was asked", async () => {
    await store.enqueue(scopeA, "proj_a", sync);
    const job = (await store.claim("owner_a", W, LEASE))!;
    harness.tick();
    await store.cancel(scopeA, job.jobId);
    expect(await store.release(job, W, { steps: 1, result: null })).toBe(true);
    expect(await store.get(scopeA, job.jobId)).toMatchObject({
      status: "cancelled", cancelRequested: true, attempts: 1, steps: 1, finishedAt: harness.iso(), errorCode: null,
    });
    expect(await store.claim("owner_a", W, LEASE)).toBeNull();
  });

  it("finishes a job whose cancel landed before the final write as cancelled, keeping its progress", async () => {
    const done = await store.enqueue(scopeA, "proj_a", sync);
    harness.tick();
    const failing = await store.enqueue(scopeB, "proj_b", sync);
    const first = (await store.claim("owner_a", W, LEASE))!;
    const second = (await store.claim("owner_a", W, LEASE))!;
    expect([first.jobId, second.jobId]).toEqual([done.job.jobId, failing.job.jobId]);
    await store.cancel(scopeA, first.jobId);
    await store.cancel(scopeB, second.jobId);
    harness.tick();
    expect(await store.finish(first, W, { status: "succeeded", errorCode: null, steps: 2, result: { written: 4 } }))
      .toBe(true);
    expect(await store.finish(second, W, { status: "failed", errorCode: "time_limit", steps: 1, result: null }))
      .toBe(true);
    expect(await store.get(scopeA, first.jobId)).toMatchObject({
      status: "cancelled", errorCode: null, cancelRequested: true, steps: 2, result: { written: 4 },
      finishedAt: harness.iso(),
    });
    expect(await store.get(scopeB, second.jobId)).toMatchObject({ status: "cancelled", errorCode: null, steps: 1 });
  });

  it("cancels queued jobs at once and asks running jobs to stop", async () => {
    const queued = await store.enqueue(scopeA, "proj_a", sync);
    harness.tick();
    const cancelled = (await store.cancel(scopeA, queued.job.jobId))!;
    expect(cancelled).toMatchObject({ status: "cancelled", cancelRequested: false, finishedAt: harness.iso() });
    expect(await store.cancel(scopeA, queued.job.jobId)).toEqual(cancelled);
    expect(await store.cancel(scopeB, queued.job.jobId)).toBeNull();
    await store.enqueue(scopeA, "proj_a", sync);
    const job = (await store.claim("owner_a", W, LEASE))!;
    expect(await store.cancel(scopeA, job.jobId)).toMatchObject({ status: "running", cancelRequested: true, finishedAt: null });
    expect(await store.heartbeat(job, W, LEASE)).toEqual({ owned: true, cancelRequested: true });
  });

  it("recovers expired leases: queued again, failed after max attempts, cancelled when asked", async () => {
    const a = await store.enqueue(scopeA, "proj_a", sync);
    const b = await store.enqueue(scopeA, "proj_a", { kind: "graph_refresh" });
    const c = await store.enqueue(scopeA, "proj_a", { kind: "search_refresh" });
    await sql`UPDATE brain_jobs SET attempts = 2 WHERE job_id = ${b.job.jobId}`.execute(harness.db);
    for (let i = 0; i < 3; i += 1) await store.claim("owner_a", W, LEASE);
    await store.cancel(scopeA, c.job.jobId);
    expect(await store.recover("owner_a", 3)).toEqual({ requeued: 0, closed: 0 });
    harness.tick(LEASE + 1);
    expect(await store.recover("owner_b", 3)).toEqual({ requeued: 0, closed: 0 });
    expect(await store.recover("owner_a", 3)).toEqual({ requeued: 1, closed: 2 });
    expect(await store.get(scopeA, a.job.jobId)).toMatchObject({ status: "queued", attempts: 1, finishedAt: null });
    expect(await store.get(scopeA, b.job.jobId)).toMatchObject({
      status: "failed", errorCode: "attempts_exhausted", finishedAt: harness.iso(),
    });
    expect(await store.get(scopeA, c.job.jobId)).toMatchObject({ status: "cancelled", errorCode: null });
  });

  it("never queues a paid model run again: release and lease recovery end it as interrupted", async () => {
    const model = { kind: "extract", extractor: "model" } as const;
    const released = await store.enqueue(scopeA, "proj_a", model);
    harness.tick();
    const rules = await store.enqueue(scopeA, "proj_a", { kind: "extract", extractor: "rules" });
    const job = (await store.claim("owner_a", W, LEASE))!;
    expect(job.jobId).toBe(released.job.jobId);
    harness.tick();
    expect(await store.release(job, W, { steps: 1, result: { claimsWritten: 2 } })).toBe(true);
    expect(await store.get(scopeA, job.jobId)).toMatchObject({
      status: "failed", errorCode: BRAIN_JOB_INTERRUPTED_CODE, attempts: 1, steps: 1, result: { claimsWritten: 2 },
      finishedAt: harness.iso(),
    });
    // The rules run (free) is queued again as before; nothing else is claimable for the model.
    const rulesJob = (await store.claim("owner_a", W, LEASE))!;
    expect(rulesJob.jobId).toBe(rules.job.jobId);
    expect(await store.release(rulesJob, W, { steps: 0, result: null })).toBe(true);
    expect(await store.get(scopeA, rules.job.jobId)).toMatchObject({ status: "queued", attempts: 0 });

    const lost = await store.enqueue(scopeB, "proj_b", model);
    await sql`DELETE FROM brain_jobs WHERE job_id = ${rules.job.jobId}`.execute(harness.db);
    expect((await store.claim("owner_a", W, LEASE))!.jobId).toBe(lost.job.jobId);
    harness.tick(LEASE + 1);
    expect(await store.recover("owner_a", 3)).toEqual({ requeued: 0, closed: 1 });
    expect(await store.get(scopeB, lost.job.jobId)).toMatchObject({
      status: "failed", errorCode: BRAIN_JOB_INTERRUPTED_CODE, attempts: 1, finishedAt: harness.iso(),
    });
    // A cancel asked before the restart still reads cancelled.
    const asked = await store.enqueue(scopeA, "proj_a", model);
    const claimed = (await store.claim("owner_a", W, LEASE))!;
    await store.cancel(scopeA, asked.job.jobId);
    expect(await store.release(claimed, W, { steps: 0, result: null })).toBe(true);
    expect(await store.get(scopeA, asked.job.jobId)).toMatchObject({ status: "cancelled", errorCode: null });
  });

  it("stores every clipped summary within the result cap", async () => {
    const entries = (count: number, value: (i: number) => string | number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value(i)]));
    const summaries: BrainJobSummary[] = [
      entries(16, () => "\u754c".repeat(300)),
      // Control characters are escaped (\u0001 is six bytes in the stored text).
      entries(16, () => "\u0001".repeat(200)),
      // jsonb prints every digit of a number JSON writes in exponent form (about 310 bytes each here).
      { ...entries(4, (i) => (i % 2 === 0 ? -1.7976931348623157e308 : -5e-324)),
        ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, "\u754c".repeat(200)])) },
      { cut: `${"x".repeat(199)}\u{1F600}`, lone: "a\udc00", nul: "a\u0000b" },
    ];
    for (const summary of summaries) {
      await sql`DELETE FROM brain_jobs`.execute(harness.db);
      await store.enqueue(scopeA, "proj_a", sync);
      const job = (await store.claim("owner_a", W, LEASE))!;
      const result = clipBrainJobSummary(summary);
      expect(await store.heartbeat(job, W, LEASE, { steps: 1, result })).toEqual({ owned: true, cancelRequested: false });
      expect((await store.get(scopeA, job.jobId))!.result).toEqual(result);
    }
  });

  it("erases a scope's jobs and reads a damaged stored request as its kind's defaults", async () => {
    const job = await store.enqueue(scopeA, "proj_a", { kind: "extract", extractor: "model" });
    await store.enqueue(scopeB, "proj_b", sync);
    await sql`UPDATE brain_jobs SET request = '{"kind":"extract","extractor":"other"}'::jsonb
      WHERE job_id = ${job.job.jobId}`.execute(harness.db);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await store.get(scopeA, job.job.jobId))!.request).toEqual({ kind: "extract", extractor: "rules" });
    expect(error).toHaveBeenCalledWith("[brain-jobs] Stored request unreadable:", "ZodError");
    expect(await store.eraseScope(scopeA)).toBe(1);
    expect(await store.list(scopeA, 10)).toEqual([]);
    expect(await store.list(scopeB, 10)).toHaveLength(1);
  });
});
