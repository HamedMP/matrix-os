import { randomUUID } from "node:crypto";
import {
  CanonicalChatMessagePartSchema,
  CollaborationOperationSchema,
  CollaborationScopeExportSchema,
  type CollaborationOperation,
  type CollaborationScopeExport,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  type CollaborationDatabase,
  type CollaborationMembersTable,
  type CollaborationScopesTable,
  type OwnerCollaborationDatabase,
} from "./database.js";

const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SCOPE_PARTICIPANTS = 8;
const MAX_EXPORT_MESSAGES = 100_000;
const MAX_EXPORT_ATTACHMENTS = 100_000;
const MAX_EXPORT_AUDIT_RECORDS = 10_000;

type Executor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;
type ScopeRow = Selectable<CollaborationScopesTable>;
type MemberRow = Selectable<CollaborationMembersTable>;

export type CollaborationRepositoryErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "capacity"
  | "expired";

export class CollaborationRepositoryError extends Error {
  constructor(
    public readonly code: CollaborationRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationRepositoryError";
  }
}

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
}

export interface ChatLifecycleInput {
  scopeId: string;
  actorId: string;
  type: "archive" | "restore" | "export" | "delete" | "transfer" | "recover";
  clientRequestId: string;
  expectedRevision: number;
  payloadHash: string;
  successorActorId?: string;
  expectedMemberRevision?: number;
}

