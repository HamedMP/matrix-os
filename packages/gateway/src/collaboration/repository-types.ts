import type { Selectable } from "kysely";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatLifecycleInput } from "./chat-lifecycle-repository.js";
import type { CollaborationMembersTable } from "./database.js";
import { CollaborationRepositoryError, type ScopeRow, toIso } from "./repository-shared.js";

export type MemberRow = Selectable<CollaborationMembersTable>;

/** Extracted verbatim from packages/gateway/src/collaboration/repository.ts (S01 / T008): record contracts and row mappers. */
export interface CollaborationScopeRecord {
  id: string;
  ownerId: string;
  /** Owning organization; absent only on pre-organization rows that the precondition denies. */
  organizationId?: string;
  kind: "chat" | "terminal" | "project";
  resourceId: string;
  parentScopeId?: string;
  membershipMode: "direct" | "inherited";
  lifecycle: "private" | "preparing" | "shared" | "archived" | "deleting" | "deleted" | "recovering";
  revision: number;
  authEpoch: number;
  authorityRuntimeId: string;
  authorityGeneration: number;
  executionGeneration: number | null;
  executionEligibility: unknown | null;
}

export interface CollaborationMemberRecord {
  scopeId: string;
  actorId: string;
  role: "owner" | "editor" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  invitationId?: string;
  invitedBy: string;
  acceptedAt?: string;
  expiresAt?: string;
  revision: number;
  joinedAt?: string;
  updatedAt: string;
}

export interface CreateDirectScopeInput {
  scopeId: string;
  ownerId: string;
  organizationId: string;
  kind: "chat" | "terminal" | "project";
  resourceId: string;
  authorityRuntimeId: string;
}

export interface CreateInvitationInput {
  scopeId: string;
  actorId: string;
  targetActorId: string;
  role: "editor" | "viewer";
  clientRequestId: string;
  expectedRevision: number;
  payloadHash: string;
  expiresAt: string;
}

export interface AcceptInvitationInput {
  invitationId: string;
  actorId: string;
  clientRequestId: string;
  expectedRevision: number;
  payloadHash: string;
}

export interface DeclineInvitationInput extends AcceptInvitationInput {}

export interface MemberMutationInput {
  scopeId: string;
  actorId: string;
  targetActorId: string;
  clientRequestId: string;
  expectedRevision: number;
  expectedMemberRevision: number;
  payloadHash: string;
}

export interface ChangeMemberRoleInput extends MemberMutationInput {
  role: "editor" | "viewer";
}

export interface RevokeInvitationInput {
  scopeId: string;
  invitationId: string;
  actorId: string;
  clientRequestId: string;
  expectedRevision: number;
  expectedMemberRevision: number;
  payloadHash: string;
}

export interface InvitationMutationResult {
  invitationId: string;
  scopeId: string;
  scopeRevision: number;
  memberRevision: number;
}

export interface MemberMutationResult {
  scopeId: string;
  actorId: string;
  role: "editor" | "viewer";
  status: "accepted" | "revoked";
  scopeRevision: number;
  memberRevision: number;
}

export interface CollaborationRepositoryOptions {
  now?: () => Date;
  createId?: () => string;
  chatRepository?: ChatRepository;
  maxExportBytes?: number;
}

export interface TerminalExportInput extends Omit<ChatLifecycleInput, "type"> {
  type: "export";
}

export function requireInvitationMutationLifecycle(scope: ScopeRow): void {
  if (scope.lifecycle !== "private" && scope.lifecycle !== "shared") {
    throw new CollaborationRepositoryError("conflict", "Scope membership is not mutable");
  }
}

export function shouldPublishMembershipDirectory(scope: ScopeRow): boolean {
  return scope.kind !== "project" || scope.lifecycle === "shared" || scope.lifecycle === "archived";
}

export function toScope(row: ScopeRow): CollaborationScopeRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    resourceId: row.resource_id,
    ...(row.parent_scope_id === null ? {} : { parentScopeId: row.parent_scope_id }),
    membershipMode: row.membership_mode,
    lifecycle: row.lifecycle,
    revision: Number(row.revision),
    authEpoch: Number(row.auth_epoch),
    authorityRuntimeId: row.authority_runtime_id,
    authorityGeneration: Number(row.authority_generation),
    executionGeneration: row.execution_generation === null ? null : Number(row.execution_generation),
    ...(row.organization_id === null || row.organization_id === undefined ? {} : { organizationId: row.organization_id }),
    executionEligibility: row.execution_eligibility,
  };
}

export function toMember(row: MemberRow): CollaborationMemberRecord {
  return {
    scopeId: row.scope_id,
    actorId: row.actor_id,
    role: row.role,
    status: row.status,
    ...(row.invitation_id === null ? {} : { invitationId: row.invitation_id }),
    invitedBy: row.invited_by,
    ...(row.accepted_at === null ? {} : { acceptedAt: toIso(row.accepted_at) }),
    ...(row.expires_at === null ? {} : { expiresAt: toIso(row.expires_at) }),
    revision: Number(row.revision),
    ...(row.joined_at === null ? {} : { joinedAt: toIso(row.joined_at) }),
    updatedAt: toIso(row.updated_at),
  };
}
