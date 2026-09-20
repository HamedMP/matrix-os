import type { CollaborationRole } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import { CollaborationAuthorizationError, type CollaborationAuthorizationErrorCode } from "./authority-error.js";
import type { CollaborationScopesTable } from "./database.js";
import type { CollaborationCapabilityRepository } from "./capability-repository.js";
import type { OrganizationPrecondition } from "./organization-precondition.js";
import type { CollaborationRepository } from "./repository.js";

export { CollaborationAuthorizationError, type CollaborationAuthorizationErrorCode };

export type CollaborationAction =
  | "read"
  | "discuss"
  | "manage_members"
  | "publish_snapshot"
  | "mutate_project"
  | "export_project"
  | "request_ai"
  | "control_execution"
  | "recover";

export interface AuthorizedCollaborationContext {
  actorId: string;
  ownerId: string;
  organizationId: string;
  scopeId: string;
  membershipScopeId: string;
  resourceKind: "chat" | "terminal" | "project";
  resourceId: string;
  role: CollaborationRole;
  authEpoch: number;
  authorityRuntimeId: string;
  authorityGeneration: number;
  capability: CollaborationAction;
}

export interface CollaborationAuthorityOptions {
  /** The organization precondition; every authorization consults it before any allow (S20). */
  organizationPrecondition: OrganizationPrecondition;
  /** S04: whole-project preset grants; when present, an active grant maps to a role (contributor→editor, viewer→viewer). */
  capabilities?: CollaborationCapabilityRepository;
  now?: () => Date;
}

type ExecutionScope = Pick<
  Selectable<CollaborationScopesTable>,
  "kind" | "lifecycle" | "owner_id" | "execution_generation" | "execution_eligibility"
>;

/**
 * Deny-wins evaluator for one home computer. Order of checks: the scope
 * exists, the membership scope resolves, the actor holds fresh membership in
 * the scope's organization (the S20 precondition; no flag or cohort), the
 * actor holds current scope membership, the lifecycle admits the action, and
 * finally the role allows it.
 */
export class CollaborationAuthority {
  private readonly now: () => Date;
  /** The organization precondition every protected operation must pass, including proof-only owner operations. */
  readonly organizationPrecondition: OrganizationPrecondition;
  private readonly capabilities: CollaborationCapabilityRepository | undefined;
  constructor(
    private readonly repository: CollaborationRepository,
    options: CollaborationAuthorityOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.organizationPrecondition = options.organizationPrecondition;
    this.capabilities = options.capabilities;
  }

  async authorize(input: {
    scopeId: string;
    actorId: string;
    action: CollaborationAction;
  }): Promise<AuthorizedCollaborationContext> {
    const scope = await this.loadScope(input.scopeId);
    const membershipScope = await this.resolveMembershipScope(scope);
    await this.organizationPrecondition.require({
      organizationId: membershipScope.organization_id,
      actorId: input.actorId,
    });
    const member = await this.repository.getMember(membershipScope.id, input.actorId);
    const legacyRole = member && member.status === "accepted"
      && !(member.expiresAt && new Date(member.expiresAt).getTime() <= this.now().getTime())
      ? member.role
      : null;
    // S04: a whole-project preset grant is the V1 membership; legacy member rows keep their exact old role.
    const role = legacyRole ?? await this.resolveGrantRole(membershipScope.id, input.actorId);
    if (!role) {
      throw new CollaborationAuthorizationError("not_found", "Current membership is required");
    }
    this.requireLifecycle(scope, role, input.action);
    requireRoleCapability(role, input.action);

    return {
      actorId: input.actorId,
      ownerId: scope.owner_id,
      organizationId: membershipScope.organization_id!,
      scopeId: scope.id,
      membershipScopeId: membershipScope.id,
      resourceKind: scope.kind,
      resourceId: scope.resource_id,
      role,
      authEpoch: Math.max(Number(scope.auth_epoch), Number(membershipScope.auth_epoch)),
      authorityRuntimeId: scope.authority_runtime_id,
      authorityGeneration: Number(scope.authority_generation),
      capability: input.action,
    };
  }