export class CollaborationRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    public readonly db: Kysely<OwnerCollaborationDatabase>,
    options: CollaborationRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
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
    if (["transfer", "recover"].includes(input.type)) {
      throw new CollaborationRepositoryError("conflict", "Lifecycle action is not available for standalone Chats");
    }
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const operationKind = `lifecycle.${input.type}`;
    return this.db.transaction().execute(async (trx) => {
      const replay = await readOperationReplay<CollaborationOperation>(trx, input, operationKind);
      if (replay) return CollaborationOperationSchema.parse(replay);
      const scope = await lockDirectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, input.scopeId, input.actorId);
      if (scope.kind !== "chat" || scope.owner_id !== input.actorId) {
        throw new CollaborationRepositoryError("forbidden", "Owner Chat lifecycle access required");
      }
      if (Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      const chat = await trx.selectFrom("chats").selectAll()
        .where("id", "=", scope.resource_id)
        .where("owner_type", "=", scope.owner_type)
        .where("owner_id", "=", scope.owner_id)
        .forUpdate()
        .executeTakeFirst();
      if (!chat || !chatBindingMatches(chat.collaboration, scope.id)) {
        throw new CollaborationRepositoryError("not_found", "Shared Chat not found");
      }

      if (input.type === "export") {
        await appendLifecycleAudit(trx, scope, input.actorId, "scope.exported", now);
        const exportId = input.clientRequestId;
        const expiresAt = new Date(nowDate.getTime() + EXPORT_RETENTION_MS).toISOString();
        const payload = await buildChatScopeExport(trx, scope, chat, exportId, now, expiresAt);
        await trx.insertInto("collaboration_exports").values({
          id: exportId,
          scope_id: scope.id,
          owner_id: scope.owner_id,
          payload: jsonb(payload),
          created_at: now,
          expires_at: expiresAt,
        }).execute();
        const result = CollaborationOperationSchema.parse({
          id: input.clientRequestId,
          scopeId: scope.id,
          type: input.type,
          status: "completed",
          revision: String(scope.revision),
          exportId,
          createdAt: now,
        });
        await writeOperation(
          trx, input, operationKind, scope, result, now,
          new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString(),
        );
        return result;
      }

      const activeRun = await trx.selectFrom("chat_runs").select("id")
        .where("chat_id", "=", chat.id)
        .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
        .executeTakeFirst();
      if (activeRun) throw new CollaborationRepositoryError("conflict", "Shared Chat has active work");
      const expectedLifecycle = input.type === "restore" ? "archived" : undefined;
      if ((input.type === "archive" && scope.lifecycle !== "shared")
        || (input.type === "restore" && scope.lifecycle !== expectedLifecycle)
        || (input.type === "delete" && !["shared", "archived"].includes(scope.lifecycle))) {
        throw new CollaborationRepositoryError("conflict", "Scope lifecycle changed");
      }
      const nextRevision = input.expectedRevision + 1;
      const nextChatRevision = Number(chat.revision) + 1;
      const nextLifecycle = input.type === "archive" ? "archived"
        : input.type === "restore" ? "shared" : "deleted";
      const updatedScope = await trx.updateTable("collaboration_scopes").set({
        lifecycle: nextLifecycle,
        revision: nextRevision,
        auth_epoch: sql<number>`auth_epoch + 1`,
        updated_at: now,
        ...(input.type === "delete" ? { deleted_at: now } : {}),
      }).where("id", "=", scope.id)
        .where("revision", "=", input.expectedRevision)
        .where("lifecycle", "=", scope.lifecycle)
        .returningAll().executeTakeFirst();
      if (!updatedScope) throw new CollaborationRepositoryError("conflict", "Scope lifecycle changed");

      await trx.insertInto("chat_outbox").values({
        owner_type: scope.owner_type,
        owner_id: scope.owner_id,
        chat_id: chat.id,
        revision: nextChatRevision,
        event_type: input.type === "delete" ? "chat.deleted" : "chat.updated",
        payload: jsonb({}),
        created_at: now,
      }).execute();
      if (input.type === "delete") {
        const deletion = await trx.insertInto("chat_deletions").values({
          owner_type: scope.owner_type,
          owner_id: scope.owner_id,
          chat_id: chat.id,
          request_id: input.clientRequestId,
          deleted_at: now,
        }).onConflict((conflict) => conflict.columns(["owner_type", "owner_id", "request_id"]).doNothing())
          .returning("chat_id").executeTakeFirst();
        if (!deletion) throw new CollaborationRepositoryError("conflict", "Chat deletion request changed");
        await trx.deleteFrom("chats").where("id", "=", chat.id)
          .where("owner_type", "=", scope.owner_type).where("owner_id", "=", scope.owner_id).execute();
      } else {
        const updatedChat = await trx.updateTable("chats").set({
          lifecycle: input.type === "archive" ? "archived" : "active",
          revision: nextChatRevision,
          updated_at: now,
        }).where("id", "=", chat.id).where("revision", "=", Number(chat.revision))
          .returning("id").executeTakeFirst();
        if (!updatedChat) throw new CollaborationRepositoryError("conflict", "Chat changed");
      }

      const result = CollaborationOperationSchema.parse({
        id: input.clientRequestId,
        scopeId: scope.id,
        type: input.type,
        status: "completed",
        revision: String(nextRevision),
        createdAt: now,
      });
      await writeOperation(
        trx, input, operationKind, scope, result, now,
        new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString(),
      );
      const memberRows = await trx.selectFrom("collaboration_members")
        .select(["actor_id", "invitation_id", "status"])
        .where("scope_id", "=", scope.id)
        .where("status", "in", input.type === "delete" ? ["accepted", "pending"] : ["accepted"])
        .execute();
      await appendMutationRecords(trx, {
        scope: updatedScope,
        actorId: input.actorId,
        action: `scope.${input.type === "archive" ? "archived" : input.type === "restore" ? "restored" : "deleted"}`,
        recipients: memberRows.map((member) => ({
          actorId: member.actor_id,
          ...(member.invitation_id === null ? {} : { invitationId: member.invitation_id }),
        })),
        discoveryState: input.type === "delete" ? "deleted" : "accepted",
        now,
      });
      return result;
    });
  }

  async getLifecycleOperation(
    scopeId: string,
    actorId: string,
    operationId: string,
  ): Promise<CollaborationOperation | null> {
    const owner = await this.db.selectFrom("collaboration_scopes").select("owner_id")
      .where("id", "=", scopeId).executeTakeFirst();
    if (!owner || owner.owner_id !== actorId) return null;
    const row = await this.db.selectFrom("collaboration_operations")
      .select("result_ref")
      .where("scope_id", "=", scopeId)
      .where("actor_id", "=", actorId)
      .where("client_request_id", "=", operationId)
      .where("operation_kind", "like", "lifecycle.%")
      .executeTakeFirst();
    return row?.result_ref ? CollaborationOperationSchema.parse(parseJson(row.result_ref)) : null;
  }

  async getScopeExport(
    scopeId: string,
    actorId: string,
    exportId: string,
  ): Promise<CollaborationScopeExport | null> {
    const row = await this.db.selectFrom("collaboration_exports as export")
      .innerJoin("collaboration_scopes as scope", "scope.id", "export.scope_id")
      .select(["export.payload", "export.expires_at", "scope.owner_id", "scope.lifecycle", "scope.deleted_at"])
      .where("export.id", "=", exportId)
      .where("export.scope_id", "=", scopeId)
      .where("export.owner_id", "=", actorId)
      .executeTakeFirst();
    if (!row || row.owner_id !== actorId || row.lifecycle === "deleted" || row.deleted_at !== null
      || new Date(row.expires_at).getTime() <= this.now().getTime()) return null;
    return CollaborationScopeExportSchema.parse(parseJson(row.payload));
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

async function appendLifecycleAudit(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: ScopeRow,
  actorId: string,
  action: string,
  now: string,
): Promise<void> {
  await trx.insertInto("collaboration_audit").values({
    scope_id: scope.id,
    actor_id: actorId,
    action,
    outcome: "completed",
    revision: Number(scope.revision),
    reason_code: null,
    created_at: now,
  }).execute();
}

async function buildChatScopeExport(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: ScopeRow,
  chat: Selectable<OwnerCollaborationDatabase["chats"]>,
  exportId: string,
  exportedAt: string,
  expiresAt: string,
): Promise<CollaborationScopeExport> {
  const [members, audit, messages, attachments] = await Promise.all([
    trx.selectFrom("collaboration_members").selectAll().where("scope_id", "=", scope.id)
      .orderBy("updated_at", "asc").limit(MAX_SCOPE_PARTICIPANTS + 1).execute(),
    trx.selectFrom("collaboration_audit").selectAll().where("scope_id", "=", scope.id)
      .orderBy("created_at", "asc").orderBy("id", "asc").limit(MAX_EXPORT_AUDIT_RECORDS + 1).execute(),
    trx.selectFrom("chat_messages").selectAll().where("chat_id", "=", chat.id)
      .orderBy("seq", "asc").limit(MAX_EXPORT_MESSAGES + 1).execute(),
    trx.selectFrom("chat_attachments").selectAll().where("chat_id", "=", chat.id)
      .orderBy("created_at", "asc").orderBy("id", "asc").limit(MAX_EXPORT_ATTACHMENTS + 1).execute(),
  ]);
  if (members.length > MAX_SCOPE_PARTICIPANTS || audit.length > MAX_EXPORT_AUDIT_RECORDS
    || messages.length > MAX_EXPORT_MESSAGES || attachments.length > MAX_EXPORT_ATTACHMENTS) {
    throw new CollaborationRepositoryError("capacity", "Scope export exceeds safe limits");
  }
  return CollaborationScopeExportSchema.parse({
    version: 1,
    id: exportId,
    scopeId: scope.id,
    exportedAt,
    expiresAt,
    scope: {
      kind: "chat",
      resourceId: scope.resource_id,
      lifecycle: scope.lifecycle,
      revision: String(scope.revision),
    },
    members: members.map((member) => ({
      actorId: member.actor_id,
      role: member.role,
      status: member.status,
      revision: String(member.revision),
      ...(member.joined_at === null ? {} : { joinedAt: toIso(member.joined_at) }),
    })),
    audit: audit.map((record) => ({
      actorId: record.actor_id,
      action: record.action,
      outcome: record.outcome,
      revision: String(record.revision),
      ...(record.reason_code === null ? {} : { reasonCode: record.reason_code }),
      createdAt: toIso(record.created_at),
    })),
    chat: {
      id: chat.id,
      title: chat.title,
      lifecycle: chat.lifecycle,
      revision: String(chat.revision),
      messages: messages.map((message) => ({
        id: message.id,
        sequence: String(message.seq),
        role: message.role,
        state: message.state,
        purpose: message.purpose,
        ...(message.actor_id === null ? {} : { actorId: message.actor_id }),
        parts: sanitizeExportParts(message.parts),
        createdAt: toIso(message.created_at),
      })),
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        messageId: attachment.message_id,
        kind: attachment.kind,
        label: attachment.label,
        ...(attachment.mime_type === null ? {} : { mimeType: attachment.mime_type }),
        ...(attachment.size_bytes === null ? {} : { sizeBytes: Number(attachment.size_bytes) }),
      })),
    },
  });
}

