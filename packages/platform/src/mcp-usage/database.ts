/**
 * Matrix Core MCP usage records (spec 2691, "Usage records").
 *
 * Content-free by construction: the schema has no column that could hold
 * arguments, results, or upstream error text. Raw rows live 30 days; daily
 * aggregates live 13 months. Bootstrapped at composition time under its own
 * migration scope, like organizations, so the core schema baseline is unchanged.
 */
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { runPlatformMigration } from "../migration-runner.js";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Generated<T> = ColumnType<T, T | undefined, T>;

export const MCP_USAGE_ENTRY_POINTS = ["stdio", "managed_pi", "external_mcp", "unknown"] as const;
export const MCP_USAGE_OUTCOMES = ["ok", "error", "denied", "approval_required", "timeout", "cancelled"] as const;
export const MCP_USAGE_RAW_RETENTION_DAYS = 30;
export const MCP_USAGE_AGGREGATE_RETENTION_MONTHS = 13;
const RETENTION_BATCH = 5_000;
const RETENTION_MAX_BATCHES = 20;
const DAY_MS = 24 * 60 * 60_000;

export interface McpUsageEventsTable {
  id: Generated<string>;
  occurred_at: Timestamp;
  org_id: string;
  actor_id: string;
  connection_id: string;
  server_key: string;
  tool_name: string;
  entry_point: string;
  harness: string;
  outcome: string;
  latency_ms: number;
}

export interface McpUsageDailyTable {
  day: ColumnType<string, string, string>;
  org_id: string;
  actor_id: string;
  connection_id: string;
  server_key: string;
  tool_name: string;
  entry_point: string;
  harness: string;
  outcome: string;
  call_count: number;
  total_latency_ms: ColumnType<string, string | number, string | number>;
  max_latency_ms: number;
  updated_at: Timestamp;
}

export interface McpUsageDatabase {
  mcp_usage_events: McpUsageEventsTable;
  mcp_usage_daily: McpUsageDailyTable;
}

/** Bump whenever this DDL changes, so completed startups skip the ALTERs. */
export const MCP_USAGE_SCHEMA_REVISION = { generation: 1, fingerprint: "mcp-usage-events-daily-v1" } as const;

const quoted = (values: readonly string[]) => sql.raw(values.map(value => `'${value}'`).join(","));

async function createMcpUsageTables(db: Transaction<McpUsageDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_usage_events (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL,
      org_id TEXT NOT NULL DEFAULT '' CHECK (char_length(org_id) <= 128),
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 256),
      connection_id TEXT NOT NULL CHECK (char_length(connection_id) BETWEEN 1 AND 64),
      server_key TEXT NOT NULL CHECK (char_length(server_key) BETWEEN 1 AND 128),
      tool_name TEXT NOT NULL CHECK (char_length(tool_name) BETWEEN 1 AND 128),
      entry_point TEXT NOT NULL CHECK (entry_point IN (${quoted(MCP_USAGE_ENTRY_POINTS)})),
      harness TEXT NOT NULL DEFAULT '' CHECK (char_length(harness) <= 32),
      outcome TEXT NOT NULL CHECK (outcome IN (${quoted(MCP_USAGE_OUTCOMES)})),
      latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS mcp_usage_events_occurred ON mcp_usage_events(occurred_at)`.execute(db);
  // NOT NULL '' sentinels (not NULL) keep the conflict key total for ON CONFLICT.
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_usage_daily (
      day DATE NOT NULL,
      org_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      server_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      entry_point TEXT NOT NULL,
      harness TEXT NOT NULL,
      outcome TEXT NOT NULL,
      call_count INTEGER NOT NULL CHECK (call_count >= 0),
      total_latency_ms BIGINT NOT NULL CHECK (total_latency_ms >= 0),
      max_latency_ms INTEGER NOT NULL CHECK (max_latency_ms >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (day, org_id, actor_id, connection_id, server_key, tool_name, entry_point, harness, outcome)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS mcp_usage_daily_org_day ON mcp_usage_daily(org_id, day)`.execute(db);
}

export async function bootstrapMcpUsageDatabase(db: Kysely<McpUsageDatabase>): Promise<void> {
  await runPlatformMigration(db, createMcpUsageTables, { scope: "mcp-usage", revision: MCP_USAGE_SCHEMA_REVISION });
}

