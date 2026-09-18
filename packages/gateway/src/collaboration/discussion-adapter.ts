import { createHash, randomUUID } from "node:crypto";
import {
  CollaborationCreateDiscussionRequestSchema,
  CollaborationDiscussionMessageSchema,
  CollaborationDiscussionMessagesResponseSchema,
  CollaborationDiscussionUserStatePatchSchema,
  CollaborationDiscussionUserStateSchema,
  type CollaborationDiscussionMessage,
  type CollaborationDiscussionMessagesResponse,
  type CollaborationDiscussionUserState,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "./authority.js";
import type { CollaborationChatAdapter } from "./chat-adapter.js";
import type { CollaborationScopesTable, OwnerCollaborationDatabase } from "./database.js";
import {
  CollaborationRepositoryError,
  OPERATION_RETENTION_MS,
  jsonb,
  parseJson,
  toIso,
} from "./repository-shared.js";
import { CollaborationDiscussionError } from "./discussion-error.js";

export { CollaborationDiscussionError } from "./discussion-error.js";

type Participant = { actorId: string; displayName: string };
const MAX_TERMINAL_DISCUSSION_EXPORT_MESSAGES = 100_000;
const MAX_TERMINAL_DISCUSSION_EXPORT_BYTES = 16 * 1024 * 1024;

export class CollaborationDiscussionAdapter {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    authority: { authorize(input: {
      scopeId: string;
      actorId: string;
      action: "read" | "discuss";
    }): Promise<AuthorizedCollaborationContext> };
    chatAdapter: CollaborationChatAdapter;
    resolveParticipant(actorId: string): Promise<Participant>;
    onCommitted?(scopeId: string): Promise<void>;
    now?: () => Date;
    createId?: () => string;
  }) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async append(
    context: AuthorizedCollaborationContext,
    input: unknown,
  ): Promise<CollaborationDiscussionMessage> {
    if (context.capability !== "discuss" || !["owner", "editor"].includes(context.role)) {
      throw new CollaborationAuthorizationError("forbidden", "Discussion access is required");
    }
    if (context.resourceKind === "chat") {
      const message = await this.options.chatAdapter.appendDiscussion(context, input);
      return CollaborationDiscussionMessageSchema.parse({
        id: message.id,
        scopeId: context.scopeId,
        sequence: message.sequence,
        actor: message.actor,
        text: message.text,
        createdAt: message.createdAt,
      });
    }
    this.requireTerminal(context);
    const request = CollaborationCreateDiscussionRequestSchema.parse(input);
    const expectedRevision = safeSequence(request.expectedRevision);
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const payloadHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const participant = await this.resolveParticipant(context.actorId);
    const result = await this.options.db.transaction().execute(async (trx) => {
      const current = await this.lockAndReauthorize(trx, context, "discuss", nowDate);
      const existing = await trx.selectFrom("collaboration_operations")
        .select(["payload_hash", "status", "result_ref"])
        .where("scope_id", "=", current.scopeId)
        .where("actor_id", "=", current.actorId)
        .where("client_request_id", "=", request.clientRequestId)
        .where("operation_kind", "=", "discussion.append")
        .executeTakeFirst();
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.status !== "completed" || !existing.result_ref) {
          throw new CollaborationRepositoryError("conflict", "Discussion request changed");
        }
        return { message: parseJson<CollaborationDiscussionMessage>(existing.result_ref), created: false };
      }
      if (Number(current.scope.revision) !== expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Scope revision changed");
      }
      const latest = await trx.selectFrom("collaboration_discussion_messages")
        .select(({ fn }) => fn.max("sequence").as("sequence"))
        .where("scope_id", "=", current.scopeId)
        .executeTakeFirst();
      const sequence = Number(latest?.sequence ?? 0) + 1;
      const message = CollaborationDiscussionMessageSchema.parse({
        id: this.createId(),
        scopeId: current.scopeId,
        sequence: String(sequence),
        actor: participant,
        text: request.text,
        createdAt: now,
      });
      await trx.insertInto("collaboration_discussion_messages").values({
        scope_id: current.scopeId,
        sequence,
        id: message.id,
        actor_id: current.actorId,
        text: message.text,
        scope_revision: Number(current.scope.revision),
        created_at: now,
      }).execute();
      await trx.insertInto("collaboration_operations").values({
        scope_id: current.scopeId,
        actor_id: current.actorId,
        client_request_id: request.clientRequestId,
        operation_kind: "discussion.append",
        payload_hash: payloadHash,
        status: "completed",
        result_ref: jsonb(message),
        expected_revision: expectedRevision,
        accepted_auth_epoch: current.authEpoch,
        created_at: now,
        expires_at: new Date(nowDate.getTime() + OPERATION_RETENTION_MS).toISOString(),
      }).execute();
      await appendEvent(trx, current.scope, "terminal.discussion_appended", now);
      return { message, created: true };
    });
    if (result.created && this.options.onCommitted) {
      try {
        await this.options.onCommitted(context.scopeId);
      } catch (error: unknown) {
        console.warn(
          "[collaboration-discussion] committed event delivery failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    return result.message;
  }

  async list(
    context: AuthorizedCollaborationContext,
    input: { afterSequence: string; limit: number },
  ): Promise<CollaborationDiscussionMessagesResponse> {
    if (context.resourceKind === "chat") {
      return this.options.chatAdapter.listDiscussionMessages(context, input);
    }
    this.requireTerminal(context);
    const afterSequence = safeSequence(input.afterSequence);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new CollaborationDiscussionError("invalid_request", "Invalid discussion page");
    }
    const current = await this.options.authority.authorize({
      scopeId: context.scopeId,
      actorId: context.actorId,
      action: "read",
    });
    const { rows, latestSequence } = await this.options.db.transaction().execute(async (trx) => {
      await this.lockAndReauthorize(trx, current, "read", this.now());
      const [rows, latest] = await Promise.all([
        trx.selectFrom("collaboration_discussion_messages")
          .selectAll()
          .where("scope_id", "=", current.scopeId)
          .where("sequence", ">", afterSequence)
          .orderBy("sequence", "asc")
          .limit(input.limit)
          .execute(),
        trx.selectFrom("collaboration_discussion_messages")
          .select(({ fn }) => fn.max("sequence").as("sequence"))
          .where("scope_id", "=", current.scopeId)
          .executeTakeFirst(),
      ]);
      return { rows, latestSequence: Number(latest?.sequence ?? 0) };
    });
    const participants = new Map<string, Participant>();
    for (const row of rows) {
      if (!participants.has(row.actor_id)) {
        participants.set(row.actor_id, await this.resolveParticipant(row.actor_id));
      }
    }
    return CollaborationDiscussionMessagesResponseSchema.parse({
      messages: rows.map((row) => ({
        id: row.id,
        scopeId: row.scope_id,
        sequence: String(row.sequence),
        actor: participants.get(row.actor_id),
        text: row.text,
        createdAt: toIso(row.created_at),
      })),
      latestSequence: String(latestSequence),
    });
  }

  async getUserState(context: AuthorizedCollaborationContext): Promise<CollaborationDiscussionUserState> {
    if (context.resourceKind === "chat") {
      return this.options.chatAdapter.getDiscussionUserState(context);
    }
    this.requireTerminal(context);
    const current = await this.options.authority.authorize({
      scopeId: context.scopeId,
      actorId: context.actorId,
      action: "read",
    });
    return this.options.db.transaction().execute(async (trx) => {
      await this.lockAndReauthorize(trx, current, "read", this.now());
      const row = await trx.selectFrom("collaboration_discussion_user_state")
        .select(["read_through_seq", "last_opened_at"])
        .where("scope_id", "=", current.scopeId)
        .where("actor_id", "=", current.actorId)
        .executeTakeFirst();
      return CollaborationDiscussionUserStateSchema.parse(row ? {
        readThroughSeq: String(row.read_through_seq),
        ...(row.last_opened_at === null ? {} : { lastOpenedAt: toIso(row.last_opened_at) }),
      } : { readThroughSeq: "0" });
    });
  }

  async updateUserState(
    context: AuthorizedCollaborationContext,
    input: unknown,
  ): Promise<CollaborationDiscussionUserState> {
    const patch = CollaborationDiscussionUserStatePatchSchema.parse(input);
    if (context.resourceKind === "chat") {
      return this.options.chatAdapter.updateDiscussionUserState(context, patch);
    }
    this.requireTerminal(context);
    const readThroughSeq = safeSequence(patch.readThroughSeq);
    const current = await this.options.authority.authorize({
      scopeId: context.scopeId,
      actorId: context.actorId,
      action: "read",
    });
    const now = this.now().toISOString();
    return this.options.db.transaction().execute(async (trx) => {
      await this.lockAndReauthorize(trx, current, "read", this.now());
      const latest = await trx.selectFrom("collaboration_discussion_messages")
        .select(({ fn }) => fn.max("sequence").as("sequence"))
        .where("scope_id", "=", current.scopeId)
        .executeTakeFirst();
      if (readThroughSeq > Number(latest?.sequence ?? 0)) {
        throw new CollaborationDiscussionError("invalid_request", "Discussion cursor is unavailable");
      }
      await trx.insertInto("collaboration_discussion_user_state").values({
        scope_id: current.scopeId,
        actor_id: current.actorId,
        read_through_seq: readThroughSeq,
        last_opened_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.columns(["scope_id", "actor_id"]).doUpdateSet({
        read_through_seq: sql<number>`GREATEST(collaboration_discussion_user_state.read_through_seq, ${readThroughSeq})`,
        last_opened_at: now,
        updated_at: now,
      })).execute();
      const row = await trx.selectFrom("collaboration_discussion_user_state")
        .select(["read_through_seq", "last_opened_at"])
        .where("scope_id", "=", current.scopeId)
        .where("actor_id", "=", current.actorId)
        .executeTakeFirstOrThrow();
      return CollaborationDiscussionUserStateSchema.parse({
        readThroughSeq: String(row.read_through_seq),
        ...(row.last_opened_at === null ? {} : { lastOpenedAt: toIso(row.last_opened_at) }),
      });
    });
  }

  /**
   * Builds the bounded shared-content fragment consumed by an owner-authorized
   * terminal export. Personal read state is intentionally not queried.
   */
  async exportTerminalDiscussion(scopeId: string): Promise<CollaborationDiscussionMessage[]> {
    const aggregate = await this.options.db.selectFrom("collaboration_discussion_messages")
      .select(({ fn }) => [
        fn.countAll<string>().as("count"),
        sql<string>`COALESCE(SUM(octet_length(text)), 0)::text`.as("text_bytes"),
      ])
      .where("scope_id", "=", scopeId)
      .executeTakeFirstOrThrow();
    if (BigInt(aggregate.count) > BigInt(MAX_TERMINAL_DISCUSSION_EXPORT_MESSAGES)
      || BigInt(aggregate.text_bytes) > BigInt(MAX_TERMINAL_DISCUSSION_EXPORT_BYTES)) {
      throw new CollaborationRepositoryError("capacity", "Terminal discussion export exceeds safe limits");
    }
    const rows = await this.options.db.selectFrom("collaboration_discussion_messages")
      .selectAll()
      .where("scope_id", "=", scopeId)
      .orderBy("sequence", "asc")
      .limit(MAX_TERMINAL_DISCUSSION_EXPORT_MESSAGES + 1)
      .execute();
    if (rows.length > MAX_TERMINAL_DISCUSSION_EXPORT_MESSAGES) {
      throw new CollaborationRepositoryError("capacity", "Terminal discussion export exceeds safe limits");
    }
    const participants = new Map<string, Participant>();
    for (const row of rows) {
      if (!participants.has(row.actor_id)) {
        participants.set(row.actor_id, await this.resolveParticipant(row.actor_id));
      }
    }
    return rows.map((row) => CollaborationDiscussionMessageSchema.parse({
      id: row.id,
      scopeId: row.scope_id,
      sequence: String(row.sequence),
      actor: participants.get(row.actor_id),
      text: row.text,
      createdAt: toIso(row.created_at),
    }));
  }

  private requireTerminal(context: AuthorizedCollaborationContext): void {
    if (context.resourceKind !== "terminal") {
      throw new CollaborationAuthorizationError("unavailable", "Session discussion is unavailable");
    }
  }

  private async lockAndReauthorize(
    trx: Transaction<OwnerCollaborationDatabase>,
    context: AuthorizedCollaborationContext,
    action: "read" | "discuss",
    now: Date,
  ): Promise<{
    scope: Selectable<CollaborationScopesTable>;
    scopeId: string;
    actorId: string;
    authEpoch: number;
  }> {
    const scope = await trx.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", context.scopeId)
      .where("kind", "=", "terminal")
      .where("resource_id", "=", context.resourceId)
      .where("owner_id", "=", context.ownerId)
      .where("lifecycle", "=", "shared")
      .where("authority_generation", "=", context.authorityGeneration)
      .forUpdate()
      .executeTakeFirst();
    if (!scope) throw new CollaborationAuthorizationError("unavailable", "Shared terminal is unavailable");
    const member = await trx.selectFrom("collaboration_members")
      .select(["role", "status", "expires_at"])
      .where("scope_id", "=", context.membershipScopeId)
      .where("actor_id", "=", context.actorId)
      .executeTakeFirst();
    if (!member || member.status !== "accepted"
      || (action === "discuss" && !["owner", "editor"].includes(member.role))
      || (member.expires_at !== null && new Date(member.expires_at).getTime() <= now.getTime())) {
      throw new CollaborationAuthorizationError("forbidden", "Current membership is required");
    }
    const parentEpoch = context.membershipScopeId === context.scopeId
      ? 0
      : Number((await trx.selectFrom("collaboration_scopes").select("auth_epoch")
        .where("id", "=", context.membershipScopeId).executeTakeFirst())?.auth_epoch ?? Number.MAX_SAFE_INTEGER);
    const authEpoch = Math.max(Number(scope.auth_epoch), parentEpoch);
    if (authEpoch !== context.authEpoch) {
      throw new CollaborationRepositoryError("conflict", "Scope authority changed");
    }
    return { scope, scopeId: context.scopeId, actorId: context.actorId, authEpoch };
  }

  private async resolveParticipant(actorId: string): Promise<Participant> {
    try {
      const participant = await this.options.resolveParticipant(actorId);
      return participant.actorId === actorId
        ? participant
        : { actorId, displayName: "Unknown participant" };
    } catch (error: unknown) {
      console.warn(
        "[collaboration-discussion] participant lookup failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return { actorId, displayName: "Unknown participant" };
    }
  }
}

function safeSequence(value: string): number {
  const parsed = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).safeParse(value);
  if (!parsed.success) throw new CollaborationDiscussionError("invalid_request", "Invalid discussion cursor");
  return parsed.data;
}

async function appendEvent(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: Selectable<CollaborationScopesTable>,
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
    resource_kind: scope.kind,
    resource_id: scope.resource_id,
    revision: Number(scope.revision),
    authority_generation: Number(scope.authority_generation),
    event_type: eventType,
    payload: jsonb({}),
    created_at: now,
  }).execute();
}
