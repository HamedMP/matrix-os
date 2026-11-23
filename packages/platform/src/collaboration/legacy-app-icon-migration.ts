import { sql, type Transaction } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";
import { resizeLegacyAppIcon } from "./app-thumbnail.js";

/** Runs once inside the existing locked schema transaction; never blindly discard preview data. */
export async function migrateLegacyAppIcons(trx: Transaction<CollaborationPlatformDatabase>): Promise<void> {
  const exists = await sql<{ present: boolean }>`SELECT to_regclass('collaboration_app_icons') IS NOT NULL AS present`.execute(trx);
  if (!exists.rows[0]?.present) return;
  await sql`LOCK TABLE collaboration_app_icons IN ACCESS EXCLUSIVE MODE`.execute(trx);
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await sql<{ scope_id: string; bytes: Uint8Array }>`
      SELECT d.scope_id, i.bytes FROM collaboration_directory d
      JOIN collaboration_app_icons i ON i.runtime_id = d.runtime_id AND i.sha256 = d.app_icon_sha256
      WHERE d.scope_id > ${cursor}::uuid AND d.app_state <> 'stopped' AND d.app_icon_bytes IS NULL
      ORDER BY d.scope_id LIMIT 25`.execute(trx);
    for (const row of rows.rows) {
      const thumbnail = await resizeLegacyAppIcon(row.bytes);
      await trx.updateTable("collaboration_directory").set({
        app_icon_bytes: thumbnail ? Buffer.from(thumbnail.bytes) : null,
        app_icon_content_type: thumbnail?.contentType ?? null,
        app_icon_sha256: thumbnail?.sha256 ?? null,
      }).where("scope_id", "=", row.scope_id).execute();
      cursor = row.scope_id;
    }
    if (rows.rows.length < 25) break;
  }
  // Clear legacy dangling/stopped references. Referenced valid artwork has already been converted.
  await sql`UPDATE collaboration_directory SET app_icon_sha256 = NULL WHERE app_icon_bytes IS NULL`.execute(trx);
  await sql`DROP TABLE collaboration_app_icons`.execute(trx);
}
