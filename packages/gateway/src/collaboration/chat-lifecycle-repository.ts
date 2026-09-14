import {
  CanonicalChatMessagePartSchema,
  CollaborationOperationSchema,
  CollaborationScopeExportSchema,
  type CollaborationOperation,
  type CollaborationScopeExport,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ChatRepository } from "../chat/repository.js";
import type { OwnerCollaborationDatabase } from "./database.js";
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
  writeOperation,
} from "./repository-shared.js";

const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_EXPORT_MESSAGES = 100_000;
const MAX_EXPORT_ATTACHMENTS = 100_000;
const MAX_EXPORT_AUDIT_RECORDS = 10_000;
export const MAX_COLLABORATION_EXPORT_BYTES = 16 * 1024 * 1024;

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

export interface ChatLifecycleRepositoryOptions {
  now: () => Date;
  chatRepository?: ChatRepository;
  maxExportBytes?: number;
}

export class ChatLifecycleRepository {
  private readonly maxExportBytes: number;

  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    private readonly options: ChatLifecycleRepositoryOptions,
  ) {
    this.maxExportBytes = Math.max(
      1,
      Math.min(options.maxExportBytes ?? MAX_COLLABORATION_EXPORT_BYTES, MAX_COLLABORATION_EXPORT_BYTES),
    );
  }

  async apply(input: ChatLifecycleInput): Promise<CollaborationOperation> {
    if (["transfer", "recover"].includes(input.type)) {
      throw new CollaborationRepositoryError("conflict", "Lifecycle action is not available for standalone Chats");
    }
    const nowDate = this.options.now();
    const now = nowDate.toISOString();
    const operationKind = `lifecycle.${input.type}`;
    const apply = async (
      trx: Transaction<OwnerCollaborationDatabase>,
      canonicalChatRepository?: ChatRepository,
    ): Promise<CollaborationOperation> => {
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
        const payload = await buildChatScopeExport(trx, scope, chat, exportId, now, expiresAt, this.maxExportBytes);
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

      if (canonicalChatRepository) {
        const acceptedMembers = input.type === "delete"
          ? undefined
          : await trx.selectFrom("collaboration_members")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("scope_id", "=", scope.id)
            .where("status", "=", "accepted")
            .executeTakeFirstOrThrow();
        await canonicalChatRepository.appendOutboxEvent(
          { type: scope.owner_type, ownerId: scope.owner_id },
          chat.id,
          nextChatRevision,
          input.type === "delete" ? "chat.deleted" : "chat.updated",
          {},
          input.type === "delete" ? undefined : {
            mode: "shared",
            membership: { role: "owner", memberCount: Number(acceptedMembers?.count) },
          },
        );
      } else {
        await trx.insertInto("chat_outbox").values({
          owner_type: scope.owner_type,
          owner_id: scope.owner_id,
          chat_id: chat.id,
          revision: nextChatRevision,
          event_type: input.type === "delete" ? "chat.deleted" : "chat.updated",
          payload: jsonb({}),
          created_at: now,
        }).execute();
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
    };
    if (this.options.chatRepository) {
      return this.options.chatRepository.withTransaction((repository) => apply(
        repository.kysely as unknown as Transaction<OwnerCollaborationDatabase>,
        repository,
      ));
    }
    return this.db.transaction().execute((trx) => apply(trx));
  }

  async getOperation(
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

  async getExport(
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
      || new Date(row.expires_at).getTime() <= this.options.now().getTime()) return null;
    return CollaborationScopeExportSchema.parse(parseJson(row.payload));
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
  maxExportBytes: number,
): Promise<CollaborationScopeExport> {
  const messageAggregate = await trx.selectFrom("chat_messages")
    .select(({ fn }) => [
      fn.countAll<string>().as("count"),
      sql<string>`COALESCE(SUM(octet_length(parts::text)), 0)::text`.as("parts_bytes"),
    ])
    .where("chat_id", "=", chat.id)
    .executeTakeFirstOrThrow();
  if (BigInt(messageAggregate.count) > BigInt(MAX_EXPORT_MESSAGES)
    || BigInt(messageAggregate.parts_bytes) > BigInt(maxExportBytes)) {
    throw new CollaborationRepositoryError("capacity", "Scope export exceeds safe limits");
  }
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
  const payload = CollaborationScopeExportSchema.parse({
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
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxExportBytes) {
    throw new CollaborationRepositoryError("capacity", "Scope export exceeds safe limits");
  }
  return payload;
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
