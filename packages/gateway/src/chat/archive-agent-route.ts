import { sql, type QueryExecutorProvider } from "kysely";

/** Generic Chat-only installations predate scoped grants. Other grants and the legacy pilot remain independent. */
export async function fenceArchivedAgentRoute(db: QueryExecutorProvider, ownerId: string, agentId: string, now: string) {
  const schema = await sql<{ ready:boolean }>`SELECT to_regclass('bot_resource_grants') IS NOT NULL AS ready`.execute(db);
  if (!schema.rows[0]?.ready) return false;
  const result = await sql`UPDATE bot_resource_grants SET revoked_at=${now}, revision=revision+1
    WHERE owner_id=${ownerId} AND bot_id=${agentId} AND kind='slack_channel'
      AND scope ? 'route' AND revoked_at IS NULL RETURNING grant_id`.execute(db);
  return result.rows.length > 0;
}
