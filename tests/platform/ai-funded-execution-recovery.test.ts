import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedOperatorRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const modelId = "anthropic/claude-sonnet-5";
const identity = { ownerId: "recovery_owner", machineId: "recovery_machine", runtimeSlot: "primary" };
const secret = "operator-recovery-test-only-secret-32";
const origin = "/api/operator/ai/funded/runtimes/recovery/policy-execution-release";

describe("audited owner execution recovery without financial settlement", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let app: Hono;
  let credential: { token: string; tokenId: string };
  let reservationId: string;
  let startedAt: string;
  let expiresAt: string;

  const authorization = (requestId: string, usage = true, maxCostMicrousd = 100) => repo.authorize({
    credential: credential.token, requestId, modelId, maxCostMicrousd,
    ...(usage ? { billingMode: "usage" as const } : {}),
  });
  const payload = () => ({
    expectedOwnerId: identity.ownerId, reservationId, tokenId: credential.tokenId,
    expectedRequestId: "old_request", expectedStartedAt: startedAt, expectedExpiresAt: expiresAt,
    maximumLiabilityMicrousd: 100, localRunId: "run_local_ended", localRunState: "failed",
    localRunEndedAt: new Date(Date.parse(startedAt) + 10_000).toISOString(),
    evidenceRef: "support:request-and-terminal-run-proof", reviewer: "operator:qa",
    acceptUnknownUpstreamLiability: true,
  });
  const send = (body: unknown = payload(), authorizationHeader = `Bearer ${secret}`, path = origin) => app.request(path, {
    method: "POST", headers: { authorization: authorizationHeader, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const rows = () => db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
    .where("reservation_id", "=", reservationId).executeTakeFirstOrThrow();
  const finance = async () => ({
    balance: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
    grants: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().execute(),
  });

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-10-03T05:00:00.000Z");
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock), credentialTtlMs: 3_600_000, inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: "recovery", runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test",
      provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    await repo.grantCredit({ entryId: "promotion:recovery", identity, kind: "promotional_grant",
      amountMicrousd: 1_000, sourceReference: "recovery-test", expiresAt: "2026-10-04T00:00:00.000Z" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
    reservationId = (await authorization("old_request")).reservation.reservationId;
    await repo.startReservation({ reservationId, tokenId: credential.tokenId });
    const row = await rows();
    startedAt = row.started_at!;
    expiresAt = row.expires_at;
    clock = new Date(clock.getTime() + 20 * 60_000);
    app = new Hono().route("/api/operator/ai/funded", createAiFundedOperatorRoutes({
      db, operatorSecret: secret, repository: repo, promotionalGrant: { enabled: false }, now: () => clock,
    }));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("records only execution recovery and preserves unknown money and exact replay", async () => {
    const before = await finance();
    const result = await send();
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).toMatchObject({ contractVersion: 1, executionAdmissionReleased: true, usageKnown: false,
      reservedMicrousd: 100, maximumLiabilityMicrousd: 100 });
    expect(await finance()).toEqual(before);
    expect(await rows()).toMatchObject({ status: "in_flight", actual_microusd: null, settlement_response: null });
    await expect(authorization("old_request")).rejects.toMatchObject({ code: "reservation_closed" });
    await expect(repo.startReservation({ reservationId, tokenId: credential.tokenId }))
      .rejects.toMatchObject({ code: "reservation_closed" });
    expect(await (await send()).json()).toEqual(body);
    expect((await send({ ...payload(), evidenceRef: "different:evidence" })).status).toBe(409);
    await expect(repo.finalizeReservation({ reservationId, tokenId: credential.tokenId, mode: "conservative" }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("admits one new execution; late old settlement does not release the newer slot", async () => {
    expect((await send()).status).toBe(200);
    const next = await authorization("new_request");
    await repo.startReservation({ reservationId: next.reservation.reservationId, tokenId: credential.tokenId });
    await expect(repo.finalizeReservation({ reservationId, tokenId: credential.tokenId, mode: "exact", actualCostMicrousd: 40 }))
      .resolves.toMatchObject({ chargedCostMicrousd: 40, releasedMicrousd: 60 });
    await expect(authorization("third_request")).rejects.toMatchObject({ code: "rate_limited", reason: "slot_busy" });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 100, settledThisMonthMicrousd: 40 });
  });

  it("permits at most one still-unknown obligation per owner", async () => {
    expect((await send()).status).toBe(200);
    reservationId = (await authorization("new_request")).reservation.reservationId;
    await repo.startReservation({ reservationId, tokenId: credential.tokenId });
    const next = await rows();
    startedAt = next.started_at!; expiresAt = next.expires_at;
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect((await send({ ...payload(), expectedRequestId: "new_request" })).status).toBe(429);
    await expect(authorization("blocked_again")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it.each([
    ["owner", { expectedOwnerId: "wrong_owner" }, 404], ["token", { tokenId: "wrong_token" }, 401],
    ["request", { expectedRequestId: "wrong_request" }, 409], ["start", { expectedStartedAt: "2026-10-03T04:59:00.000Z" }, 409],
    ["expiry", { expectedExpiresAt: "2026-10-03T05:02:00.000Z" }, 409], ["liability", { maximumLiabilityMicrousd: 99 }, 409],
  ])("rejects stale or forged %s while keeping all money", async (_name, patch, status) => {
    const before = await finance();
    expect((await send({ ...payload(), ...patch })).status).toBe(status);
    expect(await finance()).toEqual(before);
    await expect(authorization("still_blocked")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("rejects too-young execution even after its short reservation expiry", async () => {
    clock = new Date(Date.parse(startedAt) + 61_000);
    expect((await send()).status).toBe(429);
    clock = new Date(Date.parse(startedAt) + 16 * 60_000 - 1);
    expect((await send()).status).toBe(429);
  });

  it("rejects nonterminal evidence, missing acceptance and unknown fields", async () => {
    for (const patch of [{ localRunState: "running" }, { acceptUnknownUpstreamLiability: false },
      { maximumLiabilityMicrousd: 500_001 }, { actualCostMicrousd: 0 }, { ownerId: identity.ownerId },
      { localRunEndedAt: new Date(clock.getTime() + 1).toISOString() }]) {
      expect((await send({ ...payload(), ...patch })).status).toBe(400);
    }
  });

  it("rejects ordinary/runtime/relay auth, oversized bodies and query overrides", async () => {
    for (const token of ["", `Bearer ${credential.token}`, "Bearer relay-control-test-secret-32"]) {
      expect((await send(payload(), token)).status).toBe(401);
    }
    expect((await send({ ...payload(), evidenceRef: "x".repeat(5000) })).status).toBe(413);
    expect((await send(payload(), `Bearer ${secret}`, `${origin}?ownerId=wrong`)).status).toBe(400);
  });

  it("never automatically unlocks expired unknown usage", async () => {
    await expect(repo.cleanupExpiredReservations({ limit: 10 })).resolves.toBe(0);
    await expect(authorization("no_operator_transition")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it.each(["reserved", "settled", "nonusage"])("rejects %s reservations", async (state) => {
    await repo.finalizeReservation({ reservationId, tokenId: credential.tokenId, mode: "exact", actualCostMicrousd: 10 });
    if (state !== "settled") {
      reservationId = (await authorization("different_request", state !== "nonusage")).reservation.reservationId;
      if (state === "nonusage") await repo.startReservation({ reservationId, tokenId: credential.tokenId });
      const row = await rows();
      startedAt = row.started_at ?? clock.toISOString(); expiresAt = row.expires_at;
      clock = new Date(clock.getTime() + 20 * 60_000);
    }
    const response = await send({ ...payload(), expectedRequestId: state === "settled" ? "old_request" : "different_request" });
    expect([409, 400]).toContain(response.status);
  });

  it("keeps allocated promotional credit protected after expiry", async () => {
    expect((await send()).status).toBe(200);
    const allocation = await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute();
    clock = new Date("2026-10-05T00:00:00.000Z");
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 100,
      reservedMicrousd: 100, settledThisMonthMicrousd: 0, remainingBalanceMicrousd: 0 });
    expect(await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute()).toEqual(allocation);
  });
});
