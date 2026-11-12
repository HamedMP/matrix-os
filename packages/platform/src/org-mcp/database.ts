/**
 * Organization governance of Matrix Core MCP servers (spec 2691, layer 5).
 *
 * Two tables, bootstrapped under their own migration scope after the
 * organization projection tables they reference:
 * - `org_mcp_server_definitions`: allow / block / recommend plus a default
 *   tool policy, keyed by catalog id or normalized hostname.
 * - `org_mcp_member_blocks`: one member's use of a server in org context.
 *
 * Neither table references a credential. Admin reads join member connection
 * metadata (`custom_mcp_servers`, never `encrypted_credentials`) and the
 * content-free usage tables.
 */
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import type { OrgMcpServerMode, OrgMcpToolPolicy } from "@matrix-os/contracts";
import { runPlatformMigration } from "../migration-runner.js";
import type { McpUsageDatabase } from "../mcp-usage/database.js";
import type { OrganizationPlatformDatabase } from "../organizations/database.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrgMcpServerDefinitionsTable {
  organization_id: string;
  server_def_id: string;
  mode: OrgMcpServerMode;
  default_tool_policy: OrgMcpToolPolicy;
  tool_overrides: ColumnType<Record<string, OrgMcpToolPolicy>, string, string>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface OrgMcpMemberBlocksTable {
  organization_id: string;
  actor_id: string;
  server_def_id: string;
  created_by: string;
  created_at: Timestamp;
}

/** The read-only slice of the gateway-owned connection tables this module may touch. */
interface ConnectionUsersTable { id: string; clerk_id: string }
interface ConnectionServersTable {
  id: string; user_id: string; name: string; url: string; status: string; enabled: boolean; created_at: Date;
}

export interface OrgMcpDatabase extends OrganizationPlatformDatabase, McpUsageDatabase {
  org_mcp_server_definitions: OrgMcpServerDefinitionsTable;
  org_mcp_member_blocks: OrgMcpMemberBlocksTable;
  users: ConnectionUsersTable;
  custom_mcp_servers: ConnectionServersTable;
}

export const ORG_MCP_SCHEMA_REVISION = { generation: 1, fingerprint: "org-mcp-definitions-blocks-v1" } as const;
/** Above this many memberships the policy cannot be read safely in one bounded query; callers deny. */
export const ORG_MCP_MAX_MEMBERSHIPS = 1_000;
const MAX_SERVER_DEFINITIONS = 500;
const MAX_CONNECTION_ROWS = 5_000;

