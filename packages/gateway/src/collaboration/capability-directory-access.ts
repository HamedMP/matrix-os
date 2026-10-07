import { sql, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { ScopeRow } from "./repository-shared.js";

/** Discovery preserves access from another grant after a declined invitation. */
export async function actorRetainsGrantAccess(
  trx: Transaction<OwnerCollaborationDatabase>, scope: ScopeRow,
  input: { actorId: string; membershipEvidenceEpoch: string }, now: string,
): Promise<boolean> {
  if (scope.owner_id === input.actorId) return true;
  const epoch = /^\d{1,20}$/.test(input.membershipEvidenceEpoch) ? input.membershipEvidenceEpoch : null;
  const grant = await trx.selectFrom("collaboration_grants as g")
    .leftJoin("collaboration_grant_activations as a", (join) => join
      .onRef("a.grant_id", "=", "g.id").on("a.actor_id", "=", input.actorId))
    .select("g.id").where("g.scope_id", "=", scope.id)
    .where("g.state", "=", "active")
    .where((eb) => eb.or([eb("g.expires_at", "is", null), eb("g.expires_at", ">", now)]))
    .where((eb) => eb.or([
      eb.and([eb("g.audience_kind", "=", "member"), eb("g.audience_actor_id", "=", input.actorId)]),
      ...(epoch === null ? [] : [eb.and([
        eb("g.audience_kind", "=", "organization"), eb("a.state", "=", "active"),
        eb("a.membership_evidence_epoch", ">=", sql<string>`${epoch}::bigint`),
      ])]),
    ])).limit(1).executeTakeFirst();
  return grant !== undefined;
}
