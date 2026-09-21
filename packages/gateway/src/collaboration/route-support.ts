/**
 * Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008):
 * the route option contract, proof decoding, authorization helpers,
 * projections and the shared error-to-status handler used by every
 * collaboration route module.
 */
import {
  createHash,
} from "node:crypto";
import { directErrorResponse, readDirectCredentials } from "./direct-routes.js";
import type { DirectSessionService } from "./direct-sessions.js";
import type { OwnerRuntimeSessionService } from "./owner-runtime-sessions.js";
import {
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationInvitationSchema,
  CollaborationMemberSchema,
  CollaborationRevisionSchema,
  CollaborationRevokeRequestSchema,
  CollaborationScopeSchema,
} from "@matrix-os/contracts";
import type {
  Context,
} from "hono";
import {
  z,
} from "zod/v4";
import {
  CollaborationChatCommandError,
} from "../chat/collaboration-commands.js";
import {
  SharedChatQueueError,
} from "../chat/repository.js";
import type {
  RateLimiter,
} from "../security/rate-limiter.js";
import {
  CollaborationActorProofError,
  type CollaborationActorProofVerifier,
} from "./actor-proof.js";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
  type CollaborationAction,
  type CollaborationAuthority,
} from "./authority.js";
import type {
  CollaborationChatAdapter,
} from "./chat-adapter.js";
import type {
  CollaborationChatExecutionAdapter,
} from "./chat-execution-adapter.js";
import {
  CollaborationDiscussionError,
  type CollaborationDiscussionAdapter,
} from "./discussion-adapter.js";
import {
  CollaborationChatScopeError,
  type CollaborationChatScopeService,
} from "./chat-scope.js";
import type {
  createCollaborationProjectLifecycle,
} from "./project-lifecycle.js";
import {
  CollaborationProjectScopeError,
  type CollaborationProjectScopeService,
} from "./project-scope.js";
import {
  ProjectSharingError,
  type ProjectSharingService,
} from "./project-sharing.js";
import {
  ProjectInventoryError,
} from "./project-inventory.js";
import {
  ProjectTransitionError,
} from "./project-transition.js";
import {
  CollaborationTerminalAdapterError,
  type CollaborationTerminalAdapter,
} from "./terminal-adapter.js";
import {
  CollaborationTerminalDispatcherError,
  type CollaborationTerminalDispatcher,
} from "./terminal-dispatcher.js";
import type { CollaborationExecutionPolicyRepository } from "./execution-policy.js";
import { ProjectGitBrokerError, type ProjectGitBroker } from "./project-git-broker.js";
import type { ProjectAccessReadiness } from "./project-access-readiness.js";
import { ProjectAppAdapterError } from "./project-app-adapter.js";
import { ProjectResourceAdapterError } from "./project-adapters.js";
import { ResourceCatalogError } from "./resource-catalog.js";
import type { CollaborationResourceServices } from "./resource-routes.js";
import type { CollaborationCapabilityRepository } from "./capability-repository.js";
import type { CollaborationCapabilityEvaluator } from "./capability-evaluator.js";
import type { ReadinessProbes } from "./readiness-evaluator.js";
import {
  CollaborationRepositoryError,
  type CollaborationMemberRecord,
  type CollaborationRepository,
  type CollaborationScopeRecord,
} from "./repository.js";

