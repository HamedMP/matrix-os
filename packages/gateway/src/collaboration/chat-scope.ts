import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ChatOwner } from "../chat/records.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationScopeRecord } from "./repository.js";

const ACTIVE_RUN_STATES = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;
const PREFLIGHT_LIFETIME_MS = 60_000;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const PreflightPayloadSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1).max(128),
  chatId: z.string().min(1).max(160),
  chatRevision: z.number().int().min(0),
  expiresAt: z.iso.datetime(),
}).strict();

export type CollaborationChatScopeErrorCode =
  | "not_found"
  | "active_work"
  | "conflict"
  | "invalid_confirmation"
  | "shared_execution_disabled";

export class CollaborationChatScopeError extends Error {
  constructor(
    public readonly code: CollaborationChatScopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationChatScopeError";
  }
}

export class CollaborationChatScopeService {
  private readonly now: () => Date;
  private readonly createScopeId: () => string;

  constructor(
    public readonly db: Kysely<OwnerCollaborationDatabase>,
    private readonly options: {
      runtimeId: string;
      preflightSecret: string;
      now?: () => Date;
      createScopeId?: () => string;
    },
  ) {
    if (Buffer.byteLength(options.preflightSecret) < 32) {
      throw new Error("Collaboration preflight secret is unavailable");
    }
    this.now = options.now ?? (() => new Date());
    this.createScopeId = options.createScopeId ?? randomUUID;
  }

  async preflight(input: { ownerId: string; chatId: string }): Promise<{
    eligible: boolean;
    reason?: "active_work";
    chatRevision: number;
    confirmationToken?: string;
  }> {
    const chat = await this.db.selectFrom("chats")
      .select(["revision", "collaboration"])
      .where("id", "=", input.chatId)
      .where("owner_type", "=", "personal")
      .where("owner_id", "=", input.ownerId)
      .where("lifecycle", "=", "active")
      .executeTakeFirst();
    if (!chat) throw new CollaborationChatScopeError("not_found", "Chat not found");
    const chatRevision = Number(chat.revision);
    if (await hasActiveWork(this.db, input.chatId)) {
      return { eligible: false, reason: "active_work", chatRevision };
    }
    const payload = PreflightPayloadSchema.parse({
      version: 1,
      ownerId: input.ownerId,
      chatId: input.chatId,
      chatRevision,
      expiresAt: new Date(this.now().getTime() + PREFLIGHT_LIFETIME_MS).toISOString(),
    });
    return {
      eligible: true,
      chatRevision,
      confirmationToken: signPreflight(payload, this.options.preflightSecret),
    };
  }

