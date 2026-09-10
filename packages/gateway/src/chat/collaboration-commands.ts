import { randomUUID } from "node:crypto";
import {
  CanonicalChatApprovalDecisionSchema,
  CanonicalChatQueuedTurnIdSchema,
  CollaborationActorIdSchema,
  CollaborationIdSchema,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import type {
  ChatCollaborationCommandsTable,
  OwnerCollaborationDatabase,
} from "../collaboration/database.js";
import { jsonb, parseJson } from "./records.js";
import type { SharedQueuedTurn } from "./repository.js";

const RequestIdSchema = CollaborationIdSchema;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_SHARED_PENDING = 32;

export class CollaborationChatCommandError extends Error {
  constructor(readonly code: "capacity" | "conflict" | "forbidden" | "not_found" | "unavailable") {
    super("Shared Chat control unavailable");
    this.name = "CollaborationChatCommandError";
  }
}

export interface CollaborationChatCommandResult {
  id: string;
  kind: "approval" | "cancel" | "retry";
  state: "accepted" | "completed" | "failed" | "reconciling";
  request?: SharedQueuedTurn;
  approvalId?: string;
  decision?: "approve" | "approve_for_session" | "decline" | "cancel";
}

interface CommandIdentity {
  scopeId: string;
  actorId: string;
  clientRequestId: string;
  payloadHash: string;
  expectedRevision: number;
}

export class CollaborationChatCommands {
  private readonly now: () => Date;

  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    now?: () => Date;
    submitApproval(input: {
      scopeId: string;
      chatId: string;
      runId: string;
      approvalId: string;
      decision: "approve" | "approve_for_session" | "decline" | "cancel";
      clientRequestId: string;
      actorId: string;
    }): Promise<void>;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  async cancel(input: CommandIdentity & { requestId: string }): Promise<CollaborationChatCommandResult> {
    const identity = parseIdentity(input);
    const requestId = CanonicalChatQueuedTurnIdSchema.parse(input.requestId);
    return this.options.db.transaction().execute(async (trx) => {
      const authorized = await authorizeCommand(trx, identity, "cancel", requestId, this.now());
      const replay = await replayCommand(trx, identity, "cancel");
      if (replay) return replay;
      requireExpectedRevision(identity, authorized.chatRevision);
      const request = await lockRequest(trx, authorized.chatId, requestId);
      requireRequestControl(authorized.role, identity.actorId, request.requesting_actor_id);
      if (request.status !== "queued") throw new CollaborationChatCommandError("conflict");
      await trx.updateTable("chat_queued_turns").set({
        status: "cancelled",
        cancelled_at: authorized.at,
        updated_at: authorized.at,
      }).where("id", "=", request.id).where("status", "=", "queued").executeTakeFirstOrThrow();
      await compactQueue(trx, authorized.chatId, Number(request.position), authorized.at);
      const revision = await advanceChat(trx, authorized.chatId, authorized.chatRevision, authorized.at);
      const result = resultForRequest(request, "cancel", "completed", {
        status: "cancelled",
        updated_at: authorized.at,
      });
      await insertCommand(trx, identity, authorized, {
        kind: "cancel", targetRequestId: requestId, state: "completed", result,
      });
      await appendEvent(trx, authorized, revision, "chat.ai_request.cancelled", {
        requestId, actorId: identity.actorId, state: "cancelled",
      });
      return result;
    });
  }

  async retry(input: CommandIdentity & {
    requestId: string;
    newRequestId: string;
  }): Promise<CollaborationChatCommandResult> {
    const identity = parseIdentity(input);
    const requestId = CanonicalChatQueuedTurnIdSchema.parse(input.requestId);
    const newRequestId = CanonicalChatQueuedTurnIdSchema.parse(input.newRequestId);
    return this.options.db.transaction().execute(async (trx) => {
      const authorized = await authorizeCommand(trx, identity, "retry", requestId, this.now());
      const replay = await replayCommand(trx, identity, "retry");
      if (replay) return replay;
      requireExpectedRevision(identity, authorized.chatRevision);
      const original = await lockRequest(trx, authorized.chatId, requestId);
      requireRequestControl(authorized.role, identity.actorId, original.requesting_actor_id);
      if (!["cancelled", "interrupted", "unauthorized", "unavailable"].includes(original.status)) {
        throw new CollaborationChatCommandError("conflict");
      }
      const pendingCount = await countPending(trx, authorized.chatId);
      if (pendingCount >= MAX_SHARED_PENDING) throw new CollaborationChatCommandError("capacity");
      const lastAccepted = await trx.selectFrom("chat_queued_turns")
        .select(({ fn }) => fn.max<number>("accepted_seq").as("accepted_seq"))
        .where("chat_id", "=", authorized.chatId)
        .where("collaboration_scope_id", "=", identity.scopeId)
        .executeTakeFirst();
      const acceptedSequence = Number(lastAccepted?.accepted_seq ?? 0) + 1;
      const inserted = await trx.insertInto("chat_queued_turns").values({
        id: newRequestId,
        chat_id: authorized.chatId,
        client_request_id: `req_${identity.clientRequestId.replaceAll("-", "")}`,
        actor_request_id: identity.clientRequestId,
        requesting_actor_id: identity.actorId,
        collaboration_scope_id: identity.scopeId,
        accepted_seq: acceptedSequence,
        payload_hash: identity.payloadHash,
        accepted_auth_epoch: authorized.authEpoch,
        retry_of_queued_turn_id: requestId,
        position: pendingCount + 1,
        status: "queued",
        parts: original.parts,
        driver_kind: original.driver_kind,
        instance_id: original.instance_id,
        selection: original.selection,
        interaction_mode: original.interaction_mode,
        permission_mode: original.permission_mode,
        execution_root: null,
        execution_root_fingerprint: null,
        capability_snapshot: original.capability_snapshot,
        claimed_turn_id: null,
        claimed_run_id: null,
        cancelled_at: null,
        created_at: authorized.at,
        updated_at: authorized.at,
      }).returningAll().executeTakeFirstOrThrow();
      const revision = await advanceChat(trx, authorized.chatId, authorized.chatRevision, authorized.at);
      const result = resultForRequest(inserted, "retry", "completed");
      await insertCommand(trx, identity, authorized, {
        kind: "retry", targetRequestId: requestId, state: "completed", result,
      });
      await appendEvent(trx, authorized, revision, "chat.ai_request.retried", {
        requestId: newRequestId,
        retryOfRequestId: requestId,
        actorId: identity.actorId,
        acceptedSequence,
      });
      return result;
    });
  }

  async decideApproval(input: CommandIdentity & {
    runId: string;
    approvalId: string;
    decision: "approve" | "approve_for_session" | "decline" | "cancel";
  }): Promise<CollaborationChatCommandResult> {
    const identity = parseIdentity(input);
    const decision = CanonicalChatApprovalDecisionSchema.parse(input.decision);
    const runId = z.string().min(1).max(128).parse(input.runId);
    const approvalId = z.string().min(1).max(128).parse(input.approvalId);
    const reserved = await this.options.db.transaction().execute(async (trx) => {
      const authorized = await authorizeCommand(trx, identity, "approval", undefined, this.now());
      if (authorized.role !== "owner") throw new CollaborationChatCommandError("forbidden");
      const replay = await replayCommand(trx, identity, "approval");
      if (replay) return { result: replay, dispatch: false, chatId: authorized.chatId };
      requireExpectedRevision(identity, authorized.chatRevision);
      const decided = await trx.selectFrom("chat_collaboration_commands").select("id")
        .where("scope_id", "=", identity.scopeId)
        .where("kind", "=", "approval")
        .where("approval_id", "=", approvalId)
        .executeTakeFirst();
      if (decided) throw new CollaborationChatCommandError("conflict");
      const run = await trx.selectFrom("chat_runs").select(["id", "status"])
        .where("id", "=", runId)
        .where("chat_id", "=", authorized.chatId)
        .forUpdate()
        .executeTakeFirst();
      if (!run || run.status !== "waiting_for_approval"
        || !await pendingApprovalAllows(trx, runId, approvalId, decision)) {
        throw new CollaborationChatCommandError("conflict");
      }
      const result: CollaborationChatCommandResult = {
        id: randomUUID(), kind: "approval", state: "accepted", approvalId, decision,
      };
      await insertCommand(trx, identity, authorized, {
        id: result.id, kind: "approval", runId, approvalId, decision, state: "accepted", result,
      });
      return { result, dispatch: true, chatId: authorized.chatId };
    });
    if (!reserved.dispatch) return reserved.result;

    try {
      await this.options.submitApproval({
        scopeId: identity.scopeId,
        chatId: reserved.chatId,
        runId,
        approvalId,
        decision,
        clientRequestId: identity.clientRequestId,
        actorId: identity.actorId,
      });
    } catch (error: unknown) {
      console.warn("[chat/collaboration-commands] approval outcome unknown",
        error instanceof Error ? error.name : "UnknownError");
      await this.finishExternalCommand(reserved.result.id, "reconciling");
      throw new CollaborationChatCommandError("unavailable");
    }
    return this.finishExternalCommand(reserved.result.id, "completed");
  }

  private async finishExternalCommand(
    commandId: string,
    state: "completed" | "reconciling",
  ): Promise<CollaborationChatCommandResult> {
    return this.options.db.transaction().execute(async (trx) => {
      const command = await trx.selectFrom("chat_collaboration_commands").selectAll()
        .where("id", "=", commandId).forUpdate().executeTakeFirst();
      if (!command) throw new CollaborationChatCommandError("unavailable");
      const result = commandResult(command, state);
      await trx.updateTable("chat_collaboration_commands").set({
        state,
        result_ref: jsonb(result),
        updated_at: this.now().toISOString(),
      }).where("id", "=", commandId).where("state", "=", "accepted").execute();
      return result;
    });
  }
}

function parseIdentity(input: CommandIdentity): CommandIdentity {
  return {
    scopeId: CollaborationIdSchema.parse(input.scopeId),
    actorId: CollaborationActorIdSchema.parse(input.actorId),
    clientRequestId: RequestIdSchema.parse(input.clientRequestId),
    payloadHash: HashSchema.parse(input.payloadHash),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(input.expectedRevision),
  };
}

function requireExpectedRevision(identity: CommandIdentity, currentRevision: number): void {
  if (identity.expectedRevision !== currentRevision) throw new CollaborationChatCommandError("conflict");
}

async function authorizeCommand(
  trx: Transaction<OwnerCollaborationDatabase>,
  identity: CommandIdentity,
  _kind: "approval" | "cancel" | "retry",
  _requestId: string | undefined,
  now: Date,
) {
  const scope = await trx.selectFrom("collaboration_scopes").selectAll()
    .where("id", "=", identity.scopeId).forUpdate().executeTakeFirst();
  if (!scope || scope.kind !== "chat") throw new CollaborationChatCommandError("not_found");
  if (scope.lifecycle !== "shared" || scope.membership_mode !== "direct") {
    throw new CollaborationChatCommandError("unavailable");
  }
  const member = await trx.selectFrom("collaboration_members").selectAll()
    .where("scope_id", "=", identity.scopeId)
    .where("actor_id", "=", identity.actorId)
    .forUpdate().executeTakeFirst();
  if (!member || member.status !== "accepted"
    || (member.expires_at !== null && new Date(member.expires_at).getTime() <= now.getTime())) {
    throw new CollaborationChatCommandError("not_found");
  }
  if (member.role === "viewer") throw new CollaborationChatCommandError("forbidden");
  const chat = await trx.selectFrom("chats").select(["id", "revision", "collaboration"])
    .where("id", "=", scope.resource_id)
    .where("owner_id", "=", scope.owner_id)
    .where("owner_type", "=", scope.owner_type)
    .forUpdate().executeTakeFirst();
  if (!chat || !bindingMatches(chat.collaboration, scope.id)) {
    throw new CollaborationChatCommandError("unavailable");
  }
  return {
    scopeId: scope.id,
    chatId: chat.id,
    chatRevision: Number(chat.revision),
    role: member.role,
    authEpoch: Number(scope.auth_epoch),
    authorityGeneration: Number(scope.authority_generation),
    at: now.toISOString(),
  };
}

async function replayCommand(
  trx: Transaction<OwnerCollaborationDatabase>,
  identity: CommandIdentity,
  kind: "approval" | "cancel" | "retry",
): Promise<CollaborationChatCommandResult | null> {
  const existing = await trx.selectFrom("chat_collaboration_commands").selectAll()
    .where("scope_id", "=", identity.scopeId)
    .where("actor_id", "=", identity.actorId)
    .where("client_request_id", "=", identity.clientRequestId)
    .where("kind", "=", kind)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.payload_hash !== identity.payloadHash) throw new CollaborationChatCommandError("conflict");
  return existing.result_ref
    ? parseJson(existing.result_ref) as CollaborationChatCommandResult
    : commandResult(existing);
}