function sanitizeExportParts(value: unknown) {
  const parsed = CanonicalChatMessagePartSchema.array().max(64).parse(
    typeof value === "string" ? JSON.parse(value) as unknown : value,
  );
  return parsed.map((part) => part.type === "attachment_reference"
    ? {
        type: part.type,
        attachmentId: part.attachmentId,
        kind: part.kind,
        label: part.label,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.sizeBytes === undefined ? {} : { sizeBytes: part.sizeBytes }),
      }
    : part);
}

function chatBindingMatches(value: unknown, scopeId: string): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return typeof parsed === "object" && parsed !== null && "scopeId" in parsed
      && (parsed as { scopeId?: unknown }).scopeId === scopeId;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration-lifecycle] Chat binding parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}

async function lockDirectScope(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
): Promise<ScopeRow> {
  const scope = await trx.selectFrom("collaboration_scopes")
    .selectAll()
    .where("id", "=", scopeId)
    .where("deleted_at", "is", null)
    .where("lifecycle", "!=", "deleted")
    .forUpdate()
    .executeTakeFirst();
  if (!scope) throw new CollaborationRepositoryError("not_found", "Scope not found");
  if (scope.membership_mode !== "direct") {
    throw new CollaborationRepositoryError("conflict", "Scope membership is inherited");
  }
  return scope;
}