export const PROOF_HEADER = "x-matrix-collaboration-proof";
export const MessageQuerySchema = z.object({
  after: CollaborationRevisionSchema.default("0"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type Participant = { actorId: string; displayName: string };

export interface CollaborationRouteOptions {
  runtimeId: string;
  verifier: CollaborationActorProofVerifier;
  /** S05: direct sessions; when a request carries session credentials they replace the relay proof. */
  directSessions?: DirectSessionService;
  ownerRuntimeSessions?: OwnerRuntimeSessionService;
  authority: CollaborationAuthority;
  repository: CollaborationRepository;
  chatScope: CollaborationChatScopeService;
  chatAdapter: CollaborationChatAdapter;
  discussionAdapter: CollaborationDiscussionAdapter;
  chatExecutionAdapter?: CollaborationChatExecutionAdapter;
  terminalAdapter?: CollaborationTerminalAdapter;
  terminalDispatcher?: CollaborationTerminalDispatcher;
  projectLifecycle?: Pick<
    ReturnType<typeof createCollaborationProjectLifecycle>,
    "apply" | "getOperation"
  >;
  projectScope?: CollaborationProjectScopeService;
  projectSharing?: ProjectSharingService;
  projectGit?: ProjectGitBroker;
  projectReadiness?: ProjectAccessReadiness;
  /** S15: exact V1 grant storage and fresh membership evaluator. */
  capabilities?: CollaborationCapabilityRepository;
  capabilityEvaluator?: CollaborationCapabilityEvaluator;
  readinessProbes?: ReadinessProbes;
  /** S08: owner-selected execution policy repository; routes report unavailable when absent. */
  executionPolicies?: CollaborationExecutionPolicyRepository;
  /** S12: catalog, file driver and app instances; file/app routes report unavailable when absent. */
  resources?: CollaborationResourceServices;
  resolveParticipant(actorId: string): Promise<Participant>;
  resolveInvitationIdentifier(identifier: string, organizationId: string): Promise<Participant>;
  invitationResolutionRateLimiter?: RateLimiter;
  onScopeCommitted?(scopeId: string): Promise<void>;
  onRevoked?(scopeId: string, actorId: string): void;
  onRoleChanged?(scopeId: string, actorId: string, role: "editor" | "viewer"): void;
  now?: () => Date;
}

export async function authorize(
  options: { verifier: CollaborationActorProofVerifier; directSessions?: DirectSessionService },
  c: Context,
  body: Uint8Array,
  action: CollaborationAction,
  scopeId: string,
): Promise<AuthorizedCollaborationContext> {
  // S05: a direct session authenticates the request on the home; the relay signed nothing.
  const credentials = readDirectCredentials(c);
  if (credentials) {
    if (!options.directSessions) throw new CollaborationAuthorizationError("unavailable", "Direct sessions are unavailable");
    const conditional = optionalDeleteConditions(c);
    const context = await options.directSessions.authorize({
      ...credentials,
      method: method(c),
      path: c.req.path,
      query: rawQuery(c),
      body,
      ...(conditional ? { conditionalHeadersDigest: digestDeleteConditions(conditional) } : {}),
      action,
    });
    if (context.scopeId !== scopeId) throw new CollaborationAuthorizationError("forbidden", "Scope access is required");
    return context;
  }
  const context = await options.verifier.verifyAndAuthorize({
    signedProof: decodeProof(c),
    method: method(c),
    path: c.req.path,
    query: rawQuery(c),
    body,
    conditionalHeaders: optionalDeleteConditions(c),
    action,
  });
  if (context.scopeId !== scopeId) throw new CollaborationAuthorizationError("forbidden", "Scope access is required");
  return context;
}

export function optionalDeleteConditions(c: Context) {
  if (c.req.method !== "DELETE") return undefined;
  return deleteConditions(c);
}

export function deleteConditions(c: Context) {
  return CollaborationRevokeRequestSchema.parse({
    clientRequestId: c.req.header(COLLABORATION_CLIENT_REQUEST_ID_HEADER),
    expectedRevision: c.req.header(COLLABORATION_EXPECTED_REVISION_HEADER),
    expectedMemberRevision: c.req.header(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER),
  });
}

export async function verifyHttp(verifier: CollaborationActorProofVerifier, c: Context, body: Uint8Array) {
  return verifier.verifyHttp({
    signedProof: decodeProof(c),
    method: method(c),
    path: c.req.path,
    query: rawQuery(c),
    body,
    conditionalHeaders: optionalDeleteConditions(c),
  });
}

/** Initial Share routes have no scope yet: authorize only the owner's exact runtime and organization. */
export async function ownerRuntimeIdentity(
  options: Pick<CollaborationRouteOptions, "verifier" | "ownerRuntimeSessions" | "runtimeId">,
  c: Context,
  body: Uint8Array,
  requestedRuntimeId: string,
  organizationId?: string,
): Promise<{ actorId: string; ownerId: string; runtimeId: string; organizationId?: string }> {
  const credentials = readDirectCredentials(c);
  if (credentials) {
    if (!options.ownerRuntimeSessions) throw new CollaborationAuthorizationError("unavailable", "Owner runtime sessions are unavailable");
    const session = await options.ownerRuntimeSessions.authenticate({
      ...credentials, method: "POST", path: c.req.path,
      query: rawQuery(c), body,
    });
    if (requestedRuntimeId !== options.runtimeId || (organizationId && session.organizationId !== organizationId)) {
      throw new CollaborationAuthorizationError("forbidden", "Owner runtime access is required");
    }
    return { actorId: session.actorId, ownerId: session.actorId, runtimeId: options.runtimeId, organizationId: session.organizationId };
  }
  const proof = await verifyHttp(options.verifier, c, body);
  requireOwnerCreationProof(proof, requestedRuntimeId, options.runtimeId);
  return { actorId: proof.actorId, ownerId: proof.ownerId, runtimeId: proof.runtimeId };
}

export function digestDeleteConditions(input: z.infer<typeof CollaborationRevokeRequestSchema>): string {
  return digest(new TextEncoder().encode(JSON.stringify(input)));
}

export function decodeProof(c: Context): unknown {
  const encoded = c.req.header(PROOF_HEADER);
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CollaborationActorProofError("invalid_proof", "Collaboration proof is invalid");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration-routes] proof decode failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new CollaborationActorProofError("invalid_proof", "Collaboration proof is invalid");
  }
}

export function requireExecutionAdapter(
  adapter: CollaborationChatExecutionAdapter | undefined,
): CollaborationChatExecutionAdapter {
  if (!adapter) throw new CollaborationAuthorizationError("unavailable", "Shared execution is unavailable");
  return adapter;
}

export function requireTerminalAdapter(adapter: CollaborationTerminalAdapter | undefined): CollaborationTerminalAdapter {
  if (!adapter) throw new CollaborationAuthorizationError("unavailable", "Shared terminal is unavailable");
  return adapter;
}

export function requireTerminalDispatcher(
  dispatcher: CollaborationTerminalDispatcher | undefined,
): CollaborationTerminalDispatcher {
  if (!dispatcher) throw new CollaborationAuthorizationError("unavailable", "Shared terminal is unavailable");
  return dispatcher;
}

export function requireProjectScope(service: CollaborationProjectScopeService | undefined): CollaborationProjectScopeService {
  if (!service) throw new CollaborationAuthorizationError("unavailable", "Shared project is unavailable");
  return service;
}

export function requireProjectSharing(service: ProjectSharingService | undefined): ProjectSharingService {
  if (!service) throw new CollaborationAuthorizationError("unavailable", "Shared project is unavailable");
  return service;
}

export async function readJson(c: Context): Promise<{ value: unknown; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, bytes };
}

