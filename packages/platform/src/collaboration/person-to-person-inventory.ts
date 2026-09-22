/**
 * Platform-side person-to-person inventory (S20 / T102).
 *
 * The platform directory and user index were written only by homes that had
 * collaboration enabled. Every row predates the organization gate, so the
 * whole directory is the person-to-person inventory here; the expected count
 * is zero because customer VPSes shipped with collaboration off. S18 applies
 * the disposition (terminate with notice or owner re-homes into an
 * organization); nothing is auto-converted.
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
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_user_index")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("status", "=", "invited")
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_user_index")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("status", "=", "accepted")
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_user_index")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("status", "=", "revoked")
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
