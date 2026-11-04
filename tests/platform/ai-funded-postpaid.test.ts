import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { sql } from "kysely";
import { eraseOwnerPlatformData } from "../../packages/platform/src/account-deletion/cleanup-data.js";
import { exportOwnerPlatformData } from "../../packages/platform/src/account-deletion/export.js";
import { JEV_MODEL_ID } from "@matrix-os/contracts";

const modelId = "anthropic/claude-sonnet-5";
const identity = { ownerId: "user_postpaid_owner", machineId: "postpaid_machine", runtimeSlot: "primary" };

describe("postpaid funded AI customer credit", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-11-04T12:00:00.000Z");
    let counter = 0;
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock), tokenIdFactory: () => `postpaid_token_${++counter}`,
      tokenSecretFactory: () => "s".repeat(43), credentialTtlMs: 3_600_000,
      issueCooldownMs: 1_000, reservationTtlMs: 300_000, inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: identity.machineId, runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "v1",
      provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: "postpaid_grant", identity, kind: "promotional_grant",
      amountMicrousd: 1_000_000, sourceReference: "test-credit" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
  });
  afterEach(async () => { if (db) await destroyTestPlatformDb(db); });
  const request = (requestId = "postpaid_request") => ({ credential: credential.token, requestId,
    modelId, maxCostMicrousd: 5_380_000, billingMode: "usage" as const, billingPolicy: "postpaid" as const });

  it("admits without freezing customer credit and charges confirmed actual usage once", async () => {
    const auth = await repo.authorize(request());
    expect(auth.reservation).toMatchObject({ reservedMicrousd: 0, billingMode: "usage", billingPolicy: "postpaid" });
    expect(auth.funding).toMatchObject({ reservedMicrousd: 0, reservedThisMonthMicrousd: 0,
      remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 1_000_000 });
    expect(await repo.authorize(request())).toEqual(auth);
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    const settled = await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000 });
    expect(settled).toMatchObject({ actualCostMicrousd: 120_000, chargedCostMicrousd: 120_000,
      matrixAbsorbedMicrousd: 0, releasedMicrousd: 0,
      funding: { reservedMicrousd: 0, remainingBalanceMicrousd: 880_000, settledThisMonthMicrousd: 120_000 } });
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000 })).toEqual(settled);
  });

  it("permanently waives known Gateway failure cost without charging a later top-up", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    const settled = await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000, customerCharge: "waived" });
    expect(settled).toMatchObject({ actualCostMicrousd: 120_000, chargedCostMicrousd: 0,
      matrixAbsorbedMicrousd: 120_000, funding: { remainingBalanceMicrousd: 1_000_000, settledThisMonthMicrousd: 0 } });
    await repo.grantCredit({ entryId: "later_topup", identity, kind: "addon_grant", amountMicrousd: 500_000, sourceReference: "topup" });
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000, customerCharge: "waived" })).toEqual(settled);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ remainingBalanceMicrousd: 1_500_000 });
  });

  it("releases unknown failed usage immediately, retains unknown expense, and accepts exact late usage without debit", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    const start = await repo.startReservation({ ...key, executionId: "postpaid_execution" });
    await repo.recordTerminalOutcome({ contractVersion: 1, ...key, ...identity, requestId: "postpaid_request",
      startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: "postpaid_execution",
      terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" });
    const failed = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(failed).toMatchObject({ status: "expired", actual_microusd: null, settlement_response: null });
    expect(failed.customer_charge_release).not.toBeNull();
    expect((await repo.authorize(request("next_request"))).authorized).toBe(true);
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 70_000 }))
      .toMatchObject({ chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 70_000,
        funding: { reservedMicrousd: 0, remainingBalanceMicrousd: 1_000_000 } });
  });

  it("audits stale legacy holds in read-only inventory, releases them once, and never charges their late usage", async () => {
    const { billingPolicy: _policy, ...legacy } = request("old_failed_request");
    const auth = await repo.authorize(legacy);
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    clock = new Date(clock.getTime() + 61_000);
    const inventory = await repo.inventoryExpiredCustomerCharges({ limit: 10 });
    expect(inventory.items).toMatchObject([{ reservationId: key.reservationId, releaseMicrousd: 1_000_000, providerUsageKnown: false }]);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 1_000_000 });
    expect(await repo.cleanupExpiredCustomerCharges({ limit: 10 })).toBe(1);
    expect(await repo.cleanupExpiredCustomerCharges({ limit: 10 })).toBe(0);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0, remainingBalanceMicrousd: 1_000_000 });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(row.authorization_response).toBe(JSON.stringify(auth));
    expect(row.actual_microusd).toBeNull();
    expect(JSON.parse(row.customer_charge_release!)).toMatchObject({ reservedMicrousd: 1_000_000, releasedMicrousd: 1_000_000,
      reason: "legacy_expired_hold", maximumLiabilityMicrousd: 5_380_000 });
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 200_000 }))
      .toMatchObject({ chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 200_000, releasedMicrousd: 0 });
  });

  it("caps confirmed success at live credit and leaves later top-ups spendable", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_200_000 }))
      .toMatchObject({ chargedCostMicrousd: 1_000_000, matrixAbsorbedMicrousd: 200_000,
        funding: { remainingBalanceMicrousd: 0, fundingShortfallMicrousd: 0 } });
    await repo.grantCredit({ entryId: "overrun_topup", identity, kind: "addon_grant", amountMicrousd: 500_000, sourceReference: "topup" });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ remainingBalanceMicrousd: 500_000 });
  });

  it("uses the current monthly budget ceiling at successful settlement", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 50_000, expiresAt: null });
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000 }))
      .toMatchObject({ chargedCostMicrousd: 50_000, matrixAbsorbedMicrousd: 70_000,
        funding: { remainingBudgetMicrousd: 0, settledThisMonthMicrousd: 50_000 } });
  });

  it("charges the completion month across a live month boundary", async () => {
    clock = new Date("2026-11-30T23:59:40.000Z");
    credential = (await repo.issueRuntimeCredential(identity)).credential;
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    clock = new Date("2026-12-01T00:00:10.000Z");
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000 }))
      .toMatchObject({ chargedCostMicrousd: 120_000,
        funding: { periodStart: "2026-12-01T00:00:00.000Z", settledThisMonthMicrousd: 120_000 } });
  });

  it("releases an untouched postpaid request at zero and fences its replay", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    expect(await repo.releaseReservation({ ...key, reason: "pre_upstream_failure" }))
      .toMatchObject({ releasedMicrousd: 0, funding: { remainingBalanceMicrousd: 1_000_000 } });
    await expect(repo.startReservation(key)).rejects.toMatchObject({ code: "reservation_closed" });
  });

  it("rejects retroactive waivers and conflicting exact usage without changing a successful charge", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000 });
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000, customerCharge: "waived" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_001 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ remainingBalanceMicrousd: 880_000 });
  });

  it.each(["conservative", "exact"] as const)("replays a historical strict %s receipt without charging or changing it", async (storedMode) => {
    const auth = await repo.authorize({ ...request("historical_strict"), billingMode: undefined,
      billingPolicy: undefined, maxCostMicrousd: 100_000 });
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    const receipt = await repo.settleReservation({ ...key, actualCostMicrousd: 100_000 });
    // The predecessor's conservative settlement stored the same full-hold
    // financial receipt, with its original finalization mode retained separately.
    await db.executor.updateTable("ai_funded_usage_reservations").set({ finalization_mode: storedMode })
      .where("reservation_id", "=", key.reservationId).execute();
    const snapshot = async () => ({
      request: await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow(),
      balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
      ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    });
    const before = await snapshot();
    const expected = { ...receipt, finalizationMode: storedMode };
    await expect(repo.finalizeReservation({ ...key, mode: "conservative" })).resolves.toEqual(expected);
    await expect(repo.finalizeReservation({ ...key, mode: "conservative" })).resolves.toEqual(expected);
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100_000 })).resolves.toEqual(expected);
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100_001 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await snapshot()).toEqual(before);
  });

  it("exports unknown platform liability and prevents its erasure until an authentic actual arrives", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    const start = await repo.startReservation({ ...key, executionId: "postpaid_execution" });
    await repo.recordTerminalOutcome({ contractVersion: 1, ...key, ...identity, requestId: "postpaid_request",
      startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: "postpaid_execution",
      terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" });
    const exported = await exportOwnerPlatformData(db, identity.ownerId);
    expect(exported.aiGatewayCredit.requests).toMatchObject([{ status: "expired", actual_microusd: null }]);
    expect(exported.aiGatewayCredit.requests[0].customer_charge_release).not.toBeNull();
    await expect(eraseOwnerPlatformData(db, identity.ownerId)).rejects.toThrow("accounting_reconciliation_required");
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 70_000 });
    await db.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: clock.toISOString() }).execute();
    await sql`INSERT INTO account_deletion_jobs(owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
      VALUES ('postpaid-opaque-deletion','processing',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(db.executor);
    await eraseOwnerPlatformData(db, identity.ownerId, () => "postpaid-opaque-deletion");
    const deleted = await db.executor.selectFrom("account_deletion_jobs").select("accounting_summary").executeTakeFirstOrThrow();
    expect(deleted.accounting_summary).toMatchObject({ postpaid_platform_expense: { entryCount: 1, amountMicrousd: 70_000 } });
    expect(JSON.stringify(deleted.accounting_summary)).not.toContain(identity.ownerId);
  });

  it("does not waive a successfully settled request when a later terminal notification arrives", async () => {
    const auth = await repo.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    const start = await repo.startReservation({ ...key, executionId: "postpaid_execution" });
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 120_000 });
    await repo.recordTerminalOutcome({ contractVersion: 1, ...key, ...identity, requestId: "postpaid_request",
      startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: "postpaid_execution",
      terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ remainingBalanceMicrousd: 880_000 });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(row.customer_charge_release).toBeNull();
  });

  it("requires positive currently spendable credit rather than counting protected legacy holds", async () => {
    const { billingPolicy: _policy, ...legacy } = request("live_legacy_hold");
    await repo.authorize(legacy);
    await expect(repo.authorize(request())).rejects.toMatchObject({ code: "insufficient_credit" });
  });

  it("rejects late usage for an authorization that never started", async () => {
    const auth = await repo.authorize(request());
    clock = new Date(clock.getTime() + 301_000);
    expect(await repo.cleanupExpiredReservations({ limit: 10 })).toBe(1);
    await expect(repo.finalizeReservation({ reservationId: auth.reservation.reservationId,
      tokenId: credential.tokenId, mode: "exact", actualCostMicrousd: 10 })).rejects.toMatchObject({ code: "reservation_closed" });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", auth.reservation.reservationId).executeTakeFirstOrThrow();
    expect(row.actual_microusd).toBeNull();
  });

  it("retains evidence and reviewer identity for postpaid Jev expense reconciliation", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID],
      monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    const auth = await repo.authorize({ ...request("postpaid_jev"), modelId: JEV_MODEL_ID, maxCostMicrousd: 5000 });
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    clock = new Date(clock.getTime() + 661_000);
    const review = { ...key, expectedRequestId: "postpaid_jev", actualCostMicrousd: 40,
      evidenceRef: "review/provider-actual", reviewer: "operator" };
    const settled = await repo.reconcileUnknownJevUsage(review);
    expect(settled).toMatchObject({ chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 40 });
    expect(await repo.reconcileUnknownJevUsage(review)).toEqual(settled);
    await expect(repo.reconcileUnknownJevUsage({ ...review, reviewer: "other" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repo.reconcileUnknownJevUsage({ ...review, evidenceRef: "review/different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ manual_review_evidence_ref: review.evidenceRef, manual_review_actor: review.reviewer,
      manual_reviewed_at: clock.toISOString() });
  });

  it("does not charge expired promotional credit or borrow from future top-ups", async () => {
    const first = await repo.authorize(request("drain_initial_credit"));
    const firstKey = { reservationId: first.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(firstKey);
    await repo.finalizeReservation({ ...firstKey, mode: "exact", actualCostMicrousd: 1_000_000 });
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true, allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 2_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: "short_lived_credit", identity, kind: "promotional_grant", amountMicrousd: 100_000,
      sourceReference: "short-lived", expiresAt: new Date(clock.getTime() + 10_000).toISOString() });
    const auth = await repo.authorize(request("grant_expires_during_generation"));
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    clock = new Date(clock.getTime() + 11_000);
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 50_000 }))
      .toMatchObject({ chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 50_000,
        funding: { creditBalanceMicrousd: 0, fundingShortfallMicrousd: 0 } });
  });
});
