import { createHash, randomUUID } from "node:crypto";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createExpiredUsageWaiver } from "../../packages/platform/src/ai-funded-usage-waiver.js";
import { readUnknownUsageWaivers } from "../../packages/platform/src/ai-funded-usage-waiver-admission.js";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const identity = { ownerId: "race_owner", machineId: "22345678-1234-4234-8234-123456789abc", runtimeSlot: "primary" as const };
const modelId = "anthropic/claude-sonnet-5";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!databaseUrl)("waiver policy serialization and bounded inventory (PostgreSQL)", () => {
  let admin: pg.Pool;
  let schema: string;
  let db: PlatformDB;
  let other: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let input: Parameters<ReturnType<typeof createExpiredUsageWaiver>>[0];
  let pauseActor: "policy" | "waiver" | undefined;
  let machineLocked: ReturnType<typeof gate>;
  let resume: ReturnType<typeof gate>;
  let inventoryQuery: { text: string; values: unknown[] } | undefined;
  let policyPid: number;
  let waiverPid: number;

  function hookedPool(connectionString: string, actor: "policy" | "waiver") {
    const pool = new pg.Pool({ connectionString, max: 1 });
    pool.on("connect", (client) => {
      const original = client.query.bind(client);
      // Pause only after the application's actual row-lock statement succeeds.
      // PostgreSQL still executes every query and detects any real lock cycle.
      client.query = (async (query: string | pg.QueryConfig, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : query.text;
        const parameters = typeof query === "string" ? values : query.values ?? [];
        const result = await original(text, parameters);
        if (text.startsWith('select * from "ai_funded_usage_reservations"') && text.includes('"charge_waiver" is not null')) {
          inventoryQuery = { text, values: [...parameters] };
        }
        if (pauseActor === actor && text.includes('from "user_machines"') && text.endsWith("for update")) {
          pauseActor = undefined;
          machineLocked.resolve();
          await resume.promise;
        }
        return result;
      }) as typeof client.query;
    });
    return pool;
  }

  beforeEach(async () => {
    vi.stubEnv("ACCOUNT_DELETION_SECRET", undefined);
    vi.stubEnv("ACCOUNT_DELETION_ENABLED", undefined);
    schema = `waiver_locks_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const waiverPool = hookedPool(url.toString(), "waiver");
    const policyPool = hookedPool(url.toString(), "policy");
    db = createPlatformDb({ dialect: new PostgresDialect({ pool: waiverPool }) });
    await db.ready;
    other = createPlatformDb({ dialect: new PostgresDialect({ pool: policyPool }) });
    await other.ready;
    waiverPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.executor)).rows[0].pid;
    policyPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(other.executor)).rows[0].pid;
    clock = new Date("2026-09-12T12:00:00.000Z");
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => new Date(clock),
      credentialTtlMs: 3_600_000, reservationTtlMs: 300_000, inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: "race-machine", runtimeSlot: "primary", status: "running", imageVersion: "test",
      provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    await repo.grantCredit({ entryId: "race-grant", identity, kind: "promotional_grant",
      amountMicrousd: 1_000, sourceReference: "fixture", expiresAt: "2026-09-13T00:00:00.000Z" });
    const credential = (await repo.issueRuntimeCredential(identity)).credential;
    const auth = await repo.authorize({ credential: credential.token, requestId: "old-request", modelId,
      maxCostMicrousd: 2_000, billingMode: "usage" });
    await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().executeTakeFirstOrThrow();
    input = { identity, expectedRuntimeTokenEpoch: 1, accountDeletionMode: "disabled", reviewer: "operator:test",
      evidenceRef: "support:race", reason: "expired_unknown_usage", acceptPlatformLiability: true,
      expectedReleasedMicrousd: 1_000, expectedMaximumLiabilityMicrousd: 2_000,
      reservations: [{ reservationId: row.reservation_id, tokenId: row.token_id, requestId: row.request_id,
        startedAt: row.started_at!, expiresAt: row.expires_at, reservedMicrousd: 1_000,
        promotionalReservedMicrousd: 1_000, addonReservedMicrousd: 0, maximumLiabilityMicrousd: 2_000,
        authorizationSha256: hash(row.authorization_response), fundingAllocationSha256: hash(JSON.stringify([
          { grantEntryId: "race-grant", amountMicrousd: 1_000 }])), executionAdmissionReleaseSha256: null }] };
    clock = new Date(clock.getTime() + 20 * 60_000);
    machineLocked = gate(); resume = gate(); pauseActor = undefined; inventoryQuery = undefined;
  });

  afterEach(async () => {
    resume?.resolve();
    await other?.destroy(); await db?.destroy();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  async function observeBlock(waiter: number, blocker: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ blockers: number[] }>("select pg_blocking_pids($1) as blockers", [waiter]);
      if (result.rows[0].blockers.includes(blocker)) return;
    }
    throw new Error("Expected PostgreSQL row-lock wait was not observed");
  }

  for (const first of ["policy", "waiver"] as const) it(`serializes actual policy update when ${first} locks the machine first`, async () => {
    pauseActor = first;
    const update = () => createAiFundedPolicyRepository({ db: other, credentialHashSecret: "h".repeat(32), now: () => new Date(clock) })
      .setRuntimePolicy({ identity, expectedRevision: 1, enabled: false, allowedModelIds: [modelId],
        monthlyBudgetMicrousd: 2_000, expiresAt: null });
    const waive = () => createExpiredUsageWaiver({ db, now: () => new Date(clock) })(input, { apply: true });
    const firstCall = first === "policy" ? update() : waive();
    // Attach a rejection handler before opening the other transaction.
    const firstResult = Promise.allSettled([firstCall]);
    await machineLocked.promise;
    const secondCall = first === "policy" ? waive() : update();
    const secondResult = Promise.allSettled([secondCall]);
    try {
      await observeBlock(first === "policy" ? waiverPid : policyPid, first === "policy" ? policyPid : waiverPid);
    } finally { resume.resolve(); }
    const results = [...await firstResult, ...await secondResult];
    expect(results).toEqual([expect.objectContaining({ status: "fulfilled" }), expect.objectContaining({ status: "fulfilled" })]);
    expect(await db.executor.selectFrom("ai_funded_runtime_policies").select(["revision", "enabled", "monthly_budget_microusd"])
      .executeTakeFirstOrThrow()).toMatchObject({ revision: 2, enabled: false, monthly_budget_microusd: "2000" });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").select(["status", "actual_microusd"]).executeTakeFirstOrThrow())
      .toEqual({ status: "waived", actual_microusd: null });
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").select("reserved_microusd").executeTakeFirstOrThrow())
      .toEqual({ reserved_microusd: "0" });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").select("entry_id").execute()).toEqual([{ entry_id: "race-grant" }]);
  }, 30_000);

  it("indexes the full fail-closed unknown waiver predicate by owner", async () => {
    const index = (await admin.query<{ definition: string; predicate: string }>(`
      select pg_get_indexdef(i.indexrelid) as definition, pg_get_expr(i.indpred, i.indrelid) as predicate
      from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = 'idx_ai_funded_unknown_waiver_owner'`, [schema])).rows[0];
    expect(index).toEqual({
      definition: `CREATE INDEX idx_ai_funded_unknown_waiver_owner ON ${schema}.ai_funded_usage_reservations USING btree (owner_id) WHERE ((status = 'waived'::text) OR ((charge_waiver IS NOT NULL) AND (actual_microusd IS NULL)))`,
      predicate: "((status = 'waived'::text) OR ((charge_waiver IS NOT NULL) AND (actual_microusd IS NULL)))",
    });
    // Simulate a corrupt legacy status only inside this disposable database.
    await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT ai_funded_charge_waiver_state_check`.execute(db.executor);
    await db.executor.updateTable("ai_funded_usage_reservations").set({ status: "waived" }).execute();
    await expect(readUnknownUsageWaivers(db.executor, identity.ownerId)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("uses the inventory index for the actual lookup amid substantial settled history", async () => {
    await createExpiredUsageWaiver({ db, now: () => new Date(clock) })(input, { apply: true });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().executeTakeFirstOrThrow();
    const columns = Object.keys(row);
    const names = columns.map((name) => `"${name}"`).join(", ");
    const expressions = columns.map((name) => {
      if (name === "reservation_id" || name === "request_id") return `'history-' || history.n::text`;
      if (name === "status") return "'settled'";
      if (name === "actual_microusd") return "0";
      if (name === "charge_waiver") return "NULL";
      return `original."${name}"`;
    }).join(", ");
    // Identifiers come only from the typed database row; history has no unknown expense.
    await sql`INSERT INTO ai_funded_usage_reservations (${sql.raw(names)}) SELECT ${sql.raw(expressions)}
      FROM ai_funded_usage_reservations original CROSS JOIN generate_series(1, 10000) history(n)
      WHERE original.reservation_id = ${row.reservation_id}`.execute(db.executor);
    await sql`ANALYZE ai_funded_usage_reservations`.execute(db.executor);
    expect(await readUnknownUsageWaivers(db.executor, identity.ownerId)).toMatchObject({ liabilityMicrousd: 2_000, rows: [expect.objectContaining({ status: "waived" })] });
    expect(inventoryQuery).toBeDefined();
    await admin.query(`SET search_path = "${schema}"`);
    const result = await admin.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + inventoryQuery!.text, inventoryQuery!.values);
    const plan = result.rows[0]["QUERY PLAN"][0].Plan as { "Actual Rows": number; "Index Name"?: string; Plans?: unknown[] };
    expect(plan["Actual Rows"]).toBe(1);
    expect(JSON.stringify(plan)).toContain('"Index Name":"idx_ai_funded_unknown_waiver_owner"');
  });
});
