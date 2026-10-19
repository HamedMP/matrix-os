import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { PostgresComputeBudgetStore, type ComputeBudgetDatabase } from "../../packages/workspace-worker/src/data/compute-budget.js";
import { parseQueuedJob } from '../../packages/workspace-worker/src/bridge.js';

describe("durable owner compute budgets", () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let db: Kysely<ComputeBudgetDatabase>;
  let store: PostgresComputeBudgetStore;
  const policy = (ownerId: string, allowanceMs = 1_000, periodId = "october", startsAt = 100, endsAt = 1_000) => ({ ownerId, allowanceMs, periodId, startsAt, endsAt });
  const reserve = (ownerId: string, reservationId = "job", amountMs = 500, periodId = "october", now = 200) => store.reserve({ ownerId, reservationId, amountMs, periodId, now });
  beforeAll(async () => {
    engine = await createTestPGlite();
    db = new Kysely<ComputeBudgetDatabase>({ dialect: engine.dialect });
    store = new PostgresComputeBudgetStore(db);
    await store.initialize();
    await store.initialize();
  });
  afterAll(async () => { await db?.destroy(); if (engine && !engine.client.closed) await engine.client.close(); });

  it.each(['_preview','-preview','_','-','a'.repeat(160)])('reserves authenticated job identities without narrowing them: %s',async ownerId=>{
    const job=parseQueuedJob({ownerId,jobId:ownerId,type:'wake'});
    await store.provisionPolicy(policy(job.ownerId));
    expect(await reserve(job.ownerId,job.jobId,100)).toMatchObject({ownerId,reservationId:ownerId,state:'held'});
    expect(await store.settle({ownerId,reservationId:ownerId,actualMs:20})).toMatchObject({settledMs:20});
  });

  it("fails closed without a provisioned active policy and never creates one on admission", async () => {
    await expect(reserve("absent")).rejects.toMatchObject({ code: "policy_unavailable" });
    expect(await store.snapshot({ ownerId: "absent", periodId: "october" })).toBeNull();
    await store.provisionPolicy(policy("window"));
    await expect(reserve("window", "early", 10, "october", 99)).rejects.toMatchObject({ code: "policy_unavailable" });
    await expect(reserve("window", "expired", 10, "october", 1_000)).rejects.toMatchObject({ code: "policy_unavailable" });
    expect(await reserve("window", "boundary", 10, "october", 100)).toMatchObject({ state: "held", amountMs: 10, settledMs: null });
    await store.provisionPolicy(policy("zero", 0));
    await expect(reserve("zero", "zero", 1)).rejects.toMatchObject({ code: "exhausted" });
  });
  it("reserves once with an immutable owner/period/amount fingerprint, even after expiry", async () => {
    await store.provisionPolicy(policy("duplicate"));
    const first = await reserve("duplicate");
    expect(await reserve("duplicate")).toEqual(first);
    expect(await reserve("duplicate", "job", 500, "october", 1_001)).toEqual(first);
    await expect(reserve("duplicate", "job", 501)).rejects.toMatchObject({ code: "conflict" });
    await store.provisionPolicy(policy("duplicate", 1_000, "november", 1_000, 2_000));
    await expect(reserve("duplicate", "job", 500, "november", 1_100)).rejects.toMatchObject({ code: "conflict" });
    expect(await store.snapshot({ ownerId: "duplicate", periodId: "october" })).toMatchObject({ heldMs: 500, settledMs: 0, availableMs: 500 });
  });
  it("isolates owners with identical period and job IDs", async () => {
    await store.provisionPolicy(policy("other", 100));
    expect(await reserve("other", "job", 100)).toMatchObject({ ownerId: "other" });
    await expect(reserve("other", "too_much", 1)).rejects.toMatchObject({ code: "exhausted" });
    await expect(store.settle({ ownerId: "unrelated", reservationId: "job", actualMs: 0 })).rejects.toMatchObject({ code: "not_found" });
    await expect(store.markUncertain({ ownerId: "unrelated", reservationId: "job" })).rejects.toMatchObject({ code: "not_found" });
    expect(await store.snapshot({ ownerId: "duplicate", periodId: "october" })).toMatchObject({ heldMs: 500 });
  });
  it("retains uncertain cancellation holds across expiry and period rollover", async () => {
    await store.provisionPolicy(policy("cancel", 500));
    await reserve("cancel");
    expect(await store.markUncertain({ ownerId: "cancel", reservationId: "job" })).toMatchObject({ state: "uncertain", settledMs: null });
    expect(await store.markUncertain({ ownerId: "cancel", reservationId: "job" })).toMatchObject({ state: "uncertain" });
    await expect(reserve("cancel", "retry", 1)).rejects.toMatchObject({ code: "exhausted" });
    await store.provisionPolicy(policy("cancel", 100, "november", 1_000, 2_000));
    expect(await reserve("cancel", "new_job", 100, "november", 1_100)).toMatchObject({ periodId: "november", state: "held" });
    expect(await store.snapshot({ ownerId: "cancel", periodId: "october" })).toMatchObject({ heldMs: 500, availableMs: 0 });
    await store.settle({ ownerId: "cancel", reservationId: "job", actualMs: 400 });
    expect(await store.snapshot({ ownerId: "cancel", periodId: "october" })).toMatchObject({ heldMs: 0, settledMs: 400 });
    expect(await store.snapshot({ ownerId: "cancel", periodId: "november" })).toMatchObject({ heldMs: 100, settledMs: 0 });
  });
  it("settles bounded actual usage once and releases only confirmed unused time", async () => {
    await store.provisionPolicy(policy("settle", 500));
    await reserve("settle");
    const settled = await store.settle({ ownerId: "settle", reservationId: "job", actualMs: 120 });
    expect(settled).toMatchObject({ state: "settled", settledMs: 120 });
    expect(await store.settle({ ownerId: "settle", reservationId: "job", actualMs: 0 })).toEqual(settled);
    expect(await store.settle({ ownerId: "settle", reservationId: "job", actualMs: 500 })).toEqual(settled);
    expect(await store.markUncertain({ ownerId: "settle", reservationId: "job" })).toEqual(settled);
    expect(await reserve("settle", "job")).toEqual(settled);
    expect(await store.snapshot({ ownerId: "settle", periodId: "october" })).toMatchObject({ heldMs: 0, settledMs: 120, availableMs: 380 });
    await reserve("settle", "overrun", 380);
    expect(await store.settle({ ownerId: "settle", reservationId: "overrun", actualMs: 900 })).toMatchObject({ settledMs: 380 });
    await expect(reserve("settle", "empty", 1)).rejects.toMatchObject({ code: "exhausted" });
  });
  it("does not erase reservations or create headroom during a policy downgrade", async () => {
    await store.provisionPolicy(policy("downgrade"));
    await reserve("downgrade", "running", 700);
    await store.provisionPolicy(policy("downgrade", 100));
    expect(await store.snapshot({ ownerId: "downgrade", periodId: "october" })).toMatchObject({ allowanceMs: 100, heldMs: 700, availableMs: 0 });
    await expect(reserve("downgrade", "blocked", 1)).rejects.toMatchObject({ code: "exhausted" });
    await store.settle({ ownerId: "downgrade", reservationId: "running", actualMs: 200 });
    expect(await store.snapshot({ ownerId: "downgrade", periodId: "october" })).toMatchObject({ heldMs: 0, settledMs: 200, availableMs: 0 });
    await store.provisionPolicy(policy("downgrade", 500));
    expect(await reserve("downgrade", "upgrade", 300)).toMatchObject({ state: "held" });
    await expect(store.provisionPolicy({ ...policy("downgrade"), endsAt: 1_001 })).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejects a settled row without final usage at the database boundary", async () => {
    await store.provisionPolicy(policy("invalid_settlement"));
    await expect(db.insertInto("shared_compute_reservations").values({
      owner_id: "invalid_settlement", period_id: "october", reservation_id: "corrupt",
      amount_ms: 100, state: "settled", settled_ms: null,
    }).execute()).rejects.toThrow();
  });
  it("rejects malformed IDs, unsafe or negative numbers, and unbounded windows/tasks", async () => {
    for (const value of ["", "bad/id", "a".repeat(161), 'owner.with.dot', 'owner:scope']) {
      await expect(store.provisionPolicy(policy(value))).rejects.toMatchObject({ code: "invalid" });
      await expect(store.markUncertain({ ownerId: "valid", reservationId: value })).rejects.toMatchObject({ code: "invalid" });
    }
    for (const periodId of ['', 'bad/id', 'a'.repeat(129)]) {
      await expect(store.snapshot({ ownerId:'valid', periodId })).rejects.toMatchObject({code:'invalid'});
    }
    for (const amountMs of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER, Infinity, NaN, 1_800_001]) {
      await expect(reserve("valid", "job", amountMs)).rejects.toMatchObject({ code: "invalid" });
    }
    for (const allowanceMs of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
      await expect(store.provisionPolicy(policy("valid", allowanceMs))).rejects.toMatchObject({ code: "invalid" });
    }
    for (const actualMs of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
      await expect(store.settle({ ownerId: "valid", reservationId: "job", actualMs })).rejects.toMatchObject({ code: "invalid" });
    }
    for (const now of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
      await expect(reserve("valid", "job", 1, "october", now)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(store.provisionPolicy(policy("invalid_window", 100, "october", 200, 200))).rejects.toMatchObject({ code: "invalid" });
    await expect(store.provisionPolicy(policy("unbounded", 100, "october", 0, 366 * 86_400_000 + 1))).rejects.toMatchObject({ code: "invalid" });
  });
});
