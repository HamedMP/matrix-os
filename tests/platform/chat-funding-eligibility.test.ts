import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { ensureSpeechMonthlyAllowance } from "../../packages/platform/src/speech/allowance.js";
import { reserveFundingSources } from "../../packages/platform/src/ai-funded-reservation-sources.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const identity = { ownerId: "user_alice", machineId: "machine_chat", runtimeSlot: "primary" };
const modelId = "anthropic/claude-sonnet-5";
const now = new Date("2026-10-03T00:00:00.000Z");

describe("Chat funding eligibility", () => {
  let db: PlatformDB;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: string;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      ...identity, clerkUserId: identity.ownerId, handle: "chat-owner", status: "running",
      imageVersion: "v1", provisionedAt: now.toISOString(), activationState: "authorized",
    });
    repo = createAiFundedPolicyRepository({
      db, credentialHashSecret: "h".repeat(32), now: () => now,
      tokenIdFactory: () => "chat_token", tokenSecretFactory: () => "s".repeat(43),
    });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({
      identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1000, expiresAt: null,
    });
    await db.transaction((trx) => ensureSpeechMonthlyAllowance(trx.executor, identity, {
      monthlyBudgetMicrousd: 1_000_000, monthlyPromotionalCreditMicrousd: 1_000_000, now,
    }));
    credential = (await repo.issueRuntimeCredential(identity)).credential.token;
  });

  afterEach(async () => destroyTestPlatformDb(db));

  it("shows no Chat credit in runtime and checkout summaries when only speech has credit", async () => {
    const expected = { creditBalanceMicrousd: 0, promotionalBalanceMicrousd: 0, remainingBalanceMicrousd: 0 };
    expect(await repo.getFundingSummary(identity)).toMatchObject(expected);
    expect((await repo.getCheckoutFundingSummary(identity, Date.now() + 5000)).funding).toMatchObject(expected);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").select("credit_balance_microusd")
      .executeTakeFirstOrThrow()).toEqual({ credit_balance_microusd: 1_000_000 });
  });

  it("rejects speech-only funding with insufficient_credit and leaves no reservation", async () => {
    await expect(repo.authorize({ credential, requestId: "speech_cannot_pay_chat", modelId, maxCostMicrousd: 10 }))
      .rejects.toMatchObject({ code: "insufficient_credit" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").select("reserved_microusd")
      .executeTakeFirstOrThrow()).toEqual({ reserved_microusd: 0 });
  });

  it("caps a usage hold at eligible Chat funding without borrowing speech credit", async () => {
    await repo.grantCredit({ entryId: "chat_grant", identity, kind: "promotional_grant",
      amountMicrousd: 20, sourceReference: "chat_campaign" });
    const result = await repo.authorize({ credential, requestId: "mixed_usage", modelId,
      maxCostMicrousd: 100, billingMode: "usage" });
    expect(result.reservation.reservedMicrousd).toBe(20);
    expect(result.funding).toMatchObject({ creditBalanceMicrousd: 20, reservedMicrousd: 20, remainingBalanceMicrousd: 0 });
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      promotionalBalanceMicrousd: 20, reservedMicrousd: 20, remainingBalanceMicrousd: 0,
    });
  });

  it("keeps missing general grant attribution an invariant error", async () => {
    await db.executor.deleteFrom("ai_funded_promotional_grant_balances").execute();
    await expect(repo.authorize({ credential, requestId: "broken_attribution", modelId, maxCostMicrousd: 10 }))
      .rejects.toThrow("allocation invariant violated");
  });

  it("maps a source allocation shortfall explained by speech-only credit to insufficient_credit", async () => {
    const balance = await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().executeTakeFirstOrThrow();
    await expect(db.transaction((trx) => reserveFundingSources(trx.executor, identity, 10, balance, now.toISOString())))
      .rejects.toMatchObject({ code: "insufficient_credit" });
  });

  it("does not mask missing general attribution when speech credit also remains", async () => {
    await repo.grantCredit({ entryId: "missing_chat_grant", identity, kind: "promotional_grant",
      amountMicrousd: 20, sourceReference: "chat_campaign" });
    await db.executor.deleteFrom("ai_funded_promotional_grant_balances")
      .where("grant_entry_id", "=", "missing_chat_grant").execute();
    await expect(repo.authorize({ credential, requestId: "mixed_broken_attribution", modelId, maxCostMicrousd: 10 }))
      .rejects.toThrow("allocation invariant violated");
  });

  it("checkout excludes expired unprotected promotion without changing persisted grants", async () => {
    await repo.grantCredit({ entryId: "expired_chat_grant", identity, kind: "promotional_grant",
      amountMicrousd: 20, sourceReference: "chat_campaign" });
    await db.executor.updateTable("ai_funded_promotional_grant_balances")
      .set({ expires_at: "2026-10-02T00:00:00.000Z" }).where("grant_entry_id", "=", "expired_chat_grant").execute();
    expect((await repo.getCheckoutFundingSummary(identity, Date.now() + 5000)).funding)
      .toMatchObject({ creditBalanceMicrousd: 0, remainingBalanceMicrousd: 0 });
    expect(await db.executor.selectFrom("ai_funded_promotional_grant_balances").select("remaining_microusd")
      .where("grant_entry_id", "=", "expired_chat_grant").executeTakeFirstOrThrow()).toEqual({ remaining_microusd: 20 });
  });

  it("does not infer that unattributed active holds belong to speech", async () => {
    await repo.grantCredit({ entryId: "held_chat_grant", identity, kind: "promotional_grant",
      amountMicrousd: 20, sourceReference: "chat_campaign" });
    await repo.authorize({ credential, requestId: "unknown_hold", modelId, maxCostMicrousd: 10 });
    await db.executor.deleteFrom("ai_funded_reservation_promotional_allocations").execute();
    await db.executor.updateTable("ai_funded_usage_reservations")
      .set({ promotional_reserved_microusd: null, addon_reserved_microusd: null }).execute();
    expect(await repo.getFundingSummary(identity)).toMatchObject({
      creditBalanceMicrousd: 20, reservedMicrousd: 10, remainingBalanceMicrousd: 10,
    });
  });

  it("does not mask add-on protection exceeding its balance with speech credit", async () => {
    await repo.grantCredit({ entryId: "held_addon_grant", identity, kind: "addon_grant",
      amountMicrousd: 20, sourceReference: "addon_invoice" });
    await repo.authorize({ credential, requestId: "addon_hold", modelId, maxCostMicrousd: 10 });
    const balance = await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().executeTakeFirstOrThrow();
    await expect(db.transaction((trx) => reserveFundingSources(trx.executor, identity, 1,
      { ...balance, addon_balance_microusd: 0 }, now.toISOString())))
      .rejects.toThrow("allocation invariant violated");
  });
});
