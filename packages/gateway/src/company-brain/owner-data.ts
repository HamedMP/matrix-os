/** A retained tombstone proves only the host owner's export/erasure boundary, never live participant or execution access. */
import type { Kysely, Selectable } from "kysely";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "../collaboration/authority.js";
import type { CollaborationScopesTable } from "../collaboration/database.js";
import type { OrganizationPrecondition } from "../collaboration/organization-precondition.js";
import type { CompanyBrainDatabase } from "./database.js";

export type BrainOwnerAvailability = "shared" | "export" | "erase" | "deleted";
export function ownerDataScopeAvailable(scope: Selectable<CollaborationScopesTable>, mode: BrainOwnerAvailability): boolean {
  if (mode === "deleted" && scope.lifecycle === "deleted" && scope.deleted_at !== null) return true;
  return scope.deleted_at === null && (scope.lifecycle === "shared" || (mode !== "shared" && scope.lifecycle === "archived"));
}

export async function authorizeDeletedBrainOwnerData(options: {
  db: Kysely<CompanyBrainDatabase>; ownerId: string; scopeId: string; actorId: string;
  action: "read" | "publish_snapshot"; organizationPrecondition: OrganizationPrecondition; now: () => Date;
}): Promise<AuthorizedCollaborationContext | undefined> {
  if (options.actorId !== options.ownerId) return undefined;
  const scope = await options.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", options.scopeId).executeTakeFirst();
  if (!scope || scope.lifecycle !== "deleted" || scope.deleted_at === null) return undefined;
  const denied = () => new CollaborationAuthorizationError("forbidden", "Owner data authority unavailable");
  const binding = await options.db.selectFrom("company_brain_scopes").selectAll().where("scope_id", "=", scope.id).executeTakeFirst();
  if (!binding || scope.owner_type !== "personal" || scope.owner_id !== options.ownerId || !scope.organization_id
    || binding.owner_id !== scope.owner_id || binding.organization_id !== scope.organization_id
    || binding.resource_id !== scope.resource_id || binding.resource_kind !== scope.kind) throw denied();
  const membership = scope.membership_mode === "direct" ? scope : scope.parent_scope_id
    ? await options.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", scope.parent_scope_id).executeTakeFirst() : undefined;
  if (!membership || !ownerDataScopeAvailable(membership, "deleted")
    || membership.owner_type !== "personal" || membership.owner_id !== options.ownerId || membership.organization_id !== scope.organization_id
    || membership.authority_runtime_id !== scope.authority_runtime_id || Number(membership.authority_generation) !== Number(scope.authority_generation)
    || (scope.membership_mode === "direct" && scope.parent_scope_id !== null)
    || (scope.membership_mode === "inherited" && membership.kind !== "project")) throw denied();
  const member = await options.db.selectFrom("collaboration_members").selectAll().where("scope_id", "=", membership.id)
    .where("actor_id", "=", options.ownerId).executeTakeFirst();
  if (!member || member.organization_id !== scope.organization_id || member.role !== "owner" || member.status !== "accepted"
    || member.dispositioned_at !== null || (member.expires_at !== null && new Date(member.expires_at).getTime() <= options.now().getTime())) throw denied();
  const evidence = await options.organizationPrecondition.require({ organizationId: scope.organization_id, actorId: options.actorId });
  return { actorId: options.actorId, ownerId: options.ownerId, organizationId: scope.organization_id, scopeId: scope.id,
    membershipScopeId: membership.id, resourceKind: scope.kind, resourceId: scope.resource_id, role: "owner",
    authEpoch: Math.max(Number(scope.auth_epoch), Number(membership.auth_epoch)), resourceAuthEpoch: Number(scope.auth_epoch),
    membershipAuthEpoch: Number(membership.auth_epoch), ...(evidence.membershipEpoch ? { membershipEvidenceEpoch: evidence.membershipEpoch } : {}),
    authorityRuntimeId: scope.authority_runtime_id, authorityGeneration: Number(scope.authority_generation), capability: options.action };
}