async function lockRequest(trx: Transaction<OwnerCollaborationDatabase>, chatId: string, requestId: string) {
  const request = await trx.selectFrom("chat_queued_turns").selectAll()
    .where("id", "=", requestId)
    .where("chat_id", "=", chatId)
    .where("collaboration_scope_id", "is not", null)
    .forUpdate().executeTakeFirst();
  if (!request) throw new CollaborationChatCommandError("not_found");
  return request;
}

function requireRequestControl(role: string, actorId: string, requestActorId: string | null): void {
  if (role !== "owner" && requestActorId !== actorId) throw new CollaborationChatCommandError("forbidden");
}

async function compactQueue(
  trx: Transaction<OwnerCollaborationDatabase>,
  chatId: string,
  afterPosition: number,
  at: string,
): Promise<void> {
  await trx.updateTable("chat_queued_turns")
    .set({ position: sql<number>`position - 1`, updated_at: at })
    .where("chat_id", "=", chatId)
    .where("status", "=", "queued")
    .where("position", ">", afterPosition)
    .execute();
}

async function countPending(trx: Transaction<OwnerCollaborationDatabase>, chatId: string): Promise<number> {
  const count = await trx.selectFrom("chat_queued_turns")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("chat_id", "=", chatId)
    .where("collaboration_scope_id", "is not", null)
    .where("status", "=", "queued")
    .executeTakeFirstOrThrow();
  return Number(count.count);
}

