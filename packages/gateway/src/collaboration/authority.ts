import type { CollaborationRole } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import { CollaborationAuthorizationError, type CollaborationAuthorizationErrorCode } from "./authority-error.js";
import type { CollaborationScopesTable } from "./database.js";
import { CollaborationCapabilityEvaluator, isActivationCurrent } from "./capability-evaluator.js";
import type { CollaborationCapabilityRepository } from "./capability-repository.js";
import type { OrganizationPrecondition } from "./organization-precondition.js";
import type { CollaborationRepository } from "./repository.js";
import { hasRetiredLegacyAuthority } from "./repository-shared.js";

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
  | "recover"
  /** S12: write to a shared file, folder or app instance (Contributor); the project variant stays `mutate_project`. */
  | "mutate_resource";

export interface AuthorizedCollaborationContext {
  actorId: string;
  ownerId: string;
  organizationId: string;
  scopeId: string;
  membershipScopeId: string;
  resourceKind: "chat" | "terminal" | "project" | "file" | "folder" | "app";
  resourceId: string;
  role: CollaborationRole;
  authEpoch: number;
  /** Separate epochs preserve the revoke fence when parent and child epochs differ. */
  resourceAuthEpoch?: number;
  membershipAuthEpoch?: number;
  membershipEvidenceEpoch?: string;
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
  private readonly projectAccess: CollaborationCapabilityEvaluator;
  constructor(
    private readonly repository: CollaborationRepository,
    options: CollaborationAuthorityOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.organizationPrecondition = options.organizationPrecondition;
    this.capabilities = options.capabilities;
    this.projectAccess = new CollaborationCapabilityEvaluator({
      db: repository.db,
      organizationPrecondition: options.organizationPrecondition,
      ...(options.capabilities ? { grants: options.capabilities } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async authorize(input: {
    scopeId: string;
    actorId: string;
    action: CollaborationAction;
  }): Promise<AuthorizedCollaborationContext> {
    const scope = await this.loadScope(input.scopeId);
    const membershipScope = await this.resolveMembershipScope(scope);
    if (membershipScope.kind === "project") {
      const decision = await this.projectAccess.decide({ scopeId: input.scopeId, actorId: input.actorId });
      if (decision.access.preset === null) {
        throw new CollaborationAuthorizationError("not_found", "Current organization membership is required");
      }
      const role: CollaborationRole = decision.isOwner
        ? "owner"
        : decision.access.preset === "viewer" ? "viewer" : "editor";
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
        resourceAuthEpoch: Number(scope.auth_epoch),
        membershipAuthEpoch: Number(membershipScope.auth_epoch),
        ...(decision.membershipEvidenceEpoch ? { membershipEvidenceEpoch: decision.membershipEvidenceEpoch } : {}),
        authorityRuntimeId: scope.authority_runtime_id,
        authorityGeneration: Number(scope.authority_generation),
        capability: input.action,
      };
    }
    const evidence = await this.organizationPrecondition.require({
      organizationId: membershipScope.organization_id,
      actorId: input.actorId,
    });
    const appRole = scope.kind === "app"
      ? await this.resolveCurrentMembershipAppRole(scope, input.actorId)
      : null;
    const role = appRole
      ?? await this.resolveLegacyOrGrantRole(membershipScope, input.actorId, evidence.membershipEpoch);
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
      resourceAuthEpoch: Number(scope.auth_epoch),
      membershipAuthEpoch: Number(membershipScope.auth_epoch),
      ...(evidence.membershipEpoch ? { membershipEvidenceEpoch: evidence.membershipEpoch } : {}),
      authorityRuntimeId: scope.authority_runtime_id,
      authorityGeneration: Number(scope.authority_generation),
      capability: input.action,
    };
  }

  private async resolveLegacyOrGrantRole(
    membershipScope: Selectable<CollaborationScopesTable>,
    actorId: string,
    membershipEpoch: string | undefined,
  ): Promise<CollaborationRole | null> {
    const member = await this.repository.getMember(membershipScope.id, actorId);
    const legacyRole = member && member.status === "accepted" && !member.dispositionedAt
      && !(member.expiresAt && new Date(member.expiresAt).getTime() <= this.now().getTime())
      && (actorId === membershipScope.owner_id
        || !await hasRetiredLegacyAuthority(this.repository.db, membershipScope.id))
      ? member.role
      : null;
    return legacyRole ?? this.resolveGrantRole(membershipScope.id, actorId, membershipEpoch);
  }

  /** Live app sharing derives full app use from current organization membership, never recipient rows or grants. */
  private async resolveCurrentMembershipAppRole(
    scope: Selectable<CollaborationScopesTable>,
    actorId: string,
  ): Promise<CollaborationRole | null> {
    const binding = await this.repository.db.selectFrom("collaboration_app_bindings")
      .select("scope_id").where("scope_id", "=", scope.id).executeTakeFirst();
    // Pre-feature standalone app shares retain their legacy role/grant authority.
    if (!binding) return null;
    const exact = await this.repository.db.selectFrom("collaboration_app_bindings as binding")
      .innerJoin("collaboration_app_readiness as readiness", "readiness.id", "binding.readiness_id")
      .innerJoin("collaboration_resource_catalog as catalog", "catalog.id", "binding.catalog_id")
      .select("binding.scope_id")
      .where("binding.scope_id", "=", scope.id)
      .where("binding.state", "=", "active")
      .whereRef("binding.build_id", "=", "readiness.build_id")
      .whereRef("binding.registration_incarnation", "=", "readiness.registration_incarnation")
      .where("readiness.status", "=", "ready")
      .where("readiness.invalidated_at", "is", null)
      .whereRef("readiness.catalog_id", "=", "catalog.id")
      .whereRef("readiness.registration_incarnation", "=", "catalog.incarnation")
      .where("catalog.deleted_at", "is", null)
      .where("catalog.kind", "=", "app")
      .where("catalog.id", "=", scope.resource_id)
      .executeTakeFirst();
    if (!exact) throw new CollaborationAuthorizationError("unavailable", "Collaborative app needs recheck");
    return actorId === scope.owner_id ? "owner" : "editor";
  }

  /** S04: preset grants on the membership scope; contributor maps to editor, viewer to viewer. */
  private async resolveGrantRole(
    membershipScopeId: string,
    actorId: string,
    currentMembershipEpoch: string | undefined,
  ): Promise<CollaborationRole | null> {
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
    // Same fail-closed rule as the evaluator: an activation counts only under proven current epoch evidence.
    if (live(resolution.organizationGrant) && isActivationCurrent(resolution.activation, currentMembershipEpoch)) {
      presets.push(resolution.organizationGrant!.preset);
    }
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
    ? ["read", "discuss", "manage_members", "publish_snapshot", "mutate_project", "mutate_resource", "export_project", "recover"]
    : role === "editor"
      ? ["read", "discuss", "mutate_project", "mutate_resource", "export_project"]
      : ["read"];
  if (!allowed.includes(action)) {
    throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
  }
}
