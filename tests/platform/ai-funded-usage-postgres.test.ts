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
  let credentials: string[];

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
    const options = { credentialHashSecret: "h".repeat(32), now: () => new Date("2026-09-10T12:00:00Z") };
    first = createAiFundedPolicyRepository({ ...options, db });
    second = createAiFundedPolicyRepository({ ...options, db: secondDb });
    await first.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    credentials = [];
    for (let index = 0; index < 2; index++) {
      const identity = { ownerId: "shared_owner", machineId: `machine_${index}`, runtimeSlot: `runtime_${index}` };
      await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
        handle: identity.machineId, runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test",
        provisionedAt: options.now().toISOString(), activationState: "authorized" });
      await first.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId],
        monthlyBudgetMicrousd: 1_000, expiresAt: null });
      await first.grantCredit({ entryId: `grant_${index}`, identity, kind: "promotional_grant",
        amountMicrousd: 1_000, sourceReference: "test" });
      credentials.push((await first.issueRuntimeCredential(identity)).credential.token);
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
});
