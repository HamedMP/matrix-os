import { appendRunActivities } from "./activity-repository.js";
import type { ChatActivityWriteHook } from "./activity-write-hook.js";
import { appendAssistantAttachment } from "./assistant-attachment-repository.js";
import { finishRun } from "./finish-run-repository.js";
import { appendAssistantDelta, type AssistantDeltaInput, type AssistantDeltaWriteHook, type AssistantDeltaTransact } from "./assistant-delta-repository.js";
import { assertInputClaim, getChatInputState, pendingInputTransition } from "./input-submission.js";
import {
  CanonicalChatIdSchema,
  AgentAttachmentSchema,
  CanonicalChatMessagePartSchema,
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessage,
  type AgentAttachment,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
} from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import { ChatRunFailureDiagnosticSchema, type ChatRunFailureDiagnostic } from "./failure-diagnostic.js";
import type { ChatDatabase, ChatsTable } from "./database.js";
import {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatProviderInstanceLockedError,
  ChatRunNotActiveError,
} from "./errors.js";
import {
  jsonb,
  messageAttribution,
  messageSearchText,
  toActivity,
  toMessage,
  toRun,
  type ChatOutboxEventType,
  type ChatOwner,
} from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
type Transact = AssistantDeltaTransact;
type AppendOutbox = (
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
  revision: number,
  eventType: ChatOutboxEventType,
  payload?: Record<string, unknown>,
) => Promise<void>;
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;

const SAFE_INTERNAL_REF = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const encoded = new TextEncoder();

function validateOwner(owner: ChatOwner): ChatOwner {
  return CanonicalOwnerScopeSchema.parse(owner);
}

function requireSafeRef(value: string): string {
  return SAFE_INTERNAL_REF.parse(value);
}



