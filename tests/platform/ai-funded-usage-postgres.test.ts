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
