import { sql } from "kysely";
import type { PlatformDB } from "../db.js";
import { logicalRuntimeIdFor } from "../collaboration/runtime-identity.js";
import { PreviewPairConflictError } from "./repository.js";

/** Called only after the exact projected machine is locked/tombstoned, in that transaction.
 * This is metadata retirement, never an owner-home grant mutation or a fleet-wide cleanup. */
export async function retirePreviewPairCollaborationAccess(trx: PlatformDB, machineId: string, ownerId: string): Promise<void> {
  if (!trx.executor.isTransaction) throw new PreviewPairConflictError();
  const enrolled = `vps:${machineId}`, logical = logicalRuntimeIdFor(enrolled);
  if (!logical) throw new PreviewPairConflictError();
  // Lock parents before checking descendants: normal ingestion locks that parent before attaching.
  await sql`SELECT scope_id FROM collaboration_directory WHERE runtime_id = ${enrolled} FOR UPDATE`.execute(trx.executor);
  const inconsistent = await sql<{ invalid: boolean }>`SELECT
    EXISTS(SELECT 1 FROM collaboration_directory WHERE runtime_id = ${enrolled} AND owner_id <> ${ownerId})
    OR EXISTS(SELECT 1 FROM collaboration_directory child JOIN collaboration_directory parent ON child.parent_scope_id = parent.scope_id
      WHERE parent.runtime_id = ${enrolled} AND (child.runtime_id <> ${enrolled} OR child.owner_id <> ${ownerId}))
    OR EXISTS(SELECT 1 FROM collaboration_cutover_journal journal LEFT JOIN collaboration_directory directory ON journal.scope_id = directory.scope_id
      WHERE (journal.runtime_id = ${enrolled} OR directory.runtime_id = ${enrolled}) AND (journal.runtime_id <> ${enrolled} OR journal.owner_id <> ${ownerId}))
    OR EXISTS(SELECT 1 FROM collaboration_cutover_dispositions WHERE runtime_id = ${enrolled} AND owner_id <> ${ownerId})
    OR EXISTS(SELECT 1 FROM collaboration_runtime_endpoints WHERE runtime_id = ${logical} AND owner_id <> ${ownerId}) AS invalid`.execute(trx.executor);
  if (inconsistent.rows[0]?.invalid !== false) throw new PreviewPairConflictError();
  await sql`DELETE FROM collaboration_connection_tickets WHERE scope_id IN
    (SELECT scope_id FROM collaboration_directory WHERE runtime_id = ${enrolled})`.execute(trx.executor);
  // The journal FK deliberately does not cascade; remove it before project/Chat directory rows.
  await sql`DELETE FROM collaboration_cutover_journal WHERE runtime_id = ${enrolled}`.execute(trx.executor);
  await sql`DELETE FROM collaboration_cutover_dispositions WHERE runtime_id = ${enrolled}`.execute(trx.executor);
  // Existing FKs cascade only the verified project Chats and their discovery indices.
  await sql`DELETE FROM collaboration_directory WHERE runtime_id = ${enrolled}`.execute(trx.executor);
  await sql`DELETE FROM collaboration_control_upgrade_tickets WHERE runtime_id = ${logical}`.execute(trx.executor);
  await sql`DELETE FROM collaboration_runtime_endpoints WHERE runtime_id = ${logical}`.execute(trx.executor);
}
