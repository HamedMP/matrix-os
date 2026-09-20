/**
 * Person-to-person record inventory (S20 / T102).
 *
 * Counts the collaboration records on one home computer that carry no
 * organization context: scopes, grants and pending invitations created before
 * the organization became the only sharing gate. Customer VPSes shipped with
 * collaboration off, so the expected count is zero. Any record found is never
 * auto-converted; S18 terminates it with notice or the owner re-homes the
 * resource into an organization.
 */
import type { Kysely } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

export interface PersonToPersonInventory {
  scopesWithoutOrganization: number;
  /** Non-owner grants that are pending or accepted. */
  grantsWithoutOrganization: number;
  pendingInvitationsWithoutOrganization: number;
  /** Non-owner grants already revoked or expired; they still need the S18 tombstone/notice pass. */
  endedGrantsWithoutOrganization: number;
  total: number;
}

export async function inventoryPersonToPersonRecords(
  db: Kysely<OwnerCollaborationDatabase>,
): Promise<PersonToPersonInventory> {
  const [scopes, grants, invitations, ended] = await Promise.all([
    db.selectFrom("collaboration_scopes")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "is", null)
      .where("deleted_at", "is", null)
      .where("lifecycle", "!=", "deleted")
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "is", null)
      .where("role", "!=", "owner")
      .where("status", "in", ["pending", "accepted"])
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "is", null)
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow(),
    db.selectFrom("collaboration_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organization_id", "is", null)
      .where("role", "!=", "owner")
      .where("status", "in", ["revoked", "expired"])
      .executeTakeFirstOrThrow(),
  ]);
  const scopesWithoutOrganization = Number(scopes.count);
  const grantsWithoutOrganization = Number(grants.count);
  const pendingInvitationsWithoutOrganization = Number(invitations.count);
  const endedGrantsWithoutOrganization = Number(ended.count);
  return {
    scopesWithoutOrganization,
    grantsWithoutOrganization,
    pendingInvitationsWithoutOrganization,
    endedGrantsWithoutOrganization,
    total: scopesWithoutOrganization + grantsWithoutOrganization + endedGrantsWithoutOrganization,
  };
}
