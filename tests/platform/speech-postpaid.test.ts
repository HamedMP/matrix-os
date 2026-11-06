import { exportOwnerPlatformData } from "../../packages/platform/src/account-deletion/export.js";
import { eraseOwnerPlatformData } from "../../packages/platform/src/account-deletion/cleanup-data.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { assertFundedConservativeFence, migrateFundedConservativeFence } from "../../packages/platform/src/database/funded-conservative-fence.js";
import { readCustomerChargeRelease } from "../../packages/platform/src/ai-funded-customer-charge-release.js";
import { ensureSpeechMonthlyAllowance } from "../../packages/platform/src/speech/allowance.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const identity = { ownerId: "user_speech_postpaid_owner", machineId: "speech_postpaid_machine", runtimeSlot: "dev" };
describe("postpaid speech credit and independent allowance", () => {
  let db: PlatformDB, clock: Date, sequence: number;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let funding: ReturnType<typeof createAiFundedSpeechFundingPort>;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); clock = new Date("2026-11-30T23:59:40.000Z"); sequence = 0;
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "speech-postpaid",
      runtimeSlot: identity.runtimeSlot, status: "running", activationState: "authorized", imageVersion: "test", provisionedAt: clock.toISOString() });
    repo = createAiFundedPolicyRepository({ db, now: () => new Date(clock), credentialHashSecret: "h".repeat(32) });
    await db.transaction(trx => ensureSpeechMonthlyAllowance(trx.executor, identity, { monthlyBudgetMicrousd: 1_000, monthlyPromotionalCreditMicrousd: 0, now: clock }));
    await repo.grantCredit({ entryId: "speech_addon", identity, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "test" });
    funding = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => `speech_postpaid_${++sequence}`, now: () => new Date(clock), inFlightTtlMs: 60_000,
      monthlyAllowance: { monthlyBudgetMicrousd: 1_000, monthlyPromotionalCreditMicrousd: 0 } });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const reserve = (requestId = "speech_request", maximumCostMicrousd = 120) => db.transaction(trx => funding.reserve(trx.executor, {
    identity, requestId, modelId: "gpt-4o-transcribe", policyRevision: "speech-price-1", maximumCostMicrousd,
  }));
  const row = (id: string) => db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", id).executeTakeFirstOrThrow();
  const balance = () => db.executor.selectFrom("ai_funded_runtime_balances").selectAll().where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();
  const allowance = () => db.executor.selectFrom("speech_runtime_allowances").selectAll().where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();

  it("reserves only a separate allowance lease, never customer money or funding sources", async () => {
    const auth = await reserve();
    expect(auth.reservedMicrousd).toBe(0);
    expect(await balance()).toMatchObject({ reserved_microusd: 0, month_reserved_microusd: 0, credit_balance_microusd: 1_000 });
    expect(await allowance()).toMatchObject({ period_reserved_microusd: 120, period_spent_microusd: 0 });
    expect(JSON.parse((await row(auth.reservationId)).authorization_response)).toMatchObject({ capability: "speech:transcribe",
      reservation: { billingPolicy: "postpaid", maxCostMicrousd: 120, reservedMicrousd: 0 }, allowanceReservedMicrousd: 120,
      allowancePeriodStart: "2026-11-01T00:00:00.000Z" });
    expect(await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute()).toEqual([]);
  });

  it("charges successful actual usage once, preserves source eligibility, and rejects changed receipts", async () => {
    const auth = await reserve();
    await db.transaction(trx => funding.start(trx.executor, auth.reservationId));
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 40 }));
    const before = await balance();
    expect(before).toMatchObject({ credit_balance_microusd: 960, reserved_microusd: 0 });
    expect(await allowance()).toMatchObject({ period_reserved_microusd: 0, period_spent_microusd: 40 });
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 40 }));
    await expect(db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 41 }))).rejects.toThrow();
    await expect(db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "conservative" }))).rejects.toThrow();
    expect(await balance()).toEqual(before);
  });

  it("commits unknown usage without charging, then records exact late expense only for Matrix", async () => {
    const auth = await reserve();
    await db.transaction(trx => funding.start(trx.executor, auth.reservationId));
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "conservative" }));
    expect(await row(auth.reservationId)).toMatchObject({ status: "expired", actual_microusd: null, customer_charge_release: expect.any(String) });
    expect(await balance()).toMatchObject({ credit_balance_microusd: 1_000, reserved_microusd: 0 });
    expect(await allowance()).toMatchObject({ period_reserved_microusd: 0, period_spent_microusd: 0 });
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "conservative" }));
    await repo.grantCredit({ entryId: "later_topup", identity, kind: "addon_grant", amountMicrousd: 500, sourceReference: "test" });
    const financialState = async () => ({ balance: await balance(), allowance: await allowance(),
      ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().orderBy("entry_id").execute() });
    const beforeLate = await financialState();
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 70 }));
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 70 }));
    await expect(db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 71 }))).rejects.toThrow();
    expect(await financialState()).toEqual(beforeLate);
    expect(JSON.parse((await row(auth.reservationId)).settlement_response!)).toMatchObject({ actualCostMicrousd: 70,
      chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 70 });
    expect(await balance()).toMatchObject({ credit_balance_microusd: 1_500 });
    expect(await allowance()).toMatchObject({ period_spent_microusd: 0, period_reserved_microusd: 0 });
  });

  it("releases expired legacy monthly speech on suspended non-primary machines without inventing usage", async () => {
    const auth = await reserve("legacy_monthly", 80);
    const legacy = JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-price-1", fundingPolicy: "speech_monthly_v1" });
    await db.executor.updateTable("ai_funded_usage_reservations").set({ authorization_response: legacy,
      reserved_microusd: 80, promotional_reserved_microusd: 0, addon_reserved_microusd: 80 }).where("reservation_id", "=", auth.reservationId).execute();
    await db.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 80 }).where("machine_id", "=", identity.machineId).execute();
    await db.transaction(trx => funding.start(trx.executor, auth.reservationId));
    await db.executor.updateTable("user_machines").set({ status: "suspended" }).where("machine_id", "=", identity.machineId).execute();
    clock = new Date(clock.getTime() + 61_000);
    expect(await repo.cleanupExpiredReservations({ limit: 1 })).toBe(1);
    const saved = await row(auth.reservationId);
    expect(saved).toMatchObject({ authorization_response: legacy, reserved_microusd: 80, actual_microusd: null,
      status: "expired", customer_charge_release: expect.any(String) });
    expect(await balance()).toMatchObject({ reserved_microusd: 0, credit_balance_microusd: 1_000 });
    expect(await allowance()).toMatchObject({ period_reserved_microusd: 0, period_spent_microusd: 0 });
    expect(await repo.cleanupExpiredReservations({ limit: 1 })).toBe(0);
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 70 }));
    expect(await balance()).toMatchObject({ credit_balance_microusd: 1_000 });
  });

  it("never releases or spends a newer month's allowance when old unknown usage arrives late", async () => {
    const old = await reserve("november", 80);
    await db.transaction(trx => funding.start(trx.executor, old.reservationId));
    clock = new Date("2026-12-01T00:00:41.000Z");
    await reserve("december", 60);
    expect(await allowance()).toMatchObject({ period_start: "2026-12-01T00:00:00.000Z", period_reserved_microusd: 60 });
    expect(await repo.cleanupExpiredReservations({ limit: 1 })).toBe(1);
    await db.transaction(trx => funding.settle(trx.executor, old.reservationId, { mode: "exact", actualCostMicrousd: 70 }));
    expect(await allowance()).toMatchObject({ period_reserved_microusd: 60, period_spent_microusd: 0 });
    expect(JSON.parse((await row(old.reservationId)).customer_charge_release!)).toMatchObject({ fundingKind: "speech",
      allowanceDisposition: "past-period", allowanceReleasedMicrousd: 0 });
  });
  it.each([true, false])("releases a positive legacy hold without touching another owner's positive reserves (monthly=%s)", async monthly => {
    const modelId = "anthropic/claude-sonnet-5";
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    const ownCredential = (await repo.issueRuntimeCredential(identity)).credential;
    await repo.authorize({ credential: ownCredential.token, requestId: "own_protected_ai", modelId, maxCostMicrousd: 11 });
    const other = { ownerId: "other_speech_owner", machineId: "other_speech_machine", runtimeSlot: "primary" };
    await insertUserMachine(db, { machineId: other.machineId, clerkUserId: other.ownerId, handle: "other-speech-owner",
      runtimeSlot: other.runtimeSlot, status: "running", activationState: "authorized", imageVersion: "test", provisionedAt: clock.toISOString() });
    await repo.setRuntimePolicy({ identity: other, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    await repo.grantCredit({ entryId: "other_addon", identity: other, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "test" });
    const credential = (await repo.issueRuntimeCredential(other)).credential;
    await repo.authorize({ credential: credential.token, requestId: "other_protected_ai", modelId, maxCostMicrousd: 100 });
    const otherState = async () => ({
      balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().where("owner_id", "=", other.ownerId).execute(),
      ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().where("owner_id", "=", other.ownerId).execute(),
      requests: await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("owner_id", "=", other.ownerId).execute(),
    });
    const before = await otherState();
    const port = monthly ? funding : createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => "legacy_nonmonthly", now: () => new Date(clock), inFlightTtlMs: 60_000 });
    const auth = await db.transaction(trx => port.reserve(trx.executor, { identity, requestId: "legacy_scope",
      policyRevision: "speech-price-1", modelId: "gpt-4o-transcribe", maximumCostMicrousd: 80 }));
    await db.executor.updateTable("ai_funded_usage_reservations").set({ reserved_microusd: 80, addon_reserved_microusd: 80,
      authorization_response: JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-price-1",
        ...(monthly ? { fundingPolicy: "speech_monthly_v1" } : {}) }) }).where("reservation_id", "=", auth.reservationId).execute();
    await db.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 91,
      month_reserved_microusd: monthly ? 11 : 91 }).where("machine_id", "=", identity.machineId).execute();
    await db.transaction(trx => port.start(trx.executor, auth.reservationId));
    clock = new Date(clock.getTime() + 61_000);
    expect(await repo.cleanupExpiredReservations({ limit: 1 })).toBe(1);
    expect(await otherState()).toEqual(before);
    expect(await balance()).toMatchObject({ reserved_microusd: 11, month_reserved_microusd: 11, credit_balance_microusd: 1_000 });
    expect(await allowance()).toMatchObject({ period_reserved_microusd: 0, period_spent_microusd: 0 });
  });

  it("exports positive unknown Speech liability and defers erasure until exact Matrix expense is retained", async () => {
    const auth = await reserve("speech_deletion");
    await db.transaction(trx => funding.start(trx.executor, auth.reservationId));
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "conservative" }));
    const exported = await exportOwnerPlatformData(db, identity.ownerId);
    expect(exported.aiGatewayCredit.requests).toMatchObject([{ actual_microusd: null, maximum_liability_microusd: 120 }]);
    await expect(eraseOwnerPlatformData(db, identity.ownerId)).rejects.toThrow("accounting_reconciliation_required");
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 40 }));
    await db.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: clock.toISOString() }).where("machine_id", "=", identity.machineId).execute();
    await sql`INSERT INTO account_deletion_jobs(owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
      VALUES ('speech-deletion','processing',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(db.executor);
    await eraseOwnerPlatformData(db, identity.ownerId, () => "speech-deletion");
    const tombstone = await db.executor.selectFrom("account_deletion_jobs").select("accounting_summary").executeTakeFirstOrThrow();
    expect(tombstone.accounting_summary).toMatchObject({ postpaid_platform_expense: { entryCount: 1, amountMicrousd: 40 } });
    expect(JSON.stringify(tombstone.accounting_summary)).not.toContain(identity.ownerId);
  });

  it("keeps missing-lease legacy recovery portable and retains unknown Matrix liability until exact expense", async () => {
    const auth = await reserve("legacy_unreserved", 80);
    const legacy = JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-price-1", fundingPolicy: "speech_monthly_v1" });
    await db.executor.updateTable("ai_funded_usage_reservations").set({ authorization_response: legacy, reserved_microusd: 80,
      promotional_reserved_microusd: 0, addon_reserved_microusd: 80 }).where("reservation_id", "=", auth.reservationId).execute();
    await db.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 80 }).where("machine_id", "=", identity.machineId).execute();
    await db.transaction(trx => funding.start(trx.executor, auth.reservationId));
    await db.executor.updateTable("ai_funded_usage_reservations").set({ expires_at: new Date(clock.getTime() + 10_000).toISOString() })
      .where("reservation_id", "=", auth.reservationId).execute();
    await db.executor.updateTable("speech_runtime_allowances").set({ period_reserved_microusd: 0 }).where("machine_id", "=", identity.machineId).execute();
    const quota = await allowance(); clock = new Date(clock.getTime() + 11_000);
    expect(await repo.cleanupExpiredCustomerCharges({ limit: 1 })).toBe(1);
    const saved = await row(auth.reservationId);
    expect(saved).toMatchObject({ actual_microusd: null, status: "expired", reserved_microusd: 80, authorization_response: legacy });
    expect(readCustomerChargeRelease(saved)).toMatchObject({ allowanceDisposition: "unreserved", allowanceReservedBeforeMicrousd: 0,
      allowanceReservedMicrousd: 80, allowanceReleasedMicrousd: 0 });
    expect(await allowance()).toEqual(quota);
    expect(await balance()).toMatchObject({ credit_balance_microusd: 1_000, reserved_microusd: 0 });
    const exported = await exportOwnerPlatformData(db, identity.ownerId);
    expect(exported.aiGatewayCredit.requests).toMatchObject([{ actual_microusd: null, maximum_liability_microusd: 80,
      customer_charge_release: saved.customer_charge_release }]);
    await expect(eraseOwnerPlatformData(db, identity.ownerId)).rejects.toThrow("accounting_reconciliation_required");
    expect(await repo.cleanupExpiredCustomerCharges({ limit: 1 })).toBe(0);
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: 40 }));
    expect(await allowance()).toEqual(quota);
    expect(JSON.parse((await row(auth.reservationId)).settlement_response!)).toMatchObject({ chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 40 });
    await db.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: clock.toISOString() }).where("machine_id", "=", identity.machineId).execute();
    await sql`INSERT INTO account_deletion_jobs(owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
      VALUES ('unreserved-deletion','processing',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(db.executor);
    await eraseOwnerPlatformData(db, identity.ownerId, () => "unreserved-deletion");
    const tombstone = await db.executor.selectFrom("account_deletion_jobs").select("accounting_summary").executeTakeFirstOrThrow();
    expect(tombstone.accounting_summary).toMatchObject({ postpaid_platform_expense: { entryCount: 1, amountMicrousd: 40 } });
  });

  it("rejects external AI start, finalize and release APIs for an internal Speech capture", async () => {
    const auth = await reserve("speech_is_not_ai");
    const saved = await row(auth.reservationId);
    const key = { reservationId: saved.reservation_id, tokenId: saved.token_id };
    const before = { row: saved, balance: await balance(), allowance: await allowance() };
    await expect(repo.startReservation(key)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 0 })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(repo.releaseReservation({ ...key, reason: "pre_upstream_failure" })).rejects.toMatchObject({ code: "unauthorized" });
    expect({ row: await row(auth.reservationId), balance: await balance(), allowance: await allowance() }).toEqual(before);
  });

  it.each(["exact", "conservative"] as const)("replays the original legacy %s receipt after expiry without changing any financial state", async mode => {
    const auth = await reserve("legacy_receipt", 120);
    await db.executor.updateTable("ai_funded_usage_reservations").set({ reserved_microusd: 120, addon_reserved_microusd: 120,
      authorization_response: JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-price-1", fundingPolicy: "speech_monthly_v1" }) })
      .where("reservation_id", "=", auth.reservationId).execute();
    await db.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 120 }).where("machine_id", "=", identity.machineId).execute();
    await db.transaction(trx => funding.start(trx.executor, auth.reservationId));
    const actual = mode === "exact" ? 40 : 120;
    // Historical conservative receipts predate the fence; seed that old state
    // explicitly, then restore/verify the real fence before exercising replay.
    if (mode === "conservative") await sql`DROP TRIGGER ai_funded_conservative_settlement_fence ON ai_funded_usage_reservations`.execute(db.executor);
    try {
      await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: actual }));
      if (mode === "conservative") await db.executor.updateTable("ai_funded_usage_reservations").set({ finalization_mode: "conservative" })
        .where("reservation_id", "=", auth.reservationId).execute();
    } finally {
      if (mode === "conservative") await db.transaction(trx => migrateFundedConservativeFence(trx.executor));
    }
    await assertFundedConservativeFence(db.executor);
    const state = async () => ({ row: await row(auth.reservationId), balance: await balance(), quota: await allowance(),
      sources: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().execute(),
      allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
      ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().orderBy("entry_id").execute() });
    const before = await state();
    expect(JSON.parse(before.row.settlement_response!)).toEqual({ capability: "speech:transcribe", actualCostMicrousd: actual });
    clock = new Date(clock.getTime() + 61_000);
    const replay = mode === "exact" ? { mode, actualCostMicrousd: actual } : { mode };
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, replay));
    await db.transaction(trx => funding.settle(trx.executor, auth.reservationId, replay));
    await expect(db.transaction(trx => funding.settle(trx.executor, auth.reservationId, { mode: "exact", actualCostMicrousd: actual + 1 }))).rejects.toThrow();
    const conflictingMode = mode === "exact" ? { mode: "conservative" as const } : { mode: "exact" as const, actualCostMicrousd: actual };
    await expect(db.transaction(trx => funding.settle(trx.executor, auth.reservationId, conflictingMode))).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

});
