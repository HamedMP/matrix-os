import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapMcpUsageDatabase,
  createMcpUsageRepository,
  type McpUsageDatabase,
  type McpUsageEventRow,
} from "../../packages/platform/src/mcp-usage/database.js";
import { createMcpUsageWriter, startMcpUsageMaintenance } from "../../packages/platform/src/mcp-usage/writer.js";

const NOW = new Date("2026-11-12T15:00:00.000Z");

function row(overrides: Partial<McpUsageEventRow> = {}): McpUsageEventRow {
  return { occurredAt: NOW, orgId: null, actorId: "user_a", connectionId: "11111111-1111-4111-8111-111111111111",
    serverKey: "mcp.linear.test", toolName: "list_issues", entryPoint: "stdio", harness: "claude_code",
    outcome: "ok", latencyMs: 40, ...overrides };
}

describe("Matrix Core MCP usage records", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<McpUsageDatabase>;
  let clock: Date;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = new Kysely<McpUsageDatabase>({ dialect: pglite.dialect });
    await bootstrapMcpUsageDatabase(db);
    await bootstrapMcpUsageDatabase(db);
    clock = NOW;
  });
  afterEach(async () => { await db.destroy(); });

  const repository = () => createMcpUsageRepository(db, () => clock);
  const events = () => db.selectFrom("mcp_usage_events").selectAll().orderBy("id").execute();
  const daily = () => db.selectFrom("mcp_usage_daily").selectAll().orderBy("day").orderBy("tool_name").orderBy("outcome").execute();

  it("stores no column that could hold call arguments, results, or upstream errors", async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('mcp_usage_events', 'mcp_usage_daily') ORDER BY table_name, ordinal_position`.execute(db);
    expect(columns.rows.filter(column => column.table_name === "mcp_usage_events").map(column => column.column_name)).toEqual([
      "id", "occurred_at", "org_id", "actor_id", "connection_id", "server_key", "tool_name", "entry_point", "harness", "outcome", "latency_ms",
    ]);
    await expect(repository().insertEvents([row({ outcome: "leaked secret" })])).rejects.toThrow();
  });

  it("flushes queued rows in batches, drops and counts overflow, and never fails the caller", async () => {
    const insert = vi.fn((rows: readonly McpUsageEventRow[]) => repository().insertEvents(rows));
    const writer = createMcpUsageWriter({ insert, capacity: 5, batchSize: 2 });
    for (let index = 0; index < 7; index++) writer.record(row({ latencyMs: index }));
    writer.record(row({ entryPoint: "not-an-entry-point" }));
    expect(writer.stats()).toEqual({ queued: 5, written: 0, dropped: 3, failed: 0 });
    await writer.flush();
    expect(insert).toHaveBeenCalledTimes(3);
    expect((await events()).map(event => event.latency_ms)).toEqual([0, 1, 2, 3, 4]);
    expect(writer.stats()).toEqual({ queued: 0, written: 5, dropped: 3, failed: 0 });

    const failing = createMcpUsageWriter({ insert: async () => { throw new Error("connection refused"); } });
    expect(() => failing.record(row())).not.toThrow();
    await expect(failing.flush()).resolves.toBeUndefined();
    expect(failing.stats()).toMatchObject({ queued: 0, failed: 1 });
  });

  it("drains queued rows on shutdown and refuses rows after it", async () => {
    const writer = createMcpUsageWriter({ insert: rows => repository().insertEvents(rows), flushIntervalMs: 60_000 });
    writer.start();
    writer.record(row());
    writer.record(row({ toolName: "create_issue" }));
    await writer.drain();
    expect((await events()).map(event => event.tool_name)).toEqual(["list_issues", "create_issue"]);
    writer.record(row());
    expect(writer.stats()).toMatchObject({ queued: 0, written: 2, dropped: 1 });
  });

  it("rolls raw rows into idempotent UTC daily aggregates", async () => {
    const yesterday = new Date("2026-11-11T23:30:00.000Z");
    await repository().insertEvents([
      row({ latencyMs: 10 }), row({ latencyMs: 30 }), row({ outcome: "error", latencyMs: 5 }),
      row({ occurredAt: yesterday, latencyMs: 7 }),
      row({ occurredAt: new Date("2026-11-01T10:00:00.000Z") }),
    ]);
    await repository().rollupDaily();
    await repository().rollupDaily();
    const first = (await daily()).map(entry => [String(entry.day), entry.tool_name, entry.outcome, entry.call_count, Number(entry.total_latency_ms), entry.max_latency_ms]);
    expect(first.map(([day, ...rest]) => [new Date(day as string).toISOString().slice(0, 10), ...rest])).toEqual([
      ["2026-11-11", "list_issues", "ok", 1, 7, 7],
      ["2026-11-12", "list_issues", "error", 1, 5, 5],
      ["2026-11-12", "list_issues", "ok", 2, 40, 30],
    ]);
    await repository().insertEvents([row({ latencyMs: 60 })]);
    await repository().rollupDaily();
    const ok = (await daily()).find(entry => entry.outcome === "ok" && new Date(String(entry.day)).toISOString().startsWith("2026-11-12"));
    expect([ok?.call_count, Number(ok?.total_latency_ms), ok?.max_latency_ms]).toEqual([3, 100, 60]);
  });

  it("keeps raw rows 30 days and aggregates 13 months", async () => {
    await repository().insertEvents([row({ occurredAt: new Date("2026-10-12T14:00:00.000Z") }), row({ occurredAt: new Date("2026-10-14T00:00:00.000Z") })]);
    await db.insertInto("mcp_usage_daily").values([
      { day: "2025-10-11", org_id: "", actor_id: "a", connection_id: "c", server_key: "s", tool_name: "old", entry_point: "stdio",
        harness: "", outcome: "ok", call_count: 1, total_latency_ms: 1, max_latency_ms: 1, updated_at: NOW },
      { day: "2025-10-12", org_id: "", actor_id: "a", connection_id: "c", server_key: "s", tool_name: "kept", entry_point: "stdio",
        harness: "", outcome: "ok", call_count: 1, total_latency_ms: 1, max_latency_ms: 1, updated_at: NOW },
    ]).execute();
    await expect(repository().sweepRetention()).resolves.toEqual({ events: 1, daily: 1 });
    expect((await events()).map(event => event.occurred_at.toISOString())).toEqual(["2026-10-14T00:00:00.000Z"]);
    expect((await daily()).map(entry => entry.tool_name)).toEqual(["kept"]);
  });

  it("runs rollup then retention from the hourly maintenance loop and awaits it on stop", async () => {
    await repository().insertEvents([row()]);
    const maintenance = startMcpUsageMaintenance({ repository: repository(), intervalMs: 60 * 60_000 });
    await maintenance.run();
    await maintenance.stop();
    expect((await daily()).map(entry => entry.call_count)).toEqual([1]);
  });
});
