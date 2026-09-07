import { createHash, randomUUID } from "node:crypto";
import {
  CanonicalChatMessageSchema,
  CollaborationChatSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationHumanMessageSchema,
  CollaborationUserStatePatchSchema,
  CollaborationUserStateSchema,
  type CanonicalChatMessage,
  type CanonicalChatMessagePart,
  type CollaborationHumanMessage,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "./authority.js";
import type { CollaborationScopesTable, OwnerCollaborationDatabase } from "./database.js";
import { CollaborationRepositoryError } from "./repository.js";

const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SharedChatMessage {
  id: string;
  chatId: string;
  sequence: string;
  role: "user" | "assistant" | "tool" | "system";
  state: "pending" | "committed" | "failed";
  purpose: "discussion" | "ai_request" | "assistant" | "system";
  actor: { actorId: string; displayName: string };
  parts: CanonicalChatMessagePart[];
  createdAt: string;
}

export class CollaborationChatAdapter {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    authority: { authorize(input: {
      scopeId: string;
      actorId: string;
      action: "read" | "discuss";
    }): Promise<AuthorizedCollaborationContext> };
    resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string }>;
    onCommitted?(scopeId: string): Promise<void>;
    now?: () => Date;
    createId?: () => string;
  }) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async appendDiscussion(
    context: AuthorizedCollaborationContext,
    input: unknown,
  ): Promise<CollaborationHumanMessage> {
    if (context.capability !== "discuss" || !["owner", "editor"].includes(context.role)) {
      throw new CollaborationAuthorizationError("forbidden", "Discussion access is required");
    }
    const request = CollaborationCreateDiscussionRequestSchema.parse(input);
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const payloadHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const result = await this.options.db.transaction().execute(async (trx) => {
      const scope = await lockScope(trx, context);
      await reauthorizeDiscussion(trx, context, nowDate);
      if (Number(scope.revision) !== Number(request.expectedRevision)
        || Math.max(Number(scope.auth_epoch), await membershipEpoch(trx, context)) !== context.authEpoch) {
        throw new CollaborationRepositoryError("conflict", "Scope authority changed");
      }
      const existing = await trx.selectFrom("collaboration_operations")
        .select(["payload_hash", "status", "result_ref"])
        .where("scope_id", "=", context.scopeId)
        .where("actor_id", "=", context.actorId)
        .where("client_request_id", "=", request.clientRequestId)
        .where("operation_kind", "=", "discussion.append")
        .executeTakeFirst();
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.status !== "completed" || !existing.result_ref) {
          throw new CollaborationRepositoryError("conflict", "Discussion request changed");
        }
        const result = parseJson<{ messageId: string }>(existing.result_ref);
        const row = await trx.selectFrom("chat_messages").selectAll()
          .where("id", "=", result.messageId)
          .where("chat_id", "=", context.resourceId)
          .executeTakeFirst();
        if (!row) throw new CollaborationRepositoryError("conflict", "Discussion replay is unavailable");
        return { message: canonicalMessage(row), created: false };
      }

      const chat = await trx.selectFrom("chats")
        .selectAll()
        .where("id", "=", context.resourceId)
        .where("owner_type", "=", "personal")
        .where("owner_id", "=", context.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!chat || !bindingMatches(chat.collaboration, context.scopeId)) {
        throw new CollaborationAuthorizationError("unavailable", "Shared Chat binding is unavailable");
      }
      const latest = await trx.selectFrom("chat_messages")
        .select(({ fn }) => fn.max("seq").as("sequence"))
        .where("chat_id", "=", context.resourceId)
        .executeTakeFirst();
      const sequence = Number(latest?.sequence ?? 0) + 1;
      const canonical = CanonicalChatMessageSchema.parse({
        id: `msg_discussion_${this.createId().replaceAll("-", "")}`,
        chatId: context.resourceId,
        seq: sequence,
        role: "user",
        state: "committed",
        actorId: context.actorId,
        purpose: "discussion",
        parts: [{ type: "text", text: request.text }],
        createdAt: now,
      });
      await trx.insertInto("chat_messages").values({
        id: canonical.id,
        chat_id: canonical.chatId,
        seq: canonical.seq,
        role: canonical.role,
        state: canonical.state,
        turn_id: null,
        run_id: null,
        actor_id: context.actorId,
        purpose: "discussion",
        parts: jsonb(canonical.parts),
        byte_count: new TextEncoder().encode(JSON.stringify(canonical)).byteLength,
        search_text: request.text.slice(0, 96 * 1024),
        created_at: now,
      }).execute();
      const chatRevision = Number(chat.revision) + 1;
      const updatedChat = await trx.updateTable("chats").set({
        revision: chatRevision,
        message_count: sql<number>`message_count + 1`,
        last_message_preview: request.text.slice(0, 512),
        updated_at: now,
      }).where("id", "=", context.resourceId)
        .where("revision", "=", Number(chat.revision))
        .returning("id")
        .executeTakeFirst();
      if (!updatedChat) throw new CollaborationRepositoryError("conflict", "Chat changed");
      await trx.insertInto("collaboration_operations").values({
        scope_id: context.scopeId,
        actor_id: context.actorId,
        client_request_id: request.clientRequestId,
        operation_kind: "discussion.append",
        payload_hash: payloadHash,
        status: "completed",
        result_ref: jsonb({ messageId: canonical.id }),
        expected_revision: Number(request.expectedRevision),
        accepted_auth_epoch: context.authEpoch,
        created_at: now,
        expires_at: new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString(),
      }).execute();
      await appendEvent(trx, scope, chatRevision, "chat.discussion_appended", now);
      return { message: canonical, created: true };
    });
    if (result.created && this.options.onCommitted) {
      try {
        await this.options.onCommitted(context.scopeId);
      } catch (error: unknown) {
        console.warn(
          "[collaboration-chat] committed event delivery failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    return this.humanMessage(result.message);
  }

  async listMessages(
    context: AuthorizedCollaborationContext,
    input: { afterSequence: string; limit: number },
  ): Promise<SharedChatMessage[]> {
    const current = await this.options.authority.authorize({
      scopeId: context.scopeId,
      actorId: context.actorId,
      action: "read",
    });
    if (current.resourceKind !== "chat" || current.resourceId !== context.resourceId
      || current.ownerId !== context.ownerId || input.limit < 1 || input.limit > 100) {
      throw new CollaborationAuthorizationError("unavailable", "Shared Chat history is unavailable");
    }
    const rows = await this.options.db.selectFrom("chat_messages")
      .selectAll()
      .where("chat_id", "=", current.resourceId)
      .where("seq", ">", Number(input.afterSequence))
      .orderBy("seq", "asc")
      .limit(input.limit)
      .execute();
    const authors = new Map<string, { actorId: string; displayName: string }>();
    for (const row of rows) {
      if (!row.actor_id || authors.has(row.actor_id)) continue;
      authors.set(row.actor_id, await this.resolveParticipant(row.actor_id));
    }
    return rows.map((row) => {
      const message = canonicalMessage(row);
      return {
        id: message.id,
        chatId: message.chatId,
        sequence: String(message.seq),
        role: message.role,
        state: message.state,
        purpose: message.purpose ?? purposeForRole(message.role),
        actor: message.actorId
          ? authors.get(message.actorId) ?? { actorId: message.actorId, displayName: "Unknown participant" }
          : systemAuthor(message.role),
        parts: sanitizeParts(message.parts),
        createdAt: message.createdAt,
      };
    });
  }

  async getChat(context: AuthorizedCollaborationContext) {
    const current = await this.options.authority.authorize({
      scopeId: context.scopeId,
      actorId: context.actorId,
      action: "read",
    });
    if (current.resourceKind !== "chat" || current.resourceId !== context.resourceId
      || current.ownerId !== context.ownerId) {
      throw new CollaborationAuthorizationError("unavailable", "Shared Chat is unavailable");
    }
    const chat = await this.options.db.selectFrom("chats")
      .select(["id", "title", "lifecycle", "revision", "message_count", "last_message_preview", "collaboration"])
      .where("id", "=", current.resourceId)
      .where("owner_type", "=", "personal")
      .where("owner_id", "=", current.ownerId)
      .executeTakeFirst();
    if (!chat || !bindingMatches(chat.collaboration, current.scopeId)) {
      throw new CollaborationAuthorizationError("unavailable", "Shared Chat is unavailable");
    }
    return CollaborationChatSchema.parse({
      id: chat.id,
      scopeId: current.scopeId,
      title: chat.title,
      lifecycle: chat.lifecycle,
      revision: String(chat.revision),
      messageCount: String(chat.message_count),
      ...(chat.last_message_preview ? { lastMessagePreview: chat.last_message_preview } : {}),
    });
  }

  async getUserState(context: AuthorizedCollaborationContext) {
    return this.options.db.transaction().execute(async (trx) => {
      const scope = await lockScope(trx, context);
      await reauthorizeRead(trx, context, this.now());
      requireCurrentEpoch(scope, context, await membershipEpoch(trx, context));
      const row = await trx.selectFrom("chat_user_state")
        .select(["read_through_seq", "pinned", "muted", "last_opened_at"])
        .where("chat_id", "=", context.resourceId)
        .where("principal_id", "=", context.actorId)
        .executeTakeFirst();
      return CollaborationUserStateSchema.parse(row ? {
        readThroughSeq: String(row.read_through_seq),
        pinned: row.pinned,
        muted: row.muted,
        ...(row.last_opened_at === null ? {} : { lastOpenedAt: toIso(row.last_opened_at) }),
      } : { readThroughSeq: "0", pinned: false, muted: false });
    });
  }

  async updateUserState(context: AuthorizedCollaborationContext, input: unknown) {
    const patch = CollaborationUserStatePatchSchema.parse(input);
    const now = this.now().toISOString();
    return this.options.db.transaction().execute(async (trx) => {
      const scope = await lockScope(trx, context);
      await reauthorizeRead(trx, context, this.now());
      requireCurrentEpoch(scope, context, await membershipEpoch(trx, context));
      await trx.insertInto("chat_user_state").values({
        chat_id: context.resourceId,
        principal_id: context.actorId,
        read_through_seq: patch.readThroughSeq === undefined ? 0 : Number(patch.readThroughSeq),
        pinned: patch.pinned ?? false,
        muted: patch.muted ?? false,
        attention_acknowledged_at: null,
        last_opened_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.columns(["chat_id", "principal_id"]).doUpdateSet({
        ...(patch.readThroughSeq === undefined ? {} : {
          read_through_seq: sql<number>`GREATEST(chat_user_state.read_through_seq, ${Number(patch.readThroughSeq)})`,
        }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        ...(patch.muted === undefined ? {} : { muted: patch.muted }),
        last_opened_at: now,
        updated_at: now,
      })).execute();
      const row = await trx.selectFrom("chat_user_state")
        .select(["read_through_seq", "pinned", "muted", "last_opened_at"])
        .where("chat_id", "=", context.resourceId)
        .where("principal_id", "=", context.actorId)
        .executeTakeFirstOrThrow();
      return CollaborationUserStateSchema.parse({
        readThroughSeq: String(row.read_through_seq),
        pinned: row.pinned,
        muted: row.muted,
        ...(row.last_opened_at === null ? {} : { lastOpenedAt: toIso(row.last_opened_at) }),
      });
    });
  }

  private async humanMessage(message: CanonicalChatMessage): Promise<CollaborationHumanMessage> {
    const text = message.parts.find((part) => part.type === "text")?.text ?? "";
    const actor = message.actorId
      ? await this.resolveParticipant(message.actorId)
      : { actorId: "unknown_participant", displayName: "Unknown participant" };
    return CollaborationHumanMessageSchema.parse({
      id: message.id,
      chatId: message.chatId,
      sequence: String(message.seq),
      purpose: "discussion",
      actor,
      text,
      createdAt: message.createdAt,
    });
  }

  private async resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string }> {
    try {
      const participant = await this.options.resolveParticipant(actorId);
      return participant.actorId === actorId
        ? participant
        : { actorId, displayName: "Unknown participant" };
    } catch (error: unknown) {
      console.warn(
        "[collaboration-chat] participant lookup failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return { actorId, displayName: "Unknown participant" };
    }
  }
}

async function lockScope(
  trx: Transaction<OwnerCollaborationDatabase>,
  context: AuthorizedCollaborationContext,
): Promise<Selectable<CollaborationScopesTable>> {
  const scope = await trx.selectFrom("collaboration_scopes").selectAll()
    .where("id", "=", context.scopeId)
    .where("kind", "=", "chat")
    .where("resource_id", "=", context.resourceId)
    .where("owner_id", "=", context.ownerId)
    .where("lifecycle", "=", "shared")
    .where("authority_generation", "=", context.authorityGeneration)
    .forUpdate()
    .executeTakeFirst();
  if (!scope) throw new CollaborationAuthorizationError("unavailable", "Shared Chat is unavailable");
  return scope;
}

async function reauthorizeDiscussion(
  trx: Transaction<OwnerCollaborationDatabase>,
  context: AuthorizedCollaborationContext,
  now: Date,
): Promise<void> {
  const member = await trx.selectFrom("collaboration_members")
    .select(["role", "status", "expires_at"])
    .where("scope_id", "=", context.membershipScopeId)
    .where("actor_id", "=", context.actorId)
    .executeTakeFirst();
  if (!member || member.status !== "accepted" || !["owner", "editor"].includes(member.role)
    || (member.expires_at !== null && new Date(member.expires_at).getTime() <= now.getTime())) {
    throw new CollaborationAuthorizationError("forbidden", "Discussion access is required");
  }
}

async function reauthorizeRead(
  trx: Transaction<OwnerCollaborationDatabase>,
  context: AuthorizedCollaborationContext,
  now: Date,
): Promise<void> {
  const member = await trx.selectFrom("collaboration_members")
    .select(["status", "expires_at"])
    .where("scope_id", "=", context.membershipScopeId)
    .where("actor_id", "=", context.actorId)
    .executeTakeFirst();
  if (!member || member.status !== "accepted"
    || (member.expires_at !== null && new Date(member.expires_at).getTime() <= now.getTime())) {
    throw new CollaborationAuthorizationError("forbidden", "Current membership is required");
  }
}

function requireCurrentEpoch(
  scope: Selectable<CollaborationScopesTable>,
  context: AuthorizedCollaborationContext,
  inheritedEpoch: number,
): void {
  if (Math.max(Number(scope.auth_epoch), inheritedEpoch) !== context.authEpoch) {
    throw new CollaborationRepositoryError("conflict", "Scope authority changed");
  }
}

async function membershipEpoch(
  trx: Transaction<OwnerCollaborationDatabase>,
  context: AuthorizedCollaborationContext,
): Promise<number> {
  if (context.membershipScopeId === context.scopeId) return 0;
  const parent = await trx.selectFrom("collaboration_scopes").select("auth_epoch")
    .where("id", "=", context.membershipScopeId).executeTakeFirst();
  return Number(parent?.auth_epoch ?? Number.MAX_SAFE_INTEGER);
}

async function appendEvent(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: Selectable<CollaborationScopesTable>,
  resourceRevision: number,
  eventType: string,
  now: string,
): Promise<void> {
  const latest = await trx.selectFrom("collaboration_events")
    .select(({ fn }) => fn.max("scope_seq").as("sequence"))
    .where("scope_id", "=", scope.id)
    .executeTakeFirst();
  await trx.insertInto("collaboration_events").values({
    scope_id: scope.id,
    scope_seq: Number(latest?.sequence ?? 0) + 1,
    event_id: randomUUID(),
    resource_kind: "chat",
    resource_id: scope.resource_id,
    revision: resourceRevision,
    authority_generation: Number(scope.authority_generation),
    event_type: eventType,
    payload: jsonb({}),
    created_at: now,
  }).execute();
}

function canonicalMessage(row: {
  id: string;
  chat_id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  state: "pending" | "committed" | "failed";
  turn_id: string | null;
  run_id: string | null;
  actor_id: string | null;
  purpose: "discussion" | "ai_request" | "assistant" | "system";
  parts: unknown;
  created_at: Date | string;
}): CanonicalChatMessage {
  return CanonicalChatMessageSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    seq: Number(row.seq),
    role: row.role,
    state: row.state,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    purpose: row.purpose,
    parts: parseJson(row.parts),
    createdAt: toIso(row.created_at),
  });
}

function sanitizeParts(parts: CanonicalChatMessagePart[]): CanonicalChatMessagePart[] {
  return parts.map((part) => {
    if (part.type === "attachment_reference") {
      const { ownerReference: _ownerReference, ...safe } = part;
      return safe;
    }
    if (part.type === "resource_reference") {
      return { type: "status", tone: "info", label: "Resource available only to its owner" };
    }
    return part;
  });
}

function systemAuthor(role: SharedChatMessage["role"]) {
  return role === "assistant"
    ? { actorId: "matrix_ai", displayName: "Matrix AI" }
    : role === "user"
      ? { actorId: "unknown_participant", displayName: "Unknown participant" }
      : { actorId: "matrix_os", displayName: "Matrix OS" };
}

function purposeForRole(role: SharedChatMessage["role"]): SharedChatMessage["purpose"] {
  return role === "user" ? "ai_request" : role === "assistant" ? "assistant" : "system";
}

function bindingMatches(value: unknown, scopeId: string): boolean {
  const parsed = parseJson<unknown>(value);
  return typeof parsed === "object" && parsed !== null && "scopeId" in parsed && parsed.scopeId === scopeId;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