  /** S04: preset grants on the membership scope; contributor maps to editor, viewer to viewer. */
  private async resolveGrantRole(membershipScopeId: string, actorId: string): Promise<CollaborationRole | null> {
    if (!this.capabilities) return null;
    let resolution;
    try {
      resolution = await this.capabilities.resolveActorGrants(membershipScopeId, actorId);
    } catch (error: unknown) {
      console.warn("[collaboration-authority] grant lookup failed", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborationAuthorizationError("unavailable", "Collaboration policy is unavailable");
    }
    if (!resolution) return null;
    const nowMs = this.now().getTime();
    const live = (grant: { state: string; expires_at: Date | string | null } | null): boolean =>
      grant !== null && grant.state === "active" && (grant.expires_at === null || new Date(grant.expires_at).getTime() > nowMs);
    const presets: Array<"viewer" | "contributor"> = [];
    if (live(resolution.memberGrant)) presets.push(resolution.memberGrant!.preset);
    if (live(resolution.organizationGrant) && resolution.activation?.state === "active") presets.push(resolution.organizationGrant!.preset);
    if (presets.length === 0) return null;
    return presets.includes("contributor") ? "editor" : "viewer";
  }

  private async loadScope(scopeId: string): Promise<Selectable<CollaborationScopesTable>> {
    const scope = await this.repository.db.selectFrom("collaboration_scopes")
      .selectAll()
      .where("id", "=", scopeId)
      .where("deleted_at", "is", null)
      .where("lifecycle", "!=", "deleted")
      .executeTakeFirst();
    if (!scope) throw new CollaborationAuthorizationError("not_found", "Scope not found");
    return scope;
  }

  private async resolveMembershipScope(
    scope: Selectable<CollaborationScopesTable>,
  ): Promise<Selectable<CollaborationScopesTable>> {
    if (scope.membership_mode === "direct") {
      if (scope.parent_scope_id !== null) {
        throw new CollaborationAuthorizationError("unavailable", "Scope membership configuration is invalid");
      }
      return scope;
    }
    if (!scope.parent_scope_id) {
      throw new CollaborationAuthorizationError("unavailable", "Scope membership configuration is invalid");
    }
    const parent = await this.loadScope(scope.parent_scope_id);
    if (parent.kind !== "project" || parent.membership_mode !== "direct"
      || (parent.lifecycle !== "shared" && parent.lifecycle !== "archived")
      || parent.lifecycle !== scope.lifecycle || parent.owner_id !== scope.owner_id
      || parent.authority_runtime_id !== scope.authority_runtime_id
      || parent.organization_id !== scope.organization_id) {
      throw new CollaborationAuthorizationError("unavailable", "Inherited authority is unavailable");
    }
    return parent;
  }

  private requireLifecycle(
    scope: Selectable<CollaborationScopesTable>,
    role: CollaborationRole,
    action: CollaborationAction,
  ): void {
    if (action === "request_ai" || action === "control_execution") {
      if (!executionAllowed(scope, action)) {
        throw new CollaborationAuthorizationError("unavailable", "Shared execution is unavailable");
      }
    }
    if (scope.lifecycle === "shared") return;
    if (scope.lifecycle === "archived" && action === "read") return;
    if (role === "owner" && action === "recover"
      && ["archived", "deleting", "recovering"].includes(scope.lifecycle)) return;
    throw new CollaborationAuthorizationError("unavailable", "Scope is not available for this action");
  }

  canRequestAi(scope: ExecutionScope, role: CollaborationRole): boolean {
    return role !== "viewer" && scope.lifecycle === "shared" && executionAllowed(scope, "request_ai");
  }
}

/** Execution needs a resolved runtime capability on the scope; no milestone or cohort participates. */
function executionAllowed(scope: ExecutionScope, action: "request_ai" | "control_execution"): boolean {
  if (action === "request_ai" && scope.kind !== "chat") return false;
  if (action === "control_execution" && scope.kind !== "chat" && scope.kind !== "terminal") return false;
  return scope.execution_generation !== null && scope.execution_eligibility !== null;
}

function requireRoleCapability(role: CollaborationRole, action: CollaborationAction): void {
  if (action === "request_ai" || action === "control_execution") {
    if (role === "viewer") throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
    return;
  }
  const allowed = role === "owner"
    ? ["read", "discuss", "manage_members", "publish_snapshot", "mutate_project", "export_project", "recover"]
    : role === "editor"
      ? ["read", "discuss", "mutate_project"]
      : ["read"];
  if (!allowed.includes(action)) {
    throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
  }
}
