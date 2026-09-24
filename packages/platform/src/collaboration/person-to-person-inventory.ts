/**
 * Platform-side person-to-person inventory (S20 / T102).
 *
 * Only rows without an organization belong to the pre-organization sharing
 * path. Active organization shares can already occupy the same directory, so
 * index counts must join through their directory row before disposition.
 * S18 terminates legacy rows with notice or the owner re-homes them; nothing
 * is auto-converted.
 */
import type { Kysely } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";

export interface PlatformPersonToPersonInventory {
  directoryScopes: number;
  invitedIndexRows: number;
  acceptedIndexRows: number;
  /** Rows already revoked; they are still removed with notice at S18. */
  revokedIndexRows: number;
  total: number;
}

export async function inventoryPlatformPersonToPersonRecords(
  db: Kysely<CollaborationPlatformDatabase>,
): Promise<PlatformPersonToPersonInventory> {
  const [directory, invited, accepted, revoked] = await Promise.all([
    db.selectFrom("collaboration_directory")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "is", null)
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("directory.organization_id", "is", null)
      .where("user_index.status", "=", "invited")
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("directory.organization_id", "is", null)
      .where("user_index.status", "=", "accepted")
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_user_index as user_index")
      .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("directory.organization_id", "is", null)
      .where("user_index.status", "=", "revoked")
      .executeTakeFirstOrThrow(),
  ]);
  const directoryScopes = Number(directory.count);
  const invitedIndexRows = Number(invited.count);
  const acceptedIndexRows = Number(accepted.count);
  const revokedIndexRows = Number(revoked.count);
  return {
    directoryScopes,
    invitedIndexRows,
    acceptedIndexRows,
    revokedIndexRows,
    total: directoryScopes + invitedIndexRows + acceptedIndexRows + revokedIndexRows,
  };
}
