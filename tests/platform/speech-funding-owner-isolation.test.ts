import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupExpiredReservations } from "../../packages/platform/src/ai-funded-reservation-cleanup.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const first = { ownerId: "owner_first", machineId: "machine_first", runtimeSlot: "primary" };
const other = { ownerId: "owner_other", machineId: "machine_other", runtimeSlot: "primary" };
const operations = ["settle", "release", "expire_in_flight", "expire_reserved"] as const;

describe("speech allowance owner isolation", () => {
  let db: PlatformDB;
  let clock: Date;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-09-10T12:00:00.000Z");
    for (const identity of [first, other]) {
      await insertUserMachine(db, {
        machineId: identity.machineId,
        clerkUserId: identity.ownerId,
        handle: identity.machineId.replaceAll("_", "-"),
        runtimeSlot: identity.runtimeSlot,
        status: "running",
        imageVersion: "test",
        provisionedAt: clock.toISOString(),
        provisioningClass: "customer",
        activationState: "authorized",
      });
    }
  });

  afterEach(async () => destroyTestPlatformDb(db));

  function funding(reservationId: string, shortLived: boolean) {
    return createAiFundedSpeechFundingPort({
      allowedSources: ["promotional"],
      credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => reservationId,
      now: () => clock,
      ...(shortLived ? { reservationTtlMs: 30_000, inFlightTtlMs: 60_000 } : {}),
      monthlyAllowance: {
        monthlyBudgetMicrousd: 1_000_000,
        monthlyPromotionalCreditMicrousd: 1_000_000,
      },
    });
  }

  async function otherOwnerState() {
    return {
      allowance: await db.executor.selectFrom("speech_runtime_allowances").selectAll()
        .where("machine_id", "=", other.machineId).executeTakeFirstOrThrow(),
      wallet: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll()
        .where("machine_id", "=", other.machineId).executeTakeFirstOrThrow(),
      reservation: await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("machine_id", "=", other.machineId).executeTakeFirstOrThrow(),
      ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
        .where("machine_id", "=", other.machineId).orderBy("entry_id").execute(),
    };
  }

  it.each(operations)("%s changes only its owner's allowance while another owner has a live hold", async (operation) => {
    const targetFunding = funding("speech_target", true);
    const otherFunding = funding("speech_other", false);
    for (const [identity, port, hold] of [[first, targetFunding, 80], [other, otherFunding, 160]] as const) {
      await db.transaction((trx) => port.reserve(trx.executor, {
        identity,
        requestId: `request_${identity.machineId}`,
        policyRevision: "speech-1",
        modelId: "gpt-4o-transcribe",
        maximumCostMicrousd: hold,
      }));
    }
    if (operation === "settle" || operation === "expire_in_flight") {
      await db.transaction((trx) => targetFunding.start(trx.executor, "speech_target"));
    }
    const otherBefore = await otherOwnerState();
    expect(Number(otherBefore.allowance.period_reserved_microusd)).toBe(160);
    expect(otherBefore.reservation.status).toBe("reserved");

    clock = new Date(clock.getTime() + 61_000);
    if (operation === "settle") {
      await db.transaction((trx) => targetFunding.settle(trx.executor, "speech_target", {
        mode: "exact", actualCostMicrousd: 40,
      }));
    } else if (operation === "release") {
      await db.transaction((trx) => targetFunding.release(trx.executor, "speech_target"));
    } else {
      await expect(cleanupExpiredReservations({ db, now: () => clock }, { limit: 7 })).resolves.toBe(1);
    }

    // Compare every persisted field, including period, policy, counters and timestamps.
    expect(await otherOwnerState()).toEqual(otherBefore);
    const target = await db.executor.selectFrom("speech_runtime_allowances").selectAll()
      .where("machine_id", "=", first.machineId).executeTakeFirstOrThrow();
    expect(Number(target.period_reserved_microusd)).toBe(0);
    expect(Number(target.period_spent_microusd)).toBe(
      operation === "settle" ? 40 : operation === "expire_in_flight" ? 80 : 0,
    );
    expect(target.updated_at).toBe(clock.toISOString());
  });
});
