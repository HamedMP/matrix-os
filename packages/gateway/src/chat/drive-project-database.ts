import { sql, type Kysely, type QueryExecutorProvider } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { ChatRunContext } from "@matrix-os/contracts";
/** Additive schema only; the repository remains the sole pool owner. */
export async function bootstrapChatDriveProjects<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
    await db.transaction().execute(async (trx) => {
        await sql `SET LOCAL lock_timeout = '5s'`.execute(trx);
        await sql `SET LOCAL statement_timeout = '5s'`.execute(trx);
        await sql `SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('chat_drive_projects'))`.execute(trx);
        await sql `CREATE TABLE IF NOT EXISTS chat_drive_projects (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      reference JSONB, request_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.execute(trx);
    });
}
/** Called under the owned private Chat lock in the same admission transaction. Never moves an existing association. */
export async function associateAdmittedDriveChat(db: QueryExecutorProvider, chatId: string, requestId: string, context?: ChatRunContext): Promise<void> {
    const first = context?.drives?.[0];
    if (!first)
        return;
    const reference = { kind: "drive", organizationId: first.organizationId, scopeId: first.scopeId };
    await sql `INSERT INTO chat_drive_projects (chat_id,reference,request_id)
    VALUES (${chatId},${JSON.stringify(reference)}::jsonb,${requestId})
    ON CONFLICT (chat_id) DO NOTHING`.execute(db);
}
