import { JEV_MODEL_ID } from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";

// Set only to a disposable local test server. Each test owns an isolated schema;
// two independent pools exercise actual PostgreSQL transaction contention.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const modelId = "anthropic/claude-sonnet-5";

describe.skipIf(!databaseUrl)("usage admission on independent PostgreSQL connections", () => {
  let admin: pg.Pool;
  let schema: string;
  let db: PlatformDB;
  let secondDb: PlatformDB;
  let first: ReturnType<typeof createAiFundedPolicyRepository>;
  let second: ReturnType<typeof createAiFundedPolicyRepository>;
  let clock: Date;
  let credentials: string[];
  let tokenIds: string[];
  let identities: Array<{ ownerId: string; machineId: string; runtimeSlot: string }>;

  beforeEach(async () => {
    schema = `funded_usage_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = createPlatformDb(url.toString());
    await db.ready;
    secondDb = createPlatformDb(url.toString());
    await secondDb.ready;
    clock = new Date("2026-09-10T12:00:00Z");
    const options = { credentialHashSecret: "h".repeat(32), now: () => new Date(clock),
      reservationTtlMs: 30_000, inFlightTtlMs: 60_000 };
    first = createAiFundedPolicyRepository({ ...options, db });
    second = createAiFundedPolicyRepository({ ...options, db: secondDb });
    await first.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    credentials = [];
    tokenIds = [];
    identities = [];
    for (let index = 0; index < 2; index++) {
      const identity = { ownerId: "shared_owner", machineId: `machine_${index}`, runtimeSlot: `runtime_${index}` };
      identities.push(identity);
      await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
        handle: identity.machineId, runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test",
        provisionedAt: options.now().toISOString(), activationState: "authorized" });
      await first.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId],
        monthlyBudgetMicrousd: 1_000, expiresAt: null });
      await first.grantCredit({ entryId: `grant_${index}`, identity, kind: "addon_grant",
        amountMicrousd: 1_000, sourceReference: "test" });
      const issued = await first.issueRuntimeCredential(identity);
      credentials.push(issued.credential.token);
      tokenIds.push(issued.credential.tokenId);
    }
  });

  afterEach(async () => {
    await secondDb?.destroy();
    await db?.destroy();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it.each(["usage", "strict"] as const)("serializes usage against %s across two pools", async (otherMode) => {
    const results = await Promise.allSettled([
      first.authorize({ credential: credentials[0], requestId: "first", modelId,
        maxCostMicrousd: 100, billingMode: "usage" }),
      second.authorize({ credential: credentials[1], requestId: "second", modelId,
        maxCostMicrousd: 100, ...(otherMode === "usage" ? { billingMode: "usage" as const } : {}) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "rate_limited" } });
    const rows = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it("keeps expired usage capacity held across cleanup until exact settlement", async () => {
    const authorization = await first.authorize({ credential: credentials[0], requestId: "unresolved_usage",
      modelId, maxCostMicrousd: 100, billingMode: "usage" });
    await first.startReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: tokenIds[0],
    });
    clock = new Date(clock.getTime() + 61_000);

    await expect(second.cleanupExpiredReservations({ limit: 1 })).resolves.toBe(0);
    await expect(second.authorize({ credential: credentials[1], requestId: "held_capacity",
      modelId, maxCostMicrousd: 100, billingMode: "usage" }))
      .rejects.toMatchObject({ code: "rate_limited" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations")
      .select(["status", "actual_microusd"])
      .where("reservation_id", "=", authorization.reservation.reservationId)
      .executeTakeFirstOrThrow()).toEqual({ status: "in_flight", actual_microusd: null });

    await expect(second.finalizeReservation({
      reservationId: authorization.reservation.reservationId,
      tokenId: tokenIds[0],
      mode: "exact",
      actualCostMicrousd: 40,
    })).resolves.toMatchObject({
      status: "settled", actualCostMicrousd: 40, chargedCostMicrousd: 40, releasedMicrousd: 60,
    });
    expect((await db.executor.selectFrom("ai_funded_credit_ledger").select("amount_microusd")
      .where("reservation_id", "=", authorization.reservation.reservationId).execute())
      .reduce((total, row) => total + Number(row.amount_microusd), 0)).toBe(-40);
    await expect(second.authorize({ credential: credentials[1], requestId: "after_exact_settlement",
      modelId, maxCostMicrousd: 100, billingMode: "usage" }))
      .resolves.toMatchObject({ authorized: true });
  });

  it("serializes audited recovery and preserves one live execution across independent pools", async () => {
    const authorization = await first.authorize({ credential: credentials[0], requestId: "recover_unknown",
      modelId, maxCostMicrousd: 100, billingMode: "usage" });
    const key = { reservationId: authorization.reservation.reservationId, tokenId: tokenIds[0] };
    await first.startReservation(key);
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    clock = new Date(clock.getTime() + 20 * 60_000);
    const recovery = { ...key, expectedOwnerId: identities[0].ownerId,
      expectedRequestId: "recover_unknown", expectedStartedAt: row.started_at!, expectedExpiresAt: row.expires_at,
      maximumLiabilityMicrousd: 100, localRunId: "run_old", localRunState: "failed" as const,
      localRunEndedAt: new Date(Date.parse(row.started_at!) + 10_000).toISOString(),
      evidenceRef: "support:observed-terminal-run", reviewer: "operator:qa", acceptUnknownUpstreamLiability: true as const };
    const recovered = await Promise.all([first.releaseExecutionAdmission(identities[0], recovery),
      second.releaseExecutionAdmission(identities[0], recovery)]);
    expect(recovered[0]).toEqual(recovered[1]);
    expect(await first.getFundingSummary(identities[0])).toMatchObject({ reservedMicrousd: 100, settledThisMonthMicrousd: 0 });
    const fresh = await Promise.all(identities.map((identity) => first.issueRuntimeCredential(identity)));
    const attempts = await Promise.allSettled([
      first.authorize({ credential: fresh[0].credential.token, requestId: "recovered_first", modelId, maxCostMicrousd: 100, billingMode: "usage" }),
      second.authorize({ credential: fresh[1].credential.token, requestId: "recovered_second", modelId, maxCostMicrousd: 100, billingMode: "usage" }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "rate_limited" } });
    const live = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("execution_admission_release", "is", null).where("status", "in", ["reserved", "starting", "in_flight", "settling"]).execute();
    expect(live).toHaveLength(1);
    // Prove the durable constraints independently of application advisory locks.
    await expect(secondDb.executor.insertInto("ai_funded_usage_reservations").values({
      ...live[0], reservation_id: "forbidden_second_execution", request_id: "forbidden_second_execution",
    }).execute()).rejects.toMatchObject({ code: "23505", constraint: "idx_ai_funded_usage_active_owner" });
    const audited = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
    await expect(secondDb.executor.insertInto("ai_funded_usage_reservations").values({
      ...audited, reservation_id: "forbidden_second_unknown", request_id: "forbidden_second_unknown",
    }).execute()).rejects.toMatchObject({ code: "23505", constraint: "idx_ai_funded_unknown_admission_owner" });
    await first.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 40 });
    await expect(second.authorize({ credential: fresh[0].credential.token, requestId: "still_live", modelId,
      maxCostMicrousd: 100, billingMode: "usage" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").select(["status", "actual_microusd"])
      .where("reservation_id", "=", live[0].reservation_id).executeTakeFirstOrThrow())
      .toEqual({ status: "reserved", actual_microusd: null });
    const indexes = await admin.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='ai_funded_usage_reservations'", [schema]);
    expect(indexes.rows.map((value: { indexname: string }) => value.indexname)).toContain("idx_ai_funded_usage_active_owner");
    expect(indexes.rows.map((value: { indexname: string }) => value.indexname)).toContain("idx_ai_funded_unknown_admission_owner");
  });

  it("replays matching no-dispatch zero settlement across independent pools without releasing twice", async () => {
    await first.updateGlobalPolicy({ expectedRevision: 1, enabled: true, allowedModelIds: [modelId, JEV_MODEL_ID] });
    await first.setRuntimePolicy({ identity: identities[0], expectedRevision: 1, enabled: true,
      allowedModelIds: [modelId, JEV_MODEL_ID], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    const authorization = await first.authorize({ credential: credentials[0], requestId: "jev_known_no_dispatch",
      modelId: JEV_MODEL_ID, maxCostMicrousd: 100, billingMode: "usage", jevPricingVersion: "typesafe-jev-input-2026-09" });
    const key = { reservationId: authorization.reservation.reservationId, tokenId: tokenIds[0] };
    await first.startReservation(key);
    const attestation = { ...key, mode: "not_dispatched" as const, expectedRequestId: "jev_known_no_dispatch",
      jevPricingVersion: "typesafe-jev-input-2026-09" };
    const results = await Promise.all([first.finalizeReservation(attestation), second.finalizeReservation(attestation)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: "settled", actualCostMicrousd: 0, releasedMicrousd: 100 });
    expect(await first.getFundingSummary(identities[0])).toMatchObject({ reservedMicrousd: 0,
      remainingBalanceMicrousd: 1_000, settledThisMonthMicrousd: 0 });
    await expect(second.finalizeReservation({ ...attestation, expectedRequestId: "different_request" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(second.authorize({ credential: credentials[1], requestId: "after_zero_settlement",
      modelId, maxCostMicrousd: 100, billingMode: "usage" })).resolves.toMatchObject({ authorized: true });
  });

  it("serializes campaign handoff with authorization without deadlock or duplicate credit", async () => {
    const campaign = { entryId: "promotion:postgres-race", kind: "promotional_grant" as const,
      amountMicrousd: 100, sourceReference: "postgres-race", expiresAt: "2026-10-01T00:00:00.000Z" };
    await first.grantCredit({ ...campaign, identity: identities[0] });

    const results = await Promise.allSettled([
      first.authorize({ credential: credentials[0], requestId: "handoff-race", modelId, maxCostMicrousd: 100 }),
      second.grantCredit({ ...campaign, identity: identities[1] }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "rate_limited" });
      }
    }
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .select("entry_id").where("entry_id", "=", campaign.entryId).execute()).toHaveLength(1);
    const balances = await db.executor.selectFrom("ai_funded_runtime_balances")
      .select("credit_balance_microusd").where("owner_id", "=", "shared_owner").execute();
    expect(balances.reduce((sum, row) => sum + Number(row.credit_balance_microusd), 0)).toBe(2_100);
  });

  it("rechecks campaign eligibility after a concurrent policy disable commits", async () => {
    let releaseUpdate!: () => void;
    let policyLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const locked = new Promise<void>((resolve) => { policyLocked = resolve; });
    const disabling = secondDb.transaction(async (trx) => {
      await trx.executor.updateTable("ai_funded_runtime_policies").set({ enabled: false })
        .where("machine_id", "=", identities[0].machineId).execute();
      policyLocked();
      await release;
    });
    await locked;
    const grantResult = first.grantCredit({
      entryId: "promotion:policy-race", identity: identities[0], kind: "promotional_grant",
      amountMicrousd: 100, sourceReference: "policy-race", expiresAt: "2026-10-01T00:00:00.000Z",
    }).then(() => ({ code: "fulfilled" }), (error: unknown) => error);
    releaseUpdate();
    await disabling;
    await expect(grantResult).resolves.toMatchObject({ code: "access_disabled" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger")
      .select("entry_id").where("entry_id", "=", "promotion:policy-race").execute()).toEqual([]);
  });
});