async function advanceChat(
  trx: Transaction<OwnerCollaborationDatabase>,
  chatId: string,
  revision: number,
  at: string,
): Promise<number> {
  const next = revision + 1;
  const updated = await trx.updateTable("chats").set({ revision: next, updated_at: at })
    .where("id", "=", chatId).where("revision", "=", revision)
    .returning("id").executeTakeFirst();
  if (!updated) throw new CollaborationChatCommandError("conflict");
  return next;
}

async function insertCommand(
  trx: Transaction<OwnerCollaborationDatabase>,
  identity: CommandIdentity,
  authorized: Awaited<ReturnType<typeof authorizeCommand>>,
  input: {
    id?: string;
    kind: "approval" | "cancel" | "retry";
    targetRequestId?: string;
    runId?: string;
    approvalId?: string;
    decision?: string;
    state: "accepted" | "completed" | "failed" | "reconciling";
    result: CollaborationChatCommandResult;
  },
): Promise<void> {
  await trx.insertInto("chat_collaboration_commands").values({
    id: input.id ?? input.result.id,
    scope_id: identity.scopeId,
    chat_id: authorized.chatId,
    target_request_id: input.targetRequestId ?? null,
    run_id: input.runId ?? null,
    approval_id: input.approvalId ?? null,
    actor_id: identity.actorId,
    client_request_id: identity.clientRequestId,
    kind: input.kind,
    payload_hash: identity.payloadHash,
    expected_state_revision: identity.expectedRevision,
    decision: input.decision ?? null,
    authorized_epoch: authorized.authEpoch,
    state: input.state,
    result_ref: jsonb(input.result),
    created_at: authorized.at,
    updated_at: authorized.at,
  }).execute();
}

