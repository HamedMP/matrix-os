import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { sql } from "kysely";
import { reserveFundingSources } from "../../packages/platform/src/ai-funded-reservation-sources.js";
import { ensureSpeechMonthlyAllowance } from "../../packages/platform/src/speech/allowance.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const identity = { ownerId: "eligibility_owner", machineId: "eligibility_machine", runtimeSlot: "primary" };
const modelId = "z-ai/glm-5";

describe("Chat reserves only eligible funding sources", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-10-03T05:00:00.000Z");
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock), credentialTtlMs: 3_600_000, inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { ...{ machineId: identity.machineId, clerkUserId: identity.ownerId },
      handle: "eligibility", runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test",
      activationState: "authorized", provisionedAt: clock.toISOString() });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 100_000, expiresAt: null });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  const grant = (entryId: string, amountMicrousd: number, kind: "promotional_grant" | "addon_grant" = "promotional_grant",
    expiresAt?: string) => repo.grantCredit({ entryId, identity, kind, amountMicrousd,
    sourceReference: "source-eligibility-test", ...(expiresAt ? { expiresAt } : {}) });
  const speech = (amount = 999_892) => db.transaction((trx) => ensureSpeechMonthlyAllowance(trx.executor, identity, {
    monthlyBudgetMicrousd: 1_000_000, monthlyPromotionalCreditMicrousd: amount, now: clock,
  }));
  const authorize = (requestId: string, maxCostMicrousd: number, usage = true) => repo.authorize({
    credential: credential.token, requestId, modelId, maxCostMicrousd,
    ...(usage ? { billingMode: "usage" as const } : {}),
  });
  const speechGrant = () => db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll()
    .where("grant_entry_id", "like", "speech-monthly:%").executeTakeFirstOrThrow();
  const finances = async () => ({
    balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    reservations: await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
  });

  it("projects only Chat eligible sources while leaving legacy summary arithmetic intact", async () => {
    await speech();
    const legacy = await repo.getRuntimeFundingSummary(identity);
    expect(legacy).not.toHaveProperty("chatAvailability");
    const onlySpeech = await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true });
    expect(onlySpeech.funding).toEqual(legacy.funding);
    expect(onlySpeech.chatAvailability).toEqual({ contractVersion: 1, asOf: clock.toISOString(), eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 });
    await grant("general_chat", 100);
    await grant("addon_chat", 50, "addon_grant");
    const hold = await authorize("chat_hold", 70, false);
    const before = await finances();
    expect((await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true })).chatAvailability)
      .toMatchObject({ eligibleBalanceMicrousd: 150, availableBalanceMicrousd: 80 });
    // Legacy unattributed holds and shortfall must conservatively cap availability.
    await db.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 999_892 + 140 }).where("machine_id", "=", identity.machineId).execute();
    expect((await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true })).chatAvailability)
      .toMatchObject({ eligibleBalanceMicrousd: 150, availableBalanceMicrousd: 10 });
    expect((await finances()).reservations).toEqual(before.reservations);
    expect((await finances()).allocations).toEqual(before.allocations);
    expect(hold.reservation.reservedMicrousd).toBe(70);
  });

  it("caps eligible Chat funds by durable shortfall before classifying protected funds", async () => {
    await grant("general_with_shortfall", 100);
    await db.executor.updateTable("ai_funded_runtime_balances")
      .set({ funding_shortfall_microusd: 80 }).where("machine_id", "=", identity.machineId).execute();
    const before = await finances();
    const summary = await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true });
    expect(summary.chatAvailability).toMatchObject({ eligibleBalanceMicrousd: 20, availableBalanceMicrousd: 20 });
    expect(await finances()).toEqual(before);
    await speech();
    // Speech can cover aggregate shortfall, but cannot increase general credit.
    expect((await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true })).chatAvailability)
      .toMatchObject({ eligibleBalanceMicrousd: 100, availableBalanceMicrousd: 100 });
  });

  it("does not count expired protected grants as Chat credit or release their holds", async () => {
    await grant("expires_while_held", 100, "promotional_grant", "2026-10-03T05:01:00.000Z");
    await speech();
    await authorize("held_before_expiry", 70, false);
    const reservations = (await finances()).reservations;
    clock = new Date(clock.getTime() + 120_000);
    const summary = await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true });
    expect(summary.chatAvailability).toMatchObject({ eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 });
    expect(summary.funding.reservedMicrousd).toBe(70);
    expect(summary.funding.creditBalanceMicrousd).toBe(999_892 + 70);
    expect((await finances()).reservations).toEqual(reservations);
  });

  it("rolls monthly usage without resetting general funding or its outstanding holds", async () => {
    await grant("ongoing_general", 100);
    await grant("ongoing_addon", 50, "addon_grant");
    await authorize("previous_month_hold", 70, false);
    clock = new Date("2026-11-01T00:00:01.000Z");
    const summary = await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true });
    expect(summary.chatAvailability).toMatchObject({ eligibleBalanceMicrousd: 150, availableBalanceMicrousd: 80 });
    expect(summary.funding).toMatchObject({ periodStart: "2026-11-01T00:00:00.000Z", reservedMicrousd: 70, reservedThisMonthMicrousd: 0 });
  });

  it("clamps usage to general sources while preserving audited unknown liability and exact replay", async () => {
    await grant("general_initial", 105_557);
    const known = await authorize("known", 5_557);
    const knownKey = { reservationId: known.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(knownKey);
    await repo.finalizeReservation({ ...knownKey, mode: "exact", actualCostMicrousd: 5_557 });
    const old = await authorize("old_unknown", 240_845);
    expect(old.reservation.reservedMicrousd).toBe(94_443);
    const oldKey = { reservationId: old.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(oldKey);
    const oldRow = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", oldKey.reservationId).executeTakeFirstOrThrow();
    clock = new Date(clock.getTime() + 20 * 60_000);
    await repo.releaseExecutionAdmission(identity, {
      expectedOwnerId: identity.ownerId, ...oldKey, expectedRequestId: "old_unknown",
      expectedStartedAt: oldRow.started_at!, expectedExpiresAt: oldRow.expires_at,
      maximumLiabilityMicrousd: 240_845, localRunId: "run_ended", localRunState: "failed",
      localRunEndedAt: new Date(Date.parse(oldRow.started_at!) + 10_000).toISOString(),
      evidenceRef: "support:terminal-run-proof", reviewer: "operator:test", acceptUnknownUpstreamLiability: true,
    });
    expect((await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true })).chatAvailability)
      .toMatchObject({ eligibleBalanceMicrousd: 100_000, availableBalanceMicrousd: 5_557 });
    await grant("general_later", 96_832);
    await speech();
    await repo.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 258_691, expiresAt: null });
    const speechBefore = await speechGrant();
    const before = await finances();
    // The total eligible ceiling fits, but the old unknown obligation still
    // protects its sources. Strict admission must refuse without a mutation.
    await expect(authorize("strict_after_unknown", 158_691, false))
      .rejects.toMatchObject({ code: "insufficient_credit" });
    expect(await finances()).toEqual(before);
    const next = await authorize("glm_mcp", 240_845);
    expect(next.reservation).toMatchObject({ reservedMicrousd: 102_389, maxCostMicrousd: 240_845,
      remainingBudgetMicrousd: 56_302 });
    expect(await authorize("glm_mcp", 240_845)).toEqual(next);
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", next.reservation.reservationId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ promotional_reserved_microusd: 102_389, addon_reserved_microusd: 0 });
    expect(await db.executor.selectFrom("ai_funded_reservation_promotional_allocations")
      .select(["grant_entry_id", "amount_microusd"]).where("reservation_id", "=", next.reservation.reservationId)
      .orderBy("grant_entry_id").execute()).toEqual([
      { grant_entry_id: "general_initial", amount_microusd: 5_557 },
      { grant_entry_id: "general_later", amount_microusd: 96_832 },
    ]);
    expect(await speechGrant()).toEqual(speechBefore);
    expect((await finances()).ledger).toEqual(before.ledger);
    const key = { reservationId: next.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 50_000 });
    expect(await speechGrant()).toEqual(speechBefore);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", oldKey.reservationId).executeTakeFirstOrThrow())
      .toEqual({ ...oldRow, execution_admission_release: expect.any(String) });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 94_443,
      reservedThisMonthMicrousd: 94_443, settledThisMonthMicrousd: 55_557 });
  });

  it.each([true, false])("rejects speech-only Chat with typed insufficient credit (usage=%s)", async (usage) => {
    await speech();
    const before = await finances();
    await expect(authorize("speech_is_not_chat", 1, usage)).rejects.toMatchObject({ code: "insufficient_credit" });
    expect(await finances()).toEqual(before);
    expect(await db.executor.selectFrom("ai_funded_priority_claims").selectAll().execute()).toEqual([]);
  });

  it("rejects a strict hold larger than general sources without changing balances or grants", async () => {
    await grant("general", 100);
    await speech();
    const before = await finances();
    await expect(authorize("strict_shortfall", 300, false)).rejects.toMatchObject({ code: "insufficient_credit" });
    expect(await finances()).toEqual(before);
  });

  it.each([true, false])("uses both general promotional and add-on credit (usage=%s)", async (usage) => {
    await grant("general", 100);
    await grant("addon", 50, "addon_grant");
    await speech();
    const speechBefore = await speechGrant();
    const next = await authorize("eligible_mixed", usage ? 300 : 150, usage);
    expect(next.reservation.reservedMicrousd).toBe(150);
    const key = { reservationId: next.reservation.reservationId, tokenId: credential.tokenId };
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow())
      .toMatchObject({ promotional_reserved_microusd: 100, addon_reserved_microusd: 50 });
    await repo.startReservation(key);
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: usage ? 200 : 150 });
    expect(await speechGrant()).toEqual(speechBefore);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ fundingShortfallMicrousd: 0 });
  });

  it("returns typed insufficient credit from allocation itself for an eligible-source shortage", async () => {
    await speech();
    const before = await finances();
    await expect(db.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`
        .execute(trx.executor);
      const balance = await trx.executor.selectFrom("ai_funded_runtime_balances").selectAll()
        .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      return reserveFundingSources(trx.executor, identity, 1, balance, clock.toISOString());
    })).rejects.toMatchObject({ code: "insufficient_credit" });
    expect(await finances()).toEqual(before);
  });

  it("excludes expired general grants from usage even when speech balance remains", async () => {
    await grant("expired_general", 100, "promotional_grant", "2026-10-03T05:01:00.000Z");
    await speech();
    clock = new Date(clock.getTime() + 120_000);
    await expect(authorize("expired_sources", 300)).rejects.toMatchObject({ code: "insufficient_credit" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual([]);
    expect((await repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true })).chatAvailability)
      .toMatchObject({ eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 });
    expect((await speechGrant()).remaining_microusd).toBe(999_892);
  });
});
