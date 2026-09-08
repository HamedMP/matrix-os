import { randomUUID } from "node:crypto";
import {
  type CollaborationOperation,
  type CollaborationScopeExport,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ChatRepository } from "../chat/repository.js";
import {
  ChatLifecycleRepository,
  MAX_COLLABORATION_EXPORT_BYTES,
  type ChatLifecycleInput,
} from "./chat-lifecycle-repository.js";
import {
  type CollaborationDatabase,
  type CollaborationMembersTable,
  type OwnerCollaborationDatabase,
} from "./database.js";
import {
  appendMutationRecords,
  CollaborationRepositoryError,
  jsonb,
  lockDirectScope,
  MAX_SCOPE_PARTICIPANTS,
  OPERATION_RETENTION_MS,
  parseJson,
  readOperationReplay,
  requireAcceptedOwner,
  type ScopeRow,
  toIso,
  updateScopeRevision,
  writeOperation,
} from "./repository-shared.js";

type Executor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;
type MemberRow = Selectable<CollaborationMembersTable>;

export {
  CollaborationRepositoryError,
  type CollaborationRepositoryErrorCode,
} from "./repository-shared.js";
export type { ChatLifecycleInput } from "./chat-lifecycle-repository.js";

export interface CollaborationScopeRecord {
  id: string;
  ownerId: string;
  kind: "chat" | "terminal" | "project";
  resourceId: string;
  parentScopeId?: string;
  membershipMode: "direct" | "inherited";
  lifecycle: "private" | "preparing" | "shared" | "archived" | "deleting" | "deleted" | "recovering";
  revision: number;
  authEpoch: number;
  authorityRuntimeId: string;
  authorityGeneration: number;
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

export class CollaborationRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly chatLifecycle: ChatLifecycleRepository;

  constructor(
    public readonly db: Kysely<OwnerCollaborationDatabase>,
    options: CollaborationRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.chatLifecycle = new ChatLifecycleRepository(db, {
      now: this.now,
      ...(options.chatRepository ? { chatRepository: options.chatRepository } : {}),
      maxExportBytes: options.maxExportBytes ?? MAX_COLLABORATION_EXPORT_BYTES,
    });
  }