function resultForRequest(
  row: Selectable<OwnerCollaborationDatabase["chat_queued_turns"]>,
  kind: "cancel" | "retry",
  state: "completed",
  override: Partial<Selectable<OwnerCollaborationDatabase["chat_queued_turns"]>> = {},
): CollaborationChatCommandResult {
  const request = sharedRequest({ ...row, ...override });
  return { id: randomUUID(), kind, state, request };
}

function sharedRequest(row: Selectable<OwnerCollaborationDatabase["chat_queued_turns"]>): SharedQueuedTurn {
  if (!row.collaboration_scope_id || !row.actor_request_id || !row.requesting_actor_id
    || row.accepted_seq === null || row.accepted_auth_epoch === null) {
    throw new CollaborationChatCommandError("unavailable");
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    scopeId: row.collaboration_scope_id,
    clientRequestId: row.actor_request_id,
    requestingActorId: row.requesting_actor_id,
    acceptedSequence: Number(row.accepted_seq),
    acceptedAuthEpoch: Number(row.accepted_auth_epoch),
    ...(row.retry_of_queued_turn_id ? { retryOfRequestId: row.retry_of_queued_turn_id } : {}),
    state: row.status,
    parts: parseJson(row.parts) as SharedQueuedTurn["parts"],
    selection: parseJson(row.selection) as SharedQueuedTurn["selection"],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function commandResult(
  row: Selectable<ChatCollaborationCommandsTable>,
  state = row.state,
): CollaborationChatCommandResult {
  return {
    id: row.id,
    kind: row.kind,
    state,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.decision ? {
      decision: CanonicalChatApprovalDecisionSchema.parse(row.decision),
    } : {}),
  };
}

async function pendingApprovalAllows(
  trx: Transaction<OwnerCollaborationDatabase>,
  runId: string,
  approvalId: string,
  decision: string,
): Promise<boolean> {
  const rows = await trx.selectFrom("chat_run_events").select("event")
    .where("run_id", "=", runId).orderBy("run_seq", "asc").execute();
  let allowed: string[] | null = null;
  for (const row of rows) {
    const event = parseJson(row.event) as { type?: unknown; approvalId?: unknown; allowedDecisions?: unknown };
    if (event.approvalId !== approvalId) continue;
    if (event.type === "approval.requested" && Array.isArray(event.allowedDecisions)) {
      allowed = event.allowedDecisions.filter((value): value is string => typeof value === "string");
    }
    if (event.type === "approval.resolved") allowed = null;
  }
  return allowed?.includes(decision) ?? false;
}

async function appendEvent(
  trx: Transaction<OwnerCollaborationDatabase>,
  authorized: Awaited<ReturnType<typeof authorizeCommand>>,
  revision: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const latest = await trx.selectFrom("collaboration_events")
    .select(({ fn }) => fn.max<number>("scope_seq").as("scope_seq"))
    .where("scope_id", "=", authorized.scopeId)
    .executeTakeFirst();
  await trx.insertInto("collaboration_events").values({
    scope_id: authorized.scopeId,
    scope_seq: Number(latest?.scope_seq ?? 0) + 1,
    event_id: randomUUID(),
    resource_kind: "chat",
    resource_id: authorized.chatId,
    revision,
    authority_generation: authorized.authorityGeneration,
    event_type: eventType,
    payload: jsonb(payload),
    created_at: authorized.at,
  }).execute();
}

function bindingMatches(value: unknown, scopeId: string): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return !!parsed && typeof parsed === "object"
      && (parsed as { scopeId?: unknown }).scopeId === scopeId
      && (parsed as { executionFenced?: unknown }).executionFenced === true;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[chat/collaboration-commands] binding decode failed",
        error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}
