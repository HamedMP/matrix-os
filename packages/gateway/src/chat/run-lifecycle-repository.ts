import {
  CanonicalChatIdSchema,
  CanonicalChatMessagePartSchema,
  CanonicalChatMessageSchema,
  CanonicalChatRunActivitySchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
} from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
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
  messageSearchText,
  toActivity,
  toMessage,
  toRun,
  type ChatOutboxEventType,
  type ChatOwner,
} from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
type Transact = <T>(fn: (trx: Executor) => Promise<T>) => Promise<T>;
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

function preview(message: CanonicalChatMessage): string | null {
  const text = message.parts.find((part) => part.type === "text");
  return text?.type === "text" ? text.text.slice(0, 280) : null;
}

function isTerminalActivity(activity: CanonicalChatRunActivity): boolean {
  return activity.type === "run.error"
    || (activity.type === "run.status"
      && ["completed", "failed", "aborted"].includes(activity.status));
}

function railTransitionForActivity(activity: CanonicalChatRunActivity): {
  runStatus: "running" | "waiting_for_approval" | "waiting_for_input";
  attention: "none" | "approval_required" | "input_required";
} | undefined {
  switch (activity.type) {
    case "approval.requested":
      return { runStatus: "waiting_for_approval", attention: "approval_required" };
    case "input.requested":
      return { runStatus: "waiting_for_input", attention: "input_required" };
    case "approval.resolved":
    case "input.resolved":
      return { runStatus: "running", attention: "none" };
    default:
      return undefined;
  }
}

// Run activities (CanonicalChatRunActivity, dot-namespaced: "approval.requested")
// are an internal, ephemeral event stream — the run's status/attention fields
// already react to them via railTransitionForActivity above. But the chat UI
// (specifically CanonicalApprovalMessage) only ever renders approval controls
// from CanonicalChatMessage.parts entries typed "approval_request" /
// "approval_result" (snake_case, the persisted message schema — see
// packages/contracts/src/canonical-chat.ts). Nothing previously projected one
// stream into the other, so an agent's approval request was tracked correctly
// server-side but never became a message the browser could act on.
// approvalMessageId/approvalRequestDescription/approvalMessageParts below
// produce that projection; see their single call site in appendRunActivities,
// which mirrors the existing terminal.bound side effect in the same function.
// Scoped by runId, not just approvalId: chat_messages.id is a global primary
// key (not chat- or run-scoped — see database.ts), so a bare hash of
// approvalId alone would let two different runs that happen to reuse the
// same provider-supplied approvalId collide onto the same row, silently
// dropping the second projection via the onConflict do-nothing below.
// Matches the same scoping activityPersistenceId (orchestrator.ts) already
// uses for run activities.
function approvalMessageId(kind: "request" | "result", runId: string, approvalId: string): string {
  const digest = createHash("sha256").update(`${runId}\0${approvalId}`).digest("hex").slice(0, 32);
  return `msg_approval_${kind}_${digest}`;
}

// CanonicalChatRunActivity's "approval.requested" variant intentionally carries
// only { approvalId, title, risk, allowedDecisions } — no free-text description
// (see canonical-chat.ts). The approval_request message part requires one, so
// this synthesizes a generic, provider-neutral sentence from risk alone rather
// than widening the canonical contract.
function approvalRequestDescription(risk: "low" | "medium" | "high"): string {
  if (risk === "high") {
    return "This action needs your approval before the agent can continue — it may have a significant or hard-to-reverse effect.";
  }
  if (risk === "medium") {
    return "This action needs your approval before the agent can continue.";
  }
  return "This action needs your approval before the agent can continue. It's expected to be low-risk.";
}

function approvalMessageParts(activity: CanonicalChatRunActivity): {
  id: string;
  parts: CanonicalChatMessage["parts"];
} | undefined {
  if (activity.type === "approval.requested") {
    return {
      id: approvalMessageId("request", activity.runId, activity.approvalId),
      parts: [CanonicalChatMessagePartSchema.parse({
        type: "approval_request",
        approvalId: activity.approvalId,
        title: activity.title,
        description: approvalRequestDescription(activity.risk),
        risk: activity.risk,
        allowedDecisions: activity.allowedDecisions,
      })],
    };
  }
  if (activity.type === "approval.resolved") {
    return {
      id: approvalMessageId("result", activity.runId, activity.approvalId),
      parts: [CanonicalChatMessagePartSchema.parse({
        type: "approval_result",
        approvalId: activity.approvalId,
        decision: activity.decision,
      })],
    };
  }
  return undefined;
}