/**
 * Proof-only owner operations (scope creation, project inventory/confirm,
 * lifecycle, operations, exports, invitation reads/decisions) never reach
 * CollaborationAuthority.authorize, so they call the organization precondition
 * here: current membership of the actor in the organization is required
 * before any read or write, and it fails closed with no source registered.
 */
export async function requireOrganizationMembership(
  options: { authority: Pick<CollaborationAuthority, "organizationPrecondition"> },
  actorId: string,
  organizationId: string | null | undefined,
): Promise<void> {
  await options.authority.organizationPrecondition.require({ organizationId, actorId });
}

export async function requireScopeOrganizationMembership(
  options: { authority: Pick<CollaborationAuthority, "organizationPrecondition">; repository: CollaborationRepository },
  scopeId: string,
  actorId: string,
): Promise<void> {
  const scope = await options.repository.getScope(scopeId);
  if (!scope) throw new CollaborationAuthorizationError("not_found", "Scope not found");
  await requireOrganizationMembership(options, actorId, scope.organizationId ?? null);
}

export function requireOwnerCreationProof(
  proof: { actorId: string; ownerId: string; runtimeId: string; scopeId?: string },
  requestedRuntimeId: string,
  runtimeId: string,
): void {
  if (proof.actorId !== proof.ownerId || proof.runtimeId !== requestedRuntimeId
    || requestedRuntimeId !== runtimeId || proof.scopeId !== undefined) {
    throw new CollaborationAuthorizationError("forbidden", "Owner runtime access is required");
  }
}

export function requireOwnerLifecycleProof(
  proof: { actorId: string; ownerId: string; scopeId?: string },
  scopeId: string,
): void {
  if (proof.scopeId !== scopeId || proof.actorId !== proof.ownerId) {
    throw new CollaborationAuthorizationError("forbidden", "Owner lifecycle access is required");
  }
}