  async shareChat(input: {
    ownerId: string;
    chatId: string;
    clientRequestId: string;
    payloadHash: string;
    expectedChatRevision: number;
    confirmationToken: string;
  }): Promise<CollaborationScopeRecord> {
    const now = this.now().toISOString();
    return this.db.transaction().execute(async (trx) => {
      const chat = await trx.selectFrom("chats")
        .selectAll()
        .where("id", "=", input.chatId)
        .where("owner_type", "=", "personal")
        .where("owner_id", "=", input.ownerId)
        .where("lifecycle", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (!chat) throw new CollaborationChatScopeError("not_found", "Chat not found");
      const existingBinding = parseBinding(chat.collaboration);
      if (existingBinding) {
        const existing = await selectScope(trx, existingBinding.scopeId);
        if (existing && existing.kind === "chat" && existing.resource_id === input.chatId
          && existing.lifecycle === "shared") {
          const replay = await trx.selectFrom("collaboration_operations")
            .select(["payload_hash", "status"])
            .where("scope_id", "=", existing.id)
            .where("actor_id", "=", input.ownerId)
            .where("client_request_id", "=", input.clientRequestId)
            .where("operation_kind", "=", "scope.create")
            .executeTakeFirst();
          if (replay && (replay.payload_hash !== input.payloadHash || replay.status !== "completed")) {
            throw new CollaborationChatScopeError("conflict", "Scope creation request changed");
          }
          if (!replay) {
            await writeCreateOperation(trx, existing, input, now);
          }
          return scopeRecord(existing);
        }
        throw new CollaborationChatScopeError("conflict", "Chat collaboration binding is invalid");
      }
      this.verifyConfirmation(input);
      if (Number(chat.revision) !== input.expectedChatRevision) {
        throw new CollaborationChatScopeError("conflict", "Chat revision changed");
      }
      if (await hasActiveWork(trx, input.chatId)) {
        throw new CollaborationChatScopeError("active_work", "Private Chat activity must settle first");
      }

      const scopeId = this.createScopeId();
      await trx.insertInto("collaboration_scopes").values({
        id: scopeId,
        owner_type: "personal",
        owner_id: input.ownerId,
        kind: "chat",
        resource_id: input.chatId,
        parent_scope_id: null,
        membership_mode: "direct",
        lifecycle: "private",
        revision: 0,
        auth_epoch: 0,
        authority_runtime_id: this.options.runtimeId,
        authority_generation: 1,
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
        .where("kind", "=", "chat")
        .where("resource_id", "=", input.chatId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (scope.lifecycle === "shared") return scopeRecord(scope);
      if (scope.lifecycle !== "private" || Number(scope.revision) !== 0) {
        throw new CollaborationChatScopeError("conflict", "Chat scope state changed");
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
        revision: 1,
        joined_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.columns(["scope_id", "actor_id"]).doNothing()).execute();
      await trx.insertInto("chat_members").values({
        chat_id: input.chatId,
        principal_type: "user",
        principal_id: input.ownerId,
        role: "owner",
        created_at: now,
      }).onConflict((conflict) => conflict.columns(["chat_id", "principal_type", "principal_id"]).doNothing()).execute();

      const updatedChat = await trx.updateTable("chats").set({
        collaboration: jsonb({
          scopeId: scope.id,
          mode: "discussion_only",
          executionFenced: true,
          authorityGeneration: 1,
        }),
        revision: input.expectedChatRevision + 1,
        updated_at: now,
      }).where("id", "=", input.chatId)
        .where("revision", "=", input.expectedChatRevision)
        .where("collaboration", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!updatedChat) throw new CollaborationChatScopeError("conflict", "Chat revision changed");
      const activated = await trx.updateTable("collaboration_scopes").set({
        lifecycle: "shared",
        revision: 1,
        auth_epoch: 1,
        updated_at: now,
      }).where("id", "=", scope.id)
        .where("lifecycle", "=", "private")
        .where("revision", "=", 0)
        .returningAll()
        .executeTakeFirst();
      if (!activated) throw new CollaborationChatScopeError("conflict", "Chat scope state changed");
      const eventId = randomUUID();
      await trx.insertInto("collaboration_events").values({
        scope_id: scope.id,
        scope_seq: 1,
        event_id: eventId,
        resource_kind: "chat",
        resource_id: input.chatId,
        revision: 1,
        authority_generation: 1,
        event_type: "scope.shared",
        payload: jsonb({}),
        created_at: now,
      }).execute();
      await trx.insertInto("collaboration_audit").values({
        scope_id: scope.id,
        actor_id: input.ownerId,
        action: "scope.shared",
        outcome: "completed",
        revision: 1,
        reason_code: null,
        created_at: now,
      }).execute();
      await trx.insertInto("collaboration_directory_outbox").values({
        event_id: eventId,
        scope_id: scope.id,
        recipient_actor_ids: jsonb([{ actorId: input.ownerId }]),
        authority_runtime_id: this.options.runtimeId,
        authority_generation: 1,
        resource_kind: "chat",
        discovery_state: "accepted",
        retry_after: now,
        delivered_at: null,
        created_at: now,
      }).execute();
      await writeCreateOperation(trx, activated, input, now);
      return scopeRecord(activated);
    });
  }

  async assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void> {
    await assertDiscussionOnlyChatExecutionAllowed(this.db, owner, chatId);
  }

  private verifyConfirmation(input: {
    ownerId: string;
    chatId: string;
    expectedChatRevision: number;
    confirmationToken: string;
  }): void {
    const [encoded, signature, extra] = input.confirmationToken.split(".");
    if (!encoded || !signature || extra !== undefined) throw invalidConfirmation();
    const expected = createHmac("sha256", this.options.preflightSecret).update(encoded).digest();
    const received = Buffer.from(signature, "base64url");
    const padded = Buffer.alloc(expected.length);
    received.copy(padded, 0, 0, expected.length);
    if (received.length !== expected.length || !timingSafeEqual(padded, expected)) throw invalidConfirmation();
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) console.warn("[collaboration] preflight decode failed", error instanceof Error ? error.name : "UnknownError");
      throw invalidConfirmation();
    }
    const payload = PreflightPayloadSchema.safeParse(value);
    if (!payload.success || payload.data.ownerId !== input.ownerId || payload.data.chatId !== input.chatId
      || payload.data.chatRevision !== input.expectedChatRevision
      || Date.parse(payload.data.expiresAt) <= this.now().getTime()) throw invalidConfirmation();
  }
}

async function writeCreateOperation(
  trx: Transaction<OwnerCollaborationDatabase>,
  scope: Awaited<ReturnType<typeof selectScope>> & {},
  input: {
    ownerId: string;
    clientRequestId: string;
    payloadHash: string;
    expectedChatRevision: number;
  },
  now: string,
): Promise<void> {
  if (!scope) throw new CollaborationChatScopeError("conflict", "Chat scope is unavailable");
  await trx.insertInto("collaboration_operations").values({
    scope_id: scope.id,
    actor_id: input.ownerId,
    client_request_id: input.clientRequestId,
    operation_kind: "scope.create",
    payload_hash: input.payloadHash,
    status: "completed",
    result_ref: jsonb({ scopeId: scope.id }),
    expected_revision: input.expectedChatRevision,
    accepted_auth_epoch: Number(scope.auth_epoch),
    created_at: now,
    expires_at: new Date(new Date(now).getTime() + OPERATION_RETENTION_MS).toISOString(),
  }).execute();
}

export function createDiscussionOnlyChatExecutionGuard(db: Kysely<OwnerCollaborationDatabase>): {
  assertPersonalExecutionAllowed(owner: ChatOwner, chatId: string): Promise<void>;
} {
  return {
    assertPersonalExecutionAllowed: (owner, chatId) => assertDiscussionOnlyChatExecutionAllowed(db, owner, chatId),
  };
}

async function assertDiscussionOnlyChatExecutionAllowed(
  db: Kysely<OwnerCollaborationDatabase>,
  owner: ChatOwner,
  chatId: string,
): Promise<void> {
  const chat = await db.selectFrom("chats")
    .select("collaboration")
    .where("id", "=", chatId)
    .where("owner_type", "=", owner.type)
    .where("owner_id", "=", owner.ownerId)
    .executeTakeFirst();
  if (!chat) throw new CollaborationChatScopeError("not_found", "Chat not found");
  if (parseBinding(chat.collaboration)) {
    throw new CollaborationChatScopeError(
      "shared_execution_disabled",
      "AI is unavailable while this shared Chat is in discussion-only mode",
    );
  }
}

async function hasActiveWork(
  db: Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>,
  chatId: string,
): Promise<boolean> {
  const [run, queued, steer] = await Promise.all([
    db.selectFrom("chat_runs").select("id").where("chat_id", "=", chatId)
      .where("status", "in", [...ACTIVE_RUN_STATES]).limit(1).executeTakeFirst(),
    db.selectFrom("chat_queued_turns").select("id").where("chat_id", "=", chatId)
      .where("status", "in", ["queued", "claimed"]).limit(1).executeTakeFirst(),
    db.selectFrom("chat_run_steers").select("id").where("chat_id", "=", chatId)
      .where("status", "=", "pending").limit(1).executeTakeFirst(),
  ]);
  return Boolean(run || queued || steer);
}

function signPreflight(payload: z.infer<typeof PreflightPayloadSchema>, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

function invalidConfirmation(): CollaborationChatScopeError {
  return new CollaborationChatScopeError("invalid_confirmation", "Share confirmation is invalid");
}

function parseBinding(value: unknown): { scopeId: string } | null {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || !("scopeId" in parsed) || typeof parsed.scopeId !== "string") return null;
  return { scopeId: parsed.scopeId };
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

async function selectScope(db: Transaction<OwnerCollaborationDatabase>, scopeId: string) {
  return db.selectFrom("collaboration_scopes").selectAll().where("id", "=", scopeId).executeTakeFirst();
}

function scopeRecord(row: Awaited<ReturnType<typeof selectScope>> & {}): CollaborationScopeRecord {
  if (!row) throw new CollaborationChatScopeError("not_found", "Scope not found");
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