export interface McpUsageEventRow {
  occurredAt: Date;
  orgId: string | null;
  actorId: string;
  connectionId: string;
  serverKey: string;
  toolName: string;
  entryPoint: string;
  harness: string | null;
  outcome: string;
  latencyMs: number;
}

function utcMidnight(time: number): Date {
  const day = new Date(time);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
}

export function createMcpUsageRepository(db: Kysely<McpUsageDatabase>, now: () => Date = () => new Date()) {
  return {
    async insertEvents(rows: readonly McpUsageEventRow[]): Promise<void> {
      if (rows.length === 0) return;
      await db.insertInto("mcp_usage_events").values(rows.map(row => ({
        occurred_at: row.occurredAt,
        org_id: row.orgId ?? "",
        actor_id: row.actorId,
        connection_id: row.connectionId,
        server_key: row.serverKey,
        tool_name: row.toolName,
        entry_point: row.entryPoint,
        harness: row.harness ?? "",
        outcome: row.outcome,
        latency_ms: row.latencyMs,
      }))).execute();
    },

    /**
     * Recompute whole UTC days (yesterday and today) from raw rows and SET the
     * totals, so a rerun or an overlapping run converges instead of double counting.
     */
    async rollupDaily(): Promise<number> {
      const today = utcMidnight(now().getTime());
      const from = new Date(today.getTime() - DAY_MS);
      const to = new Date(today.getTime() + DAY_MS);
      const result = await sql`
        INSERT INTO mcp_usage_daily (day, org_id, actor_id, connection_id, server_key, tool_name, entry_point, harness, outcome,
          call_count, total_latency_ms, max_latency_ms, updated_at)
        SELECT (occurred_at AT TIME ZONE 'UTC')::date, org_id, actor_id, connection_id, server_key, tool_name, entry_point, harness, outcome,
          count(*)::int, COALESCE(sum(latency_ms), 0)::bigint, COALESCE(max(latency_ms), 0)::int, now()
        FROM mcp_usage_events
        WHERE occurred_at >= ${from} AND occurred_at < ${to}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
        ON CONFLICT (day, org_id, actor_id, connection_id, server_key, tool_name, entry_point, harness, outcome) DO UPDATE SET
          call_count = EXCLUDED.call_count,
          total_latency_ms = EXCLUDED.total_latency_ms,
          max_latency_ms = EXCLUDED.max_latency_ms,
          updated_at = EXCLUDED.updated_at
        RETURNING 1
      `.execute(db);
      return result.rows.length;
    },

    /** Bounded batches; anything left is picked up by the next hourly sweep. */
    async sweepRetention(): Promise<{ events: number; daily: number }> {
      const current = now();
      const rawCutoff = new Date(current.getTime() - MCP_USAGE_RAW_RETENTION_DAYS * DAY_MS);
      const aggregateCutoff = utcMidnight(current.getTime());
      aggregateCutoff.setUTCMonth(aggregateCutoff.getUTCMonth() - MCP_USAGE_AGGREGATE_RETENTION_MONTHS);
      const aggregateDay = aggregateCutoff.toISOString().slice(0, 10);
      let events = 0;
      let daily = 0;
      for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
        const deleted = await sql`
          DELETE FROM mcp_usage_events WHERE id IN (
            SELECT id FROM mcp_usage_events WHERE occurred_at < ${rawCutoff} ORDER BY occurred_at LIMIT ${RETENTION_BATCH})
          RETURNING 1
        `.execute(db);
        const count = deleted.rows.length;
        events += count;
        if (count < RETENTION_BATCH) break;
      }
      for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
        const deleted = await sql`
          DELETE FROM mcp_usage_daily WHERE ctid IN (
            SELECT ctid FROM mcp_usage_daily WHERE day < ${aggregateDay}::date LIMIT ${RETENTION_BATCH})
          RETURNING 1
        `.execute(db);
        const count = deleted.rows.length;
        daily += count;
        if (count < RETENTION_BATCH) break;
      }
      return { events, daily };
    },
  };
}

export type McpUsageRepository = ReturnType<typeof createMcpUsageRepository>;