export function requireProjectLifecycle(
  lifecycle: Pick<ReturnType<typeof createCollaborationProjectLifecycle>, "apply" | "getOperation"> | undefined,
) {
  if (!lifecycle) throw new CollaborationAuthorizationError("unavailable", "Project lifecycle is unavailable");
  return lifecycle;
}

export async function scopeProjection(
  scope: CollaborationScopeRecord,
  context: AuthorizedCollaborationContext,
  authority: CollaborationAuthority,
  chatScope: CollaborationChatScopeService,
): Promise<ReturnType<typeof CollaborationScopeSchema.parse>> {
  const mutable = scope.lifecycle === "shared";
  const terminal = scope.kind === "terminal";
  const requestAi = scope.kind === "chat"
    && chatScope.matchesCurrentExecutionCapability(scope)
    && authority.canRequestAi({
      kind: scope.kind,
      lifecycle: scope.lifecycle,
      owner_id: scope.ownerId,
      execution_generation: scope.executionGeneration,
      execution_eligibility: scope.executionEligibility,
    }, context.role);
  return CollaborationScopeSchema.parse({
    id: scope.id,
    ownerId: scope.ownerId,
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    kind: scope.kind,
    resourceId: scope.resourceId,
    ...(scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {}),
    membershipMode: scope.membershipMode,
    lifecycle: scope.lifecycle,
    revision: String(scope.revision),
    authEpoch: String(context.authEpoch),
    authorityGeneration: String(scope.authorityGeneration),
    role: context.role,
    capabilities: {
      read: true,
      discuss: context.role !== "viewer" && mutable,
      manageMembers: context.role === "owner" && scope.membershipMode === "direct" && mutable,
      requestAi,
      observeTerminal: terminal && mutable,
      controlTerminal: terminal && context.role !== "viewer" && mutable,
      stopTerminal: terminal && context.role === "owner" && mutable,
    },
  });
}

export function projectPreparationProjection(scope: CollaborationScopeRecord) {
  return CollaborationScopeSchema.parse({
    id: scope.id,
    ownerId: scope.ownerId,
    kind: "project",
    resourceId: scope.resourceId,
    membershipMode: "direct",
    lifecycle: scope.lifecycle,
    revision: String(scope.revision),
    authEpoch: String(scope.authEpoch),
    authorityGeneration: String(scope.authorityGeneration),
    role: "owner",
    capabilities: {
      read: false,
      discuss: false,
      manageMembers: true,
      requestAi: false,
      observeTerminal: false,
      controlTerminal: false,
      stopTerminal: false,
    },
  });
}

export async function memberProjection(
  options: { resolveParticipant(actorId: string): Promise<Participant> },
  member: CollaborationMemberRecord,
) {
  return CollaborationMemberSchema.parse({
    actor: await options.resolveParticipant(member.actorId),
    role: member.role,
    status: member.status,
    ...(member.invitationId ? { invitationId: member.invitationId } : {}),
    revision: String(member.revision),
    ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
    updatedAt: member.updatedAt,
  });
}

export async function invitationProjection(
  options: {
    repository: CollaborationRepository;
    resolveParticipant(actorId: string): Promise<Participant>;
  },
  member: CollaborationMemberRecord,
) {
  const scope = await requireScope(options.repository, member.scopeId);
  if (!member.invitationId || !member.expiresAt || member.role === "owner") {
    throw new CollaborationRepositoryError("not_found", "Invitation not found");
  }
  return CollaborationInvitationSchema.parse({
    id: member.invitationId,
    scopeId: member.scopeId,
    owner: await options.resolveParticipant(scope.ownerId),
    target: await options.resolveParticipant(member.actorId),
    scopeKind: scope.kind,
    role: member.role,
    status: member.status,
    expiresAt: member.expiresAt,
    revision: String(scope.revision),
  });
}

export async function requireScope(repository: CollaborationRepository, scopeId: string): Promise<CollaborationScopeRecord> {
  const scope = await repository.getScope(scopeId);
  if (!scope) throw new CollaborationRepositoryError("not_found", "Scope not found");
  return scope;
}

export async function requireInvitation(
  repository: CollaborationRepository,
  invitationId: string,
): Promise<CollaborationMemberRecord> {
  const invitation = await repository.getInvitation(invitationId);
  if (!invitation) throw new CollaborationRepositoryError("not_found", "Invitation not found");
  return invitation;
}

