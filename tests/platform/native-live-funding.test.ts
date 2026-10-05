import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createNativeLiveFunding, NativeLiveFundingError } from "../../packages/platform/src/native-live/funding.js";

const at = new Date("2026-10-05T12:00:00Z");
const policy = { revision: "live-1", sessionBudgetMicrousd: 2_000_000, monthlyOwnerBudgetMicrousd: 4_000_000,
  maximumActiveSessions: 2, maximumSessionMs: 1_800_000, allowedHandles: ["alice", "alice-test", "bob"] };
describe("Matrix-paid Live admission", () => {
  let db: PlatformDB;
  let now = at;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); now = at;
    for (const [handle, owner] of [["alice", "user_alice"], ["alice-test", "user_alice"], ["bob", "user_bob"]]) {
      await insertUserMachine(db, { machineId: `machine_${handle}`, clerkUserId: owner!, handle: handle!,
        runtimeSlot: handle!, status: "running", imageVersion: "v1", activationState: "authorized", provisionedAt: at.toISOString() });
    }
  });
  afterEach(async () => destroyTestPlatformDb(db));
  const funding = () => createNativeLiveFunding({ db, policy, now: () => now });
  it("reserves platform spend without granting or debiting any user wallet", async () => {
    const reservation = await funding().reserve("alice", "live_one");
    expect(reservation).toMatchObject({ ownerId: "user_alice", reservedMicrousd: 2_000_000 });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute()).toEqual([]);
  });
  it("enforces one active session per owner across different VPSes", async () => {
    await funding().reserve("alice", "live_one");
    await expect(funding().reserve("alice-test", "live_two")).rejects.toBeInstanceOf(NativeLiveFundingError);
  });
  it("keeps uncertain disconnected sessions in the monthly platform allowance", async () => {
    const repo = funding();
    await repo.reserve("alice", "live_one"); await repo.finish("live_one");
    await repo.reserve("alice", "live_two"); await repo.finish("live_two");
    await expect(repo.reserve("alice", "live_three")).rejects.toBeInstanceOf(NativeLiveFundingError);
    const rows = await db.executor.selectFrom("native_live_sessions").selectAll().execute();
    expect(rows.map(row => row.accounted_microusd)).toEqual([2_000_000, 2_000_000]);
    expect(rows.every(row => row.accounting_mode === "conservative")).toBe(true);
  });
  it("records provider usage upper bounds and closes at the reserved session cap", async () => {
    const repo = funding(); await repo.reserve("alice", "live_one");
    expect(await repo.recordUsage("live_one", { promptTokenCount: 100, responseTokenCount: 10, thoughtsTokenCount: 5 })).toBe(true);
    expect(await repo.recordUsage("live_one", { promptTokenCount: 1_000_000, responseTokenCount: 0 })).toBe(false);
    await repo.finish("live_one"); await repo.finish("live_one");
    const row = await db.executor.selectFrom("native_live_sessions").selectAll().where("session_id", "=", "live_one").executeTakeFirstOrThrow();
    expect(row.reported_upper_microusd).toBe(3_000_480);
    expect(row.accounted_microusd).toBe(3_000_480);
    expect(row.platform_absorbed_overrun_microusd).toBe(1_000_480);
  });
  it("reclaims an expired active slot while retaining its uncertain spend", async () => {
    const repo = funding(); await repo.reserve("alice", "live_one");
    now = new Date(at.getTime() + policy.maximumSessionMs + 1);
    await repo.reserve("alice-test", "live_two");
    const row = await db.executor.selectFrom("native_live_sessions").selectAll().where("session_id", "=", "live_one").executeTakeFirstOrThrow();
    expect(row.status).toBe("closed"); expect(row.accounted_microusd).toBe(2_000_000);
  });
  it("rejects changed activation, missing machines, and unapproved handles", async () => {
    await db.executor.updateTable("user_machines").set({ activation_state: "pending" }).where("handle", "=", "alice").execute();
    await expect(funding().reserve("alice", "live_one")).rejects.toBeInstanceOf(NativeLiveFundingError);
    await expect(funding().reserve("missing", "live_two")).rejects.toBeInstanceOf(NativeLiveFundingError);
  });
  it("does not let usage mutate a closed reservation", async () => {
    const repo = funding(); await repo.reserve("alice", "live_one"); await repo.finish("live_one");
    expect(await repo.recordUsage("live_one", { promptTokenCount: 10, responseTokenCount: 1 })).toBe(false);
  });
  it("reports exhausted included allowance before a new session is offered", async () => {
    const repo = funding();
    await repo.reserve("alice", "live_one"); await repo.finish("live_one");
    await repo.reserve("alice", "live_two"); await repo.finish("live_two");
    expect(await repo.available("alice")).toBe(false);
  });
});
