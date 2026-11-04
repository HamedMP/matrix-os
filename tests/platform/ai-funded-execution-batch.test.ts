import { createHash, createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedOperatorRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { insertUserMachine, type PlatformDB, type PlatformDatabase } from "../../packages/platform/src/db.js";
import { sql, type Transaction } from "kysely";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const identity = { ownerId: "batch_owner", machineId: "batch_machine", runtimeSlot: "primary" };
const modelId = "@cf/zai-org/glm-5.3-flash";
const secret = "batch-operator-test-secret-32-characters";
describe("atomic mixed GLM and speech execution recovery", () => {
  let db: PlatformDB; let clock: Date; let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let speech: ReturnType<typeof createAiFundedSpeechFundingPort>; let credential: { token: string; tokenId: string }; let app: Hono;
  const rows = () => db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("reservation_id").execute();
  const finance = async () => ({ balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    grants: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
    allowances: await db.executor.selectFrom("speech_runtime_allowances").selectAll().execute() });
  const request = async () => ({ expectedOwnerId: identity.ownerId, reviewer: "operator:fixture", evidenceRef: "support:reviewed-batch",
    acceptUnknownUpstreamLiability: true, reservations: (await rows()).filter((row) => row.status === "in_flight").map((row) => ({ ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot,
      fundingKind: row.token_id.startsWith("speech_") ? "speech" : "usage", reservationId: row.reservation_id,
      tokenId: row.token_id, expectedRequestId: row.request_id, expectedStartedAt: row.started_at!, expectedExpiresAt: row.expires_at,
      maximumLiabilityMicrousd: row.token_id.startsWith("speech_") ? 6_000 : 240_845,
      authorizationSha256: createHash("sha256").update(row.authorization_response).digest("hex"),
      localRunId: `local-${row.request_id}`, localRunState: "failed", localRunEndedAt: row.expires_at })) });
  const send = (body: unknown, token = secret) => app.request("/execution-recovery/batch", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  // Persist the actual pre-policy producer shape. Today's zero-hold reserve is not historical evidence.
  const legacySpeech = (owner: typeof identity, reservationId: string, requestId: string) => db.transaction(async trx => {
    const tokenId = `speech_${createHmac("sha256", "s".repeat(32))
      .update(`${owner.ownerId}\0${owner.machineId}\0${owner.runtimeSlot}`).digest("hex").slice(0, 48)}`;
    const checkedAt = clock.toISOString();
    await trx.executor.insertInto("ai_runtime_credentials").values({ token_id: tokenId,
      token_hash: createHmac("sha256", "s".repeat(32)).update(`${tokenId}\0${owner.ownerId}\0${owner.machineId}\0${owner.runtimeSlot}`).digest("hex"),
      owner_id: owner.ownerId, machine_id: owner.machineId, runtime_slot: owner.runtimeSlot,
      audience: "matrix-platform-speech", scope: "speech:transcribe", issued_at: checkedAt,
      expires_at: new Date(clock.getTime() + 86_400_000).toISOString(), revoked_at: null,
    }).onConflict(c => c.column("token_id").doNothing()).execute();
    await trx.executor.insertInto("ai_funded_usage_reservations").values({ reservation_id: reservationId, request_id: requestId,
      payload_hash: createHash("sha256").update(JSON.stringify({ identity: owner, requestId, policyRevision: "speech-v1",
        modelId: "speech-model", maximumCostMicrousd: 6_000 })).digest("hex"),
      authorization_response: JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-v1" }),
      token_id: tokenId, owner_id: owner.ownerId, machine_id: owner.machineId, runtime_slot: owner.runtimeSlot,
      model_id: "speech-model", reserved_microusd: 6_000, promotional_reserved_microusd: 0, addon_reserved_microusd: 6_000,
      period_start: "2026-09-01T00:00:00.000Z", status: "in_flight", created_at: checkedAt, started_at: checkedAt,
      expires_at: new Date(clock.getTime() + 60_000).toISOString(),
      start_response: JSON.stringify({ capability: "speech:transcribe", startedAt: checkedAt }),
      actual_microusd: null, settlement_response: null, finalization_mode: null, settled_at: null, released_at: null,
      release_response: null, release_reason: null, resolved_model: null, pricing_version: null,
      manual_review_evidence_ref: null, manual_review_actor: null, manual_reviewed_at: null,
    }).execute();
    await trx.executor.updateTable("ai_funded_runtime_balances").set({
      reserved_microusd: sql<number>`reserved_microusd + 6000`, month_reserved_microusd: sql<number>`month_reserved_microusd + 6000`,
    }).where("machine_id", "=", owner.machineId).execute();
  });
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); clock = new Date("2026-09-10T12:00:00.000Z");
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => new Date(clock), credentialTtlMs: 3_600_000, inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "batch", runtimeSlot: identity.runtimeSlot,
      status: "running", imageVersion: "test", provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: "batch-credit", identity, kind: "addon_grant", amountMicrousd: 1_000_000, sourceReference: "fixture" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
    const glm = await repo.authorize({ credential: credential.token, requestId: "glm-old", modelId, maxCostMicrousd: 240_845, billingMode: "usage" });
    await repo.startReservation({ reservationId: glm.reservation.reservationId, tokenId: credential.tokenId });
    let speechSequence = 0;
    speech = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => `speech-reservation-${++speechSequence}`, now: () => new Date(clock), inFlightTtlMs: 60_000 });
    await legacySpeech(identity, "speech-reservation", "speech-old");
    clock = new Date(clock.getTime() + 20 * 60_000);
    app = createAiFundedOperatorRoutes({ db, operatorSecret: secret, repository: repo, promotionalGrant: { enabled: false }, now: () => new Date(clock) });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  it("atomically recovers exactly reviewed mixed obligations, retains money and replays immutable typed audits", async () => {
    const body = await request(); const before = await finance(); const oldRows = await rows();
    expect((await send(body, "forged")).status).toBe(401);
    const result = await send(body); expect(result.status).toBe(200); const response = await result.json();
    expect(response).toMatchObject({ usageKnown: false, maximumLiabilityMicrousd: 246_845, executionAdmissionReleased: true });
    expect(await finance()).toEqual(before); expect((await rows()).map((r) => r.execution_recovery_slot).sort()).toEqual([0, 1]);
    for (const r of await rows()) expect(JSON.parse(r.execution_admission_release!)).toMatchObject({ kind: "operator_batch_v2" });
    expect(await (await send(body)).json()).toEqual(response);
    expect((await send({ ...body, evidenceRef: "support:different" })).status).toBe(409);
    await repo.authorize({ credential: credential.token, requestId: "new-work", modelId, maxCostMicrousd: 100, billingMode: "usage" });
    // A late old speech settlement frees only its financial hold, not newer admission.
    await db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, "speech-reservation", { mode: "exact", actualCostMicrousd: 1_000 }));
    await expect(repo.authorize({ credential: credential.token, requestId: "newer-work", modelId, maxCostMicrousd: 100, billingMode: "usage" }))
      .rejects.toMatchObject({ code: "rate_limited" });
    expect(oldRows.every((r) => r.actual_microusd === null)).toBe(true);
  });
  it("audits release of recovered speech's hold on unknown failure and absorbs late expense", async () => {
    expect((await send(await request())).status).toBe(200);
    const before = await finance(); const beforeRows = await rows();
    await db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, "speech-reservation", { mode: "conservative" }));
    const released = (await rows()).find(r => r.reservation_id === "speech-reservation")!;
    expect(released).toMatchObject({ status: "expired", actual_microusd: null, settlement_response: null,
      authorization_response: beforeRows.find(r => r.reservation_id === "speech-reservation")!.authorization_response,
      execution_admission_release: beforeRows.find(r => r.reservation_id === "speech-reservation")!.execution_admission_release });
    expect(JSON.parse(released.customer_charge_release!)).toMatchObject({ fundingKind: "speech", reservedMicrousd: 6_000,
      addonReservedMicrousd: 6_000, releasedMicrousd: 6_000, maximumLiabilityMicrousd: 6_000,
      reason: "usage_unknown", allowanceDisposition: "no-lease" });
    const after = await finance();
    expect(after.ledger).toEqual(before.ledger); expect(after.grants).toEqual(before.grants);
    expect(after.allocations).toEqual(before.allocations); expect(after.allowances).toEqual(before.allowances);
    expect(Number(after.balances[0].credit_balance_microusd)).toBe(Number(before.balances[0].credit_balance_microusd));
    expect(Number(after.balances[0].reserved_microusd)).toBe(Number(before.balances[0].reserved_microusd) - 6_000);
    expect(Number(after.balances[0].month_reserved_microusd)).toBe(Number(before.balances[0].month_reserved_microusd) - 6_000);
    await db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, "speech-reservation", { mode: "conservative" }));
    expect(await finance()).toEqual(after);
    await db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, "speech-reservation", { mode: "exact", actualCostMicrousd: 1_000 }));
    const settled = (await rows()).find(r => r.reservation_id === "speech-reservation")!;
    expect(settled).toMatchObject({ status: "settled", actual_microusd: 1_000, customer_charge_release: released.customer_charge_release });
    expect(JSON.parse(settled.settlement_response!)).toMatchObject({ actualCostMicrousd: 1_000,
      chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 1_000 });
    expect(await finance()).toEqual(after);
  });
  it.each(["liability", "identity", "hash", "kind", "early", "future", "outside-live"])("rolls back every row and financial byte for invalid %s", async (kind) => {
    const body = await request();
    if (kind === "liability") body.reservations[1].maximumLiabilityMicrousd++;
    if (kind === "identity") body.reservations[1].ownerId = "other";
    if (kind === "hash") body.reservations[1].authorizationSha256 = "0".repeat(64);
    if (kind === "kind") body.reservations[1].fundingKind = "usage";
    if (kind === "early") clock = new Date("2026-09-10T12:02:00.000Z");
    if (kind === "future") body.reservations[1].localRunEndedAt = "2026-09-11T00:00:00.000Z";
    if (kind === "outside-live") await db.transaction((trx) => speech.reserve(trx.executor as Transaction<PlatformDatabase>, { identity,
      requestId: "speech-new", policyRevision: "speech-v1", modelId: "speech-model", maximumCostMicrousd: 100 }));
    const before = await finance(); const beforeRows = await rows(); expect((await send(body)).status).toBeGreaterThanOrEqual(400);
    expect(await rows()).toEqual(beforeRows); expect(await finance()).toEqual(before);
  });
  it("allows two reviewed records on distinct machines owned by the same owner", async () => {
    await db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, "speech-reservation", { mode: "exact", actualCostMicrousd: 0 }));
    const peer = { ...identity, machineId: "batch_peer_machine", runtimeSlot: "preview-peer" };
    await insertUserMachine(db, { machineId: peer.machineId, clerkUserId: peer.ownerId, handle: "batch-peer", runtimeSlot: peer.runtimeSlot,
      status: "running", imageVersion: "test", provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.setRuntimePolicy({ identity: peer, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 10_000, expiresAt: null });
    await repo.grantCredit({ entryId: "batch-peer-credit", identity: peer, kind: "addon_grant", amountMicrousd: 10_000, sourceReference: "fixture" });
    await legacySpeech(peer, "speech-reservation-peer", "speech-peer-old");
    clock = new Date(clock.getTime() + 20 * 60_000); const before = await finance(); const body = await request();
    expect(new Set(body.reservations.map((r) => r.machineId)).size).toBe(2);
    expect((await send(body)).status).toBe(200); expect(await finance()).toEqual(before);
  });

  it("rolls back an earlier execution write if the second row cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await request(); const beforeRows = await rows(); const before = await finance();
    await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT fixture_fail_second_write CHECK
      (reservation_id <> 'speech-reservation' OR execution_admission_release IS NULL)`.execute(db.executor);
    expect((await send(body)).status).toBeGreaterThanOrEqual(400);
    expect(await rows()).toEqual(beforeRows); expect(await finance()).toEqual(before); vi.restoreAllMocks();
  });

  it("prevents a third audited obligation and rejects a malformed typed speech audit on admission and settlement", async () => {
    expect((await send(await request())).status).toBe(200);
    const next = await repo.authorize({ credential: credential.token, requestId: "third-old", modelId, billingMode: "usage", maxCostMicrousd: 100 });
    await repo.startReservation({ reservationId: next.reservation.reservationId, tokenId: credential.tokenId });
    clock = new Date(clock.getTime() + 20 * 60_000);
    const body = await request(); body.reservations = body.reservations.filter((r) => r.expectedRequestId === "third-old");
    body.reservations[0].maximumLiabilityMicrousd = 100;
    const before = await finance(); expect((await send(body)).status).toBe(429); expect(await finance()).toEqual(before);
    const speechRow = (await rows()).find((r) => r.reservation_id === "speech-reservation")!;
    const audit = JSON.parse(speechRow.execution_admission_release!); audit.request.reservations.find((r: { fundingKind: string }) => r.fundingKind === "speech").maximumLiabilityMicrousd = 5_999;
    await db.executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: JSON.stringify(audit) }).where("reservation_id", "=", speechRow.reservation_id).execute();
    await expect(repo.authorize({ credential: credential.token, requestId: "malformed-history", modelId, billingMode: "usage", maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, "speech-reservation", { mode: "exact", actualCostMicrousd: 1_000 })))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("cleanup audits release of both recovered customer holds and retains unknown liabilities", async () => {
    expect((await send(await request())).status).toBe(200);
    const beforeRows = await rows(); const before = await finance();
    expect(await repo.cleanupExpiredReservations({ limit: 100 })).toBe(2);
    const afterRows = await rows(); const after = await finance();
    for (const row of afterRows) {
      const original = beforeRows.find(old => old.reservation_id === row.reservation_id)!;
      expect(row).toMatchObject({ status: "expired", actual_microusd: null, settlement_response: null,
        authorization_response: original.authorization_response, execution_admission_release: original.execution_admission_release });
      expect(JSON.parse(row.customer_charge_release!)).toMatchObject({ reservedMicrousd: Number(original.reserved_microusd),
        releasedMicrousd: Number(original.reserved_microusd), maximumLiabilityMicrousd: Number(original.reserved_microusd),
        reason: "legacy_expired_hold" });
    }
    expect(after.ledger).toEqual(before.ledger); expect(after.grants).toEqual(before.grants);
    expect(after.allocations).toEqual(before.allocations); expect(after.allowances).toEqual(before.allowances);
    expect(Number(after.balances[0].credit_balance_microusd)).toBe(Number(before.balances[0].credit_balance_microusd));
    expect(Number(after.balances[0].reserved_microusd)).toBe(0);
    expect(Number(after.balances[0].month_reserved_microusd)).toBe(0);
    expect(await repo.cleanupExpiredReservations({ limit: 100 })).toBe(0);
    expect(await rows()).toEqual(afterRows); expect(await finance()).toEqual(after);
  });

  it.each(["usage", "speech", "speech-corrupt-audit"] as const)("handles a previously recovered speech operation after late %s settlement", async (settledKind) => {
    const oldSpeech = (await rows()).find((r) => r.reservation_id === "speech-reservation")!;
    await db.executor.insertInto("speech_operations").values({ owner_id: identity.ownerId, machine_id: identity.machineId, runtime_slot: identity.runtimeSlot,
      operation_id: oldSpeech.request_id, source_kind: "dictation", content_fingerprint: "a".repeat(64), policy_revision: "speech-v1", adapter_id: "fixture",
      model_id: "speech-model", funding_reservation_id: oldSpeech.reservation_id, execution_state: "dispatching", cancellation_requested: false, tombstone: false,
      dispatch_claimed_at: oldSpeech.started_at, safe_outcome_code: null, audio_duration_ms: 1_000, reserved_microusd: 6_000, actual_microusd: null,
      created_at: oldSpeech.created_at, updated_at: oldSpeech.started_at!, expires_at: "2026-09-11T00:00:00.000Z" }).execute();
    expect((await send(await request())).status).toBe(200);
    const oldGlm = (await rows()).find((r) => r.request_id === "glm-old")!;
    if (settledKind === "usage") await repo.finalizeReservation({ reservationId: oldGlm.reservation_id, tokenId: oldGlm.token_id, mode: "exact", actualCostMicrousd: 10 });
    else await db.transaction((trx) => speech.settle(trx.executor as Transaction<PlatformDatabase>, oldSpeech.reservation_id, { mode: "exact", actualCostMicrousd: 1_000 }));
    const next = await repo.authorize({ credential: credential.token, requestId: "next-expired-glm", modelId, maxCostMicrousd: 100, billingMode: "usage" });
    await repo.startReservation({ reservationId: next.reservation.reservationId, tokenId: credential.tokenId }); clock = new Date(clock.getTime() + 20 * 60_000);
    const body = await request(); body.reservations = body.reservations.filter((r) => r.expectedRequestId === "next-expired-glm"); body.reservations[0].maximumLiabilityMicrousd = 100;
    if (settledKind === "speech-corrupt-audit") await db.executor.updateTable("ai_funded_usage_reservations")
      .set({ execution_admission_release: "{}" }).where("reservation_id", "=", oldSpeech.reservation_id).execute();
    const before = await finance(); expect((await send(body)).status).toBe(settledKind === "speech-corrupt-audit" ? 409 : 200); expect(await finance()).toEqual(before);
  });

});
