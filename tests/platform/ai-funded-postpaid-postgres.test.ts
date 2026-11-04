import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";
import { finalizeAiCreditCheckoutClaim, getClaimByPaymentReference, prepareAiCreditCheckoutClaim } from "../../packages/platform/src/ai-credit-checkout-store.js";
import { processAiCreditWebhookEvent } from "../../packages/platform/src/ai-credit-checkout-webhook.js";

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const identity = { ownerId: "postpaid_owner", machineId: "postpaid_machine", runtimeSlot: "primary" };
const modelId = "anthropic/claude-sonnet-5";

describe.skipIf(!databaseUrl)("postpaid credit on independent PostgreSQL connections", () => {
  let admin: pg.Pool, schema: string, db: PlatformDB, secondDb: PlatformDB;
  let first: ReturnType<typeof createAiFundedPolicyRepository>, second: typeof first;
  let clock: Date, token: string, tokenId: string;
  beforeEach(async () => {
    schema = `postpaid_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", `${schema}_first`);
    db = createPlatformDb(url.toString());
    await db.ready;
    url.searchParams.set("application_name", `${schema}_second`);
    secondDb = createPlatformDb(url.toString());
    await secondDb.ready;
    clock = new Date("2026-11-04T12:00:00.000Z");
    const options = { credentialHashSecret: "h".repeat(32), now: () => new Date(clock),
      reservationTtlMs: 30_000, inFlightTtlMs: 60_000, credentialTtlMs: 3_600_000 };
    first = createAiFundedPolicyRepository({ ...options, db });
    second = createAiFundedPolicyRepository({ ...options, db: secondDb });
    await first.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: identity.machineId, runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test",
      provisionedAt: clock.toISOString(), activationState: "authorized" });
    await first.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    await first.grantCredit({ entryId: "postpaid_grant", identity, kind: "addon_grant", amountMicrousd: 1_000_000, sourceReference: "test" });
    const issued = await first.issueRuntimeCredential(identity);
    token = issued.credential.token; tokenId = issued.credential.tokenId;
  });
  afterEach(async () => {
    await secondDb?.destroy(); await db?.destroy();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  const request = (id = "postpaid_request") => ({ credential: token, requestId: id, modelId,
    maxCostMicrousd: 2_000_000, billingMode: "usage" as const, billingPolicy: "postpaid" as const });

  it.each(["postpaid", "legacy"])("keeps %s execution exclusive across replicas after releasing uncertain customer cost", async mode => {
    const { billingPolicy, ...legacy } = request();
    const admitted = await first.authorize(mode === "postpaid" ? { ...legacy, billingPolicy } : legacy);
    const key = { reservationId: admitted.reservation.reservationId, tokenId };
    const start = await first.startReservation({ ...key, executionId: "uncertain_execution" });
    await expect(first.finalizeReservation({ ...key, mode: "conservative" })).rejects.toMatchObject({ code: "unavailable" });
    expect(await second.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0,
      reservedThisMonthMicrousd: 0, remainingBalanceMicrousd: 1_000_000 });
    const beforeExpiry = await Promise.allSettled([
      first.authorize(request("early_first")), second.authorize(request("early_second")),
    ]);
    expect(beforeExpiry).toMatchObject([{ status: "rejected", reason: { code: "rate_limited" } },
      { status: "rejected", reason: { code: "rate_limited" } }]);
    clock = new Date(start.expiresAt);
    const atExpiry = await Promise.allSettled([
      first.authorize(request("after_first")), second.authorize(request("after_second")),
    ]);
    expect(atExpiry.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(atExpiry.filter(result => result.status === "rejected")).toMatchObject([
      { reason: { code: "rate_limited" } },
    ]);
    const retained = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(retained).toMatchObject({ status: "expired", actual_microusd: null, settlement_response: null });
  });

  async function settleAfterLockWait(key: { reservationId: string; tokenId: string }, actualCostMicrousd: number, afterWait: Date, lock: "owner" | "balance") {
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const blocker = db.transaction(async trx => {
      if (lock === "owner") await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
      else await trx.executor.selectFrom("ai_funded_runtime_balances").select("machine_id")
        .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const result = Promise.allSettled([second.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd })]);
    try {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
          [`${schema}_second`])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      clock = afterWait;
    } finally { release.resolve(); await blocker; }
    const outcome = (await result)[0];
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }

  it.each(["owner", "balance"] as const)("refreshes settlement time after a %s-lock wait across promotional grant expiry", async (lock) => {
    const drain = await first.authorize(request("drain_credit"));
    const drainKey = { reservationId: drain.reservation.reservationId, tokenId };
    await first.startReservation(drainKey);
    await first.finalizeReservation({ ...drainKey, mode: "exact", actualCostMicrousd: 1_000_000 });
    await first.setRuntimePolicy({ identity, expectedRevision: 1, enabled: true, allowedModelIds: [modelId],
      monthlyBudgetMicrousd: 2_000_000, expiresAt: null });
    await first.grantCredit({ entryId: "expires_while_waiting", identity, kind: "promotional_grant", amountMicrousd: 100_000,
      sourceReference: "test", expiresAt: new Date(clock.getTime() + 5_000).toISOString() });
    const auth = await first.authorize(request("grant_expiry_wait"));
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    const afterWait = new Date(clock.getTime() + 6_000);
    expect(await settleAfterLockWait(key, 50_000, afterWait, lock)).toMatchObject({ settledAt: afterWait.toISOString(),
      chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 50_000,
      funding: { remainingBalanceMicrousd: 0, fundingShortfallMicrousd: 0 } });
  });

  it.each(["owner", "balance"] as const)("uses the completion month after a %s-lock wait across the UTC month boundary", async (lock) => {
    const earlier = await first.authorize(request("old_month_usage"));
    const earlierKey = { reservationId: earlier.reservation.reservationId, tokenId };
    await first.startReservation(earlierKey);
    await first.finalizeReservation({ ...earlierKey, mode: "exact", actualCostMicrousd: 900_000 });
    clock = new Date("2026-11-30T23:59:50.000Z");
    const issued = await first.issueRuntimeCredential(identity);
    token = issued.credential.token; tokenId = issued.credential.tokenId;
    const auth = await first.authorize(request("month_boundary_wait"));
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    const afterWait = new Date("2026-12-01T00:00:01.000Z");
    expect(await settleAfterLockWait(key, 50_000, afterWait, lock)).toMatchObject({ settledAt: afterWait.toISOString(),
      chargedCostMicrousd: 50_000, matrixAbsorbedMicrousd: 0,
      funding: { periodStart: "2026-12-01T00:00:00.000Z", settledThisMonthMicrousd: 50_000 } });
  });

  it.each(["owner", "balance"] as const)("permanently releases customer charges when the request expires during a %s-lock wait", async (lock) => {
    const auth = await first.authorize(request("request_expiry_wait"));
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    const afterWait = new Date(clock.getTime() + 61_000);
    expect(await settleAfterLockWait(key, 100_000, afterWait, lock)).toMatchObject({ settledAt: afterWait.toISOString(),
      chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 100_000 });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").select("customer_charge_release")
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(JSON.parse(row.customer_charge_release!)).toMatchObject({ reason: "expired_request", releasedAt: afterWait.toISOString() });
  });

  async function purchaseCheckoutCredit() {
    const claimId = randomUUID(), suffix = claimId.replaceAll("-", ""), sessionId = `cs_${suffix}`, paymentId = `pi_${suffix}`;
    await prepareAiCreditCheckoutClaim(db, { requestId: claimId, ...identity, packageId: "usd_5", priceId: "price_five",
      amountMicrousd: 5_000_000, amountCents: 500, currency: "usd", automaticTax: false, idempotencyKey: claimId }, clock);
    await finalizeAiCreditCheckoutClaim(db, claimId, { id: sessionId, url: "https://checkout.stripe.com/test" }, clock.toISOString());
    await db.transaction(trx => processAiCreditWebhookEvent({ trx, repository: first, at: clock.toISOString(), event: {
      id: `evt_${claimId}`, type: "checkout.session.completed", created: clock.getTime() / 1000,
      data: { object: { id: sessionId, mode: "payment", status: "complete", payment_status: "paid", payment_intent: paymentId,
        amount_subtotal: 500, amount_total: 500, currency: "usd", client_reference_id: identity.ownerId,
        metadata: { matrix_checkout_kind: "ai_credit_addon", matrix_owner_id: identity.ownerId,
          matrix_machine_id: identity.machineId, matrix_runtime_slot: identity.runtimeSlot,
          matrix_ai_credit_package_id: "usd_5", matrix_ai_credit_request_id: claimId,
          matrix_ai_credit_price_id: "price_five", matrix_ai_credit_microusd: "5000000" } } },
    } }));
    return { claimId, paymentId };
  }

  it.each(["settlement", "authorization", "cleanup", "terminal"] as const)("serializes %s with an actual checkout refund without a machine-FK deadlock", async (operation) => {
    const { claimId, paymentId } = await purchaseCheckoutCredit();
    const auth = operation === "authorization" ? null : await first.authorize(request("refund_race"));
    const key = auth ? { reservationId: auth.reservation.reservationId, tokenId } : null;
    const start = key ? await first.startReservation({ ...key, executionId: "refund-race-attempt" }) : null;
    if (operation === "cleanup") clock = new Date(clock.getTime() + 61_000);
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const refund = db.transaction(async trx => {
      await getClaimByPaymentReference(trx, paymentId, null);
      await trx.executor.selectFrom("ai_funded_runtime_balances").select("machine_id")
        .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      locked.resolve(); await release.promise;
      return processAiCreditWebhookEvent({ trx, at: clock.toISOString(), event: {
        id: `refund_${claimId}`, type: "charge.refunded", created: clock.getTime() / 1000,
        data: { object: { id: `ch_${claimId}`, payment_intent: paymentId, amount_refunded: 500, currency: "usd" } },
      } });
    });
    await locked.promise;
    const competing = operation === "authorization" ? second.authorize(request("after_refund"))
      : operation === "cleanup" ? second.cleanupExpiredCustomerCharges({ limit: 1 })
      : operation === "settlement" ? second.finalizeReservation({ ...key!, mode: "exact", actualCostMicrousd: 100_000 })
      : second.recordTerminalOutcome({ contractVersion: 1, ...identity, ...key!, requestId: "refund_race",
        startedAt: start!.startedAt, expiresAt: start!.expiresAt, executionId: "refund-race-attempt",
        terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" });
    const results = Promise.allSettled([refund, competing]);
    try {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
          [`${schema}_second`])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { release.resolve(); }
    for (const outcome of await results) if (outcome.status === "rejected") throw outcome.reason;
    expect(await first.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0,
      creditBalanceMicrousd: operation === "settlement" ? 900_000 : 1_000_000, fundingShortfallMicrousd: 0 });
    const reversals = await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("kind", "=", "addon_reversal").execute();
    expect(reversals.map(row => Number(row.amount_microusd))).toEqual([-5_000_000]);
  });

  it("keeps the balance exclusive when settlement reaches the debit before an actual checkout refund", async () => {
    const { claimId, paymentId } = await purchaseCheckoutCredit();
    const auth = await first.authorize(request("settlement_before_refund"));
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    const gate = `settlement-ledger:${schema}`;
    await sql`CREATE FUNCTION pause_customer_debit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0], 0)); RETURN NEW; END $$`.execute(db.executor);
    await sql`CREATE TRIGGER pause_customer_debit BEFORE INSERT ON ai_funded_credit_ledger
      FOR EACH ROW WHEN (NEW.kind = 'addon_debit') EXECUTE FUNCTION pause_customer_debit(${sql.lit(gate)})`.execute(db.executor);
    await admin.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gate]);
    const phases: Array<Promise<PromiseSettledResult<unknown>[]>> = [
      Promise.allSettled([first.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100_000 })]),
    ];
    const waitForLock = async (replica: "first" | "second") => {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
          [`${schema}_${replica}`])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    };
    try {
      await waitForLock("first");
      phases.push(Promise.allSettled([secondDb.transaction(trx => processAiCreditWebhookEvent({ trx, at: clock.toISOString(), event: {
        id: `refund_${claimId}`, type: "charge.refunded", created: clock.getTime() / 1000,
        data: { object: { id: `ch_${claimId}`, payment_intent: paymentId, amount_refunded: 500, currency: "usd" } },
      } }))]));
      await waitForLock("second");
      let balanceLocked = false;
      try { await admin.query(`SELECT machine_id FROM "${schema}".ai_funded_runtime_balances FOR UPDATE NOWAIT`); }
      catch (error) { if ((error as { code?: string }).code === "55P03") balanceLocked = true; else throw error; }
      expect(balanceLocked).toBe(true);
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gate]);
      await Promise.all(phases);
    }
    for (const outcome of (await Promise.all(phases)).flat()) if (outcome.status === "rejected") throw outcome.reason;
    expect(await first.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 900_000,
      reservedMicrousd: 0, fundingShortfallMicrousd: 0 });
    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("kind", "in", ["addon_reversal", "addon_debit"]).execute();
    expect(ledger.map(row => Number(row.amount_microusd)).sort((a, b) => a - b)).toEqual([-5_000_000, -100_000]);
  });

  it("serializes duplicate admission and settlement without a hold or duplicate debit", async () => {
    const authorizations = await Promise.all([first.authorize(request()), second.authorize(request())]);
    expect(authorizations[0]).toEqual(authorizations[1]);
    const key = { reservationId: authorizations[0].reservation.reservationId, tokenId };
    await first.startReservation(key);
    const settlements = await Promise.all([
      first.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100_000 }),
      second.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100_000 }),
    ]);
    expect(settlements[0]).toEqual(settlements[1]);
    expect(await first.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0,
      remainingBalanceMicrousd: 900_000, settledThisMonthMicrousd: 100_000 });
    const ledger = await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("reservation_id", "=", key.reservationId).execute();
    expect(ledger.map(row => Number(row.amount_microusd))).toEqual([-100_000]);
  });

  it("takes the machine lock before settlement rows when an add-on top-up is in progress", async () => {
    const auth = await first.authorize(request("topup_race"));
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const topup = db.transaction(async trx => {
      await trx.executor.selectFrom("user_machines").select("machine_id").where("machine_id", "=", identity.machineId)
        .forUpdate().executeTakeFirstOrThrow();
      locked.resolve(); await release.promise;
      return first.grantCreditInTransaction(trx, { entryId: "concurrent_topup", identity, kind: "addon_grant",
        amountMicrousd: 100_000, sourceReference: "test" });
    });
    await locked.promise;
    const settling = second.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 100_000 });
    const result = Promise.allSettled([topup, settling]);
    let rowUnlocked = true;
    try {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
          [`${schema}_second`])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      try { await admin.query(`SELECT reservation_id FROM "${schema}".ai_funded_usage_reservations WHERE reservation_id=$1 FOR UPDATE NOWAIT`, [key.reservationId]); }
      catch (error) { if ((error as { code?: string }).code === "55P03") rowUnlocked = false; else throw error; }
    } finally { release.resolve(); }
    const outcomes = await result;
    expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
    expect(outcomes[1]).toMatchObject({ status: "fulfilled" });
    expect(rowUnlocked).toBe(true);
    expect(await first.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 1_000_000,
      reservedMicrousd: 0, settledThisMonthMicrousd: 100_000 });
  });

  it("keeps owner execution exclusive even though customer monetary reservation is zero", async () => {
    const admitted = await Promise.allSettled([first.authorize(request("first")), second.authorize(request("second"))]);
    expect(admitted.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(admitted.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await first.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0, remainingBalanceMicrousd: 1_000_000 });
  });

  it("serializes timeout cleanup against late exact settlement, leaving no customer debt", async () => {
    const auth = await first.authorize(request());
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    clock = new Date(clock.getTime() + 61_000);
    await Promise.all([first.cleanupExpiredCustomerCharges({ limit: 10 }),
      second.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 400_000 })]);
    expect(await first.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0,
      remainingBalanceMicrousd: 1_000_000, fundingShortfallMicrousd: 0 });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    expect(row.status).toBe("settled"); expect(Number(row.actual_microusd)).toBe(400_000);
    expect(JSON.parse(row.settlement_response!)).toMatchObject({ chargedCostMicrousd: 0, matrixAbsorbedMicrousd: 400_000 });
    expect(await first.cleanupExpiredCustomerCharges({ limit: 10 })).toBe(0);
  });

  it("rejects an unmarked zero reservation at the database boundary", async () => {
    const auth = await first.authorize(request());
    await expect(sql`UPDATE ai_funded_usage_reservations SET authorization_response = '{}'
      WHERE reservation_id = ${auth.reservation.reservationId}`.execute(db.executor)).rejects.toThrow(/check constraint/);
  });

  it("releases every legacy AI batch without a fallback full-hold charge", async () => {
    const { billingPolicy: _policy, ...legacy } = request("legacy_first");
    const one = await first.authorize({ ...legacy, maxCostMicrousd: 100_000, billingMode: undefined });
    const two = await first.authorize({ ...legacy, requestId: "legacy_second", maxCostMicrousd: 100_000, billingMode: undefined });
    await first.startReservation({ reservationId: one.reservation.reservationId, tokenId });
    await first.startReservation({ reservationId: two.reservation.reservationId, tokenId });
    clock = new Date(clock.getTime() + 61_000);
    expect(await first.cleanupExpiredReservations({ limit: 1 })).toBe(1);
    expect(await first.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 1_000_000, reservedMicrousd: 100_000 });
    expect(await first.cleanupExpiredReservations({ limit: 1 })).toBe(1);
    expect(await first.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 1_000_000, reservedMicrousd: 0 });
    const rows = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute();
    expect(rows.every(row => row.status === "expired" && row.actual_microusd === null && row.customer_charge_release !== null)).toBe(true);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().where("reservation_id", "is not", null).execute()).toEqual([]);
  });

  it("validates released legacy recovery audits before excluding them from old admission limits", async () => {
    const { billingPolicy: _policy, ...legacy } = request("legacy_recovered");
    const auth = await first.authorize({ ...legacy, maxCostMicrousd: 5_000 });
    const key = { reservationId: auth.reservation.reservationId, tokenId };
    await first.startReservation(key);
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    clock = new Date(clock.getTime() + 20 * 60_000);
    await first.releaseExecutionAdmission(identity, { expectedOwnerId: identity.ownerId, ...key,
      expectedRequestId: row.request_id, expectedStartedAt: row.started_at!, expectedExpiresAt: row.expires_at,
      maximumLiabilityMicrousd: 5_000, localRunId: "local-failed", localRunState: "failed",
      localRunEndedAt: new Date(Date.parse(row.started_at!) + 10_000).toISOString(),
      evidenceRef: "support:terminal-proof", reviewer: "operator:qa", acceptUnknownUpstreamLiability: true });
    expect(await first.cleanupExpiredCustomerCharges({ limit: 10 })).toBe(1);
    const admitted = await first.authorize(request("valid_released_history"));
    await first.releaseReservation({ reservationId: admitted.reservation.reservationId, tokenId, reason: "pre_upstream_failure" });
    // An externally corrupted/imported audit must not become an exclusion shortcut.
    await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT ai_funded_customer_release_check`.execute(db.executor);
    await db.executor.updateTable("ai_funded_usage_reservations").set({ customer_charge_release: "{}" })
      .where("reservation_id", "=", key.reservationId).execute();
    await expect(second.authorize(request("corrupt_released_history")))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await first.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 1_000_000,
      reservedMicrousd: 0, fundingShortfallMicrousd: 0 });
  });

  it("runs bounded read-only inventory pages without starting migrations or changing customer finances", async () => {
    clock = new Date(Date.now() - 120_000);
    const { billingPolicy: _policy, ...legacy } = request("inventory_first");
    await first.authorize({ ...legacy, maxCostMicrousd: 100_000, billingMode: undefined });
    await first.authorize({ ...legacy, requestId: "inventory_second", maxCostMicrousd: 100_000, billingMode: undefined });
    clock = new Date(clock.getTime() + 31_000);
    const before = await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute();
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema} -c default_transaction_read_only=off`);
    const invoke = (args: string[]) => promisify(execFile)("bun", ["scripts/inventory-expired-customer-credit.ts", ...args],
      { env: { ...process.env, PLATFORM_DATABASE_URL: url.toString() }, timeout: 30_000, maxBuffer: 32 * 1024 });
    const one = JSON.parse((await invoke(["1"])).stdout);
    expect(one).toMatchObject({ hasMore: true, items: [{ releaseMicrousd: 100_000, providerUsageKnown: false }] });
    const two = JSON.parse((await invoke(["1", one.nextCursor])).stdout);
    expect(two).toMatchObject({ hasMore: false, nextCursor: null, items: [{ releaseMicrousd: 100_000 }] });
    expect(one.items[0].reservationId).not.toBe(two.items[0].reservationId);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute()).toEqual(before);
    expect((await db.executor.selectFrom("ai_funded_usage_reservations").select("status").execute())
      .every(row => row.status === "reserved")).toBe(true);
    await sql`UPDATE platform_schema_revisions SET generation=23 WHERE scope='core'`.execute(db.executor);
    await expect(invoke(["1"])).rejects.toThrow(/Customer credit inventory failed/);
    expect((await db.executor.selectFrom("platform_schema_revisions").select("generation").where("scope", "=", "core")
      .executeTakeFirstOrThrow()).generation).toBe(23);
  });

  it("upgrades the previous positive-hold schema additively without changing historical money or captures", async () => {
    const { billingPolicy: _policy, ...legacy } = request("legacy_request");
    const auth = await first.authorize(legacy);
    const before = await first.getFundingSummary(identity);
    await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT ai_funded_customer_release_check`.execute(db.executor);
    await sql`DROP INDEX idx_ai_funded_customer_unknown_expense`.execute(db.executor);
    await sql`DROP INDEX idx_ai_funded_unknown_admission_owner`.execute(db.executor);
    await sql`ALTER TABLE ai_funded_usage_reservations DROP COLUMN customer_charge_release`.execute(db.executor);
    await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT ai_funded_usage_reservations_reserved_microusd_check`.execute(db.executor);
    await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_usage_reservations_reserved_microusd_check CHECK (reserved_microusd > 0)`.execute(db.executor);
    await sql`UPDATE platform_schema_revisions SET generation=23,
      fingerprint='588aa2cb52e99cfd8d48cf0ddd92f5f663aa266f2a5a1b40b099f7b92af5d3f0' WHERE scope='core'`.execute(db.executor);
    await runPlatformStartupMigrations(db.kysely);
    expect(await first.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: before.reservedMicrousd,
      remainingBalanceMicrousd: before.remainingBalanceMicrousd });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", auth.reservation.reservationId).executeTakeFirstOrThrow();
    expect(row.authorization_response).toBe(JSON.stringify(auth));
    expect(row.customer_charge_release).toBeNull();
  });
});
