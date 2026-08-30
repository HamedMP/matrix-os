import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiFundedPolicyError,
  createAiFundedPolicyRepository,
} from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const modelId = "anthropic/claude-sonnet-5";
const otherModelId = "anthropic/claude-opus-5";
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;

describe("funded AI metering", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "alice",
      runtimeSlot: identity.runtimeSlot,
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-08-30T19:00:00.000Z",
      activationState: "authorized",
    });
    clock = new Date("2026-08-30T20:00:00.000Z");
    let tokenCounter = 0;
    repo = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock),
      tokenIdFactory: () => `credential_${++tokenCounter}`,
      tokenSecretFactory: () => "s".repeat(43),
      credentialTtlMs: 60 * 60_000,
      issueCooldownMs: 1_000,
      reservationTtlMs: 5 * 60_000,
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function enableAndFund(input: { budget?: number; credit?: number } = {}) {
    await repo.updateGlobalPolicy({
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId, otherModelId],
    });
    await repo.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId],
      monthlyBudgetMicrousd: input.budget ?? 1_000,
      expiresAt: null,
    });
    if ((input.credit ?? 1_000) > 0) {
      await repo.grantCredit({
        entryId: "grant_1",
        identity,
        kind: "promotional_grant",
        amountMicrousd: input.credit ?? 1_000,
        sourceReference: "launch-credit-2026",
      });
    }
    const issued = await repo.issueRuntimeCredential(identity);
    return issued.credential;
  }

  it("atomically reserves worst-case cost so concurrent requests cannot overspend", async () => {
    const credential = await enableAndFund({ budget: 100, credit: 100 });
    const results = await Promise.allSettled([
      repo.authorize({ credential: credential.token, requestId: "request_a", modelId, maxCostMicrousd: 80 }),
      repo.authorize({ credential: credential.token, requestId: "request_b", modelId, maxCostMicrousd: 80 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: expect.stringMatching(/insufficient_credit|budget_exceeded/) });
    const reservations = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute();
    expect(reservations).toHaveLength(1);
    expect(Number(reservations[0].reserved_microusd)).toBe(80);
  });

  it("reads one exact runtime funding summary and rolls the monthly projection forward", async () => {
    await enableAndFund({ budget: 1_000, credit: 1_000 });
    await repo.grantCredit({
      entryId: "grant_addon_summary",
      identity,
      kind: "addon_grant",
      amountMicrousd: 400,
      sourceReference: "addon-summary",
    });
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      periodStart: "2026-08-01T00:00:00.000Z",
      monthlyBudgetMicrousd: 1_000,
      promotionalBalanceMicrousd: 1_000,
      addonBalanceMicrousd: 400,
      creditBalanceMicrousd: 1_400,
      remainingBalanceMicrousd: 1_400,
      remainingBudgetMicrousd: 1_000,
    });

    clock = new Date("2026-09-01T00:00:01.000Z");
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      periodStart: "2026-09-01T00:00:00.000Z",
      settledThisMonthMicrousd: 0,
      reservedThisMonthMicrousd: 0,
      remainingBudgetMicrousd: 1_000,
    });
    await expect(repo.getFundingSummary({ ...identity, ownerId: "user_other" }))
      .rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("replays the same reservation and rejects reuse with a different payload", async () => {
    const credential = await enableAndFund();
    const request = { credential: credential.token, requestId: "request_replay", modelId, maxCostMicrousd: 70 };
    const first = await repo.authorize(request);
    const replay = await repo.authorize(request);
    expect(replay).toEqual(first);

    await expect(repo.authorize({ ...request, maxCostMicrousd: 71 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toHaveLength(1);
  });

  it("settles actual usage exactly once, releases unused credit, and rejects over-settlement", async () => {
    const credential = await enableAndFund({ budget: 200, credit: 200 });
    const authorization = await repo.authorize({
      credential: credential.token,
      requestId: "request_settle",
      modelId,
      maxCostMicrousd: 100,
    });
    await expect(repo.settleReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 60,
    })).rejects.toMatchObject({ code: "reservation_closed" });
    const startRequest = { reservationId: authorization.reservation.reservationId, tokenId: credential.tokenId };
    const started = await repo.startReservation(startRequest);
    await expect(repo.startReservation(startRequest)).resolves.toEqual(started);
    const settlementRequest = {
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 60,
    };
    const settlement = await repo.settleReservation(settlementRequest);
    expect(settlement).toMatchObject({ actualCostMicrousd: 60, releasedMicrousd: 40, remainingBalanceMicrousd: 140 });
    await expect(repo.settleReservation(settlementRequest)).resolves.toEqual(settlement);
    await expect(repo.settleReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 61,
    })).rejects.toMatchObject({ code: "idempotency_conflict" });

    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger")
      .select(["kind", "amount_microusd"]).orderBy("created_at").execute();
    expect(ledger.map((row) => [row.kind, Number(row.amount_microusd)])).toEqual([
      ["promotional_grant", 200],
      ["promotional_debit", -60],
    ]);

    const second = await repo.authorize({
      credential: credential.token,
      requestId: "request_over",
      modelId,
      maxCostMicrousd: 50,
    });
    await repo.startReservation({ reservationId: second.reservation.reservationId, tokenId: credential.tokenId });
    await expect(repo.settleReservation({
      reservationId: second.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 51,
    })).rejects.toMatchObject({ code: "over_settlement" });
  });

  it("enforces zero balance, model allowlist, monthly budget, and the global kill switch before reservation", async () => {
    const credential = await enableAndFund({ budget: 50, credit: 0 });
    await expect(repo.authorize({
      credential: credential.token, requestId: "zero", modelId, maxCostMicrousd: 1,
    })).rejects.toMatchObject({ code: "insufficient_credit" });

    await repo.grantCredit({
      entryId: "grant_later", identity, kind: "addon_grant", amountMicrousd: 100, sourceReference: "invoice_123",
    });
    await expect(repo.authorize({
      credential: credential.token, requestId: "denied", modelId: otherModelId, maxCostMicrousd: 1,
    })).rejects.toMatchObject({ code: "model_not_allowed" });
    await expect(repo.authorize({
      credential: credential.token, requestId: "budget", modelId, maxCostMicrousd: 51,
    })).rejects.toMatchObject({ code: "budget_exceeded" });

    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] });
    await expect(repo.authorize({
      credential: credential.token, requestId: "killed", modelId, maxCostMicrousd: 1,
    })).rejects.toMatchObject({ code: "access_disabled" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toHaveLength(0);
  });

  it("resets monthly budget at the UTC month boundary without resetting credit", async () => {
    clock = new Date("2026-08-31T23:30:00.000Z");
    const credential = await enableAndFund({ budget: 100, credit: 200 });
    const august = await repo.authorize({
      credential: credential.token, requestId: "august", modelId, maxCostMicrousd: 80,
    });
    await repo.startReservation({ reservationId: august.reservation.reservationId, tokenId: credential.tokenId });
    await repo.settleReservation({
      reservationId: august.reservation.reservationId, tokenId: credential.tokenId, actualCostMicrousd: 80,
    });
    await expect(repo.authorize({
      credential: credential.token, requestId: "august-over", modelId, maxCostMicrousd: 21,
    })).rejects.toMatchObject({ code: "budget_exceeded" });

    clock = new Date("2026-09-01T00:10:00.000Z");
    await expect(repo.authorize({
      credential: credential.token, requestId: "september", modelId, maxCostMicrousd: 80,
    })).resolves.toMatchObject({ reservation: { periodStart: "2026-09-01T00:00:00.000Z" } });
  });

  it("recovers expired reservations through a bounded cleanup path", async () => {
    const credential = await enableAndFund({ budget: 100, credit: 100 });
    const first = await repo.authorize({
      credential: credential.token, requestId: "expires", modelId, maxCostMicrousd: 100,
    });
    clock = new Date("2026-08-30T20:06:00.000Z");
    expect(await repo.cleanupExpiredReservations({ limit: 10 })).toBe(1);
    const row = await db.executor.selectFrom("ai_funded_usage_reservations")
      .selectAll().where("reservation_id", "=", first.reservation.reservationId).executeTakeFirstOrThrow();
    expect(row.status).toBe("expired");
    await expect(repo.settleReservation({
      reservationId: first.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 10,
    })).rejects.toMatchObject({ code: "reservation_expired" });
    await expect(repo.authorize({
      credential: credential.token, requestId: "after-expiry", modelId, maxCostMicrousd: 100,
    })).resolves.toMatchObject({ authorized: true });
  });

  it("conservatively charges the full reservation when in-flight usage expires", async () => {
    const credential = await enableAndFund({ budget: 100, credit: 100 });
    const authorization = await repo.authorize({
      credential: credential.token, requestId: "in_flight_expiry", modelId, maxCostMicrousd: 100,
    });
    const started = await repo.startReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
    });
    await expect(repo.startReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
    })).resolves.toEqual(started);
    clock = new Date("2026-08-30T20:31:00.000Z");
    const cleanupCounts = await Promise.all([
      repo.cleanupExpiredReservations({ limit: 10 }),
      repo.cleanupExpiredReservations({ limit: 10 }),
    ]);
    expect(cleanupCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
    const reservation = await db.executor.selectFrom("ai_funded_usage_reservations")
      .selectAll().where("reservation_id", "=", authorization.reservation.reservationId)
      .executeTakeFirstOrThrow();
    expect(reservation).toMatchObject({ status: "settled", actual_microusd: 100 });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("reservation_id", "=", reservation.reservation_id).execute())
      .toEqual([{ amount_microusd: -100 }]);
    await expect(repo.settleReservation({
      reservationId: reservation.reservation_id,
      tokenId: credential.tokenId,
      actualCostMicrousd: 100,
    })).resolves.toMatchObject({ status: "settled", actualCostMicrousd: 100, releasedMicrousd: 0 });
  });

  it("keeps grants immutable and idempotent by explicit billing/admin entry ID", async () => {
    await enableAndFund({ credit: 100 });
    const same = {
      entryId: "addon_1", identity, kind: "addon_grant" as const,
      amountMicrousd: 250, sourceReference: "invoice_abc",
    };
    const first = await repo.grantCredit(same);
    await expect(repo.grantCredit(same)).resolves.toEqual(first);
    await expect(repo.grantCredit({ ...same, amountMicrousd: 251 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .selectAll().where("entry_id", "=", "addon_1").execute()).toHaveLength(1);
  });

  it("atomically retires only expired promotional remainder and keeps add-on credit usable", async () => {
    await repo.updateGlobalPolicy({
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId],
    });
    await repo.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    });
    const grant = {
      entryId: "launch_campaign_2026",
      identity,
      kind: "promotional_grant" as const,
      amountMicrousd: 500,
      sourceReference: "launch-2026",
      expiresAt: "2026-08-30T20:04:00.000Z",
    };
    const [first, concurrentReplay] = await Promise.all([
      repo.grantCredit(grant),
      repo.grantCredit(grant),
    ]);
    expect(concurrentReplay).toEqual(first);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .selectAll().where("entry_id", "=", grant.entryId).execute()).toHaveLength(1);
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      promotionalBalanceMicrousd: 500,
      creditBalanceMicrousd: 500,
    });
    await repo.grantCredit({
      entryId: "expiry_addon",
      identity,
      kind: "addon_grant",
      amountMicrousd: 300,
      sourceReference: "invoice_expiry_addon",
    });
    await expect(repo.grantCredit({ ...grant, expiresAt: "2026-08-30T20:06:00.000Z" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repo.grantCredit({ ...grant, entryId: "bad_addon_expiry", kind: "addon_grant" }))
      .rejects.toThrow();
    const issued = await repo.issueRuntimeCredential(identity);

    clock = new Date("2026-08-30T20:04:00.000Z");
    const summaries = await Promise.all([
      repo.getFundingSummary(identity),
      repo.getFundingSummary(identity),
    ]);
    expect(summaries[0]).toMatchObject({
      promotionalBalanceMicrousd: 0,
      addonBalanceMicrousd: 300,
      creditBalanceMicrousd: 300,
      remainingBalanceMicrousd: 300,
    });
    expect(summaries[1]).toEqual(summaries[0]);
    await expect(repo.authorize({
      credential: issued.credential.token,
      requestId: "expired_promotion",
      modelId,
      maxCostMicrousd: 100,
    })).resolves.toMatchObject({
      funding: { promotionalBalanceMicrousd: 0, addonBalanceMicrousd: 300 },
      reservation: { remainingBalanceMicrousd: 200 },
    });
    await expect(repo.issueRuntimeCredential(identity)).resolves.toMatchObject({
      policy: { enabled: true },
    });
    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger")
      .select(["kind", "amount_microusd", "source_reference"])
      .where("machine_id", "=", identity.machineId)
      .orderBy("created_at").orderBy("entry_id").execute();
    expect(ledger.filter((row) => row.kind === "promotional_expiry")).toEqual([{
      kind: "promotional_expiry",
      amount_microusd: -500,
      source_reference: grant.entryId,
    }]);
    expect(ledger.filter((row) => row.kind === "promotional_grant")).toHaveLength(1);
  });

  it("protects reserved promotional credit at expiry then retires only the released remainder", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    });
    await repo.grantCredit({
      entryId: "reserved_expiring_promo",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 100,
      sourceReference: "reserved-expiry-campaign",
      expiresAt: "2026-08-30T20:04:00.000Z",
    });
    await repo.grantCredit({
      entryId: "reserved_expiry_addon",
      identity,
      kind: "addon_grant",
      amountMicrousd: 100,
      sourceReference: "reserved-expiry-invoice",
    });
    const credential = (await repo.issueRuntimeCredential(identity)).credential;
    const reserved = await repo.authorize({
      credential: credential.token,
      requestId: "reserved_across_expiry",
      modelId,
      maxCostMicrousd: 80,
    });

    clock = new Date("2026-08-30T20:04:00.000Z");
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      promotionalBalanceMicrousd: 80,
      addonBalanceMicrousd: 100,
      creditBalanceMicrousd: 180,
      reservedMicrousd: 80,
      remainingBalanceMicrousd: 100,
    });
    await repo.releaseReservation({
      reservationId: reserved.reservation.reservationId,
      tokenId: credential.tokenId,
      reason: "pre_upstream_failure",
    });
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      promotionalBalanceMicrousd: 0,
      addonBalanceMicrousd: 100,
      creditBalanceMicrousd: 100,
      reservedMicrousd: 0,
      remainingBalanceMicrousd: 100,
    });
    const expiryDebits = await db.executor.selectFrom("ai_funded_credit_ledger")
      .select("amount_microusd").where("kind", "=", "promotional_expiry")
      .orderBy("created_at").orderBy("entry_id").execute();
    expect(expiryDebits.map((row) => Number(row.amount_microusd)).sort((a, b) => a - b))
      .toEqual([-80, -20]);
  });

  it("charges an in-flight reservation before retiring its expired promotional backing", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    });
    await repo.grantCredit({
      entryId: "inflight_expiring_promo",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 100,
      sourceReference: "inflight-expiry-campaign",
      expiresAt: "2026-08-30T20:04:00.000Z",
    });
    await repo.grantCredit({
      entryId: "inflight_expiry_addon",
      identity,
      kind: "addon_grant",
      amountMicrousd: 100,
      sourceReference: "inflight-expiry-invoice",
    });
    const credential = (await repo.issueRuntimeCredential(identity)).credential;
    const authorization = await repo.authorize({
      credential: credential.token,
      requestId: "inflight_across_expiry",
      modelId,
      maxCostMicrousd: 80,
    });
    await repo.startReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
    });

    clock = new Date("2026-08-30T20:04:00.000Z");
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      promotionalBalanceMicrousd: 80,
      addonBalanceMicrousd: 100,
      reservedMicrousd: 80,
    });
    await expect(repo.settleReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 30,
    })).resolves.toMatchObject({
      funding: {
        promotionalBalanceMicrousd: 0,
        addonBalanceMicrousd: 100,
        creditBalanceMicrousd: 100,
        reservedMicrousd: 0,
      },
    });
    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger")
      .select(["kind", "amount_microusd"])
      .where("machine_id", "=", identity.machineId).execute();
    expect(ledger.filter((row) => row.kind === "promotional_debit")
      .map((row) => Number(row.amount_microusd))).toEqual([-30]);
    expect(ledger.filter((row) => row.kind === "promotional_expiry")
      .map((row) => Number(row.amount_microusd)).sort((a, b) => a - b)).toEqual([-50, -20]);
  });

  it("leaves unexpired promotional grants intact when an older campaign expires", async () => {
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    });
    await repo.grantCredit({
      entryId: "older_expired_campaign",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 100,
      sourceReference: "older-campaign",
      expiresAt: "2026-08-30T20:05:00.000Z",
    });
    await repo.grantCredit({
      entryId: "newer_active_campaign",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 70,
      sourceReference: "newer-campaign",
      expiresAt: "2026-09-30T20:00:00.000Z",
    });
    clock = new Date("2026-08-30T20:05:00.000Z");
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      promotionalBalanceMicrousd: 70,
      addonBalanceMicrousd: 0,
      creditBalanceMicrousd: 70,
    });
    const balances = await db.executor.selectFrom("ai_funded_promotional_grant_balances")
      .select(["grant_entry_id", "remaining_microusd"])
      .orderBy("grant_entry_id").execute();
    expect(balances.map((row) => [row.grant_entry_id, Number(row.remaining_microusd)])).toEqual([
      ["newer_active_campaign", 70],
      ["older_expired_campaign", 0],
    ]);
  });

  it("tracks promotional and add-on balances without exposing ledger internals", async () => {
    const credential = await enableAndFund({ budget: 200, credit: 50 });
    await repo.grantCredit({
      entryId: "addon_bucket", identity, kind: "addon_grant", amountMicrousd: 100, sourceReference: "invoice_bucket",
    });
    const authorization = await repo.authorize({
      credential: credential.token, requestId: "bucketed", modelId, maxCostMicrousd: 120,
    });
    expect(authorization.funding).toMatchObject({
      promotionalBalanceMicrousd: 50,
      addonBalanceMicrousd: 100,
      creditBalanceMicrousd: 150,
      reservedMicrousd: 120,
      remainingBalanceMicrousd: 30,
      settledThisMonthMicrousd: 0,
      asOf: "2026-08-30T20:00:00.000Z",
      periodStart: "2026-08-01T00:00:00.000Z",
    });
    await repo.startReservation({ reservationId: authorization.reservation.reservationId, tokenId: credential.tokenId });
    const settled = await repo.settleReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
      actualCostMicrousd: 80,
    });
    expect(settled.funding).toMatchObject({
      promotionalBalanceMicrousd: 0,
      addonBalanceMicrousd: 70,
      creditBalanceMicrousd: 70,
      reservedMicrousd: 0,
      settledThisMonthMicrousd: 80,
    });
  });

  it("releases definitive pre-upstream failures idempotently and closes settlement", async () => {
    const credential = await enableAndFund({ budget: 100, credit: 100 });
    const authorization = await repo.authorize({
      credential: credential.token, requestId: "release_me", modelId, maxCostMicrousd: 80,
    });
    const request = {
      reservationId: authorization.reservation.reservationId,
      tokenId: credential.tokenId,
      reason: "pre_upstream_failure" as const,
    };
    const released = await repo.releaseReservation(request);
    expect(released).toMatchObject({ releasedMicrousd: 80, status: "released", funding: { reservedMicrousd: 0 } });
    await expect(repo.releaseReservation(request)).resolves.toEqual(released);
    await expect(repo.settleReservation({
      reservationId: request.reservationId,
      tokenId: request.tokenId,
      actualCostMicrousd: 1,
    })).rejects.toMatchObject({ code: "reservation_closed" });
    await expect(repo.authorize({
      credential: credential.token, requestId: "after_release", modelId, maxCostMicrousd: 100,
    })).resolves.toMatchObject({ authorized: true });
  });
});
