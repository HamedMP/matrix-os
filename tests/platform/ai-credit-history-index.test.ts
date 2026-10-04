import { CompiledQuery, sql, type KyselyPlugin } from "kysely";
import { Hono } from "hono";
import { AiCreditHistoryResponseSchema } from "@matrix-os/contracts";
import { createAiCreditHistoryHandler } from "../../packages/platform/src/billing/ai-credit-history-route.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

describe("credit history indexed pagination", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: "history-index-machine", clerkUserId: "history-owner", runtimeSlot: "primary", handle: "history-index-machine", status: "running", imageVersion: "v1", activationState: "authorized", provisionedAt: "2026-10-01T00:00:00.000Z" });
    await sql`INSERT INTO ai_funded_credit_ledger (entry_id, owner_id, machine_id, runtime_slot, kind, amount_microusd, source_reference, created_at)
      SELECT 'history-entry-' || n, 'history-owner', 'history-index-machine', 'primary', 'addon_grant', 1, 'fixture',
        '2026-10-01T00:00:00.000Z' FROM generate_series(1, 10000) AS n`.execute(db.executor);
    await sql`ANALYZE ai_funded_credit_ledger`.execute(db.executor);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("uses the scoped expression index for the opaque anchor instead of hashing the owner ledger", async () => {
    const marker = (await sql<{ cursor: string }>`SELECT md5('history-entry-9000:history-owner:history-index-machine:primary') AS cursor`.execute(db.executor)).rows[0]!.cursor;
    const plan = await sql<{ "QUERY PLAN": string }>`EXPLAIN SELECT entry_id, created_at FROM ai_funded_credit_ledger AS l
      WHERE owner_id = 'history-owner' AND machine_id = 'history-index-machine' AND runtime_slot = 'primary'
        AND md5(l.entry_id || ':' || l.owner_id || ':' || l.machine_id || ':' || l.runtime_slot) = ${marker}`.execute(db.executor);
    const text = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("idx_ai_funded_ledger_history_cursor");
    expect(text).toMatch(/Index Cond:.*md5/);
    expect(text).not.toContain("Seq Scan");
  });

  it("bounds real joined endpoint pages, including subsequent and deep keyset cursors", async () => {
    await db.executor.insertInto("ai_runtime_credentials").values({
      token_id: "history-token", owner_id: "history-owner", machine_id: "history-index-machine", runtime_slot: "primary",
      token_hash: "a".repeat(64), audience: "matrix-funded-relay", scope: "ai:invoke",
      issued_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-10-02T00:00:00.000Z", revoked_at: null,
    }).execute();
    await sql`INSERT INTO ai_funded_usage_reservations (reservation_id, request_id, payload_hash, authorization_response,
      token_id, owner_id, machine_id, runtime_slot, model_id, reserved_microusd, period_start, status, created_at, expires_at)
      SELECT 'history-reservation-' || n, 'history-request-' || n, repeat('a', 64), '{}', 'history-token',
        'history-owner', 'history-index-machine', 'primary',
        CASE WHEN n % 2 = 0 THEN '@cf/zai-org/glm-5.3-flash' ELSE 'anthropic/claude-sonnet-5' END,
        1, '2026-10-01T00:00:00.000Z', CASE WHEN n % 3 = 0 THEN 'in_flight' ELSE 'settled' END,
        '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'
      FROM generate_series(1, 10000) AS n`.execute(db.executor);
    // Ten equal-timestamp entries per bucket exercise the secondary key; grants,
    // pending and settled reservations exercise all real LEFT JOIN outcomes.
    await sql`UPDATE ai_funded_credit_ledger SET
      reservation_id = CASE WHEN substring(entry_id from 15)::int % 4 = 0 THEN NULL
        ELSE 'history-reservation-' || substring(entry_id from 15) END,
      kind = CASE WHEN substring(entry_id from 15)::int % 4 = 0 THEN 'addon_grant' ELSE 'addon_debit' END,
      period_start = CASE WHEN substring(entry_id from 15)::int % 4 = 0 THEN NULL ELSE '2026-10-01T00:00:00.000Z' END,
      amount_microusd = substring(entry_id from 15)::int * CASE WHEN substring(entry_id from 15)::int % 4 = 0 THEN 1 ELSE -1 END,
      created_at = to_char('2026-10-01'::timestamp + (substring(entry_id from 15)::int / 10) * interval '1 second',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.execute(db.executor);
    await sql`ANALYZE ai_funded_credit_ledger`.execute(db.executor);
    await sql`ANALYZE ai_funded_usage_reservations`.execute(db.executor);
    const queries: CompiledQuery[] = [];
    const observer: KyselyPlugin = {
      transformQuery(args) {
        const query = db.executor.getExecutor().compileQuery(args.node, args.queryId);
        if (query.sql.includes('left join "ai_funded_usage_reservations"')) queries.push(query);
        return args.node;
      },
      async transformResult(args) { return args.result; },
    };
    const app = new Hono();
    app.get("/history", createAiCreditHistoryHandler({
      db: { ...db, executor: db.executor.withPlugin(observer) }, resolveClerkUserId: async () => "history-owner",
    }));
    type Plan = { "Node Type": string; "Index Name"?: string; Alias?: string; "Actual Rows": number;
      "Rows Removed by Filter"?: number; Plans?: Plan[] };
    const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const request = async (cursor?: string) => {
      const response = await app.request(`/history?limit=20${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const page = AiCreditHistoryResponseSchema.parse(await response.json());
      expect(page.entries).toHaveLength(20);
      expect(page.nextCursor).toMatch(/^[a-f0-9]{32}$/);
      const actual = queries.at(-1)!;
      expect(actual.sql).toContain('"r"."status" =');
      if (cursor) expect(actual.sql).toContain("(l.created_at, l.entry_id) <");
      const explained = await db.executor.executeQuery<{ "QUERY PLAN": { Plan: Plan }[] }>(
        CompiledQuery.raw("EXPLAIN (ANALYZE, FORMAT JSON) " + actual.sql, [...actual.parameters]));
      const nodes = flatten(explained.rows[0]!["QUERY PLAN"][0]!.Plan);
      expect(nodes.some(node => /Sort/.test(node["Node Type"])), nodes.map(node => node["Node Type"]).join(" → ")).toBe(false);
      const ledger = nodes.find(node => node.Alias === "l")!;
      expect(ledger["Index Name"]).toMatch(/^idx_ai_funded_ledger_(history_page|runtime)$/);
      expect(ledger["Actual Rows"]).toBeLessThanOrEqual(21);
      expect(ledger["Rows Removed by Filter"] ?? 0).toBeLessThanOrEqual(21);
      return page;
    };
    const first = await request();
    const second = await request(first.nextCursor ?? undefined);
    expect(new Set([...first.entries, ...second.entries].map(entry => entry.amountMicrousd)).size).toBe(40);
    const deep = (await sql<{ cursor: string }>`SELECT md5('history-entry-1000:history-owner:history-index-machine:primary') AS cursor`.execute(db.executor)).rows[0]!.cursor;
    const deepPage = await request(deep);
    const signed = (n: number) => n % 4 === 0 ? n : -n;
    expect(first.entries.map(entry => entry.amountMicrousd)).toEqual(
      Array.from({ length: 20 }, (_, offset) => signed(10000 - offset)));
    expect(second.entries.map(entry => entry.amountMicrousd)).toEqual(
      Array.from({ length: 20 }, (_, offset) => signed(9980 - offset)));
    expect(deepPage.entries.map(entry => entry.amountMicrousd)).toEqual(
      Array.from({ length: 20 }, (_, offset) => signed(999 - offset)));
    expect(new Set(first.entries.map(entry => entry.modelId))).toEqual(
      new Set([null, "@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5"]));
    // A valid anchor cannot cross runtime slots or another authenticated owner.
    for (const [owner, machine, slot] of [["history-owner", "history-preview", "preview"], ["other-owner", "other-machine", "primary"]] as const) {
      await insertUserMachine(db, { machineId: machine, clerkUserId: owner, runtimeSlot: slot, handle: machine,
        status: "running", imageVersion: "v1", activationState: "authorized", provisionedAt: "2026-10-01T00:00:00.000Z" });
    }
    expect((await app.request(`/history?runtimeSlot=preview&cursor=${deep}`)).status).toBe(400);
    const outsider = new Hono();
    outsider.get("/history", createAiCreditHistoryHandler({ db, resolveClerkUserId: async () => "other-owner" }));
    expect((await outsider.request(`/history?cursor=${deep}`)).status).toBe(400);
  });

  it("upgrades the previous core generation idempotently while retaining ledger values", async () => {
    await sql`DROP INDEX idx_ai_funded_ledger_history_cursor`.execute(db.executor);
    await sql`DROP INDEX idx_ai_funded_ledger_history_page`.execute(db.executor);
    await sql`UPDATE platform_schema_revisions SET generation = 11, fingerprint = 'previous-core' WHERE scope = 'core'`.execute(db.executor);
    await runPlatformStartupMigrations(db.executor);
    await runPlatformStartupMigrations(db.executor);
    const indexes = await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename = 'ai_funded_credit_ledger' AND indexname IN ('idx_ai_funded_ledger_history_cursor', 'idx_ai_funded_ledger_history_page')`.execute(db.executor);
    expect(indexes.rows).toHaveLength(2);
    const retained = await sql<{ count: number; total: string }>`SELECT count(*)::int AS count, sum(amount_microusd)::text AS total FROM ai_funded_credit_ledger`.execute(db.executor);
    expect(retained.rows[0]).toEqual({ count: 10000, total: "10000" });
  });
});
