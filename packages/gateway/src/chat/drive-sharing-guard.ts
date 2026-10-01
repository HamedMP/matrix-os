import { sql, type Kysely, type QueryExecutorProvider } from "kysely";
import type { ChatDatabase } from "./database.js";
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
    ) or exists (
      select 1 from chat_queued_turns where chat_id = ${chatId}
      and (context_snapshot ? 'drives'
        or parts @> '[{"type":"resource_reference","resource":{"kind":"organization_drive"}}]'::jsonb)
    ) as present
  `.execute(db);
    return result.rows[0]?.present === true;
}

/** Additive, serialized indexes keep live audience checks bounded as history grows. */
export async function bootstrapCompanyDriveSharingIndexes<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
    await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
        await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('company_drive_sharing_indexes'))`.execute(trx);
        await sql`CREATE INDEX IF NOT EXISTS idx_chat_messages_company_drive ON chat_messages(chat_id)
          WHERE parts @> '[{"type":"resource_reference","resource":{"kind":"organization_drive"}}]'::jsonb`.execute(trx);
        await sql`CREATE INDEX IF NOT EXISTS idx_chat_runs_company_drive ON chat_runs(chat_id)
          WHERE context_snapshot ? 'drives'`.execute(trx);
        await sql`CREATE INDEX IF NOT EXISTS idx_chat_queued_turns_company_drive ON chat_queued_turns(chat_id)
          WHERE context_snapshot ? 'drives'
            OR parts @> '[{"type":"resource_reference","resource":{"kind":"organization_drive"}}]'::jsonb`.execute(trx);
    });
}
