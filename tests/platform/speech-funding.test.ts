import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
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
      maximumCostMicrousd: 120,
    }));

    expect(reservation).toEqual({ reservationId: "speech_funding_1", reservedMicrousd: 120 });
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
        maximumCostMicrousd: 80,
      });
      await sql`SELECT missing_speech_column`.execute(trx.executor);
    })).rejects.toThrow();

    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances")
      .select("reserved_microusd").where("machine_id", "=", identity.machineId)
      .executeTakeFirstOrThrow()).toEqual({ reserved_microusd: 0 });
  });
});
