import {
  type Kysely,
} from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  appendMutationRecords,
  CollaborationRepositoryError,
  lockDirectScope,
  MAX_SCOPE_PARTICIPANTS,
  OPERATION_RETENTION_MS,
  readOperationReplay,
  requireAcceptedOwner,
  updateScopeRevision,
  writeOperation,
} from "./repository-shared.js";
import {
  requireInvitationMutationLifecycle,
  shouldPublishMembershipDirectory,
  type AcceptInvitationInput,
  type ChangeMemberRoleInput,
  type CreateInvitationInput,
  type DeclineInvitationInput,
  type InvitationMutationResult,
  type MemberMutationInput,
  type MemberMutationResult,
  type RevokeInvitationInput,
} from "./repository-types.js";

/**
 * Extracted verbatim from packages/gateway/src/collaboration/repository.ts
 * (S01 / T008): invitation and member grant mutations. Every method keeps its
 * original single-transaction scope and lock order (scope row before member row).
 */
export class CollaborationGrantRepository {
  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    private readonly options: { now: () => Date; createId: () => string },
  ) {}

  private get now(): () => Date {
    return this.options.now;
  }

  private get createId(): () => string {
    return this.options.createId;
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
      requireInvitationMutationLifecycle(scope);
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
        publishDirectory: shouldPublishMembershipDirectory(scope),
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
      requireInvitationMutationLifecycle(scope);
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
          publishDirectory: shouldPublishMembershipDirectory(scope),
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
        publishDirectory: shouldPublishMembershipDirectory(scope),
        now,
      });
      return { kind: "accepted" as const, value };
    });
    if (result.kind === "expired") {
      throw new CollaborationRepositoryError("expired", "Invitation expired");
    }
    return result.value;
  }

  async declineInvitation(input: DeclineInvitationInput): Promise<MemberMutationResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationExpiresAt = new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString();
    return this.db.transaction().execute(async (trx) => {
      const invitation = await trx.selectFrom("collaboration_members")
        .select("scope_id")
        .where("invitation_id", "=", input.invitationId)
        .where("actor_id", "=", input.actorId)
        .executeTakeFirst();
      if (!invitation) throw new CollaborationRepositoryError("not_found", "Invitation not found");
      const scope = await lockDirectScope(trx, invitation.scope_id);
      const member = await trx.selectFrom("collaboration_members")
        .selectAll()
        .where("scope_id", "=", invitation.scope_id)
        .where("invitation_id", "=", input.invitationId)
        .where("actor_id", "=", input.actorId)
        .forUpdate()
        .executeTakeFirst();
      if (!member) throw new CollaborationRepositoryError("not_found", "Invitation not found");
      const scopedInput = { ...input, scopeId: member.scope_id };
      const replay = await readOperationReplay<MemberMutationResult>(
        trx,
        scopedInput,
        "invitation.declined",
      );
      if (replay) return replay;
      requireInvitationMutationLifecycle(scope);
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
        throw new CollaborationRepositoryError("expired", "Invitation expired");
      }
      const memberRevision = Number(member.revision) + 1;
      const updated = await trx.updateTable("collaboration_members").set({
        status: "revoked",
        revision: memberRevision,
        updated_at: now,
      }).where("scope_id", "=", member.scope_id)
        .where("actor_id", "=", input.actorId)
        .where("status", "=", "pending")
        .where("revision", "=", Number(member.revision))
        .returning("actor_id")
        .executeTakeFirst();
      if (!updated) throw new CollaborationRepositoryError("conflict", "Invitation state changed");
      const nextRevision = input.expectedRevision + 1;
      await updateScopeRevision(trx, member.scope_id, input.expectedRevision, nextRevision, now);
      const result: MemberMutationResult = {
        scopeId: member.scope_id,
        actorId: member.actor_id,
        role: member.role as "editor" | "viewer",
        status: "revoked",
        scopeRevision: nextRevision,
        memberRevision,
      };
      await writeOperation(trx, scopedInput, "invitation.declined", scope, result, now, operationExpiresAt);
      await appendMutationRecords(trx, {
        scope: { ...scope, revision: nextRevision, auth_epoch: Number(scope.auth_epoch) + 1 },
        actorId: input.actorId,
        action: "invitation.declined",
        recipients: [{ actorId: input.actorId, invitationId: input.invitationId }],
        discoveryState: "revoked",
        publishDirectory: shouldPublishMembershipDirectory(scope),
        now,
      });
      return result;
    });
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
      requireInvitationMutationLifecycle(scope);
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
        publishDirectory: shouldPublishMembershipDirectory(scope),
        now,
      });
      return result;
    });
  }

  async changeMemberRole(input: ChangeMemberRoleInput): Promise<MemberMutationResult> {
    return this.mutateMember(input, "member.role_changed", input.role);
  }

  async revokeMember(input: MemberMutationInput): Promise<MemberMutationResult> {
    return this.mutateMember(input, "member.revoked");
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
      if (scope.lifecycle !== "shared") {
        throw new CollaborationRepositoryError("conflict", "Scope membership is not mutable");
      }
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
        publishDirectory: shouldPublishMembershipDirectory(scope),
        now,
      });
      return result;
    });
  }
}
