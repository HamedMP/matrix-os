import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { cleanupExpiredReservations } from "../../packages/platform/src/ai-funded-reservation-cleanup.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import {
  SpeechFundingError,
  createAiFundedSpeechFundingPort,
} from "../../packages/platform/src/speech/funding.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const now = new Date("2026-09-10T12:00:00.000Z");
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;

describe("funded AI speech wallet adapter", () => {
  let db: PlatformDB;
  let funded: ReturnType<typeof createAiFundedPolicyRepository>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "alice",
      runtimeSlot: identity.runtimeSlot,
      status: "running",
      imageVersion: "v1",
      provisionedAt: now.toISOString(),
      activationState: "authorized",
    });
    funded = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => now,
    });
    await funded.setRuntimePolicy({
      identity,
      expectedRevision: 0,
      enabled: false,
      allowedModelIds: [],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  function port(allowedSources: readonly ("promotional" | "addon")[]) {
    return createAiFundedSpeechFundingPort({
      allowedSources,
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => "speech_funding_1",
      now: () => now,
    });
  }

  function monthlyPort(reservationId: string, clock: () => Date = () => now) {
    return createAiFundedSpeechFundingPort({
      allowedSources: ["promotional"],
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => reservationId,
      now: clock,
      monthlyAllowance: {
        monthlyBudgetMicrousd: 1_000_000,
        monthlyPromotionalCreditMicrousd: 1_000_000,
      },
    });
  }

  it("uses speech-only monthly counters without enabling or consuming the text-model policy", async () => {
    await db.executor.updateTable("ai_funded_runtime_balances").set({
      month_spent_microusd: 77,
      month_reserved_microusd: 11,
    }).where("machine_id", "=", identity.machineId).execute();
    await db.executor.deleteFrom("ai_funded_runtime_policies")
      .where("machine_id", "=", identity.machineId).execute();
    const funding = monthlyPort("speech_monthly_1");
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_monthlyboundarya`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 120,
    }));

    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["month_spent_microusd", "month_reserved_microusd", "reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ month_spent_microusd: 77, month_reserved_microusd: 11, reserved_microusd: 120 });
    expect(await db.executor.selectFrom("speech_runtime_allowances")
      .select(["period_spent_microusd", "period_reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ period_spent_microusd: 0, period_reserved_microusd: 120 });

    await db.transaction((trx) => funding.start(trx.executor, reservation.reservationId));
    await db.transaction((trx) => funding.settle(trx.executor, reservation.reservationId, {
      mode: "exact",
      actualCostMicrousd: 40,
    }));
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["month_spent_microusd", "month_reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ month_spent_microusd: 77, month_reserved_microusd: 11 });
    expect(await db.executor.selectFrom("speech_runtime_allowances")
      .select(["period_spent_microusd", "period_reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ period_spent_microusd: 40, period_reserved_microusd: 0 });
    expect(await db.executor.selectFrom("ai_funded_runtime_policies").selectAll().execute()).toEqual([]);
  });

  it("conservatively cleans up monthly speech without requiring a text-model policy", async () => {
    await db.executor.updateTable("ai_funded_runtime_balances").set({
      month_spent_microusd: 77,
      month_reserved_microusd: 11,
    }).where("machine_id", "=", identity.machineId).execute();
    await db.executor.deleteFrom("ai_funded_runtime_policies")
      .where("machine_id", "=", identity.machineId).execute();
    let clock = new Date(now);
    const funding = monthlyPort("speech_monthly_cleanup", () => clock);
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_monthlycleanupaa`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-mini-tts",
      maximumCostMicrousd: 80,
      capability: "synthesis",
    }));
    await db.transaction((trx) => funding.start(trx.executor, reservation.reservationId));
    clock = new Date(clock.getTime() + 31 * 60_000);

    await expect(cleanupExpiredReservations({ db, now: () => clock }, { limit: 7 })).resolves.toBe(1);
    expect(await db.executor.selectFrom("speech_runtime_allowances")
      .select(["period_spent_microusd", "period_reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ period_spent_microusd: 80, period_reserved_microusd: 0 });
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["month_spent_microusd", "month_reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ month_spent_microusd: 77, month_reserved_microusd: 11 });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select("settlement_response").where("reservation_id", "=", reservation.reservationId)
      .executeTakeFirstOrThrow()).toMatchObject({
        settlement_response: expect.stringContaining('"capability":"speech:synthesize"'),
      });
  });

  it("does not treat a general promotional grant as monthly speech credit", async () => {
    await funded.grantCredit({
      entryId: "promo_general_only",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 500,
      sourceReference: "general-campaign",
    });
    const funding = createAiFundedSpeechFundingPort({
      allowedSources: ["promotional"],
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => "speech_monthly_no_credit",
      now: () => now,
      monthlyAllowance: {
        monthlyBudgetMicrousd: 1_000,
        monthlyPromotionalCreditMicrousd: 0,
      },
    });

    await expect(db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_nogeneralpromoa`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 40,
    }))).rejects.toMatchObject({ code: "allowance_exhausted" });
  });

  it("does not expose monthly speech promotional grants to general funding reservations", async () => {
    const speech = monthlyPort("speech_monthly_isolated");
    const speechReservation = await db.transaction((trx) => speech.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_speechisolationa`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 40,
    }));
    await db.transaction((trx) => speech.release(trx.executor, speechReservation.reservationId));

    const general = port(["promotional"]);
    await expect(db.transaction((trx) => general.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_generalisolation`,
      policyRevision: "speech-legacy",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 40,
    }))).rejects.toMatchObject({ code: "allowance_exhausted" });
  });

  it("settles and releases pre-rollout reservations against their stored general funding policy", async () => {
    await funded.grantCredit({
      entryId: "addon_before_speech_allowance",
      identity,
      kind: "addon_grant",
      amountMicrousd: 500,
      sourceReference: "invoice_before_speech_allowance",
    });
    const legacy = port(["addon"]);
    const settlement = await db.transaction((trx) => legacy.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_legacysettlementa`,
      policyRevision: "speech-legacy",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 80,
    }));
    const release = await db.transaction((trx) => createAiFundedSpeechFundingPort({
      allowedSources: ["addon"],
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => "speech_legacy_release",
      now: () => now,
    }).reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_legacyreleaseaaa`,
      policyRevision: "speech-legacy",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 60,
    }));
    await db.transaction((trx) => legacy.start(trx.executor, settlement.reservationId));

    const current = monthlyPort("unused_current_factory");
    await db.transaction((trx) => current.settle(trx.executor, settlement.reservationId, {
      mode: "exact",
      actualCostMicrousd: 40,
    }));
    await db.transaction((trx) => current.release(trx.executor, release.reservationId));

    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["month_spent_microusd", "month_reserved_microusd", "reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toEqual({ month_spent_microusd: 40, month_reserved_microusd: 0, reserved_microusd: 0 });
    expect(await db.executor.selectFrom("speech_runtime_allowances").selectAll().execute()).toEqual([]);
  });

  it("reserves, starts and settles against an eligible add-on balance in the existing ledger", async () => {
    await funded.grantCredit({
      entryId: "addon_1",
      identity,
      kind: "addon_grant",
      amountMicrousd: 500,
      sourceReference: "invoice_1",
    });
    const funding = port(["addon"]);
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_abcdefghijklmnop`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 120,
    }));

    expect(reservation).toEqual({ reservationId: "speech_funding_1", reservedMicrousd: 120 });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select("model_id").where("reservation_id", "=", reservation.reservationId)
      .executeTakeFirstOrThrow()).toEqual({ model_id: "gpt-4o-transcribe" });
    expect(await db.executor.selectFrom("ai_runtime_credentials")
      .select(["audience", "scope", "expires_at"]).where("machine_id", "=", identity.machineId)
      .executeTakeFirstOrThrow()).toEqual({
      audience: "matrix-platform-speech",
      scope: "speech:transcribe",
      expires_at: "2026-09-11T12:00:00.000Z",
    });
    await db.transaction((trx) => funding.start(trx.executor, reservation.reservationId));
    await db.transaction((trx) => funding.settle(trx.executor, reservation.reservationId, {
      mode: "exact",
      actualCostMicrousd: 40,
    }));

    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["credit_balance_microusd", "addon_balance_microusd", "reserved_microusd", "month_spent_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toMatchObject({
        credit_balance_microusd: 460,
        addon_balance_microusd: 460,
        reserved_microusd: 0,
        month_spent_microusd: 40,
      });
    const usage = await db.executor.selectFrom("ai_funded_credit_ledger")
      .select(["kind", "amount_microusd", "reservation_id"])
      .where("reservation_id", "=", reservation.reservationId).executeTakeFirstOrThrow();
    expect(usage).toEqual({ kind: "addon_debit", amount_microusd: -40, reservation_id: reservation.reservationId });
  });

  it("cannot spend a promotional-only balance when speech allows add-on credit only", async () => {
    await funded.grantCredit({
      entryId: "promo_text_only",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 500,
      sourceReference: "text-only-campaign",
    });
    const funding = port(["addon"]);

    await expect(db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_ponmlkjihgfedcba`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 120,
    }))).rejects.toBeInstanceOf(SpeechFundingError);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select("reserved_microusd").where("machine_id", "=", identity.machineId)
      .executeTakeFirstOrThrow()).toEqual({ reserved_microusd: 0 });
  });

  it("releases a pre-dispatch hold without debiting owner credit", async () => {
    await funded.grantCredit({
      entryId: "promo_speech",
      identity,
      kind: "promotional_grant",
      amountMicrousd: 300,
      sourceReference: "speech-campaign",
    });
    const funding = port(["promotional"]);
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_abcdefghijklmnoq`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 80,
    }));
    await db.transaction((trx) => funding.release(trx.executor, reservation.reservationId));

    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["credit_balance_microusd", "promotional_balance_microusd", "reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow())
      .toMatchObject({ credit_balance_microusd: 300, promotional_balance_microusd: 300, reserved_microusd: 0 });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select("status").where("reservation_id", "=", reservation.reservationId)
      .executeTakeFirstOrThrow()).toEqual({ status: "released" });
  });

  it.each(["revoked", "expired"] as const)("rejects dispatch under a %s runtime credential", async (state) => {
    await funded.grantCredit({
      entryId: `addon_${state}`,
      identity,
      kind: "addon_grant",
      amountMicrousd: 300,
      sourceReference: `invoice_${state}`,
    });
    let clock = new Date(now);
    const funding = createAiFundedSpeechFundingPort({
      allowedSources: ["addon"],
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => `speech_funding_${state}`,
      now: () => clock,
      reservationTtlMs: 10 * 60_000,
      credentialTtlMs: 5 * 60_000,
    });
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_credential${state}`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 80,
    }));
    if (state === "revoked") {
      await db.executor.updateTable("ai_runtime_credentials")
        .set({ revoked_at: clock.toISOString() })
        .where("machine_id", "=", identity.machineId)
        .where("audience", "=", "matrix-platform-speech")
        .executeTakeFirstOrThrow();
    } else {
      clock = new Date(clock.getTime() + 5 * 60_000);
    }

    await expect(db.transaction((trx) => funding.start(trx.executor, reservation.reservationId)))
      .rejects.toBeInstanceOf(SpeechFundingError);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select("status").where("reservation_id", "=", reservation.reservationId)
      .executeTakeFirstOrThrow()).toEqual({ status: "reserved" });
  });

  it("conservatively reconciles an expired in-flight speech reservation", async () => {
    await funded.grantCredit({
      entryId: "addon_crashed_dispatch",
      identity,
      kind: "addon_grant",
      amountMicrousd: 300,
      sourceReference: "invoice_crashed_dispatch",
    });
    let clock = new Date(now);
    const funding = createAiFundedSpeechFundingPort({
      allowedSources: ["addon"],
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => "speech_funding_crashed",
      now: () => clock,
      inFlightTtlMs: 60_000,
    });
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_crasheddispatchx`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 80,
    }));
    await db.transaction((trx) => funding.start(trx.executor, reservation.reservationId));
    clock = new Date(clock.getTime() + 61_000);

    await expect(cleanupExpiredReservations({ db, now: () => clock }, { limit: 7 })).resolves.toBe(1);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["status", "actual_microusd", "finalization_mode"])
      .where("reservation_id", "=", reservation.reservationId)
      .executeTakeFirstOrThrow()).toEqual({
        status: "settled",
        actual_microusd: 80,
        finalization_mode: "conservative",
      });
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["credit_balance_microusd", "reserved_microusd"])
      .where("machine_id", "=", identity.machineId)
      .executeTakeFirstOrThrow()).toMatchObject({ credit_balance_microusd: 220, reserved_microusd: 0 });
  });

  it("rolls back the wallet reservation when its enclosing speech admission fails", async () => {
    await funded.grantCredit({
      entryId: "addon_rollback",
      identity,
      kind: "addon_grant",
      amountMicrousd: 300,
      sourceReference: "invoice_rollback",
    });
    const funding = port(["addon"]);

    await expect(db.transaction(async (trx) => {
      await funding.reserve(trx.executor, {
        identity,
        requestId: `sp_${now.getTime()}_abcdefghijklmnoz`,
        policyRevision: "speech-1",
        modelId: "gpt-4o-transcribe",
        maximumCostMicrousd: 80,
      });
      await sql`SELECT missing_speech_column`.execute(trx.executor);
    })).rejects.toThrow();

    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select("reserved_microusd").where("machine_id", "=", identity.machineId)
      .executeTakeFirstOrThrow()).toEqual({ reserved_microusd: 0 });
  });

  it("rotates the internal credential namespace without stranding an existing runtime", async () => {
    await funded.grantCredit({
      entryId: "addon_rotation",
      identity,
      kind: "addon_grant",
      amountMicrousd: 300,
      sourceReference: "invoice_rotation",
    });
    const first = port(["addon"]);
    await db.transaction((trx) => first.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_rotationrequestaa`,
      policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 40,
    }));
    const rotated = createAiFundedSpeechFundingPort({
      allowedSources: ["addon"],
      credentialHashSecret: "r".repeat(32),
      reservationIdFactory: () => "speech_funding_rotated",
      now: () => now,
    });
    await expect(db.transaction((trx) => rotated.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_rotationrequestbb`,
      policyRevision: "speech-2",
      modelId: "gpt-4o-transcribe",
      maximumCostMicrousd: 40,
    }))).resolves.toEqual({ reservationId: "speech_funding_rotated", reservedMicrousd: 40 });
    expect(await db.executor.selectFrom("ai_runtime_credentials").select("token_id").execute()).toHaveLength(2);
  });

  it("runs the real synthesis reservation lifecycle against its persisted capability", async () => {
    await funded.grantCredit({
      entryId: "addon_synthesis",
      identity,
      kind: "addon_grant",
      amountMicrousd: 300,
      sourceReference: "invoice_synthesis",
    });
    const funding = port(["addon"]);
    const reservation = await db.transaction((trx) => funding.reserve(trx.executor, {
      identity,
      requestId: `sp_${now.getTime()}_synthesisfunding`,
      policyRevision: "speech-tts-1",
      modelId: "gpt-4o-mini-tts",
      maximumCostMicrousd: 80,
      capability: "synthesis",
    }));

    await db.transaction((trx) => funding.start(trx.executor, reservation.reservationId));
    await db.transaction((trx) => funding.settle(trx.executor, reservation.reservationId, {
      mode: "exact",
      actualCostMicrousd: 30,
    }));

    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["authorization_response", "start_response", "settlement_response", "status"])
      .where("reservation_id", "=", reservation.reservationId).executeTakeFirstOrThrow())
      .toMatchObject({
        status: "settled",
        authorization_response: expect.stringContaining('"capability":"speech:synthesize"'),
        start_response: expect.stringContaining('"capability":"speech:synthesize"'),
        settlement_response: expect.stringContaining('"capability":"speech:synthesize"'),
      });
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select("reserved_microusd").where("machine_id", "=", identity.machineId)
      .executeTakeFirstOrThrow()).toEqual({ reserved_microusd: 0 });
  });
});