  async createDirectScope(input: CreateDirectScopeInput): Promise<CollaborationScopeRecord> {
    const now = this.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      await trx.insertInto("collaboration_scopes").values({
        id: input.scopeId,
        owner_type: "personal",
        owner_id: input.ownerId,
        kind: input.kind,
        resource_id: input.resourceId,
        parent_scope_id: null,
        membership_mode: "direct",
        lifecycle: "private",
        authority_runtime_id: input.authorityRuntimeId,
        execution_generation: null,
        execution_eligibility: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      }).onConflict((conflict) => conflict
        .columns(["owner_type", "owner_id", "kind", "resource_id"])
        .where("deleted_at", "is", null)
        .where("lifecycle", "!=", "deleted")
        .doNothing()).execute();

      const scope = await trx.selectFrom("collaboration_scopes")
        .selectAll()
        .where("owner_type", "=", "personal")
        .where("owner_id", "=", input.ownerId)
        .where("kind", "=", input.kind)
        .where("resource_id", "=", input.resourceId)
        .where("deleted_at", "is", null)
        .where("lifecycle", "!=", "deleted")
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (scope.membership_mode !== "direct") {
        throw new CollaborationRepositoryError("conflict", "Resource uses inherited membership");
      }
      await trx.insertInto("collaboration_members").values({
        scope_id: scope.id,
        actor_id: input.ownerId,
        role: "owner",
        status: "accepted",
        invitation_id: null,
        invited_by: input.ownerId,
        accepted_at: now,
        expires_at: null,
        joined_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.columns(["scope_id", "actor_id"]).doNothing()).execute();

      const owner = await trx.selectFrom("collaboration_members")
        .select(["role", "status"])
        .where("scope_id", "=", scope.id)
        .where("actor_id", "=", input.ownerId)
        .executeTakeFirstOrThrow();
      if (owner.role !== "owner" || owner.status !== "accepted") {
        throw new CollaborationRepositoryError("conflict", "Scope owner membership is invalid");
      }
      return toScope(scope);
    });
  }

  async getScope(scopeId: string): Promise<CollaborationScopeRecord | null> {
    const row = await this.db.selectFrom("collaboration_scopes")
      .selectAll()
      .where("id", "=", scopeId)
      .where("deleted_at", "is", null)
      .where("lifecycle", "!=", "deleted")
      .executeTakeFirst();
    return row ? toScope(row) : null;
  }

  async getMember(scopeId: string, actorId: string): Promise<CollaborationMemberRecord | null> {
    const row = await this.db.selectFrom("collaboration_members")
      .selectAll()
      .where("scope_id", "=", scopeId)
      .where("actor_id", "=", actorId)
      .executeTakeFirst();
    return row ? toMember(row) : null;
  }

  async getInvitation(invitationId: string): Promise<CollaborationMemberRecord | null> {
    const row = await this.db.selectFrom("collaboration_members")
      .selectAll()
      .where("invitation_id", "=", invitationId)
      .executeTakeFirst();
    return row ? toMember(row) : null;
  }

  async listMembers(
    scopeId: string,
    options: { includePending: boolean },
  ): Promise<CollaborationMemberRecord[]> {
    let query = this.db.selectFrom("collaboration_members")
      .selectAll()
      .where("scope_id", "=", scopeId);
    if (!options.includePending) query = query.where("status", "=", "accepted");
    const rows = await query.orderBy("updated_at", "asc").orderBy("actor_id", "asc").execute();
    return rows.map(toMember);
  }

  async createInvitation(input: CreateInvitationInput): Promise<InvitationMutationResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const scope = await lockDirectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, input.scopeId, input.actorId);
      const replay = await readOperationReplay<InvitationMutationResult>(trx, input, "invitation.create");
      if (replay) return replay;
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      if (input.targetActorId === scope.owner_id) {
        throw new CollaborationRepositoryError("conflict", "Owner is already a member");
      }

      const occupied = await trx.selectFrom("collaboration_members")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("scope_id", "=", input.scopeId)
        .where((eb) => eb.or([
          eb("status", "=", "accepted"),
          eb.and([eb("status", "=", "pending"), eb("expires_at", ">", now)]),
        ]))
        .executeTakeFirstOrThrow();
      if (Number(occupied.count) >= MAX_SCOPE_PARTICIPANTS) {
        throw new CollaborationRepositoryError("capacity", "Scope participant capacity reached");
      }

      const currentTarget = await trx.selectFrom("collaboration_members")
        .selectAll()
        .where("scope_id", "=", input.scopeId)
        .where("actor_id", "=", input.targetActorId)
        .executeTakeFirst();
      const targetInvitationExpired = currentTarget?.status === "pending"
        && currentTarget.expires_at !== null
        && new Date(currentTarget.expires_at).getTime() <= nowDate.getTime();
      if (currentTarget && !["revoked", "expired"].includes(currentTarget.status) && !targetInvitationExpired) {
        throw new CollaborationRepositoryError("conflict", "Target already has membership state");
      }

      const invitationId = this.createId();
      const memberRevision = Number(currentTarget?.revision ?? 0) + 1;
      if (currentTarget) {
        const renewed = await trx.updateTable("collaboration_members").set({
          role: input.role,
          status: "pending",
          invitation_id: invitationId,
          invited_by: input.actorId,
          accepted_at: null,
          expires_at: input.expiresAt,
          revision: memberRevision,
          joined_at: null,
          updated_at: now,
        }).where("scope_id", "=", input.scopeId)
          .where("actor_id", "=", input.targetActorId)
          .where("revision", "=", Number(currentTarget.revision))
          .returning("revision")
          .executeTakeFirst();
        if (!renewed) throw new CollaborationRepositoryError("conflict", "Membership revision changed");
      } else {
        await trx.insertInto("collaboration_members").values({
          scope_id: input.scopeId,
          actor_id: input.targetActorId,
          role: input.role,
          status: "pending",
          invitation_id: invitationId,
          invited_by: input.actorId,
          accepted_at: null,
          expires_at: input.expiresAt,
          revision: memberRevision,
          joined_at: null,
          updated_at: now,
        }).execute();
      }

      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, input.scopeId, input.expectedRevision, nextRevision, now);
      const result = { invitationId, scopeId: input.scopeId, scopeRevision: nextRevision, memberRevision };
      await writeOperation(trx, input, "invitation.create", scope, result, now, operationExpiresAt);
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action: "invitation.created",
        recipients: [{ actorId: input.targetActorId, invitationId }],
        discoveryState: "invited",
        now,
      });
      return result;
    });
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<InvitationMutationResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    const result = await this.db.transaction().execute(async (trx) => {
      const invitation = await trx.selectFrom("collaboration_members")
        .select(["scope_id"])
        .where("invitation_id", "=", input.invitationId)
        .where("actor_id", "=", input.actorId)
        .executeTakeFirst();
      if (!invitation) throw new CollaborationRepositoryError("not_found", "Invitation not found");
      // All membership mutations lock the scope before a member row. Keeping one
      // lock order prevents accept/revoke deadlocks on real PostgreSQL.
      const scope = await lockDirectScope(trx, invitation.scope_id);
      const member = await trx.selectFrom("collaboration_members")
        .selectAll()
        .where("scope_id", "=", invitation.scope_id)
        .where("invitation_id", "=", input.invitationId)
        .where("actor_id", "=", input.actorId)
        .forUpdate()
        .executeTakeFirst();
      if (!member) throw new CollaborationRepositoryError("not_found", "Invitation not found");
      const replay = await readOperationReplay<InvitationMutationResult>(
        trx,
        { ...input, scopeId: member.scope_id },
        "invitation.accept",
      );
      if (replay) return { kind: "accepted" as const, value: replay };
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      if (member.status !== "pending") {
        throw new CollaborationRepositoryError(
          member.status === "expired" ? "expired" : "conflict",
          "Invitation is not pending",
        );
      }
      if (!member.expires_at || new Date(member.expires_at).getTime() <= nowDate.getTime()) {
        const memberRevision = Number(member.revision) + 1;
        const expired = await trx.updateTable("collaboration_members").set({
          status: "expired",
          revision: memberRevision,
          updated_at: now,
        }).where("scope_id", "=", member.scope_id)
          .where("actor_id", "=", input.actorId)
          .where("status", "=", "pending")
          .where("revision", "=", Number(member.revision))
          .returning("revision")
          .executeTakeFirst();
        if (!expired) throw new CollaborationRepositoryError("conflict", "Invitation state changed");
        const nextRevision = input.expectedRevision + 1;
        await updateScopeRevision(trx, member.scope_id, input.expectedRevision, nextRevision, now);
        await appendMutationRecords(trx, {
          scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
          actorId: input.actorId,
          action: "invitation.expired",
          recipients: [{ actorId: input.actorId, invitationId: input.invitationId }],
          discoveryState: "revoked",
          now,
          reasonCode: "expired",
        });
        return { kind: "expired" as const };
      }

      const memberRevision = Number(member.revision) + 1;
      const accepted = await trx.updateTable("collaboration_members").set({
        status: "accepted",
        accepted_at: now,
        joined_at: member.joined_at ?? now,
        revision: memberRevision,
        updated_at: now,
      }).where("scope_id", "=", member.scope_id)
        .where("actor_id", "=", input.actorId)
        .where("status", "=", "pending")
        .where("revision", "=", Number(member.revision))
        .returning("revision")
        .executeTakeFirst();
      if (!accepted) throw new CollaborationRepositoryError("conflict", "Invitation state changed");
      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, member.scope_id, input.expectedRevision, nextRevision, now);
      const value = {
        invitationId: input.invitationId,
        scopeId: member.scope_id,
        scopeRevision: nextRevision,
        memberRevision,
      };
      await writeOperation(
        trx,
        { ...input, scopeId: member.scope_id },
        "invitation.accept",
        scope,
        value,
        now,
        operationExpiresAt,
      );
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action: "invitation.accepted",
        recipients: [{ actorId: input.actorId, invitationId: input.invitationId }],
        discoveryState: "accepted",
        now,
      });
      return { kind: "accepted" as const, value };
    });
    if (result.kind === "expired") {
      throw new CollaborationRepositoryError("expired", "Invitation expired");
    }
    return result.value;
  }

  async revokeInvitation(input: RevokeInvitationInput): Promise<MemberMutationResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const scope = await lockDirectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, input.scopeId, input.actorId);
      const replay = await readOperationReplay<MemberMutationResult>(trx, input, "invitation.revoked");
      if (replay) return replay;
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      const member = await trx.selectFrom("collaboration_members")
        .selectAll()
        .where("scope_id", "=", input.scopeId)
        .where("invitation_id", "=", input.invitationId)
        .forUpdate()
        .executeTakeFirst();
      if (!member) throw new CollaborationRepositoryError("not_found", "Invitation not found");
      if (member.status !== "pending" || Number(member.revision) !== input.expectedMemberRevision) {
        throw new CollaborationRepositoryError("conflict", "Invitation state changed");
      }
      const memberRevision = input.expectedMemberRevision + 1;
      const updated = await trx.updateTable("collaboration_members").set({
        status: "revoked",
        revision: memberRevision,
        updated_at: now,
      }).where("scope_id", "=", input.scopeId)
        .where("actor_id", "=", member.actor_id)
        .where("status", "=", "pending")
        .where("revision", "=", input.expectedMemberRevision)
        .returning("actor_id")
        .executeTakeFirst();
      if (!updated) throw new CollaborationRepositoryError("conflict", "Invitation state changed");
      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, input.scopeId, input.expectedRevision, nextRevision, now);
      const result: MemberMutationResult = {
        scopeId: input.scopeId,
        actorId: member.actor_id,
        role: member.role as "editor" | "viewer",
        status: "revoked",
        scopeRevision: nextRevision,
        memberRevision,
      };
      await writeOperation(trx, input, "invitation.revoked", scope, result, now, operationExpiresAt);
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action: "invitation.revoked",
        recipients: [{ actorId: member.actor_id, invitationId: input.invitationId }],
        discoveryState: "revoked",
        now,
      });
      return result;
    });
  }

  async getChatUserState(chatId: string, actorId: string): Promise<{
    readThroughSeq: number;
    pinned: boolean;
    muted: boolean;
    lastOpenedAt?: string;
  }> {
    const row = await this.db.selectFrom("chat_user_state")
      .select(["read_through_seq", "pinned", "muted", "last_opened_at"])
      .where("chat_id", "=", chatId)
      .where("principal_id", "=", actorId)
      .executeTakeFirst();
    return row ? {
      readThroughSeq: Number(row.read_through_seq),
      pinned: row.pinned,
      muted: row.muted,
      ...(row.last_opened_at === null ? {} : { lastOpenedAt: toIso(row.last_opened_at) }),
    } : { readThroughSeq: 0, pinned: false, muted: false };
  }

  async updateChatUserState(input: {
    chatId: string;
    actorId: string;
    readThroughSeq?: number;
    pinned?: boolean;
    muted?: boolean;
    openedAt?: string;
  }): Promise<void> {
    const now = this.now().toISOString();
    await this.db.insertInto("chat_user_state").values({
      chat_id: input.chatId,
      principal_id: input.actorId,
      read_through_seq: input.readThroughSeq ?? 0,
      pinned: input.pinned ?? false,
      muted: input.muted ?? false,
      attention_acknowledged_at: null,
      last_opened_at: input.openedAt ?? null,
      updated_at: now,
    }).onConflict((conflict) => conflict.columns(["chat_id", "principal_id"]).doUpdateSet({
      ...(input.readThroughSeq === undefined ? {} : {
        read_through_seq: sql<number>`GREATEST(chat_user_state.read_through_seq, ${input.readThroughSeq})`,
      }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.muted === undefined ? {} : { muted: input.muted }),
      ...(input.openedAt === undefined ? {} : { last_opened_at: input.openedAt }),
      updated_at: now,
    })).execute();
  }

  async changeMemberRole(input: ChangeMemberRoleInput): Promise<MemberMutationResult> {
    return this.mutateMember(input, "member.role_changed", input.role);
  }

  async revokeMember(input: MemberMutationInput): Promise<MemberMutationResult> {
    return this.mutateMember(input, "member.revoked");
  }

  async applyChatLifecycle(input: ChatLifecycleInput): Promise<CollaborationOperation> {
    return this.chatLifecycle.apply(input);
  }

  async getLifecycleOperation(
    scopeId: string,
    actorId: string,
    operationId: string,
  ): Promise<CollaborationOperation | null> {
    return this.chatLifecycle.getOperation(scopeId, actorId, operationId);
  }

  async getScopeExport(
    scopeId: string,
    actorId: string,
    exportId: string,
  ): Promise<CollaborationScopeExport | null> {
    return this.chatLifecycle.getExport(scopeId, actorId, exportId);
  }

  private async mutateMember(
    input: MemberMutationInput,
    action: "member.role_changed" | "member.revoked",
    role?: "editor" | "viewer",
  ): Promise<MemberMutationResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const scope = await lockDirectScope(trx, input.scopeId);
      const actingMember = await trx.selectFrom("collaboration_members")
        .select(["role", "status"])
        .where("scope_id", "=", input.scopeId)
        .where("actor_id", "=", input.actorId)
        .executeTakeFirst();
      const canLeave = action === "member.revoked" && input.actorId === input.targetActorId;
      if (!actingMember || actingMember.status !== "accepted"
        || (actingMember.role !== "owner" && !canLeave)) {
        throw new CollaborationRepositoryError("forbidden", "Member management is not allowed");
      }
      const replay = await readOperationReplay<MemberMutationResult>(trx, input, action);
      if (replay) return replay;
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      const member = await trx.selectFrom("collaboration_members")
        .selectAll()
        .where("scope_id", "=", input.scopeId)
        .where("actor_id", "=", input.targetActorId)
        .forUpdate()
        .executeTakeFirst();
      if (!member) throw new CollaborationRepositoryError("not_found", "Member not found");
      if (member.role === "owner") {
        throw new CollaborationRepositoryError("forbidden", "The final owner cannot be changed or removed");
      }
      if (member.status !== "accepted" || Number(member.revision) !== input.expectedMemberRevision) {
        throw new CollaborationRepositoryError("conflict", "Membership state changed");
      }

      const memberRevision = input.expectedMemberRevision + 1;
      const status = action === "member.revoked" ? "revoked" : "accepted";
      const updated = await trx.updateTable("collaboration_members").set({
        ...(role ? { role } : {}),
        status,
        revision: memberRevision,
        updated_at: now,
      }).where("scope_id", "=", input.scopeId)
        .where("actor_id", "=", input.targetActorId)
        .where("status", "=", "accepted")
        .where("revision", "=", input.expectedMemberRevision)
        .returning("actor_id")
        .executeTakeFirst();
      if (!updated) throw new CollaborationRepositoryError("conflict", "Membership state changed");

      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, input.scopeId, input.expectedRevision, nextRevision, now);
      const result: MemberMutationResult = {
        scopeId: input.scopeId,
        actorId: input.targetActorId,
        role: role ?? (member.role as "editor" | "viewer"),
        status,
        scopeRevision: nextRevision,
        memberRevision,
      };
      await writeOperation(trx, input, action, scope, result, now, operationExpiresAt);
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action,
        recipients: [{
          actorId: input.targetActorId,
          ...(member.invitation_id ? { invitationId: member.invitation_id } : {}),
        }],
        discoveryState: status === "revoked" ? "revoked" : "accepted",
        now,
      });
      return result;
    });
  }
}

function toScope(row: ScopeRow): CollaborationScopeRecord {
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
  };
}

function toMember(row: MemberRow): CollaborationMemberRecord {
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

export type { CollaborationDatabase };
