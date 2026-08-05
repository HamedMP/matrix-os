import type { OwnerRef } from "./context-token.js";

export type ResourceOperation = "read" | "write" | "administer";
export type ResourceSurface = "files" | "app_data" | "ai_retrieval" | "realtime";
export type ResourceRole = "viewer" | "editor" | "resource_admin";

export interface AuthorizableResource {
  id: string;
  owner: OwnerRef;
  parentId: string | null;
  kind: "vault" | "collection" | "project" | "page" | "whiteboard" | "app_data";
}

export interface ResourceGrant {
  id: string;
  resourceId: string;
  subjectUserId: string;
  effect: "allow" | "deny";
  role: ResourceRole;
  version: number;
}

export interface AuthorizationRequest {
  actorUserId: string;
  resourceId: string;
  operation: ResourceOperation;
  surface?: ResourceSurface;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: "grant" | "org_admin" | "default_deny" | "explicit_deny" | "missing_resource" | "stale_membership";
  surface?: ResourceSurface;
  matchedResourceId?: string;
  policyVersion: number | null;
}

export class ResourceNotFoundError extends Error {
  readonly code = "resource_not_found";

  constructor() {
    super("Resource not found");
    this.name = "ResourceNotFoundError";
  }
}

const ROLE_OPERATIONS: Record<ResourceRole, ReadonlySet<ResourceOperation>> = {
  viewer: new Set(["read"]),
  editor: new Set(["read", "write"]),
  resource_admin: new Set(["read", "write", "administer"]),
};

export interface PermissionEvaluator {
  decide(request: AuthorizationRequest): AuthorizationDecision;
  assert(request: AuthorizationRequest): AuthorizationDecision;
  currentPolicyVersion(actorUserId: string): number | null;
}

export function createPermissionEvaluator(options: {
  resources: readonly AuthorizableResource[];
  getGrants(): readonly ResourceGrant[];
  getOrganizationRole(actorUserId: string, organizationId: string): "owner" | "admin" | "member" | "guest" | null;
  getMembershipPolicyVersion(actorUserId: string): number | null;
}): PermissionEvaluator {
  const resources = new Map(options.resources.map((resource) => [resource.id, resource]));

  function ancestry(resource: AuthorizableResource): AuthorizableResource[] {
    const result: AuthorizableResource[] = [];
    const seen = new Set<string>();
    let current: AuthorizableResource | undefined = resource;
    while (current && !seen.has(current.id)) {
      result.push(current);
      seen.add(current.id);
      current = current.parentId ? resources.get(current.parentId) : undefined;
    }
    return result;
  }

  function decide(request: AuthorizationRequest): AuthorizationDecision {
    const policyVersion = options.getMembershipPolicyVersion(request.actorUserId);
    const resource = resources.get(request.resourceId);
    if (!resource) {
      return { allowed: false, reason: "missing_resource", surface: request.surface, policyVersion };
    }

    if (resource.owner.type === "user") {
      // The spike deliberately models no private-owner sharing. Even the same
      // actor needs a personal-context token, which this org evaluator lacks.
      return { allowed: false, reason: "default_deny", surface: request.surface, policyVersion };
    }
    const organizationRole = options.getOrganizationRole(request.actorUserId, resource.owner.id);
    if (!organizationRole || policyVersion === null) {
      return { allowed: false, reason: "stale_membership", surface: request.surface, policyVersion };
    }

    const chain = ancestry(resource);
    for (const candidate of chain) {
      const sameDepth = options.getGrants().filter(
        (grant) => grant.subjectUserId === request.actorUserId && grant.resourceId === candidate.id,
      );
      const matching = sameDepth.filter((grant) => ROLE_OPERATIONS[grant.role].has(request.operation));
      if (matching.some((grant) => grant.effect === "deny")) {
        return {
          allowed: false,
          reason: "explicit_deny",
          matchedResourceId: candidate.id,
          surface: request.surface,
          policyVersion,
        };
      }
      if (matching.some((grant) => grant.effect === "allow")) {
        return {
          allowed: true,
          reason: "grant",
          matchedResourceId: candidate.id,
          surface: request.surface,
          policyVersion,
        };
      }
    }

    if (request.operation === "administer" && (organizationRole === "owner" || organizationRole === "admin")) {
      return { allowed: true, reason: "org_admin", surface: request.surface, policyVersion };
    }
    return { allowed: false, reason: "default_deny", surface: request.surface, policyVersion };
  }

  return {
    decide,
    assert(request) {
      const decision = decide(request);
      if (!decision.allowed) throw new ResourceNotFoundError();
      return decision;
    },
    currentPolicyVersion(actorUserId) {
      return options.getMembershipPolicyVersion(actorUserId);
    },
  };
}

export function createRealtimeAuthorizationLease(input: {
  evaluator: PermissionEvaluator;
  actorUserId: string;
  resourceId: string;
  operation: ResourceOperation;
  policyVersion: number;
}): { check(): { allowed: boolean; close: boolean } } {
  return {
    check() {
      const currentVersion = input.evaluator.currentPolicyVersion(input.actorUserId);
      if (currentVersion !== input.policyVersion) return { allowed: false, close: true };
      const decision = input.evaluator.decide({
        actorUserId: input.actorUserId,
        resourceId: input.resourceId,
        operation: input.operation,
        surface: "realtime",
      });
      return { allowed: decision.allowed, close: !decision.allowed };
    },
  };
}
