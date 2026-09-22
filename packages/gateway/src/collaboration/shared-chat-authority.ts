import type { Selectable, Transaction } from "kysely";
import type { OwnerCollaborationDatabase, CollaborationScopesTable } from "./database.js";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "./authority.js";
import { isActivationCurrent } from "./capability-evaluator.js";

/** Fresh Clerk and grant evidence is supplied by CollaborationAuthority before the transaction. */
export type SharedChatAuthorizer = (
  scopeId: string,
  actorId: string,
  action: "request_ai" | "control_execution",
) => Promise<AuthorizedCollaborationContext>;

/** Locks the same scopes grant mutations advance, so a preflight cannot survive revocation. */
export async function fenceSharedChatAuthority(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: Selectable<CollaborationScopesTable>,
  context: AuthorizedCollaborationContext,
  actorId: string,
  action: "request_ai" | "control_execution",
): Promise<"owner" | "editor"> {
  if (scope.kind !== "chat" || scope.lifecycle !== "shared"
    || context.scopeId !== scope.id || context.resourceId !== scope.resource_id
    || context.ownerId !== scope.owner_id || context.actorId !== actorId
    || context.organizationId !== scope.organization_id || context.capability !== action
    || context.authorityRuntimeId !== scope.authority_runtime_id
    || context.authorityGeneration !== Number(scope.authority_generation)
    || (context.role === "owner" && actorId !== scope.owner_id)
    || (scope.membership_mode === "direct" && scope.parent_scope_id !== null)
    || context.role === "viewer") {
    throw new CollaborationAuthorizationError("forbidden", "Shared Chat authority changed");
  }
  const membershipScope = scope.membership_mode === "direct"
    ? scope
    : scope.parent_scope_id
      ? await trx.selectFrom("collaboration_scopes").selectAll()
        .where("id", "=", scope.parent_scope_id).forUpdate().executeTakeFirst()
      : undefined;
  if (!membershipScope || membershipScope.id !== context.membershipScopeId
    || membershipScope.lifecycle !== "shared"
    || membershipScope.owner_id !== scope.owner_id
    || membershipScope.organization_id !== scope.organization_id
    || membershipScope.authority_runtime_id !== scope.authority_runtime_id
    || (scope.membership_mode === "inherited" && membershipScope.kind !== "project")
    || Number(scope.auth_epoch) !== (context.resourceAuthEpoch ?? context.authEpoch)
    || Number(membershipScope.auth_epoch) !== (context.membershipAuthEpoch ?? context.authEpoch)) {
    throw new CollaborationAuthorizationError("unavailable", "Shared Chat authority changed");
  }
  const member = await trx.selectFrom("collaboration_members").selectAll()
    .where("scope_id", "=", membershipScope.id).where("actor_id", "=", actorId)
    .forUpdate().executeTakeFirst();
  const now = Date.now();
  const legacyRole = member?.status === "accepted" && member.dispositioned_at === null
    && (member.expires_at === null || new Date(member.expires_at).getTime() > now)
    ? member.role : null;
  let currentRole = legacyRole;
  if (!currentRole) {
    const grants = await trx.selectFrom("collaboration_grants").selectAll()
      .where("scope_id", "=", membershipScope.id)
      .where("state", "=", "active")
      .where((eb) => eb.or([
        eb("audience_kind", "=", "organization"),
        eb.and([eb("audience_kind", "=", "member"), eb("audience_actor_id", "=", actorId)]),
      ])).execute();
    let contributor = false;
    let viewer = false;
    for (const grant of grants) {
      if (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= now) continue;
      if (grant.audience_kind === "organization") {
        const activation = await trx.selectFrom("collaboration_grant_activations").selectAll()
          .where("grant_id", "=", grant.id).where("actor_id", "=", actorId).executeTakeFirst();
        if (!isActivationCurrent(activation, context.membershipEvidenceEpoch)) continue;
      }
      if (grant.preset === "contributor") contributor = true;
      else viewer = true;
    }
    currentRole = contributor ? "editor" : viewer ? "viewer" : null;
  }
  if (currentRole !== context.role) {
    throw new CollaborationAuthorizationError("forbidden", "Shared Chat authority changed");
  }
  return context.role;
}
