/** Opt-in isolated PostgreSQL proof. Never drops databases or touches unrelated owners. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { PostgresComputeBudgetStore, reserveComputeBudget, type ComputeBudgetDatabase } from "../../packages/workspace-worker/src/data/compute-budget.js";

const secretFile = process.env.MATRIX_SHARED_WORKSPACE_TEST_DATABASE_FILE;
const testDatabaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
// Explicit configuration must run and fail visibly if invalid, never silently skip.
const enabled = secretFile !== undefined || testDatabaseUrl !== undefined;
describe.skipIf(!enabled)("isolated Postgres compute budget concurrency", () => {
  const prefix = `compute_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const owners = Array.from({ length: 6 }, (_, index) => `${prefix}_${index}`);
  let databases: Kysely<ComputeBudgetDatabase>[] = [];
  let stores: PostgresComputeBudgetStore[] = [];
  const period = (ownerId: string, allowanceMs = 500, periodId = "october", startsAt = 0, endsAt = 1_000) => ({ ownerId, periodId, allowanceMs, startsAt, endsAt });
  const reserve = (index: number, ownerId: string, reservationId: string, amountMs = 200, periodId = "october", now = 100) => stores[index].reserve({ ownerId, reservationId, amountMs, periodId, now });
  beforeAll(async () => {
    // Separate pools are required: the in-process fixture cannot prove row-lock isolation.
    // A configured private file takes precedence; missing/unreadable files fail setup.
    const connectionString = secretFile !== undefined ? readFileSync(secretFile, "utf8").trim() : testDatabaseUrl!.trim();
    if (!connectionString) throw new Error("A disposable PostgreSQL test connection is required");
    databases = [0, 1].map(() => new Kysely<ComputeBudgetDatabase>({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString, max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000,
      statement_timeout: 10_000, query_timeout: 12_000,
    }) }) }));
    stores = databases.map((db) => new PostgresComputeBudgetStore(db));
    await stores[0].initialize();
  });
  afterAll(async () => {
    try {
      if (databases[0]) await databases[0].transaction().execute(async (trx) => {
        await trx.deleteFrom("shared_compute_reservations").where("owner_id", "in", owners).execute();
        await trx.deleteFrom("shared_compute_policies").where("owner_id", "in", owners).execute();
      });
    } finally { await Promise.all(databases.map((db) => db.destroy())); }
  });
  it("admits only affordable competing reservations across independent pools", async () => {
    await stores[0].provisionPolicy(period(owners[0]));
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => reserve(index % 2, owners[0], `job_${index}`)));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(rejected).toHaveLength(6);
    expect(rejected.every((attempt) => attempt.status === "rejected" && attempt.reason.code === "exhausted")).toBe(true);
    expect(await stores[1].snapshot({ ownerId: owners[0], periodId: "october" })).toMatchObject({ heldMs: 400, settledMs: 0, availableMs: 100 });
  });
  it("duplicates cannot double-hold or double-release", async () => {
    await stores[0].provisionPolicy(period(owners[1]));
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => reserve(index % 2, owners[1], "same_job", 500)));
    expect(attempts.every((value) => JSON.stringify(value) === JSON.stringify(attempts[0]))).toBe(true);
    expect(await stores[1].snapshot({ ownerId: owners[1], periodId: "october" })).toMatchObject({ heldMs: 500 });
    await Promise.all(Array.from({ length: 8 }, (_, index) => stores[index % 2].settle({ ownerId: owners[1], reservationId: "same_job", actualMs: 20 })));
    expect(await stores[1].snapshot({ ownerId: owners[1], periodId: "october" })).toMatchObject({ heldMs: 0, settledMs: 20, availableMs: 480 });
  });
  it("rejects owner-global key reuse racing across periods without leaking holds", async () => {
    await stores[0].provisionPolicy(period(owners[2]));
    await stores[0].provisionPolicy(period(owners[2], 500, "november", 1_000, 2_000));
    const attempts = await Promise.allSettled([
      reserve(0, owners[2], "one_key", 200),
      reserve(1, owners[2], "one_key", 200, "november", 1_100),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toMatchObject([{ reason: { code: "conflict" } }]);
    const snapshots = await Promise.all(["october", "november"].map((periodId) => stores[0].snapshot({ ownerId: owners[2], periodId })));
    expect(snapshots.reduce((total, snapshot) => total + snapshot!.heldMs, 0)).toBe(200);
  });
  it("rolls reservation and counter back with a failed caller-owned outbox transaction", async () => {
    await stores[0].provisionPolicy(period(owners[3]));
    await expect(databases[0].transaction().execute(async (trx) => {
      await reserveComputeBudget(trx, { ownerId: owners[3], periodId: "october", reservationId: "outbox", amountMs: 500, now: 100 });
      throw new Error("simulated outbox rejection");
    })).rejects.toThrow("simulated outbox rejection");
    expect(await stores[1].snapshot({ ownerId: owners[3], periodId: "october" })).toMatchObject({ heldMs: 0, settledMs: 0 });
    expect(await reserve(1, owners[3], "outbox", 500)).toMatchObject({ state: "held" });
  });
  it("serializes downgrade with admission and preserves uncertain holds after closure", async () => {
    await stores[0].provisionPolicy(period(owners[4]));
    await Promise.allSettled([
      reserve(0, owners[4], "racing", 500),
      stores[1].provisionPolicy(period(owners[4], 100)),
    ]);
    const snapshot = await stores[0].snapshot({ ownerId: owners[4], periodId: "october" });
    expect(snapshot).toMatchObject({ allowanceMs: 100, availableMs: snapshot!.heldMs ? 0 : 100 });
    expect([0, 500]).toContain(snapshot!.heldMs);
    await expect(reserve(0, owners[4], "too_big", 200)).rejects.toMatchObject({ code: "exhausted" });
    await stores[0].provisionPolicy(period(owners[5]));
    await reserve(0, owners[5], "unknown", 500);
    await stores[1].markUncertain({ ownerId: owners[5], reservationId: "unknown" });
    await expect(reserve(0, owners[5], "late", 1, "october", 1_001)).rejects.toMatchObject({ code: "policy_unavailable" });
    expect(await stores[0].snapshot({ ownerId: owners[5], periodId: "october" })).toMatchObject({ heldMs: 500, settledMs: 0 });
  });
});