export function requireChatContext(context: AuthorizedCollaborationContext): void {
  if (context.resourceKind !== "chat") {
    throw new CollaborationAuthorizationError("unavailable", "Chat scope is unavailable");
  }
}

export async function notifyScope(
  options: { onScopeCommitted?(scopeId: string): Promise<void> },
  scopeId: string,
): Promise<void> {
  if (!options.onScopeCommitted) return;
  try {
    await options.onScopeCommitted(scopeId);
  } catch (error: unknown) {
    console.warn("[collaboration-routes] committed event delivery failed", error instanceof Error ? error.name : "UnknownError");
  }
}

export function exactQuery(c: Context, allowed: readonly string[]): Record<string, string> {
  const parameters = new URL(c.req.url).searchParams;
  const output: Record<string, string> = {};
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || key in output) throw new SyntaxError("Invalid query");
    output[key] = parameters.get(key)!;
  }
  return output;
}

export function rawQuery(c: Context): string {
  return new URL(c.req.url).search.slice(1);
}

export function method(c: Context): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  return c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

export function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function handle(c: Context, operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error: unknown) {
    const direct = directErrorResponse(c, error);
    if (direct) return direct;
    if (error instanceof CollaborationActorProofError) {
      if (error.code === "rate_limited") {
        return c.json({ error: "Try again later", code: "rate_limited" }, 429);
      }
      return c.json({ error: "Collaboration authentication failed", code: "unauthorized" }, 401);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ error: "Invalid collaboration request", code: "invalid_request" }, 400);
    }
    if (error instanceof CollaborationDiscussionError) {
      return c.json({ error: "Invalid collaboration request", code: error.code }, 400);
    }
    if (error instanceof ProjectGitBrokerError) {
      const status = error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : error.code === "busy" ? 429
            : error.code === "conflict" ? 409 : 503;
      return c.json({ error: "Collaboration unavailable", code: error.code }, status);
    }
    if (error instanceof CollaborationAuthorizationError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 503;
      return c.json({ error: "Collaboration unavailable", code: error.code }, status);
    }
    if (error instanceof CollaborationChatScopeError) {
      const status = error.code === "not_found" ? 404
        : error.code === "active_work" || error.code === "conflict" || error.code === "invalid_confirmation" ? 409
          : 503;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof CollaborationProjectScopeError) {
      const status = error.code === "not_found" ? 404
        : error.code === "conflict" || error.code === "invalid_confirmation" ? 409 : 503;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof ProjectSharingError || error instanceof ProjectInventoryError
      || error instanceof ProjectTransitionError) {
      const code = error instanceof ProjectInventoryError
        ? error.code === "project_changed" ? "conflict" : error.code === "invalid_confirmation" ? "conflict" : "unavailable"
        : error.code;
      const status = code === "not_found" ? 404
        : code === "forbidden" ? 403
          : code === "capacity" ? 429
            : code === "conflict" || code === "resource_blocked" ? 409 : 503;
      return c.json({ error: "Collaboration state changed", code }, status);
    }
    if (error instanceof CollaborationTerminalAdapterError
      || error instanceof CollaborationTerminalDispatcherError) {
      const status = error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : error.code === "capacity" ? 429
            : error.code === "conflict" || error.code === "invalid_confirmation"
              || error.code === "held" || error.code === "stale_lease" ? 409 : 503;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof ResourceCatalogError || error instanceof ProjectResourceAdapterError) {
      const status = error.code === "invalid" ? 400 : error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 503;
      return c.json({ error: status === 400 ? "Invalid collaboration request" : "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof ProjectAppAdapterError) {
      const status = error.code === "invalid_action" ? 400 : error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 503;
      return c.json({ error: status === 400 ? "Invalid collaboration request" : "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof CollaborationRepositoryError) {
      const status = error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : error.code === "capacity" ? 429
            : error.code === "expired" ? 410 : 409;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof SharedChatQueueError || error instanceof CollaborationChatCommandError) {
      const status = error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : error.code === "capacity" ? 429
            : error.code === "conflict" ? 409 : 503;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    console.warn("[collaboration-routes] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Collaboration unavailable", code: "unavailable" }, 503);
  }
}