async function selectOwnedChat(
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
  lock = false,
): Promise<Selectable<ChatsTable> | undefined> {
  let query = executor.selectFrom("chats").selectAll()
    .where("id", "=", chatId)
    .where("owner_type", "=", owner.type)
    .where("owner_id", "=", owner.ownerId);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

export class ChatRunLifecycleRepository {
  constructor(
    private readonly kysely: Kysely<ChatDatabase>,
    private readonly transact: Transact,
    private readonly appendOutbox: AppendOutbox,
    private readonly assistantDeltaWrites?: AssistantDeltaWriteHook,
    private readonly activityWrites?: ChatActivityWriteHook,
  ) {}

  async hasRetryRequest(ownerInput: ChatOwner, input: { chatId: string; turnId: string; clientRequestId: string }): Promise<boolean> {
    const owner = validateOwner(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    [input.turnId, input.clientRequestId].forEach(requireSafeRef);
    const row = await this.kysely.selectFrom("chat_runs")
      .innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .select("chat_runs.id")
      .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
      .where("chat_runs.chat_id", "=", chatId).where("chat_runs.turn_id", "=", input.turnId)
      .where("chat_runs.client_request_id", "=", input.clientRequestId).executeTakeFirst();
    return row !== undefined;
  }

  async getAdapterState(ownerInput: ChatOwner, input: {
    runId: string;
    driverKind: string;
    instanceId: string;
  }): Promise<{ schemaVersion: number; state: unknown } | null> {
    const owner = validateOwner(ownerInput);
    [input.runId, input.driverKind, input.instanceId].forEach(requireSafeRef);
    const row = await this.kysely.selectFrom("chat_run_adapter_state")
      .innerJoin("chat_runs", "chat_runs.id", "chat_run_adapter_state.run_id")
      .innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .select(["chat_run_adapter_state.schema_version", "chat_run_adapter_state.state"])
      .where("chats.owner_type", "=", owner.type)
      .where("chats.owner_id", "=", owner.ownerId)
      .where("chat_run_adapter_state.run_id", "=", input.runId)
      .where("chat_run_adapter_state.driver_kind", "=", input.driverKind)
      .where("chat_run_adapter_state.instance_id", "=", input.instanceId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      schemaVersion: row.schema_version,
      state: typeof row.state === "string" ? JSON.parse(row.state) : row.state,
    };
  }

  async getLatestAdapterStateForChat(ownerInput: ChatOwner, input: {
    chatId: string;
    driverKind: string;
    instanceId: string;
    schemaVersion: number;
    executionRootFingerprint: string | null;
    includeInterrupted?: boolean;
  }): Promise<{ schemaVersion: number; state: unknown; executionRootFingerprint?: string } | null> {
    const owner = validateOwner(ownerInput);
    [input.driverKind, input.instanceId].forEach(requireSafeRef);
    if (!await selectOwnedChat(this.kysely, owner, CanonicalChatIdSchema.parse(input.chatId))) return null;
    const row = await this.kysely.selectFrom("chat_run_adapter_state")
      .innerJoin("chat_runs", "chat_runs.id", "chat_run_adapter_state.run_id")
      .select([
        "chat_run_adapter_state.schema_version",
        "chat_run_adapter_state.state",
        "chat_runs.execution_root_fingerprint",
      ])
      .where("chat_runs.chat_id", "=", input.chatId)
      .where("chat_runs.driver_kind", "=", input.driverKind)
      .where("chat_runs.instance_id", "=", input.instanceId)
      .where(sql<boolean>`chat_runs.context_snapshot -> 'agent' IS NULL`)
      // Never revive a native session from before an intervening Agent run.
      .where(sql<boolean>`NOT EXISTS (
        SELECT 1 FROM chat_runs AS agent_boundary
        WHERE agent_boundary.chat_id = chat_runs.chat_id
          AND agent_boundary.context_snapshot -> 'agent' IS NOT NULL
          AND agent_boundary.history_boundary_seq >= chat_runs.history_boundary_seq
      )`)
      // Returning to a former root must not revive a session missing completed
      // work performed in another root. Interrupted-checkpoint fallback remains.
      .where(sql<boolean>`NOT EXISTS (
        SELECT 1 FROM chat_runs AS root_boundary
        WHERE root_boundary.chat_id = chat_runs.chat_id
          AND root_boundary.status = 'completed'
          AND root_boundary.history_boundary_seq > chat_runs.history_boundary_seq
          AND root_boundary.execution_root_fingerprint IS DISTINCT FROM chat_runs.execution_root_fingerprint
      )`)
      // A new user turn continues the native conversation even when its last
      // run failed. Explicit retry callers retain the completed-only boundary.
      .where("chat_runs.status", "in", input.includeInterrupted
        ? ["completed", "failed", "aborted"]
        : ["completed"])
      .where("chat_run_adapter_state.driver_kind", "=", input.driverKind)
      .where("chat_run_adapter_state.instance_id", "=", input.instanceId)
      .where("chat_run_adapter_state.schema_version", "=", input.schemaVersion)
      .where("chat_runs.execution_root_fingerprint", input.executionRootFingerprint === null ? "is" : "=", input.executionRootFingerprint)
      .orderBy("chat_runs.completed_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return {
      schemaVersion: row.schema_version,
      state: typeof row.state === "string" ? JSON.parse(row.state) : row.state,
      ...(row.execution_root_fingerprint === null ? {} : {
        executionRootFingerprint: row.execution_root_fingerprint,
      }),
    };
  }

  async getInputState(owner: ChatOwner, input: { chatId: string; runId: string; requestId: string }) {
    validateOwner(owner);
    CanonicalChatIdSchema.parse(input.chatId);
    [input.runId, input.requestId].forEach(requireSafeRef);
    return getChatInputState(this.kysely, owner, input);
  }

  async reopenInputSubmission(owner: ChatOwner, input: { chatId: string; runId: string; requestId: string; submissionId: string }): Promise<boolean> {
    const state = await this.getInputState(owner, input);
    if (!state.request || state.resolved || state.submitted?.id !== input.submissionId) return false;
    try {
      return await this.appendRunActivities(owner, input.chatId, input.runId, [{
        ...state.request, id: `activity_input_retry_${input.submissionId}`, occurredAt: new Date().toISOString(),
      }], input) > 0;
    } catch (error: unknown) {
      if (error instanceof ChatRunNotActiveError || error instanceof ChatConflictError) return false;
      throw error;
    }
  }

  async getPendingApproval(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    approvalId: string;
  }): Promise<Extract<CanonicalChatRunActivity, { type: "approval.requested" }> | null> {
    const owner = validateOwner(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    [input.runId, input.approvalId].forEach(requireSafeRef);
    const rows = await this.kysely.selectFrom("chat_run_events")
      .innerJoin("chat_runs", "chat_runs.id", "chat_run_events.run_id")
      .innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .select(["chat_run_events.event"])
      .where("chats.owner_type", "=", owner.type)
      .where("chats.owner_id", "=", owner.ownerId)
      .where("chat_runs.chat_id", "=", chatId)
      .where("chat_runs.id", "=", input.runId)
      .where("chat_runs.status", "in", [...ACTIVE_RUNS])
      .orderBy("chat_run_events.run_seq")
      .limit(500)
      .execute();
    let pending: Extract<CanonicalChatRunActivity, { type: "approval.requested" }> | null = null;
    for (const row of rows) {
      const activity = CanonicalChatRunActivitySchema.safeParse(row.event);
      if (!activity.success) continue;
      if (activity.data.type !== "approval.requested" && activity.data.type !== "approval.resolved") continue;
      if (activity.data.approvalId !== input.approvalId) continue;
      if (activity.data.type === "approval.requested") pending = activity.data;
      if (activity.data.type === "approval.resolved") pending = null;
    }
    return pending;
  }

  async markRunRunning(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    startedAt: string;
  }): Promise<CanonicalChatRun> {
    const owner = validateOwner(ownerInput);
    const startedAt = new Date(input.startedAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(input.chatId), true);
      if (!chat) throw new ChatNotFoundError(input.chatId);
      const current = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", requireSafeRef(input.runId))
        .where("chat_id", "=", input.chatId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ChatNotFoundError(input.chatId);
      if (current.status !== "accepted") {
        if (ACTIVE_RUNS.includes(current.status as typeof ACTIVE_RUNS[number])) return toRun(current);
        throw new ChatRunNotActiveError(input.chatId, input.runId);
      }
      const updated = await trx.updateTable("chat_runs").set({
        status: "running",
        started_at: startedAt,
        updated_at: startedAt,
      }).where("id", "=", input.runId)
        .where("status", "=", "accepted")
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new ChatRunNotActiveError(input.chatId, input.runId);
      await trx.updateTable("chat_turns").set({ status: "running", updated_at: startedAt })
        .where("id", "=", updated.turn_id)
        .where("status", "=", "accepted")
        .execute();
      return toRun(updated);
    });
  }

  async updateAdapterState(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    driverKind: string;
    instanceId: string;
    schemaVersion: number;
    state: unknown;
  }): Promise<void> {
    const owner = validateOwner(ownerInput);
    [input.runId, input.driverKind, input.instanceId].forEach(requireSafeRef);
    const stateBytes = encoded.encode(JSON.stringify(input.state)).byteLength;
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1 || stateBytes > 64 * 1024) {
      throw new ChatConflictError(input.chatId, 0);
    }
    await this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(input.chatId), true);
      if (!chat) throw new ChatNotFoundError(input.chatId);
      const run = await trx.selectFrom("chat_runs").select(["status", "driver_kind", "instance_id"])
        .where("id", "=", input.runId)
        .where("chat_id", "=", input.chatId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) throw new ChatNotFoundError(input.chatId);
      if (!ACTIVE_RUNS.includes(run.status as typeof ACTIVE_RUNS[number])) {
        throw new ChatRunNotActiveError(input.chatId, input.runId);
      }
      if (run.driver_kind !== input.driverKind || run.instance_id !== input.instanceId) {
        throw new ChatProviderInstanceLockedError(input.chatId);
      }
      await trx.insertInto("chat_run_adapter_state").values({
        run_id: input.runId,
        driver_kind: input.driverKind,
        instance_id: input.instanceId,
        schema_version: input.schemaVersion,
        state: jsonb(input.state),
        byte_count: stateBytes,
      }).onConflict((conflict) => conflict.column("run_id").doUpdateSet({
        schema_version: input.schemaVersion,
        state: jsonb(input.state),
        byte_count: stateBytes,
        updated_at: sql`now()`,
      })).execute();
    });
  }

  async appendRunActivities(owner: ChatOwner, chatId: string, runId: string, input: CanonicalChatRunActivity[], expectedInputClaim?: { requestId: string; submissionId: string }, signal?: AbortSignal): Promise<number> {
    return appendRunActivities({ transact: this.transact, appendOutbox: this.appendOutbox, selectOwnedChat, hook: this.activityWrites }, owner, chatId, runId, input, expectedInputClaim, signal);
  }

  async appendAssistantDelta(ownerInput: ChatOwner, input: AssistantDeltaInput, signal?: AbortSignal): Promise<CanonicalChatMessage> {
    return appendAssistantDelta({ transact: this.transact, appendOutbox: this.appendOutbox, selectOwnedChat, hook: this.assistantDeltaWrites }, ownerInput, input, signal);
  }

  async appendAssistantAttachment(owner: ChatOwner, input: Parameters<typeof appendAssistantAttachment>[2], signal?: AbortSignal) {
    return appendAssistantAttachment({ transact: this.transact, appendOutbox: this.appendOutbox, selectOwnedChat, hook: this.assistantDeltaWrites }, owner, input, signal);
  }

  async finishRun(owner: ChatOwner, input: Parameters<typeof finishRun>[2], signal?: AbortSignal) {
    return finishRun({ transact: this.transact, appendOutbox: this.appendOutbox, selectOwnedChat, hook: this.assistantDeltaWrites }, owner, input, signal);
  }

}
