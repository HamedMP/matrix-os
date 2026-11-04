import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import { migrateFundedConservativeFence, FUNDED_CONSERVATIVE_FENCE_BODY } from "../../packages/platform/src/database/funded-conservative-fence.js";
import { FUNDED_CONSERVATIVE_FENCE_REVISION } from "../../packages/platform/src/database/funded-conservative-fence-revision.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createSpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const identity = { ownerId: "fence_owner", machineId: "fence_machine", runtimeSlot: "primary" };
const modelId = "anthropic/claude-sonnet-5";
const constraint = "ai_funded_conservative_settlement_check";

describe.skipIf(!databaseUrl)("conservative settlement fence on actual PostgreSQL", () => {
  let admin: pg.Pool, schema: string, a: PlatformDB, b: PlatformDB, clock: Date;
  let funded: ReturnType<typeof createAiFundedPolicyRepository>;
  let funding: ReturnType<typeof createAiFundedSpeechFundingPort>;
  let token: string, tokenId: string;
  beforeEach(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("Disposable loopback test PostgreSQL required");
    schema = `fence_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000`);
    url.searchParams.set("application_name", `${schema}_a`); a = createPlatformDb(url.toString()); await a.ready;
    url.searchParams.set("application_name", `${schema}_b`); b = createPlatformDb(url.toString()); await b.ready;
    clock = new Date("2026-11-05T12:00:00.000Z");
    await insertUserMachine(a, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: identity.machineId,
      runtimeSlot: identity.runtimeSlot, status: "running", activationState: "authorized", imageVersion: "test", provisionedAt: clock.toISOString() });
    funded = createAiFundedPolicyRepository({ db: a, now: () => new Date(clock), credentialHashSecret: "h".repeat(32), inFlightTtlMs: 60_000 });
    await funded.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await funded.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    await funded.grantCredit({ entryId: "initial_addon", identity, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "test" });
    const issued = await funded.issueRuntimeCredential(identity); token = issued.credential.token; tokenId = issued.credential.tokenId;
    funding = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      reservationIdFactory: () => `speech_${randomUUID().replaceAll("-", "")}`, now: () => new Date(clock), inFlightTtlMs: 60_000,
      monthlyAllowance: { monthlyBudgetMicrousd: 1_000, monthlyPromotionalCreditMicrousd: 0 } });
  });
  afterEach(async () => { await b?.destroy(); await a?.destroy(); if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  async function legacyCapture(kind: "AI" | "Speech") {
    if (kind === "AI") {
      const auth = await funded.authorize({ credential: token, requestId: "ai_legacy", modelId, maxCostMicrousd: 120, billingMode: "usage" });
      await funded.startReservation({ reservationId: auth.reservation.reservationId, tokenId });
      expect(auth.reservation.reservedMicrousd).toBe(120);
      return { reservationId: auth.reservation.reservationId, requestId: "ai_legacy" };
    }
    const requestId = `sp_${clock.getTime()}_${randomUUID().replaceAll("-", "")}`;
    const ops = createSpeechOperationsRepository({ db: a, now: () => new Date(clock) });
    const operation = await ops.admit({ identity, requestId, sourceKind: "dictation", contentFingerprint: "a".repeat(64),
      policyRevision: "speech-price-1", adapterId: "synthetic", modelId: "gpt-4o-transcribe", audioDurationMs: 1_000, maximumCostMicrousd: 120 },
      trx => funding.reserve(trx, { identity, requestId, policyRevision: "speech-price-1", modelId: "gpt-4o-transcribe", maximumCostMicrousd: 120 }));
    const reservationId = operation.fundingReservationId!;
    await a.transaction(async trx => {
      await trx.executor.updateTable("ai_funded_usage_reservations").set({ authorization_response: JSON.stringify({ capability: "speech:transcribe", policyRevision: "speech-price-1", fundingPolicy: "speech_monthly_v1" }),
        reserved_microusd: 120, addon_reserved_microusd: 120, status: "in_flight", started_at: clock.toISOString(), expires_at: new Date(clock.getTime() + 60_000).toISOString(),
        start_response: JSON.stringify({ capability: "speech:transcribe", startedAt: clock.toISOString() }) }).where("reservation_id", "=", reservationId).execute();
      await trx.executor.updateTable("ai_funded_runtime_balances").set({ reserved_microusd: 120 }).where("machine_id", "=", identity.machineId).execute();
      await trx.executor.updateTable("speech_runtime_allowances").set({ period_reserved_microusd: 120 }).where("machine_id", "=", identity.machineId).execute();
    });
    return { reservationId, requestId };
  }
  const snapshot = async () => ({
    requests: await a.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("reservation_id").execute(),
    operations: await a.executor.selectFrom("speech_operations").selectAll().execute(),
    balances: await a.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    quota: await a.executor.selectFrom("speech_runtime_allowances").selectAll().execute(),
    ledger: await a.executor.selectFrom("ai_funded_credit_ledger").selectAll().orderBy("entry_id").execute(),
  });
  // Old binaries write wallet/month/ledger first, then the reservation receipt.
  const legacySettle = (key: { reservationId: string; requestId: string }, kind: "AI" | "Speech", gate?: { locked: () => void; proceed: Promise<void> }) => b.transaction(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
    await trx.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id").where("reservation_id", "=", key.reservationId).forUpdate().executeTakeFirstOrThrow();
    await trx.executor.selectFrom("ai_funded_runtime_balances").select("machine_id").where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
    if (gate) { gate.locked(); await gate.proceed; }
    await trx.executor.updateTable("ai_funded_runtime_balances").set({ credit_balance_microusd: 880, addon_balance_microusd: 880,
      reserved_microusd: 0, month_spent_microusd: 120, month_reserved_microusd: 0 }).where("machine_id", "=", identity.machineId).execute();
    await trx.executor.insertInto("ai_funded_credit_ledger").values({ entry_id: `usage:${key.reservationId}:addon`, owner_id: identity.ownerId,
      machine_id: identity.machineId, runtime_slot: identity.runtimeSlot, kind: "addon_debit", amount_microusd: -120,
      source_reference: key.requestId, reservation_id: key.reservationId, period_start: "2026-11-01T00:00:00.000Z", expires_at: null, created_at: clock.toISOString() }).execute();
    if (kind === "Speech") {
      await trx.executor.updateTable("speech_runtime_allowances").set({ period_reserved_microusd: 0, period_spent_microusd: 120 }).where("machine_id", "=", identity.machineId).execute();
      await trx.executor.updateTable("speech_operations").set({ execution_state: "uncertain", dispatch_claimed_at: clock.toISOString(), safe_outcome_code: "provider_failure", actual_microusd: null }).where("operation_id", "=", key.requestId).execute();
    }
    await trx.executor.updateTable("ai_funded_usage_reservations").set({ status: "settled", actual_microusd: 120, finalization_mode: "conservative",
      settled_at: clock.toISOString(), settlement_response: JSON.stringify({ actualCostMicrousd: 120, capability: kind === "Speech" ? "speech:transcribe" : "ai" }) }).where("reservation_id", "=", key.reservationId).execute();
  });

  it("rejects INSERT of a new conservative settled receipt", async () => {
    const key = await legacyCapture("AI");
    const row = await a.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    await expect(b.executor.insertInto("ai_funded_usage_reservations").values({ ...row, reservation_id: "inserted_conservative", request_id: "inserted_conservative",
      status: "settled", finalization_mode: "conservative", actual_microusd: 120, settled_at: clock.toISOString(), settlement_response: "{\"actualCostMicrousd\":120}" }).execute())
      .rejects.toMatchObject({ code: "23514", constraint });
  });

  it.each(["AI", "Speech"] as const)("rolls back every old %s conservative debit against a positive legacy capture", async kind => {
    const key = await legacyCapture(kind), before = await snapshot();
    await expect(legacySettle(key, kind)).rejects.toMatchObject({ code: "23514", constraint });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["AI", "Speech"] as const)("preserves exact %s settlement and rejects relabeling it as conservative", async kind => {
    const key = await legacyCapture(kind);
    if (kind === "AI") await funded.finalizeReservation({ reservationId: key.reservationId, tokenId, mode: "exact", actualCostMicrousd: 40 });
    else await a.transaction(trx => funding.settle(trx.executor, key.reservationId, { mode: "exact", actualCostMicrousd: 40 }));
    const before = await snapshot();
    expect(before.requests[0]).toMatchObject({ status: "settled", actual_microusd: "40", finalization_mode: "exact" });
    expect(before.balances[0]).toMatchObject({ credit_balance_microusd: "960", reserved_microusd: "0" });
    await expect(b.executor.updateTable("ai_funded_usage_reservations").set({ finalization_mode: "conservative" })
      .where("reservation_id", "=", key.reservationId).execute()).rejects.toMatchObject({ code: "23514", constraint });
    expect(await snapshot()).toEqual(before);
  });

  it("retains pre-fence historical conservative receipts, permits replay, and freezes their financial tuple", async () => {
    const key = await legacyCapture("Speech");
    // Explicitly seed a historical committed receipt before restoring the fence.
    await sql`DROP TRIGGER ai_funded_conservative_settlement_fence ON ai_funded_usage_reservations`.execute(a.executor);
    try { await legacySettle(key, "Speech"); }
    finally { await a.transaction(trx => migrateFundedConservativeFence(trx.executor)); }
    await runPlatformStartupMigrations(a.executor);
    const before = await snapshot();
    await a.transaction(trx => funding.settle(trx.executor, key.reservationId, { mode: "conservative" }));
    await b.executor.updateTable("ai_funded_usage_reservations").set({ settlement_response: before.requests[0].settlement_response })
      .where("reservation_id", "=", key.reservationId).execute();
    expect(await snapshot()).toEqual(before);
    for (const change of [{ actual_microusd: 121 }, { settlement_response: "{}" }, { reserved_microusd: 121 },
      { addon_reserved_microusd: 121 }, { finalization_mode: "exact" }, { status: "in_flight" }]) {
      await expect(b.executor.updateTable("ai_funded_usage_reservations").set(change).where("reservation_id", "=", key.reservationId).execute())
        .rejects.toMatchObject({ code: "23514", constraint });
    }
    expect(await snapshot()).toEqual(before);
    // A separately audited execution metadata write does not mutate the receipt.
    await b.executor.updateTable("ai_funded_usage_reservations").set({ execution_recovery_slot: 1 })
      .where("reservation_id", "=", key.reservationId).execute();
    expect((await snapshot()).requests[0]).toEqual({ ...before.requests[0], execution_recovery_slot: 1 });
  });

  it.each(["AI", "Speech"] as const)("serializes old %s settlement against audited expiry cleanup without any customer debit", async kind => {
    const key = await legacyCapture(kind);
    clock = new Date(clock.getTime() + 61_000);
    const locked = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
    const legacy = Promise.allSettled([legacySettle(key, kind, { locked: () => locked.resolve(), proceed: proceed.promise })]);
    await locked.promise;
    const cleanup = funded.cleanupExpiredCustomerCharges({ limit: 1 });
    try {
      let waiting = false;
      const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [`${schema}_a`])).rows[0].waiting);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { proceed.resolve(); }
    expect((await legacy)[0]).toMatchObject({ status: "rejected", reason: { code: "23514", constraint } });
    await cleanup;
    const state = await snapshot();
    expect(state.balances[0]).toMatchObject({ credit_balance_microusd: "1000", reserved_microusd: "0", month_reserved_microusd: "0", month_spent_microusd: "0" });
    expect(state.requests[0]).toMatchObject({ actual_microusd: null, settlement_response: null, customer_charge_release: expect.any(String) });
    expect(state.ledger.filter(row => row.reservation_id === key.reservationId)).toHaveLength(0);
    if (kind === "Speech") {
      expect(state.quota[0]).toMatchObject({ period_reserved_microusd: "0", period_spent_microusd: "0" });
      expect(state.operations[0]).toMatchObject({ execution_state: "reserved", actual_microusd: null });
    }
    // The reverse order also cannot overwrite a committed release with a charge.
    await expect(legacySettle(key, kind)).rejects.toMatchObject({ code: "23514", constraint });
    expect(await snapshot()).toEqual(state);
  });

  it("runs repeatedly and keeps older-core startup compatible without changing the core marker", async () => {
    const core = (await sql`SELECT * FROM platform_schema_revisions WHERE scope='core'`.execute(a.executor)).rows;
    await runPlatformStartupMigrations(a.executor);
    await runPlatformMigration(b.executor, async () => { throw new Error("Older core must not run"); },
      { revision: { generation: 23, fingerprint: "older-deployed-core" } });
    expect((await sql`SELECT * FROM platform_schema_revisions WHERE scope='core'`.execute(a.executor)).rows).toEqual(core);
    const marker = await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope='funded-conservative-fence'`.execute(a.executor);
    expect(marker.rows).toEqual([FUNDED_CONSERVATIVE_FENCE_REVISION]);
  });

  it("installs its independent scope even when a newer core marker skips core DDL", async () => {
    await sql`DELETE FROM platform_schema_revisions WHERE scope='funded-conservative-fence'`.execute(a.executor);
    await sql`DROP TRIGGER ai_funded_conservative_settlement_fence ON ai_funded_usage_reservations`.execute(a.executor);
    await sql`UPDATE platform_schema_revisions SET generation=25, fingerprint='newer-preview-core' WHERE scope='core'`.execute(a.executor);
    await runPlatformStartupMigrations(a.executor);
    expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(a.executor)).rows)
      .toEqual([{ generation: 25, fingerprint: "newer-preview-core" }]);
    const key = await legacyCapture("AI");
    await expect(legacySettle(key, "AI")).rejects.toMatchObject({ code: "23514", constraint });
  });

  it.each(["missing", "disabled", "body", "binding", "events", "predicate"] as const)("fails actual startup closed for a %s fence despite its migration marker", async fault => {
    if (fault === "disabled") await sql`ALTER TABLE ai_funded_usage_reservations DISABLE TRIGGER ai_funded_conservative_settlement_fence`.execute(a.executor);
    else if (fault === "body") await sql`CREATE OR REPLACE FUNCTION enforce_ai_funded_conservative_settlement_fence() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'`.execute(a.executor);
    else {
      await sql`DROP TRIGGER ai_funded_conservative_settlement_fence ON ai_funded_usage_reservations`.execute(a.executor);
      if (fault === "binding") {
        await sql`CREATE FUNCTION replacement_fence() RETURNS trigger LANGUAGE plpgsql AS $fence$${sql.raw(FUNDED_CONSERVATIVE_FENCE_BODY)}$fence$`.execute(a.executor);
        await sql`CREATE TRIGGER ai_funded_conservative_settlement_fence BEFORE INSERT OR UPDATE ON ai_funded_usage_reservations FOR EACH ROW EXECUTE FUNCTION replacement_fence()`.execute(a.executor);
      } else if (fault === "events") await sql`CREATE TRIGGER ai_funded_conservative_settlement_fence BEFORE UPDATE ON ai_funded_usage_reservations FOR EACH ROW EXECUTE FUNCTION enforce_ai_funded_conservative_settlement_fence()`.execute(a.executor);
      else if (fault === "predicate") await sql`CREATE TRIGGER ai_funded_conservative_settlement_fence BEFORE INSERT OR UPDATE ON ai_funded_usage_reservations FOR EACH ROW WHEN (NEW.status = 'reserved') EXECUTE FUNCTION enforce_ai_funded_conservative_settlement_fence()`.execute(a.executor);
    }
    const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
    const starting = createPlatformDb(url.toString());
    try { await expect(starting.ready).rejects.toThrow("Funded usage settlement fence is missing or invalid"); }
    finally { await starting.destroy(); }
  });

});