function canTransitionAgentActivity(
  current: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
  next: Extract<CanonicalChatRunActivity, { type: "agent.activity" }>,
): boolean {
  if (current.activityId !== next.activityId || current.kind !== next.kind || current.label !== next.label) return false;
  if (current.status === "running") return true;
  if (current.status === "partial") {
    return ["partial", "completed", "failed", "cancelled"].includes(next.status);
  }
  return current.status === next.status;
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
  ) {}

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
      .where("chat_runs.status", "=", "completed")
      .where("chat_run_adapter_state.driver_kind", "=", input.driverKind)
      .where("chat_run_adapter_state.instance_id", "=", input.instanceId)
      .orderBy("chat_runs.completed_at", "desc")
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

  async appendRunActivities(
    ownerInput: ChatOwner,
    chatId: string,
    runId: string,
    input: CanonicalChatRunActivity[],
  ): Promise<number> {
    const owner = validateOwner(ownerInput);
    if (input.length > 100) throw new ChatConflictError(chatId, 0);
    const activities = input.map((activity) => CanonicalChatRunActivitySchema.parse(activity));
    if (activities.some((activity) => activity.chatId !== chatId || activity.runId !== runId)) {
      throw new ChatConflictError(chatId, 0);
    }
    if (activities.length === 0) return 0;
    return this.transact(async (trx) => {
      const current = await selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(chatId), true);
      if (!current) throw new ChatNotFoundError(chatId);
      const run = await trx.selectFrom("chat_runs").select(["id", "turn_id"])
        .where("id", "=", runId).where("chat_id", "=", chatId)
        .where("status", "in", [...ACTIVE_RUNS]).executeTakeFirst();
      const existingRun = run ?? await trx.selectFrom("chat_runs").select("id")
        .where("id", "=", runId).where("chat_id", "=", chatId).executeTakeFirst();
      if (existingRun && !run) throw new ChatRunNotActiveError(chatId, runId);
      if (!run) throw new ChatNotFoundError(chatId);
      const count = await trx.selectFrom("chat_run_events").select(({ fn }) => fn.countAll().as("count"))
        .where("run_id", "=", runId).executeTakeFirstOrThrow();
      const activityIds = [...new Set(activities.map((activity) => activity.id))];
      const existing = await trx.selectFrom("chat_run_events").select(["id", "chat_id", "run_id", "run_seq", "event"])
        .where("id", "in", activityIds).execute();
      if (existing.some((row) => row.chat_id !== chatId || row.run_id !== runId)) {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      const unseenCount = activityIds.length - existing.length;
      const overflow = Number(count.count) + unseenCount - 500;
      if (overflow > 0) {
        if (!activities.some(isTerminalActivity)) {
          throw new ChatConflictError(chatId, Number(current.revision));
        }
        const candidates = await trx.selectFrom("chat_run_events")
          .select(["id", "event"])
          .where("run_id", "=", runId)
          .orderBy("occurred_at")
          .orderBy("run_seq")
          .orderBy("id")
          .execute();
        const evictedIds = candidates.flatMap((row) => {
          const persisted = CanonicalChatRunActivitySchema.safeParse(row.event);
          return persisted.success && !isTerminalActivity(persisted.data) ? [row.id] : [];
        }).slice(0, overflow);
        if (evictedIds.length !== overflow) {
          throw new ChatConflictError(chatId, Number(current.revision));
        }
        await trx.deleteFrom("chat_run_events").where("id", "in", evictedIds).execute();
      }
      const latestSequence = await trx.selectFrom("chat_run_events")
        .select(({ fn }) => fn.max("run_seq").as("sequence"))
        .where("run_id", "=", runId)
        .executeTakeFirst();
      const existingIds = new Set(existing.map((row) => row.id));
      const existingById = new Map(existing.map((row) => [row.id, row]));
      let nextSequence = Number(latestSequence?.sequence ?? 0);
      let changed = 0;
      let railTransition: ReturnType<typeof railTransitionForActivity>;
      // Lazily fetched: most batches contain no approval activity, so avoid
      // the extra chat_messages seq lookup unless we actually need one.
      let nextMessageSeq: number | undefined;
      const allocateMessageSeq = async (): Promise<number> => {
        if (nextMessageSeq === undefined) {
          const latestMessage = await trx.selectFrom("chat_messages")
            .select(({ fn }) => fn.max("seq").as("seq"))
            .where("chat_id", "=", chatId)
            .executeTakeFirst();
          nextMessageSeq = Number(latestMessage?.seq ?? 0);
        }
        nextMessageSeq += 1;
        return nextMessageSeq;
      };
      const insertedApprovalMessageIds: string[] = [];
      for (const activity of activities) {
        if (existingIds.has(activity.id)) {
          const row = existingById.get(activity.id);
          if (!row) throw new ChatConflictError(chatId, Number(current.revision));
          const persisted = CanonicalChatRunActivitySchema.parse(row.event);
          if (persisted.type !== "agent.activity" || activity.type !== "agent.activity") continue;
          if (!canTransitionAgentActivity(persisted, activity)) {
            throw new ChatConflictError(chatId, Number(current.revision));
          }
          const updated = CanonicalChatRunActivitySchema.parse({
            ...activity,
            sequence: Number(row.run_seq ?? persisted.sequence),
            occurredAt: persisted.occurredAt,
          });
          if (JSON.stringify(updated) === JSON.stringify(persisted)) continue;
          await trx.updateTable("chat_run_events").set({ event: jsonb(updated) })
            .where("id", "=", activity.id)
            .where("chat_id", "=", chatId)
            .where("run_id", "=", runId)
            .execute();
          changed += 1;
          continue;
        }
        nextSequence += 1;
        const sequenced = CanonicalChatRunActivitySchema.parse({
          ...activity,
          sequence: nextSequence,
        });
        const row = await trx.insertInto("chat_run_events").values({
          id: sequenced.id,
          chat_id: chatId,
          run_id: runId,
          run_seq: nextSequence,
          event: jsonb(sequenced),
          occurred_at: sequenced.occurredAt,
        }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
        if (row) {
          changed += 1;
          railTransition = railTransitionForActivity(sequenced) ?? railTransition;
          if (sequenced.type === "terminal.bound") {
            await trx.insertInto("chat_terminal_bindings").values({
              chat_id: chatId,
              session_id: sequenced.terminalSessionId,
              session_created_at: sequenced.terminalSessionCreatedAt,
              run_id: runId,
              bound_at: sequenced.occurredAt,
            }).onConflict((conflict) => conflict.columns(["chat_id", "session_id"]).doUpdateSet({
              run_id: runId,
              session_created_at: sequenced.terminalSessionCreatedAt,
            })).execute();
          }
          // Project approval.requested / approval.resolved into a chat message
          // the browser can actually render (see approvalMessageParts above).
          // Only fires for a genuinely new chat_run_events row (we're inside
          // `if (row)`), and the chat_messages insert below is itself
          // deduplicated on a deterministic id, so replaying or retrying the
          // same activity can never produce a duplicate approval card.
          const approvalMessage = approvalMessageParts(sequenced);
          if (approvalMessage) {
            const messageSeq = await allocateMessageSeq();
            const message = CanonicalChatMessageSchema.parse({
              id: approvalMessage.id,
              chatId,
              seq: messageSeq,
              role: "system",
              state: "committed",
              turnId: run.turn_id,
              runId,
              parts: approvalMessage.parts,
              createdAt: sequenced.occurredAt,
            });
            const messageRow = await trx.insertInto("chat_messages").values({
              id: message.id,
              chat_id: message.chatId,
              seq: message.seq,
              role: message.role,
              state: message.state,
              turn_id: message.turnId ?? null,
              run_id: message.runId ?? null,
              parts: jsonb(message.parts),
              byte_count: encoded.encode(JSON.stringify(message)).byteLength,
              search_text: messageSearchText(message),
              created_at: message.createdAt,
            }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
            if (messageRow) insertedApprovalMessageIds.push(message.id);
          }
        }
      }
      if (changed > 0) {
        const revision = Number(current.revision) + 1;
        if (railTransition) {
          await trx.updateTable("chat_runs").set({
            status: railTransition.runStatus,
            updated_at: sql`now()`,
          }).where("id", "=", runId).where("status", "in", [...ACTIVE_RUNS]).execute();
        }
        await trx.updateTable("chats").set({
          revision,
          ...(railTransition ? { attention: railTransition.attention } : {}),
          ...(insertedApprovalMessageIds.length > 0
            ? { message_count: sql<number>`message_count + ${insertedApprovalMessageIds.length}` }
            : {}),
          updated_at: sql`now()`,
        }).where("id", "=", chatId).execute();
        await this.appendOutbox(trx, owner, chatId, revision, "run.activity", { runId });
        for (const messageId of insertedApprovalMessageIds) {
          await this.appendOutbox(trx, owner, chatId, revision, "run.message", { runId, messageId });
        }
      }
      return changed;
    });
  }

  async appendAssistantDelta(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    messageId: string;
    delta: string;
    createdAt: string;
  }): Promise<CanonicalChatMessage> {
    const owner = validateOwner(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    [input.runId, input.messageId].forEach(requireSafeRef);
    const createdAt = new Date(input.createdAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, chatId, true);
      if (!chat) throw new ChatNotFoundError(chatId);
      const run = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", input.runId)
        .where("chat_id", "=", chatId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) throw new ChatNotFoundError(chatId);
      if (!ACTIVE_RUNS.includes(run.status as typeof ACTIVE_RUNS[number])) {
        throw new ChatRunNotActiveError(chatId, input.runId);
      }
      const existing = await trx.selectFrom("chat_messages").selectAll()
        .where("id", "=", input.messageId)
        .forUpdate()
        .executeTakeFirst();
      let next: CanonicalChatMessage;
      let inserted = false;
      if (existing) {
        const current = toMessage(existing);
        const textParts = current.parts.every((part) => part.type === "text")
          ? current.parts
          : undefined;
        if (current.chatId !== chatId || current.runId !== input.runId
          || current.turnId !== run.turn_id || current.role !== "assistant"
          || current.state !== "pending" || !textParts?.length) {
          throw new ChatConflictError(chatId, Number(chat.revision));
        }
        const last = textParts.at(-1)!;
        const combined = CanonicalChatMessagePartSchema.safeParse({
          type: "text",
          text: `${last.text}${input.delta}`,
        });
        const parts = combined.success
          ? [...textParts.slice(0, -1), combined.data]
          : [...textParts, CanonicalChatMessagePartSchema.parse({ type: "text", text: input.delta })];
        next = CanonicalChatMessageSchema.parse({
          ...current,
          parts,
        });
        await trx.updateTable("chat_messages").set({
          parts: jsonb(next.parts),
          byte_count: encoded.encode(JSON.stringify(next)).byteLength,
          search_text: messageSearchText(next),
        }).where("id", "=", next.id).execute();
      } else {
        const latest = await trx.selectFrom("chat_messages")
          .select(({ fn }) => fn.max("seq").as("seq"))
          .where("chat_id", "=", chatId)
          .executeTakeFirst();
        const seq = Number(latest?.seq ?? 0) + 1;
        next = CanonicalChatMessageSchema.parse({
          id: input.messageId,
          chatId,
          seq,
          role: "assistant",
          state: "pending",
          turnId: run.turn_id,
          runId: input.runId,
          parts: [{ type: "text", text: input.delta }],
          createdAt,
        });
        await trx.insertInto("chat_messages").values({
          id: next.id,
          chat_id: next.chatId,
          seq: next.seq,
          role: next.role,
          state: next.state,
          turn_id: next.turnId ?? null,
          run_id: next.runId ?? null,
          parts: jsonb(next.parts),
          byte_count: encoded.encode(JSON.stringify(next)).byteLength,
          search_text: messageSearchText(next),
          created_at: next.createdAt,
        }).execute();
        inserted = true;
      }
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({
        revision,
        ...(inserted ? { message_count: sql<number>`message_count + 1` } : {}),
        last_message_preview: preview(next),
        updated_at: createdAt,
      }).where("id", "=", chatId).execute();
      await this.appendOutbox(trx, owner, chatId, revision, "run.message", {
        runId: input.runId,
        messageId: input.messageId,
      });
      return next;
    });
  }

  async finishRun(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    outcome: "completed" | "failed" | "aborted";
    completedAt: string;
    output?: CanonicalChatMessage;
  }): Promise<{ run: CanonicalChatRun; transitioned: boolean }> {
    const owner = validateOwner(ownerInput);
    const completedAt = new Date(input.completedAt).toISOString();
    const output = input.output === undefined ? undefined : CanonicalChatMessageSchema.parse(input.output);
    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(input.chatId), true);
      if (!chat) throw new ChatNotFoundError(input.chatId);
      const current = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", input.runId).where("chat_id", "=", input.chatId).forUpdate().executeTakeFirst();
      if (!current) throw new ChatNotFoundError(input.chatId);
      if (!ACTIVE_RUNS.includes(current.status as typeof ACTIVE_RUNS[number])) {
        return { run: toRun(current), transitioned: false };
      }
      const expectedState = input.outcome === "completed" ? "committed" : "failed";
      // Finalizes whatever assistant message(s) appendAssistantDelta already
      // streamed for this run (state "pending" -> committed/failed). A
      // non-streaming adapter that never called appendAssistantDelta can
      // instead pass its complete output here via `output` -- that's the
      // `else` branch below. Neither branch trusts a caller-supplied seq:
      // the streaming branch keeps the pending row's existing seq (already
      // allocated when appendAssistantDelta first inserted it), and the
      // `output` branch allocates its own seq from MAX(seq)+1 itself, same
      // as appendAssistantDelta and the approval projection -- so this
      // remains the single, repository-owned seq allocator for the chat.
      const pendingRows = await trx.selectFrom("chat_messages").selectAll()
        .where("chat_id", "=", input.chatId)
        .where("run_id", "=", input.runId)
        .where("role", "=", "assistant")
        .orderBy("seq")
        .forUpdate()
        .execute();
      let finalizedOutput: CanonicalChatMessage | undefined;
      let insertedOutput = false;
      if (pendingRows.length > 0) {
        const pendingMessages = pendingRows.map(toMessage);
        if (pendingMessages.some((pending) => pending.state !== "pending")) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        if (output !== undefined && !pendingMessages.some((pending) => output.id === pending.id)) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        for (const pending of pendingMessages) {
          const finalized = CanonicalChatMessageSchema.parse({
            ...(output?.id === pending.id ? { ...output, seq: pending.seq } : pending),
            state: expectedState,
          });
          await trx.updateTable("chat_messages").set({
            state: expectedState,
            parts: jsonb(finalized.parts),
            byte_count: encoded.encode(JSON.stringify(finalized)).byteLength,
            search_text: messageSearchText(finalized),
          }).where("id", "=", pending.id).execute();
          finalizedOutput = finalized;
        }
      } else if (output !== undefined) {
        if (output.chatId !== input.chatId || output.runId !== input.runId
          || output.turnId !== current.turn_id || output.role !== "assistant"
          || output.state !== expectedState) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        const latest = await trx.selectFrom("chat_messages")
          .select(({ fn }) => fn.max("seq").as("seq"))
          .where("chat_id", "=", input.chatId)
          .executeTakeFirst();
        const finalized = CanonicalChatMessageSchema.parse({ ...output, seq: Number(latest?.seq ?? 0) + 1 });
        await trx.insertInto("chat_messages").values({
          id: finalized.id,
          chat_id: finalized.chatId,
          seq: finalized.seq,
          role: finalized.role,
          state: finalized.state,
          turn_id: finalized.turnId ?? null,
          run_id: finalized.runId ?? null,
          parts: jsonb(finalized.parts),
          byte_count: encoded.encode(JSON.stringify(finalized)).byteLength,
          search_text: messageSearchText(finalized),
          created_at: finalized.createdAt,
        }).execute();
        finalizedOutput = finalized;
        insertedOutput = true;
      }
      const updated = await trx.updateTable("chat_runs").set({
        status: input.outcome,
        outcome: input.outcome,
        started_at: current.started_at ?? completedAt,
        completed_at: completedAt,
        updated_at: completedAt,
      }).where("id", "=", input.runId).where("status", "in", [...ACTIVE_RUNS])
        .returningAll().executeTakeFirst();
      if (!updated) throw new ChatBusyError(input.chatId);
      await trx.updateTable("chat_turns").set({ status: input.outcome, updated_at: completedAt })
        .where("id", "=", updated.turn_id).execute();
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({
        revision,
        ...(finalizedOutput === undefined ? {} : {
          ...(insertedOutput ? { message_count: sql<number>`message_count + 1` } : {}),
          last_message_preview: preview(finalizedOutput),
        }),
        attention: input.outcome === "failed" ? "failed" : "none",
        updated_at: completedAt,
      }).where("id", "=", input.chatId).execute();
      await this.appendOutbox(trx, owner, input.chatId, revision, `run.${input.outcome}` as ChatOutboxEventType, { runId: input.runId });
      return { run: toRun(updated), transitioned: true };
    });
  }
}
