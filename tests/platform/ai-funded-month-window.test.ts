import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./funded-policy-db-test-helper.js";

// ENG-576. A funded transaction can act on an older clock than one that
// already committed: authorize, release and the funding summary read the clock
// before they wait for locks, and platform replicas' clocks differ. At a UTC
// month change that older clock must not move a runtime's budget window back.
// Each test stands in for the lock wait by handing one call a clock 20 ms
// older than a call that committed before it.
const modelId = "anthropic/claude-sonnet-5";
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
const BEFORE_MIDNIGHT = "2026-08-31T23:59:59.990Z";
const AFTER_MIDNIGHT = "2026-09-01T00:00:00.010Z";
const SEPTEMBER = "2026-09-01T00:00:00.000Z";

describe("funded AI monthly budget window at a month change", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-08-31T23:30:00.000Z");
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "alice",
      runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "v1",
      provisionedAt: clock.toISOString(), activationState: "authorized" });
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => new Date(clock),
      tokenIdFactory: () => "credential_1", tokenSecretFactory: () => "s".repeat(43),
      credentialTtlMs: 60 * 60_000, issueCooldownMs: 1_000, reservationTtlMs: 5 * 60_000 });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000, expiresAt: null });
    await repo.grantCredit({ entryId: "grant_1", identity, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "test" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
  });
  afterEach(() => destroyTestPlatformDb(db));

  async function balance() {
    const row = await db.executor.selectFrom("ai_funded_runtime_balances")
      .select(["month_period_start", "month_spent_microusd", "month_reserved_microusd", "reserved_microusd"])
      .where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();
    return { period: row.month_period_start, spent: Number(row.month_spent_microusd),
      monthReserved: Number(row.month_reserved_microusd), reserved: Number(row.reserved_microusd) };
  }
  async function authorize(requestId: string, at: string, billingMode?: "usage") {
    clock = new Date(at);
    const authorization = await repo.authorize({ credential: credential.token, requestId, modelId,
      maxCostMicrousd: 100, ...(billingMode ? { billingMode } : {}) });
    return { reservationId: authorization.reservation.reservationId, tokenId: credential.tokenId,
      periodStart: authorization.reservation.periodStart };
  }

  it("a funding summary with a clock from before midnight leaves the new month's window, and the request settles", async () => {
    const { periodStart, ...locator } = await authorize("request_1", AFTER_MIDNIGHT, "usage");
    await repo.startReservation(locator);
    expect(periodStart).toBe(SEPTEMBER);

    clock = new Date(BEFORE_MIDNIGHT);
    const summary = await repo.getRuntimeFundingSummary(identity);

    expect(summary.funding).toMatchObject({ periodStart: SEPTEMBER, reservedThisMonthMicrousd: 100 });
    expect(await balance()).toEqual({ period: SEPTEMBER, spent: 0, monthReserved: 100, reserved: 100 });
    clock = new Date("2026-09-01T00:00:05.000Z");
    await expect(repo.settleReservation({ ...locator, actualCostMicrousd: 60 })).resolves.toMatchObject({ status: "settled" });
    expect(await balance()).toEqual({ period: SEPTEMBER, spent: 60, monthReserved: 0, reserved: 0 });
  });

  it("an authorization with a clock from before midnight is counted in the window it lands in", async () => {
    const { periodStart: firstPeriod, ...first } = await authorize("request_1", AFTER_MIDNIGHT);
    await repo.startReservation(first);
    clock = new Date("2026-09-01T00:00:00.015Z");
    await repo.settleReservation({ ...first, actualCostMicrousd: 100 });
    expect(firstPeriod).toBe(SEPTEMBER);

    const { periodStart: latePeriod, ...late } = await authorize("request_2", BEFORE_MIDNIGHT);

    // September's spend is kept, and the late hold counts against September.
    expect(latePeriod).toBe(SEPTEMBER);
    expect(await balance()).toEqual({ period: SEPTEMBER, spent: 100, monthReserved: 100, reserved: 100 });
    clock = new Date("2026-09-01T00:00:05.000Z");
    await repo.startReservation(late);
    await repo.settleReservation({ ...late, actualCostMicrousd: 40 });
    expect(await balance()).toEqual({ period: SEPTEMBER, spent: 140, monthReserved: 0, reserved: 0 });
  });

  it("a release with a clock from before midnight gives back only its own hold", async () => {
    const { periodStart: _first, ...kept } = await authorize("request_1", AFTER_MIDNIGHT);
    const { periodStart: _second, ...released } = await authorize("request_2", AFTER_MIDNIGHT);

    clock = new Date(BEFORE_MIDNIGHT);
    await expect(repo.releaseReservation({ ...released, reason: "pre_upstream_failure" }))
      .resolves.toMatchObject({ status: "released" });

    expect(await balance()).toEqual({ period: SEPTEMBER, spent: 0, monthReserved: 100, reserved: 100 });
    clock = new Date("2026-09-01T00:00:05.000Z");
    await repo.startReservation(kept);
    await expect(repo.settleReservation({ ...kept, actualCostMicrousd: 100 })).resolves.toMatchObject({ status: "settled" });
  });

  it("a speech reservation with a clock from before midnight leaves the new month's window", async () => {
    const { periodStart: _period, ...locator } = await authorize("request_1", AFTER_MIDNIGHT);
    const speech = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => "speech_late_1", now: () => new Date(BEFORE_MIDNIGHT) });

    const reservation = await db.transaction((trx) => speech.reserve(trx.executor, { identity,
      requestId: `sp_${Date.parse(BEFORE_MIDNIGHT)}_monthwindowaaaa`, policyRevision: "speech-1",
      modelId: "gpt-4o-transcribe", maximumCostMicrousd: 50 }));

    const after = await balance();
    expect(after).toMatchObject({ period: SEPTEMBER, monthReserved: 100 + reservation.reservedMicrousd });
    const stored = await db.executor.selectFrom("ai_funded_usage_reservations").select("period_start")
      .where("reservation_id", "=", reservation.reservationId).executeTakeFirstOrThrow();
    expect(stored.period_start).toBe(SEPTEMBER);
    clock = new Date("2026-09-01T00:00:05.000Z");
    await repo.startReservation(locator);
    await expect(repo.settleReservation({ ...locator, actualCostMicrousd: 100 })).resolves.toMatchObject({ status: "settled" });
  });
});
