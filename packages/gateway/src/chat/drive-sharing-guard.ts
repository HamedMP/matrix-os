import { sql, type QueryExecutorProvider } from "kysely";
/** Transitional guard: an audience policy must authorize any copied drive material. */
export async function hasCompanyDriveMaterial(db: QueryExecutorProvider, chatId: string): Promise<boolean> {
    const result = await sql<{
        present: boolean;
    }> `
    select exists (
      select 1 from chat_messages where chat_id = ${chatId}
      and parts @> '[{"type":"resource_reference","resource":{"kind":"organization_drive"}}]'::jsonb
    ) or exists (
      select 1 from chat_runs where chat_id = ${chatId} and context_snapshot ? 'drives'
    ) as present
  `.execute(db);
    return result.rows[0]?.present === true;
}