async function requireAcceptedOwner(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
  actorId: string,
): Promise<void> {
  const member = await trx.selectFrom("collaboration_members")
    .select(["role", "status"])
    .where("scope_id", "=", scopeId)
    .where("actor_id", "=", actorId)
    .executeTakeFirst();
  if (!member || member.role !== "owner" || member.status !== "accepted") {
    throw new CollaborationRepositoryError("forbidden", "Owner access required");
  }
}

async function updateScopeRevision(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
  expectedRevision: number,
  nextRevision: number,
  now: string,
): Promise<void> {
  const updated = await trx.updateTable("collaboration_scopes").set({
    revision: nextRevision,
    auth_epoch: sql<number>`auth_epoch + 1`,
    updated_at: now,
  }).where("id", "=", scopeId)
    .where("revision", "=", expectedRevision)
    .returning("revision")
    .executeTakeFirst();
  if (!updated) {
    throw new CollaborationRepositoryError("conflict", "Scope revision changed");
  }
}

async function readOperationReplay<T>(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: { scopeId: string; actorId: string; clientRequestId: string; payloadHash: string },
  operationKind: string,
): Promise<T | null> {
  const row = await trx.selectFrom("collaboration_operations")
    .select(["payload_hash", "status", "result_ref"])
    .where("scope_id", "=", input.scopeId)
    .where("actor_id", "=", input.actorId)
    .where("client_request_id", "=", input.clientRequestId)
    .where("operation_kind", "=", operationKind)
    .executeTakeFirst();
  if (!row) return null;
  if (row.payload_hash !== input.payloadHash) {
    throw new CollaborationRepositoryError("conflict", "Operation key payload changed");
  }
  if (row.status !== "completed" || row.result_ref === null) {
    throw new CollaborationRepositoryError("conflict", "Operation has not completed");
  }
  return parseJson<T>(row.result_ref);
}

async function writeOperation(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: {
    scopeId: string;
    actorId: string;
    clientRequestId: string;
    payloadHash: string;
    expectedRevision: number;
  },
  operationKind: string,
  scope: ScopeRow,
  result: unknown,
  now: string,
  expiresAt: string,
): Promise<void> {
  await trx.insertInto("collaboration_operations").values({
    scope_id: input.scopeId,
    actor_id: input.actorId,
    client_request_id: input.clientRequestId,
    operation_kind: operationKind,
    payload_hash: input.payloadHash,
    status: "completed",
    result_ref: jsonb(result),
    expected_revision: input.expectedRevision,
    accepted_auth_epoch: Number(scope.auth_epoch),
    created_at: now,
    expires_at: expiresAt,
  }).execute();
}

async function appendMutationRecords(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: {
    scope: ScopeRow;
    actorId: string;
    action: string;
    recipients: Array<{ actorId: string; invitationId?: string }>;
    discoveryState: "invited" | "accepted" | "revoked" | "deleted";
    now: string;
    reasonCode?: string;
  },
): Promise<void> {
  const latest = await trx.selectFrom("collaboration_events")
    .select(({ fn }) => fn.max("scope_seq").as("sequence"))
    .where("scope_id", "=", input.scope.id)
    .executeTakeFirst();
  const sequence = Number(latest?.sequence ?? 0) + 1;
  const eventId = randomUUID();
  await trx.insertInto("collaboration_events").values({
    scope_id: input.scope.id,
    scope_seq: sequence,
    event_id: eventId,
    resource_kind: input.scope.kind,
    resource_id: input.scope.resource_id,
    revision: Number(input.scope.revision),
    authority_generation: Number(input.scope.authority_generation),
    event_type: input.action,
    payload: jsonb({}),
    created_at: input.now,
  }).execute();
  await trx.insertInto("collaboration_audit").values({
    scope_id: input.scope.id,
    actor_id: input.actorId,
    action: input.action,
    outcome: "completed",
    revision: Number(input.scope.revision),
    reason_code: input.reasonCode ?? null,
    created_at: input.now,
  }).execute();
  await trx.insertInto("collaboration_directory_outbox").values({
    event_id: eventId,
    scope_id: input.scope.id,
    recipient_actor_ids: jsonb(input.recipients),
    authority_runtime_id: input.scope.authority_runtime_id,
    authority_generation: Number(input.scope.authority_generation),
    resource_kind: input.scope.kind,
    discovery_state: input.discoveryState,
    retry_after: input.now,
    delivered_at: null,
    created_at: input.now,
  }).execute();
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

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export type { CollaborationDatabase };
