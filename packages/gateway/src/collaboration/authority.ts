import type { CollaborationRole } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import type { CollaborationPolicy } from "@matrix-os/contracts";
import type { CollaborationScopesTable } from "./database.js";
import type { CollaborationRepository } from "./repository.js";

export type CollaborationAction =
  | "read"
  | "discuss"
  | "manage_members"
  | "publish_snapshot"
  | "request_ai"
  | "control_execution"
  | "recover";

export type CollaborationAuthorizationErrorCode = "not_found" | "forbidden" | "unavailable";

export class CollaborationAuthorizationError extends Error {
  constructor(
    public readonly code: CollaborationAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationAuthorizationError";
  }
}

export interface AuthorizedCollaborationContext {
  actorId: string;
  ownerId: string;
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
  now?: () => Date;
}

export class CollaborationAuthority {
  private readonly now: () => Date;
  constructor(
    private readonly repository: CollaborationRepository,
    options: CollaborationAuthorityOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async authorize(input: {
    scopeId: string;
    actorId: string;
    action: CollaborationAction;
    executionPolicy?: CollaborationPolicy;
  }): Promise<AuthorizedCollaborationContext> {
    const scope = await this.loadScope(input.scopeId);
    const membershipScope = await this.resolveMembershipScope(scope);
    const member = await this.repository.getMember(membershipScope.id, input.actorId);
    if (!member || member.status !== "accepted") {
      throw new CollaborationAuthorizationError("not_found", "Current membership is required");
    }
    if (member.expiresAt && new Date(member.expiresAt).getTime() <= this.now().getTime()) {
      throw new CollaborationAuthorizationError("not_found", "Current membership is required");
    }
    this.requireLifecycle(scope, member.role, input.actorId, input.action, input.executionPolicy);
    requireRoleCapability(member.role, input.action);

    return {
      actorId: input.actorId,
      ownerId: scope.owner_id,
      scopeId: scope.id,
      membershipScopeId: membershipScope.id,
      resourceKind: scope.kind,
      resourceId: scope.resource_id,
      role: member.role,
      authEpoch: Math.max(Number(scope.auth_epoch), Number(membershipScope.auth_epoch)),
      authorityRuntimeId: scope.authority_runtime_id,
      authorityGeneration: Number(scope.authority_generation),
      capability: input.action,
    };
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
      || parent.lifecycle !== "shared" || parent.owner_id !== scope.owner_id
      || parent.authority_runtime_id !== scope.authority_runtime_id) {
      throw new CollaborationAuthorizationError("unavailable", "Inherited authority is unavailable");
    }
    return parent;
  }

  private requireLifecycle(
    scope: Selectable<CollaborationScopesTable>,
    role: CollaborationRole,
    actorId: string,
    action: CollaborationAction,
    executionPolicy?: CollaborationPolicy,
  ): void {
    if (action === "request_ai" || action === "control_execution") {
      if (!this.executionAllowed(scope, actorId, action, executionPolicy)) {
        throw new CollaborationAuthorizationError("unavailable", "Shared execution is unavailable");
      }
    }
    if (scope.lifecycle === "shared") return;
    if (scope.lifecycle === "archived" && action === "read") return;
    if (role === "owner" && action === "recover"
      && ["archived", "deleting", "recovering"].includes(scope.lifecycle)) return;
    throw new CollaborationAuthorizationError("unavailable", "Scope is not available for this action");
  }

  canRequestAi(
    scope: Selectable<CollaborationScopesTable>,
    actorId: string,
    role: CollaborationRole,
    executionPolicy?: CollaborationPolicy,
  ): boolean {
    return role !== "viewer" && scope.lifecycle === "shared"
      && this.executionAllowed(scope, actorId, "request_ai", executionPolicy);
  }

  private executionAllowed(
    scope: Selectable<CollaborationScopesTable>,
    actorId: string,
    action: "request_ai" | "control_execution",
    policy?: CollaborationPolicy,
  ): boolean {
    if (action === "request_ai" && scope.kind !== "chat") return false;
    if (action === "control_execution" && scope.kind !== "chat" && scope.kind !== "terminal") return false;
    const requiredMilestone = scope.kind === "terminal" ? "m3" : "m2";
    if (!policy || policy.milestone !== requiredMilestone || policy.mode === "off" || policy.mode === "read_only"
      || scope.execution_generation === null || scope.execution_eligibility === null) return false;
    if (policy.mode === "enabled") return true;
    if (policy.cohort.length > 1_000) return false;
    return policy.cohort.includes(actorId) && policy.cohort.includes(scope.owner_id);
  }
}

function requireRoleCapability(role: CollaborationRole, action: CollaborationAction): void {
  if (action === "request_ai" || action === "control_execution") {
    if (role === "viewer") throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
    return;
  }
  const allowed = role === "owner"
    ? ["read", "discuss", "manage_members", "publish_snapshot", "recover"]
    : role === "editor"
      ? ["read", "discuss"]
      : ["read"];
  if (!allowed.includes(action)) {
    throw new CollaborationAuthorizationError("forbidden", "Role does not allow this action");
  }
}
