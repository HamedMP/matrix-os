import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createSpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";
import { finalizeAiCreditCheckoutClaim, getClaimByPaymentReference, prepareAiCreditCheckoutClaim } from "../../packages/platform/src/ai-credit-checkout-store.js";
import { processAiCreditWebhookEvent } from "../../packages/platform/src/ai-credit-checkout-webhook.js";

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const identity = { ownerId: "speech_pg_owner", machineId: "speech_pg_machine", runtimeSlot: "dev" };
describe.skipIf(!databaseUrl)("Speech postpaid actual PostgreSQL boundaries", () => {
  let admin: pg.Pool, schema: string, a: PlatformDB, b: PlatformDB, clock: Date;
  let funded: ReturnType<typeof createAiFundedPolicyRepository>, funding: ReturnType<typeof createAiFundedSpeechFundingPort>;
  let opsA: ReturnType<typeof createSpeechOperationsRepository>, opsB: typeof opsA;
  beforeEach(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("Disposable loopback test PostgreSQL required");
    schema = `speech_postpaid_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000`);
    url.searchParams.set("application_name", `${schema}_a`); a = createPlatformDb(url.toString()); await a.ready;
    url.searchParams.set("application_name", `${schema}_b`); b = createPlatformDb(url.toString()); await b.ready;
    clock = new Date("2026-11-30T23:59:40.000Z");
    await insertUserMachine(a, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "speech-postpaid-pg",
      runtimeSlot: identity.runtimeSlot, status: "running", activationState: "authorized", imageVersion: "test", provisionedAt: clock.toISOString() });
    funded = createAiFundedPolicyRepository({ db: a, now: () => new Date(clock), credentialHashSecret: "h".repeat(32) });
    await funded.setRuntimePolicy({ identity, enabled: false, allowedModelIds: [], expectedRevision: 0, monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    await funded.grantCredit({ entryId: "initial_addon", identity, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "test" });
    funding = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => `speech_${randomUUID().replaceAll("-", "")}`, now: () => new Date(clock), inFlightTtlMs: 60_000,
      monthlyAllowance: { monthlyBudgetMicrousd: 1_000, monthlyPromotionalCreditMicrousd: 0 } });
    opsA = createSpeechOperationsRepository({ db: a, now: () => new Date(clock) });
    opsB = createSpeechOperationsRepository({ db: b, now: () => new Date(clock) });
  });
  afterEach(async () => { await b?.destroy(); await a?.destroy(); if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });
  async function admit(start = false) {
    const requestId = `sp_${clock.getTime()}_${randomUUID().replaceAll("-", "")}`;
    const input = { identity, requestId, sourceKind: "dictation" as const, contentFingerprint: "a".repeat(64),
      policyRevision: "speech-price-1", adapterId: "synthetic", modelId: "gpt-4o-transcribe", audioDurationMs: 1_000, maximumCostMicrousd: 120 };
    const operation = await opsA.admit(input, trx => funding.reserve(trx, { identity, requestId, policyRevision: input.policyRevision, modelId: input.modelId, maximumCostMicrousd: input.maximumCostMicrousd }));
    if (start) await opsA.claimDispatch(identity, requestId, (trx, id) => funding.start(trx, id));
    return { requestId, reservationId: operation.fundingReservationId! };
  }
  const snapshot = async () => ({
    requests: await a.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("reservation_id").execute(),
    operations: await a.executor.selectFrom("speech_operations").selectAll().orderBy("operation_id").execute(),
    balances: await a.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    quota: await a.executor.selectFrom("speech_runtime_allowances").selectAll().execute(),
    ledger: await a.executor.selectFrom("ai_funded_credit_ledger").selectAll().orderBy("entry_id").execute(),
  });
  async function waitForLock(replica: "a" | "b") {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [`${schema}_${replica}`])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected actual PostgreSQL lock wait");
  }

  it.each(["start", "settle", "release"] as const)("rejects an old %s writer for a new zero capture and rolls back the full operation transaction", async stage => {
    const key = await admit(stage === "settle"); const before = await snapshot();
    clock = new Date(clock.getTime() + 1_000);
    const legacy = async (trx: PlatformDB["executor"], id: string) => {
      await trx.updateTable("ai_funded_runtime_balances").set({ updated_at: clock.toISOString() }).where("machine_id", "=", identity.machineId).execute();
      await trx.updateTable("speech_runtime_allowances").set({ updated_at: clock.toISOString() }).where("machine_id", "=", identity.machineId).execute();
      const mutation = stage === "start" ? { status: "in_flight", started_at: clock.toISOString(),
        start_response: JSON.stringify({ capability: "speech:transcribe", startedAt: clock.toISOString() }) }
        : stage === "release" ? { status: "released", released_at: clock.toISOString(), release_reason: "cancelled",
          release_response: JSON.stringify({ capability: "speech:transcribe", releasedMicrousd: 0 }) }
        : { status: "settled", actual_microusd: 0, finalization_mode: "conservative", settled_at: clock.toISOString(),
          settlement_response: JSON.stringify({ capability: "speech:transcribe", actualCostMicrousd: 0 }) };
      await trx.updateTable("ai_funded_usage_reservations").set(mutation).where("reservation_id", "=", id).execute();
    };
    const action = stage === "start" ? opsB.claimDispatch(identity, key.requestId, legacy)
      : stage === "release" ? opsB.cancel(identity, key.requestId, legacy)
      : opsB.complete(identity, key.requestId, { executionState: "uncertain", outcomeCode: "provider_failure", actualCostMicrousd: null }, legacy);
    await expect(action).rejects.toMatchObject({ code: "23514", constraint: stage === "settle"
      ? "ai_funded_conservative_settlement_check" : "ai_funded_speech_postpaid_state_check" });
    expect(await snapshot()).toEqual(before);
  });

  it("serializes duplicate successful operation completion into one actual debit", async () => {
    const key = await admit(true);
    const completion = { executionState: "succeeded" as const, outcomeCode: "transcript" as const, actualCostMicrousd: 40 };
    const finish = (ops: typeof opsA) => ops.complete(identity, key.requestId, completion,
      (trx, id) => funding.settle(trx, id, { mode: "exact", actualCostMicrousd: 40 }));
    const results = await Promise.all([finish(opsA), finish(opsB)]); expect(results[0]).toEqual(results[1]);
    const state = await snapshot();
    expect(state.balances[0]).toMatchObject({ credit_balance_microusd: "960", reserved_microusd: "0" });
    expect(state.quota[0]).toMatchObject({ period_reserved_microusd: "0", period_spent_microusd: "40" });
    expect(state.ledger.filter(row => row.reservation_id === key.reservationId)).toHaveLength(1);
  });

  it("keeps the operation row unlocked while a policy update owns the machine", async () => {
    const key = await admit(); const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const policy = a.transaction(async trx => { await trx.executor.selectFrom("user_machines").select("machine_id")
      .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow(); locked.resolve(); await release.promise; });
    await locked.promise;
    const claiming = Promise.allSettled([opsB.claimDispatch(identity, key.requestId, (trx, id) => funding.start(trx, id))]);
    try {
      await waitForLock("b");
      await admin.query(`SELECT operation_id FROM "${schema}".speech_operations WHERE operation_id=$1 FOR UPDATE NOWAIT`, [key.requestId]);
    } finally { release.resolve(); await policy; }
    expect((await claiming)[0].status).toBe("fulfilled");
  });

  it("refreshes time after a balance wait crossing the request expiry and never charges late completion", async () => {
    const key = await admit(true); const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const blocker = a.transaction(async trx => { await trx.executor.selectFrom("ai_funded_runtime_balances").select("machine_id")
      .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow(); locked.resolve(); await release.promise; });
    await locked.promise;
    const completing = Promise.allSettled([opsB.complete(identity, key.requestId,
      { executionState: "succeeded", outcomeCode: "transcript", actualCostMicrousd: 40 },
      (trx, id) => funding.settle(trx, id, { mode: "exact", actualCostMicrousd: 40 }))]);
    try { await waitForLock("b"); clock = new Date(clock.getTime() + 61_000); }
    finally { release.resolve(); await blocker; }
    const result = (await completing)[0]; if (result.status === "rejected") throw result.reason;
    const state = await snapshot();
    expect(state.balances[0].credit_balance_microusd).toBe("1000");
    expect(JSON.parse(state.requests[0].settlement_response!)).toMatchObject({ actualCostMicrousd: 40, chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 40 });
    expect(state.quota[0].period_reserved_microusd).toBe("0");
  });

  it.each(["reserve", "settle"] as const)("keeps real Speech %s compatible with a balance-first checkout refund", async stage => {
    const claimId = randomUUID(), suffix = claimId.replaceAll("-", ""), paymentId = `pi_${suffix}`, sessionId = `cs_${suffix}`;
    await prepareAiCreditCheckoutClaim(a, { ...identity, requestId: claimId, packageId: "usd_5", priceId: "price_test",
      amountMicrousd: 5_000_000, amountCents: 500, currency: "usd", automaticTax: false, idempotencyKey: claimId }, clock);
    await finalizeAiCreditCheckoutClaim(a, claimId, { id: sessionId, url: "https://checkout.stripe.com/test" }, clock.toISOString());
    await a.transaction(trx => processAiCreditWebhookEvent({ trx, repository: funded, at: clock.toISOString(), event: {
      id: `evt_${suffix}`, type: "checkout.session.completed", created: clock.getTime() / 1000,
      data: { object: { id: sessionId, mode: "payment", status: "complete", payment_status: "paid", payment_intent: paymentId,
        amount_subtotal: 500, amount_total: 500, currency: "usd", client_reference_id: identity.ownerId,
        metadata: { matrix_checkout_kind: "ai_credit_addon", matrix_owner_id: identity.ownerId, matrix_machine_id: identity.machineId,
          matrix_runtime_slot: identity.runtimeSlot, matrix_ai_credit_package_id: "usd_5", matrix_ai_credit_request_id: claimId,
          matrix_ai_credit_price_id: "price_test", matrix_ai_credit_microusd: "5000000" } } },
    } }));
    const key = stage === "settle" ? await admit(true) : null;
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const refund = a.transaction(async trx => {
      await getClaimByPaymentReference(trx, paymentId, null);
      await trx.executor.selectFrom("ai_funded_runtime_balances").select("machine_id").where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      locked.resolve(); await release.promise;
      return processAiCreditWebhookEvent({ trx, at: clock.toISOString(), event: { id: `refund_${suffix}`, type: "charge.refunded",
        created: clock.getTime() / 1000, data: { object: { id: `ch_${suffix}`, payment_intent: paymentId, amount_refunded: 500, currency: "usd" } } } });
    });
    await locked.promise;
    const competing = key ? opsB.complete(identity, key.requestId,
      { executionState: "succeeded", outcomeCode: "transcript", actualCostMicrousd: 40 },
      (trx, id) => funding.settle(trx, id, { mode: "exact", actualCostMicrousd: 40 }))
      : opsB.admit({ identity, requestId: `sp_${clock.getTime()}_${suffix}`, sourceKind: "dictation", contentFingerprint: "a".repeat(64),
        policyRevision: "speech-price-1", adapterId: "synthetic", modelId: "gpt-4o-transcribe", audioDurationMs: 1_000, maximumCostMicrousd: 120 },
        trx => funding.reserve(trx, { identity, requestId: `sp_${clock.getTime()}_${suffix}`, policyRevision: "speech-price-1", modelId: "gpt-4o-transcribe", maximumCostMicrousd: 120 }));
    const results = Promise.allSettled([refund, competing]);
    try { await waitForLock("b"); } finally { release.resolve(); }
    for (const result of await results) if (result.status === "rejected") throw result.reason;
    expect((await snapshot()).balances[0]).toMatchObject({ credit_balance_microusd: stage === "settle" ? "960" : "1000", reserved_microusd: "0" });
  });
  it("serializes expired legacy Speech cleanup against late exact expense on a suspended non-primary machine", async () => {
    const key = await admit();
    const original = JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-price-1", fundingPolicy: "speech_monthly_v1" });
    await a.executor.updateTable("ai_funded_usage_reservations").set({ authorization_response: original,
      reserved_microusd: 120, addon_reserved_microusd: 120 }).where("reservation_id", "=", key.reservationId).execute();
    await a.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 120 }).where("machine_id", "=", identity.machineId).execute();
    // Legacy positive captures deliberately remain writable by the old start shape.
    await a.executor.updateTable("ai_funded_usage_reservations").set({ status: "in_flight", started_at: clock.toISOString(),
      expires_at: new Date(clock.getTime() + 60_000).toISOString(),
      start_response: JSON.stringify({ capability: "speech:transcribe", startedAt: clock.toISOString() }) })
      .where("reservation_id", "=", key.reservationId).execute();
    await a.executor.updateTable("user_machines").set({ status: "suspended" }).where("machine_id", "=", identity.machineId).execute();
    clock = new Date(clock.getTime() + 61_000);
    await Promise.all([funded.cleanupExpiredReservations({ limit: 1 }),
      b.transaction(trx => funding.settle(trx.executor, key.reservationId, { mode: "exact", actualCostMicrousd: 40 }))]);
    const state = await snapshot();
    expect(state.requests[0]).toMatchObject({ status: "settled", actual_microusd: "40", authorization_response: original,
      reserved_microusd: "120", customer_charge_release: expect.any(String) });
    expect(JSON.parse(state.requests[0].settlement_response!)).toMatchObject({ actualCostMicrousd: 40, chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 40 });
    expect(state.balances[0]).toMatchObject({ credit_balance_microusd: "1000", reserved_microusd: "0", month_reserved_microusd: "0" });
    expect(state.quota[0]).toMatchObject({ period_reserved_microusd: "0", period_spent_microusd: "0" });
  });

  it.each(["marker", "ceiling"] as const)("rejects a zero Speech capture missing its positive %s contract", async missing => {
    const key = await admit();
    const saved = await a.executor.selectFrom("ai_funded_usage_reservations").select("authorization_response")
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    const bad = JSON.parse(saved.authorization_response);
    if (missing === "marker") delete bad.reservation.billingPolicy;
    else delete bad.reservation.maxCostMicrousd;
    await expect(a.executor.updateTable("ai_funded_usage_reservations").set({ authorization_response: JSON.stringify(bad) })
      .where("reservation_id", "=", key.reservationId).execute()).rejects.toThrow(/check constraint/);
  });

});
