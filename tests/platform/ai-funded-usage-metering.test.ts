import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

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

  it("does not manufacture usage after a timeout and blocks until exact reconciliation", async () => {
    const auth = await repo.authorize(request(credential.token));
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.finalizeReservation({ ...key, mode: "conservative" }))
      .rejects.toMatchObject({ code: "unavailable" });
    clock = new Date(clock.getTime() + 61_000);
    expect(await repo.cleanupExpiredReservations({ limit: 10 })).toBe(0);
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      reservedMicrousd: 1_000_000, settledThisMonthMicrousd: 0,
    });
    await expect(repo.authorize(request(credential.token, "blocked")))
      .rejects.toMatchObject({ code: "rate_limited" });
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100 });
    expect((await repo.authorize(request(credential.token, "reconciled"))).authorized).toBe(true);
  });

  it("keeps zero credit and strict maximum-cost admission fail-closed", async () => {
    await expect(repo.authorize({ ...request(credential.token), billingMode: undefined }))
      .rejects.toMatchObject({ code: "budget_exceeded" });
    const empty = await fundRuntime({ ...identity, ownerId: "empty_owner", machineId: "empty_machine" }, 0);
    await expect(repo.authorize(request(empty.token))).rejects.toMatchObject({ code: "insufficient_credit" });
  });
});
