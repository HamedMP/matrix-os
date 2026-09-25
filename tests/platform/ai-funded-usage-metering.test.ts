import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { JEV_MODEL_ID } from "@matrix-os/contracts";
import { sql } from "kysely";
import { migrateAiFunded } from "../../packages/platform/src/database/migrations/ai-funded.js";

const modelId = "anthropic/claude-sonnet-5";
const identity = { ownerId: "usage_owner", machineId: "usage_machine", runtimeSlot: "primary" };

describe("usage-based funded AI admission", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };

  async function fundRuntime(target = identity, credit = 1_000_000) {
    await insertUserMachine(db, {
      machineId: target.machineId, clerkUserId: target.ownerId, handle: target.machineId,
      runtimeSlot: target.runtimeSlot, status: "running", imageVersion: "v1",
      provisionedAt: clock.toISOString(), activationState: "authorized",
    });
    await repo.setRuntimePolicy({ identity: target, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    if (credit > 0) await repo.grantCredit({ entryId: `grant_${target.machineId}`, identity: target,
      kind: "promotional_grant", amountMicrousd: credit, sourceReference: "test-credit" });
    return (await repo.issueRuntimeCredential(target)).credential;
  }

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-09-10T12:00:00.000Z");
    let counter = 0;
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock), tokenIdFactory: () => `usage_token_${++counter}`,
      tokenSecretFactory: () => "s".repeat(43), credentialTtlMs: 3_600_000,
      issueCooldownMs: 1_000, reservationTtlMs: 300_000, inFlightTtlMs: 60_000 });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    credential = await fundRuntime();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  const request = (token: string, requestId = "usage_request") => ({ credential: token,
    requestId, modelId, maxCostMicrousd: 5_380_000, billingMode: "usage" as const });

  it("admits a $1 balance without requiring the maximum liability and replays idempotently", async () => {
    const first = await repo.authorize(request(credential.token));
    expect(first.reservation).toMatchObject({ reservedMicrousd: 1_000_000, billingMode: "usage" });
    expect(await repo.authorize(request(credential.token))).toEqual(first);
    await expect(repo.authorize({ ...request(credential.token), billingMode: undefined }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("blocks another runtime while an owner's usage request is active", async () => {
    const second = await fundRuntime({ ...identity, machineId: "usage_second", runtimeSlot: "preview" });
    expect((await repo.authorize(request(credential.token))).authorized).toBe(true);
    await expect(repo.authorize(request(second.token, "usage_second")))
      .rejects.toMatchObject({ code: "rate_limited" });
  });

  it("releases an expired usage reservation that never started", async () => {
    const second = await fundRuntime({ ...identity, machineId: "usage_second", runtimeSlot: "preview" });
    const authorization = await repo.authorize(request(credential.token, "never_started"));
    clock = new Date(clock.getTime() + 301_000);

    await expect(repo.cleanupExpiredReservations({ limit: 10 })).resolves.toBe(1);
    await expect(repo.getFundingSummary(identity)).resolves.toMatchObject({
      reservedMicrousd: 0,
      reservedThisMonthMicrousd: 0,
      remainingBalanceMicrousd: 1_000_000,
      remainingBudgetMicrousd: 1_000_000,
    });
    await expect(db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["status", "actual_microusd"])
      .where("reservation_id", "=", authorization.reservation.reservationId)
      .executeTakeFirstOrThrow()).resolves.toEqual({ status: "expired", actual_microusd: null });
    await expect(repo.authorize(request(second.token, "after_never_started_expiry")))
      .resolves.toMatchObject({ authorized: true });
  });

  it("audits the final overrun without debt or later credit clawback", async () => {
    const auth = await repo.authorize(request(credential.token));
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    const settled = await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_200_000 });
    expect(settled).toMatchObject({ actualCostMicrousd: 1_200_000, chargedCostMicrousd: 1_000_000,
      matrixAbsorbedMicrousd: 200_000, releasedMicrousd: 0,
      funding: { fundingShortfallMicrousd: 0, settledThisMonthMicrousd: 1_000_000 } });
    expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_200_000 })).toEqual(settled);
    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute();
    expect(ledger.reduce((total, entry) => total + Number(entry.amount_microusd), 0)).toBe(-1_000_000);
    const audit = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(Number(audit.actual_microusd)).toBe(1_200_000);
    expect(JSON.parse(audit.settlement_response!)).toMatchObject({ matrixAbsorbedMicrousd: 200_000 });
    await repo.grantCredit({ entryId: "later_topup", identity, kind: "addon_grant",
      amountMicrousd: 500_000, sourceReference: "later-topup" });
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      remainingBalanceMicrousd: 500_000, fundingShortfallMicrousd: 0,
    });
  });

  it("keeps stale usage holds until exact provider usage arrives", async () => {
    const auth = await repo.authorize(request(credential.token));
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.finalizeReservation({ ...key, mode: "conservative" }))
      .rejects.toMatchObject({ code: "unavailable" });
    clock = new Date(clock.getTime() + 61_000);
    expect(await repo.cleanupExpiredReservations({ limit: 10 })).toBe(0);
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      reservedMicrousd: 1_000_000, settledThisMonthMicrousd: 0,
      remainingBalanceMicrousd: 0, remainingBudgetMicrousd: 0,
    });
    const stale = await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["status", "actual_microusd", "settlement_response"])
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(stale).toEqual({ status: "in_flight", actual_microusd: null, settlement_response: null });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .selectAll().where("reservation_id", "=", key.reservationId).execute()).toEqual([]);
    await expect(repo.authorize(request(credential.token, "blocked_while_unresolved")))
      .rejects.toMatchObject({ code: "rate_limited" });
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100 }))
      .resolves.toMatchObject({
        status: "settled", actualCostMicrousd: 100, chargedCostMicrousd: 100,
        releasedMicrousd: 999_900,
      });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["status", "actual_microusd", "finalization_mode"])
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow())
      .toEqual({ status: "settled", actual_microusd: 100, finalization_mode: "exact" });
    expect((await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("reservation_id", "=", key.reservationId).execute())
      .reduce((total, row) => total + Number(row.amount_microusd), 0)).toBe(-100);
    expect((await repo.authorize(request(credential.token, "reconciled"))).authorized).toBe(true);
  });

  it("requires evidence before manually releasing an expired Jev hold", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true,
      allowedModelIds: [modelId, JEV_MODEL_ID], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    const auth = await repo.authorize({ ...request(credential.token, "jev_manual_review"),
      modelId: JEV_MODEL_ID, maxCostMicrousd: 5_000 });
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    const review = { ...key, expectedRequestId: "jev_manual_review", actualCostMicrousd: 0,
      evidenceRef: "ENG-11/provider-no-charge", reviewer: "operator_1" };
    await expect(repo.reconcileUnknownJevUsage(review)).rejects.toMatchObject({ code: "rate_limited" });
    clock = new Date(clock.getTime() + 61_000 + 10 * 60_000);
    await expect(repo.cleanupExpiredReservations({ limit: 10 })).resolves.toBe(0);
    await expect(repo.reconcileUnknownJevUsage({ ...review, expectedRequestId: "wrong_request" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    const settled = await repo.reconcileUnknownJevUsage(review);
    expect(settled).toMatchObject({ status: "settled", actualCostMicrousd: 0, releasedMicrousd: 5_000 });
    await expect(repo.reconcileUnknownJevUsage(review)).resolves.toEqual(settled);
    await expect(repo.reconcileUnknownJevUsage({ ...review, evidenceRef: "ENG-11/different" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    const audit = await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["manual_review_evidence_ref", "manual_review_actor", "manual_reviewed_at", "actual_microusd"])
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ manual_review_evidence_ref: review.evidenceRef,
      manual_review_actor: review.reviewer, actual_microusd: 0 });
    expect(audit.manual_reviewed_at).toBeTruthy();
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute()).toEqual([]);
  });

  it("binds versioned Jev authorization to exact settlement provenance and idempotent ledger replay", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true,
      allowedModelIds: [modelId, JEV_MODEL_ID], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    const versioned = {
      ...request(credential.token, "jev_versioned"), modelId: JEV_MODEL_ID,
      maxCostMicrousd: 5_000, jevPricingVersion: "typesafe-jev-input-2026-09",
    };
    const auth = await repo.authorize(versioned);
    expect(auth.reservation).toMatchObject({ jevPricingVersion: versioned.jevPricingVersion });
    await expect(repo.authorize({ ...request(credential.token, "jev_versioned"),
      modelId: JEV_MODEL_ID, maxCostMicrousd: 5_000 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repo.authorize({ ...versioned, jevPricingVersion: "unreviewed-price-version" }))
      .rejects.toBeTruthy();
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id")
      .where("request_id", "=", "jev_versioned").execute()).toHaveLength(1);

    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 12 }))
      .rejects.toBeTruthy();
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 12,
      jevProvenance: { resolvedModel: "jev-1.13.0", pricingVersion: "typesafe-jev-input-2026-08" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").select(["status", "actual_microusd"])
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow())
      .toEqual({ status: "in_flight", actual_microusd: null });
    const exact = { ...key, mode: "exact" as const, actualCostMicrousd: 12,
      jevProvenance: { resolvedModel: "jev-1.13.0", pricingVersion: versioned.jevPricingVersion } };
    const settled = await repo.finalizeReservation(exact);
    expect(await repo.finalizeReservation(exact)).toEqual(settled);
    await expect(repo.finalizeReservation({ ...exact,
      jevProvenance: { ...exact.jevProvenance, resolvedModel: "jev-1.14.0" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const row = await sql<{ resolved_model: string | null; pricing_version: string | null }>`
      SELECT resolved_model, pricing_version FROM ai_funded_usage_reservations
      WHERE reservation_id = ${key.reservationId}
    `.execute(db.executor);
    expect(row.rows[0]).toEqual({ resolved_model: "jev-1.13.0", pricing_version: versioned.jevPricingVersion });
    const debits = await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("reservation_id", "=", key.reservationId).execute();
    expect(debits.reduce((total, entry) => total + Number(entry.amount_microusd), 0)).toBe(-12);
  });

  it("rejects Jev provenance on a non-Jev reservation without charging", async () => {
    const auth = await repo.authorize(request(credential.token, "non_jev_provenance"));
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 12,
      jevProvenance: { resolvedModel: "jev-1.13.0", pricingVersion: "typesafe-jev-input-2026-09" },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute()).toEqual([]);
  });

  it("keeps a versioned unknown Jev hold for evidence-bound manual reconciliation without invented provenance", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true,
      allowedModelIds: [modelId, JEV_MODEL_ID], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    const auth = await repo.authorize({ ...request(credential.token, "jev_versioned_unknown"),
      modelId: JEV_MODEL_ID, maxCostMicrousd: 5_000, jevPricingVersion: "typesafe-jev-input-2026-09" });
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.finalizeReservation({ ...key, mode: "conservative" }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute()).toEqual([]);
    clock = new Date(clock.getTime() + 61_000 + 10 * 60_000);
    const review = { ...key, expectedRequestId: "jev_versioned_unknown", actualCostMicrousd: 0,
      evidenceRef: "ENG-11/provider-no-charge-versioned", reviewer: "operator_1" };
    await expect(repo.reconcileUnknownJevUsage(review))
      .resolves.toMatchObject({ status: "settled", actualCostMicrousd: 0 });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["resolved_model", "pricing_version", "manual_review_evidence_ref"])
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow())
      .toEqual({ resolved_model: null, pricing_version: null,
        manual_review_evidence_ref: review.evidenceRef });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute()).toEqual([]);
  });

  it("keeps historical Jev settlement valid without inventing resolved model or price version", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true,
      allowedModelIds: [modelId, JEV_MODEL_ID], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    const auth = await repo.authorize({ ...request(credential.token, "jev_legacy"),
      modelId: JEV_MODEL_ID, maxCostMicrousd: 5_000 });
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 12 }))
      .resolves.toMatchObject({ status: "settled", actualCostMicrousd: 12 });
    // Recreate the pre-provenance table shape in this disposable database while
    // retaining the existing reservation and settlement row.
    await sql`ALTER TABLE ai_funded_usage_reservations DROP COLUMN resolved_model`.execute(db.executor);
    await sql`ALTER TABLE ai_funded_usage_reservations DROP COLUMN pricing_version`.execute(db.executor);
    await migrateAiFunded(db.executor);
    await migrateAiFunded(db.executor);
    const row = await sql<{ resolved_model: string | null; pricing_version: string | null;
      status: string; actual_microusd: number }>`
      SELECT resolved_model, pricing_version, status, actual_microusd FROM ai_funded_usage_reservations
      WHERE reservation_id = ${key.reservationId}
    `.execute(db.executor);
    expect(row.rows[0]).toEqual({ resolved_model: null, pricing_version: null,
      status: "settled", actual_microusd: 12 });
  });

  it("keeps zero credit and strict maximum-cost admission fail-closed", async () => {
    await expect(repo.authorize({ ...request(credential.token), billingMode: undefined }))
      .rejects.toMatchObject({ code: "budget_exceeded" });
    const empty = await fundRuntime({ ...identity, ownerId: "empty_owner", machineId: "empty_machine" }, 0);
    await expect(repo.authorize(request(empty.token))).rejects.toMatchObject({ code: "insufficient_credit" });
  });
});
