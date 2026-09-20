import { randomUUID } from "node:crypto";
import {
  type CollaborationDiscussionMessage,
  type CollaborationOperation,
  type CollaborationScopeExport,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  ChatLifecycleRepository,
  MAX_COLLABORATION_EXPORT_BYTES,
  type ChatLifecycleInput,
} from "./chat-lifecycle-repository.js";
import type { CollaborationDatabase, OwnerCollaborationDatabase } from "./database.js";
import { CollaborationGrantRepository } from "./grant-repository.js";
import { CollaborationLifecycleRepository } from "./lifecycle-repository.js";
import { CollaborationRepositoryError, toIso } from "./repository-shared.js";
import {
  toMember,
  toScope,
  type AcceptInvitationInput,
  type ChangeMemberRoleInput,
  type CollaborationMemberRecord,
  type CollaborationRepositoryOptions,
  type CollaborationScopeRecord,
  type CreateDirectScopeInput,
  type CreateInvitationInput,
  type DeclineInvitationInput,
  type InvitationMutationResult,
  type MemberMutationInput,
  type MemberMutationResult,
  type RevokeInvitationInput,
  type TerminalExportInput,
} from "./repository-types.js";

export {
  CollaborationRepositoryError,
  type CollaborationRepositoryErrorCode,
} from "./repository-shared.js";
export type { ChatLifecycleInput } from "./chat-lifecycle-repository.js";
export type {
  AcceptInvitationInput,
  ChangeMemberRoleInput,
  CollaborationMemberRecord,
  CollaborationRepositoryOptions,
  CollaborationScopeRecord,
  CreateDirectScopeInput,
  CreateInvitationInput,
  DeclineInvitationInput,
  InvitationMutationResult,
  MemberMutationInput,
  MemberMutationResult,
  RevokeInvitationInput,
  TerminalExportInput,
} from "./repository-types.js";

/**
 * Owner-home collaboration repository facade. Scope/member reads and Chat user
 * state live here; grant mutations delegate to CollaborationGrantRepository and
 * terminal export / lifecycle reads to CollaborationLifecycleRepository (S01 / T008).
 */
export class CollaborationRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly chatLifecycle: ChatLifecycleRepository;
  private readonly maxExportBytes: number;
  private readonly grants: CollaborationGrantRepository;
  private readonly lifecycle: CollaborationLifecycleRepository;

  constructor(
    public readonly db: Kysely<OwnerCollaborationDatabase>,
    options: CollaborationRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxExportBytes = Math.max(
      1,
      Math.min(options.maxExportBytes ?? MAX_COLLABORATION_EXPORT_BYTES, MAX_COLLABORATION_EXPORT_BYTES),
    );
    this.chatLifecycle = new ChatLifecycleRepository(db, {
      now: this.now,
      ...(options.chatRepository ? { chatRepository: options.chatRepository } : {}),
      maxExportBytes: this.maxExportBytes,
    });
    this.grants = new CollaborationGrantRepository(db, { now: this.now, createId: this.createId });
    this.lifecycle = new CollaborationLifecycleRepository(db, this.chatLifecycle, {
      now: this.now,
      maxExportBytes: this.maxExportBytes,
    });
  }

  async createDirectScope(input: CreateDirectScopeInput): Promise<CollaborationScopeRecord> {
    const now = this.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      await trx.insertInto("collaboration_scopes").values({
        id: input.scopeId,
        owner_type: "personal",
        owner_id: input.ownerId,
        organization_id: input.organizationId,
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
      if ((scope.organization_id ?? null) !== (input.organizationId ?? null)) {
        // The resource is already shared inside another organization; never reuse that scope.
        throw new CollaborationRepositoryError("conflict", "Resource is shared in another organization");
      }
      await trx.insertInto("collaboration_members").values({
        scope_id: scope.id,
        organization_id: input.organizationId,
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


  async createInvitation(input: CreateInvitationInput): Promise<InvitationMutationResult> {
    return this.grants.createInvitation(input);
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<InvitationMutationResult> {
    return this.grants.acceptInvitation(input);
  }

  async declineInvitation(input: DeclineInvitationInput): Promise<MemberMutationResult> {
    return this.grants.declineInvitation(input);
  }

  async revokeInvitation(input: RevokeInvitationInput): Promise<MemberMutationResult> {
    return this.grants.revokeInvitation(input);
  }

  async changeMemberRole(input: ChangeMemberRoleInput): Promise<MemberMutationResult> {
    return this.grants.changeMemberRole(input);
  }

  async revokeMember(input: MemberMutationInput): Promise<MemberMutationResult> {
    return this.grants.revokeMember(input);
  }

  async applyChatLifecycle(input: ChatLifecycleInput): Promise<CollaborationOperation> {
    return this.chatLifecycle.apply(input);
  }


  async applyTerminalExport(
    input: TerminalExportInput,
    prepareDiscussion: () => Promise<(
      trx: Transaction<OwnerCollaborationDatabase>,
    ) => Promise<CollaborationDiscussionMessage[]>>,
  ): Promise<CollaborationOperation> {
    return this.lifecycle.applyTerminalExport(input, prepareDiscussion);
  }

  async getLifecycleOperation(
    scopeId: string,
    actorId: string,
    operationId: string,
  ): Promise<CollaborationOperation | null> {
    return this.lifecycle.getLifecycleOperation(scopeId, actorId, operationId);
  }

  async getScopeExport(
    scopeId: string,
    actorId: string,
    exportId: string,
  ): Promise<CollaborationScopeExport | null> {
    return this.lifecycle.getScopeExport(scopeId, actorId, exportId);
  }
}

export type { CollaborationDatabase };
