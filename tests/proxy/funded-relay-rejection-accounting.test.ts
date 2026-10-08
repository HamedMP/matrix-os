import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";
import { classifyFundedUpstreamRejection } from "../../packages/proxy/src/funded-relay-rejection.js";

const modelId = "anthropic/claude-sonnet-5";
const identity = { ownerId: "rejection_owner", machineId: "rejection_machine", runtimeSlot: "preview" };
const NOW = new Date("2026-09-10T12:00:00Z");

describe("trusted Relay rejection usage accounting", () => {
  let db: PlatformDB;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    let counter = 0;
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => NOW,
      tokenIdFactory: () => `rejection_token_${++counter}`, tokenSecretFactory: () => "s".repeat(43) });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: identity.machineId, runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "v1",
      provisionedAt: NOW.toISOString(), activationState: "authorized" });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: "rejection_grant", identity, kind: "promotional_grant",
      amountMicrousd: 1_000_000, sourceReference: "test-credit" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const request = (token: string, requestId: string) => ({ credential: token, requestId,
    modelId, maxCostMicrousd: 5_380_000, billingMode: "usage" as const });

  it("clears an admitted but rejected hold with zero debit and permits the next owner run", async () => {
    const admitted = await repo.authorize(request(credential.token, "rejected_run"));
    const key = { reservationId: admitted.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await expect(repo.authorize(request(credential.token, "while_in_flight"))).rejects.toMatchObject({ code: "rate_limited" });
    const decision = await classifyFundedUpstreamRejection({ upstream: new Response(JSON.stringify({
      type: "error", error: { type: "rate_limit_error", message: "Rate limited" }, request_id: "req_test",
    }), { status: 429, headers: { "content-type": "application/json" } }),
    canonicalModelId: modelId, requestPath: "/v1/messages", signal: new AbortController().signal });
    expect(decision).toEqual({ mode: "exact", actualCostMicrousd: 0 });
    const settled = await repo.finalizeReservation({ ...key, ...decision });
    expect(settled).toMatchObject({ status: "settled", actualCostMicrousd: 0,
      releasedMicrousd: 1_000_000, finalizationMode: "exact" });
    expect(await repo.finalizeReservation({ ...key, ...decision })).toEqual(settled);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0,
      settledThisMonthMicrousd: 0, remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 1_000_000 });
    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("reservation_id", "=", key.reservationId).execute();
    expect(ledger.reduce((sum, entry) => sum + Number(entry.amount_microusd), 0)).toBe(0);
    await expect(repo.authorize(request(credential.token, "next_owner_run"))).resolves.toMatchObject({ authorized: true });
  });

  it("retains the owner admission barrier when a 429 has no trustworthy response body", async () => {
    const admitted = await repo.authorize(request(credential.token, "unknown_run"));
    const key = { reservationId: admitted.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    const decision = await classifyFundedUpstreamRejection({ upstream: new Response("Rate limited", { status: 429 }),
      canonicalModelId: modelId, requestPath: "/v1/messages", signal: new AbortController().signal });
    expect(decision).toEqual({ mode: "conservative" });
    await expect(repo.finalizeReservation({ ...key, ...decision })).rejects.toMatchObject({ code: "unavailable" });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 1_000_000,
      settledThisMonthMicrousd: 0, remainingBalanceMicrousd: 0 });
    await expect(repo.authorize(request(credential.token, "blocked_owner_run"))).rejects.toMatchObject({ code: "rate_limited" });
  });
});