async function createOrgMcpTables(db: Transaction<OrgMcpDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS org_mcp_server_definitions (
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
      server_def_id TEXT NOT NULL CHECK (char_length(server_def_id) BETWEEN 2 AND 253),
      mode TEXT NOT NULL CHECK (mode IN ('allow', 'block', 'recommend')),
      default_tool_policy TEXT NOT NULL CHECK (default_tool_policy IN ('allow', 'blocked')),
      tool_overrides JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tool_overrides) = 'object'),
      updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 128),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, server_def_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS org_mcp_member_blocks (
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      server_def_id TEXT NOT NULL CHECK (char_length(server_def_id) BETWEEN 2 AND 253),
      created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, actor_id, server_def_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS org_mcp_member_blocks_actor ON org_mcp_member_blocks(actor_id)`.execute(db);
}

export async function bootstrapOrgMcpDatabase(db: Kysely<OrgMcpDatabase>): Promise<void> {
  await runPlatformMigration(db, createOrgMcpTables, { scope: "org-mcp", revision: ORG_MCP_SCHEMA_REVISION });
}

export interface OrgMcpPolicyRow {
  organizationId: string;
  definitions: Array<{ serverDefId: string; mode: OrgMcpServerMode; defaultToolPolicy: OrgMcpToolPolicy; toolOverrides: Record<string, OrgMcpToolPolicy> }>;
  memberBlocked: boolean;
}

export interface OrgMcpPolicyRows { rows: OrgMcpPolicyRow[]; truncated: boolean }
export type OrgMcpPutResult = "saved" | "cap_reached" | "mode_required" | "organization_missing";

export interface OrgMcpConnectionRow {
  actorId: string; connectionId: string; name: string; url: string; status: string; enabled: boolean; connectedAt: Date;
}

export interface OrgMcpUsageAggregate {
  day: string; actorId: string; serverKey: string; toolName: string; calls: number; failures: number;
}

function definitionFromRow(row: { server_def_id: string; mode: OrgMcpServerMode; default_tool_policy: OrgMcpToolPolicy; tool_overrides: unknown; updated_at?: Date | string }) {
  const overrides = row.tool_overrides && typeof row.tool_overrides === "object" && !Array.isArray(row.tool_overrides)
    ? row.tool_overrides as Record<string, OrgMcpToolPolicy>
    : {};
  return { serverDefId: row.server_def_id, mode: row.mode, defaultToolPolicy: row.default_tool_policy, toolOverrides: overrides };
}

export function createOrgMcpRepository(db: Kysely<OrgMcpDatabase>) {
  return {
    /**
     * Every active organization the actor belongs to, with the definitions and
     * member blocks that match `serverDefIds`. One statement, so a policy write
     * committed before the call starts is always visible to it.
     */
    async policyRowsForActor(actorId: string, serverDefIds: readonly string[]): Promise<OrgMcpPolicyRows> {
      // An unmatched sentinel keeps the membership rows (usage attribution) when nothing is governable.
      const ids = sql.join((serverDefIds.length > 0 ? serverDefIds : [""]).map(id => sql`${id}`));
      const result = await sql<{ organization_id: string; definitions: unknown; member_blocked: boolean }>`
        SELECT m.organization_id,
          COALESCE((
            SELECT json_agg(json_build_object('server_def_id', d.server_def_id, 'mode', d.mode,
              'default_tool_policy', d.default_tool_policy, 'tool_overrides', d.tool_overrides))
            FROM org_mcp_server_definitions d
            WHERE d.organization_id = m.organization_id AND d.server_def_id IN (${ids})
          ), '[]'::json) AS definitions,
          EXISTS (
            SELECT 1 FROM org_mcp_member_blocks b
            WHERE b.organization_id = m.organization_id AND b.actor_id = m.actor_id AND b.server_def_id IN (${ids})
          ) AS member_blocked
        FROM organization_memberships m
        JOIN organizations o ON o.organization_id = m.organization_id AND o.lifecycle = 'active'
        WHERE m.actor_id = ${actorId} AND m.state = 'active'
        ORDER BY m.organization_id
        LIMIT ${ORG_MCP_MAX_MEMBERSHIPS + 1}
      `.execute(db);
      // Every membership is read; one past the cap marks the result incomplete so the caller denies.
      return {
        truncated: result.rows.length > ORG_MCP_MAX_MEMBERSHIPS,
        rows: result.rows.slice(0, ORG_MCP_MAX_MEMBERSHIPS).map(row => ({
          organizationId: row.organization_id,
          definitions: (Array.isArray(row.definitions) ? row.definitions : []).map(definitionFromRow),
          memberBlocked: row.member_blocked === true,
        })),
      };
    },

    /**
     * Membership-free fallback: the first org (by id) that defines this server
     * or blocks this actor on it. Used only when membership data is unavailable,
     * so the caller can refuse governed servers instead of allowing them.
     */
    async governingOrgWithoutMembership(actorId: string, serverDefIds: readonly string[]): Promise<string | null> {
      if (serverDefIds.length === 0) return null;
      const ids = sql.join(serverDefIds.map(id => sql`${id}`));
      const result = await sql<{ organization_id: string }>`
        SELECT organization_id FROM (
          SELECT organization_id FROM org_mcp_server_definitions WHERE server_def_id IN (${ids})
          UNION
          SELECT organization_id FROM org_mcp_member_blocks WHERE actor_id = ${actorId} AND server_def_id IN (${ids})
        ) governing ORDER BY organization_id LIMIT 1
      `.execute(db);
      return result.rows[0]?.organization_id ?? null;
    },

    async listServerDefinitions(organizationId: string) {
      const rows = await db.selectFrom("org_mcp_server_definitions").selectAll()
        .where("organization_id", "=", organizationId).orderBy("server_def_id").limit(MAX_SERVER_DEFINITIONS).execute();
      return rows.map(row => ({ ...definitionFromRow(row), updatedAt: new Date(row.updated_at) }));
    },

    /**
     * Partial upsert. The organization row is locked first, so concurrent
     * creates in one org serialize and the 500-definition cap cannot be
     * overshot; an existing definition keeps every field the input omits.
     */
    async putServerDefinition(input: {
      organizationId: string; serverDefId: string; mode?: OrgMcpServerMode; defaultToolPolicy?: OrgMcpToolPolicy;
      toolOverrides?: Record<string, OrgMcpToolPolicy>; updatedBy: string;
    }): Promise<OrgMcpPutResult> {
      return db.transaction().execute(async (trx) => {
        const organization = await trx.selectFrom("organizations").select("organization_id")
          .where("organization_id", "=", input.organizationId).forUpdate().executeTakeFirst();
        if (!organization) return "organization_missing";
        const existing = await trx.selectFrom("org_mcp_server_definitions").select("server_def_id")
          .where("organization_id", "=", input.organizationId).where("server_def_id", "=", input.serverDefId)
          .forUpdate().executeTakeFirst();
        if (existing) {
          await trx.updateTable("org_mcp_server_definitions").set({
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.defaultToolPolicy ? { default_tool_policy: input.defaultToolPolicy } : {}),
            ...(input.toolOverrides ? { tool_overrides: JSON.stringify(input.toolOverrides) } : {}),
            updated_by: input.updatedBy, updated_at: new Date(),
          }).where("organization_id", "=", input.organizationId).where("server_def_id", "=", input.serverDefId).execute();
          return "saved";
        }
        if (!input.mode) return "mode_required";
        const count = await trx.selectFrom("org_mcp_server_definitions").select(eb => eb.fn.countAll<number>().as("count"))
          .where("organization_id", "=", input.organizationId).executeTakeFirstOrThrow();
        if (Number(count.count) >= MAX_SERVER_DEFINITIONS) return "cap_reached";
        await trx.insertInto("org_mcp_server_definitions").values({
          organization_id: input.organizationId, server_def_id: input.serverDefId, mode: input.mode,
          default_tool_policy: input.defaultToolPolicy ?? "allow",
          tool_overrides: JSON.stringify(input.toolOverrides ?? {}), updated_by: input.updatedBy,
        }).execute();
        return "saved";
      });
    },

    async deleteServerDefinition(organizationId: string, serverDefId: string): Promise<void> {
      await db.deleteFrom("org_mcp_server_definitions")
        .where("organization_id", "=", organizationId).where("server_def_id", "=", serverDefId).execute();
    },

    async blockMember(input: { organizationId: string; actorId: string; serverDefId: string; createdBy: string }): Promise<void> {
      await db.insertInto("org_mcp_member_blocks").values({
        organization_id: input.organizationId, actor_id: input.actorId, server_def_id: input.serverDefId, created_by: input.createdBy,
      }).onConflict(conflict => conflict.columns(["organization_id", "actor_id", "server_def_id"]).doNothing()).execute();
    },

    async unblockMember(input: { organizationId: string; actorId: string; serverDefId: string }): Promise<void> {
      await db.deleteFrom("org_mcp_member_blocks").where("organization_id", "=", input.organizationId)
        .where("actor_id", "=", input.actorId).where("server_def_id", "=", input.serverDefId).execute();
    },

    async listMemberBlocks(organizationId: string, actorIds: readonly string[]): Promise<Map<string, string[]>> {
      const blocks = new Map<string, string[]>();
      if (actorIds.length === 0) return blocks;
      const rows = await db.selectFrom("org_mcp_member_blocks").select(["actor_id", "server_def_id"])
        .where("organization_id", "=", organizationId).where("actor_id", "in", [...actorIds])
        .orderBy("actor_id").orderBy("server_def_id").limit(MAX_CONNECTION_ROWS).execute();
      for (const row of rows) blocks.set(row.actor_id, [...(blocks.get(row.actor_id) ?? []), row.server_def_id]);
      return blocks;
    },

    /** Connection metadata only: the credential column is never selected. */
    async listConnections(actorIds: readonly string[]): Promise<OrgMcpConnectionRow[]> {
      if (actorIds.length === 0) return [];
      const rows = await db.selectFrom("custom_mcp_servers as s").innerJoin("users as u", "u.id", "s.user_id")
        .select(["u.clerk_id", "s.id", "s.name", "s.url", "s.status", "s.enabled", "s.created_at"])
        .where("u.clerk_id", "in", [...actorIds])
        .orderBy("u.clerk_id").orderBy("s.created_at").orderBy("s.id").limit(MAX_CONNECTION_ROWS).execute();
      return rows.map(row => ({ actorId: row.clerk_id, connectionId: row.id, name: row.name, url: row.url,
        status: row.status, enabled: row.enabled, connectedAt: new Date(row.created_at) }));
    },

    /** Last use attributed to this organization only; personal use elsewhere stays invisible. */
    async lastUsedByConnection(organizationId: string, connectionIds: readonly string[]): Promise<Map<string, Date>> {
      const lastUsed = new Map<string, Date>();
      if (connectionIds.length === 0) return lastUsed;
      const ids = sql.join(connectionIds.map(id => sql`${id}`));
      const result = await sql<{ connection_id: string; last_used: Date | string }>`
        SELECT connection_id, max(last_used) AS last_used FROM (
          SELECT connection_id, max(occurred_at) AS last_used FROM mcp_usage_events
          WHERE org_id = ${organizationId} AND connection_id IN (${ids}) GROUP BY connection_id
          UNION ALL
          SELECT connection_id, (max(day)::timestamp AT TIME ZONE 'UTC') AS last_used FROM mcp_usage_daily
          WHERE org_id = ${organizationId} AND connection_id IN (${ids}) GROUP BY connection_id
        ) usage GROUP BY connection_id
      `.execute(db);
      for (const row of result.rows) lastUsed.set(row.connection_id, new Date(row.last_used));
      return lastUsed;
    },

    /** Daily aggregates for current members only, newest first, capped at `limit` rows. */
    async usageAggregates(input: { organizationId: string; from: string; to: string; actorId?: string; limit: number }): Promise<OrgMcpUsageAggregate[]> {
      const result = await sql<{ day: string | Date; actor_id: string; server_key: string; tool_name: string; calls: string | number; failures: string | number }>`
        SELECT u.day, u.actor_id, u.server_key, u.tool_name,
          sum(u.call_count)::bigint AS calls,
          COALESCE(sum(u.call_count) FILTER (WHERE u.outcome <> 'ok'), 0)::bigint AS failures
        FROM mcp_usage_daily u
        JOIN organization_memberships m ON m.organization_id = u.org_id AND m.actor_id = u.actor_id AND m.state = 'active'
        WHERE u.org_id = ${input.organizationId} AND u.day BETWEEN ${input.from}::date AND ${input.to}::date
          ${input.actorId ? sql`AND u.actor_id = ${input.actorId}` : sql``}
        GROUP BY u.day, u.actor_id, u.server_key, u.tool_name
        ORDER BY u.day DESC, u.actor_id, u.server_key, u.tool_name
        LIMIT ${input.limit}
      `.execute(db);
      return result.rows.map(row => ({
        day: typeof row.day === "string" ? row.day.slice(0, 10) : row.day.toISOString().slice(0, 10),
        actorId: row.actor_id, serverKey: row.server_key, toolName: row.tool_name,
        calls: Number(row.calls), failures: Number(row.failures),
      }));
    },
  };
}

export type OrgMcpRepository = ReturnType<typeof createOrgMcpRepository>;
