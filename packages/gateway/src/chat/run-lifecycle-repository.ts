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

async function insertOutbox(
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
  revision: number,
  eventType: ChatOutboxEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await executor.insertInto("chat_outbox").values({
    owner_type: owner.type,
    owner_id: owner.ownerId,
    chat_id: chatId,
    revision,
    event_type: eventType,
    payload: jsonb(payload),
  }).execute();
}

export class ChatRunLifecycleRepository {
  constructor(
    private readonly kysely: Kysely<ChatDatabase>,
    private readonly transact: Transact,
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
      const run = await trx.selectFrom("chat_runs").select("id")
        .where("id", "=", runId).where("chat_id", "=", chatId)
        .where("status", "in", [...ACTIVE_RUNS]).executeTakeFirst();
      const existingRun = run ?? await trx.selectFrom("chat_runs").select("id")
        .where("id", "=", runId).where("chat_id", "=", chatId).executeTakeFirst();
      if (existingRun && !run) throw new ChatRunNotActiveError(chatId, runId);
      if (!run) throw new ChatNotFoundError(chatId);
      const count = await trx.selectFrom("chat_run_events").select(({ fn }) => fn.countAll().as("count"))
        .where("run_id", "=", runId).executeTakeFirstOrThrow();
      const activityIds = [...new Set(activities.map((activity) => activity.id))];
      const existing = await trx.selectFrom("chat_run_events").select(["id", "chat_id", "run_id"])
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
      let nextSequence = Number(latestSequence?.sequence ?? 0);
      let inserted = 0;
      for (const activity of activities) {
        if (existingIds.has(activity.id)) continue;
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
          inserted += 1;
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
        }
      }
      if (inserted > 0) {
        const revision = Number(current.revision) + 1;
        await trx.updateTable("chats").set({ revision, updated_at: sql`now()` }).where("id", "=", chatId).execute();
        await insertOutbox(trx, owner, chatId, revision, "run.activity", { runId });
      }
      return inserted;
    });
  }

  async appendAssistantDelta(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    messageId: string;
    seq: number;
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
          || current.state !== "pending" || current.seq !== input.seq || !textParts?.length) {
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
        if (input.seq !== Number(latest?.seq ?? 0) + 1) {
          throw new ChatConflictError(chatId, Number(chat.revision));
        }
        next = CanonicalChatMessageSchema.parse({
          id: input.messageId,
          chatId,
          seq: input.seq,
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
      await insertOutbox(trx, owner, chatId, revision, "run.message", {
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
      const pendingRow = await trx.selectFrom("chat_messages").selectAll()
        .where("chat_id", "=", input.chatId)
        .where("run_id", "=", input.runId)
        .where("role", "=", "assistant")
        .forUpdate()
        .executeTakeFirst();
      let finalizedOutput: CanonicalChatMessage | undefined;
      let insertedOutput = false;
      if (pendingRow) {
        const pending = toMessage(pendingRow);
        if (pending.state !== "pending") {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        if (output !== undefined && (output.id !== pending.id || output.seq !== pending.seq)) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        finalizedOutput = CanonicalChatMessageSchema.parse({
          ...(output ?? pending),
          state: expectedState,
        });
        await trx.updateTable("chat_messages").set({
          state: expectedState,
          parts: jsonb(finalizedOutput.parts),
          byte_count: encoded.encode(JSON.stringify(finalizedOutput)).byteLength,
          search_text: messageSearchText(finalizedOutput),
        }).where("id", "=", pending.id).execute();
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
        if (output.seq !== Number(latest?.seq ?? 0) + 1) {
          throw new ChatConflictError(input.chatId, Number(chat.revision));
        }
        await trx.insertInto("chat_messages").values({
          id: output.id,
          chat_id: output.chatId,
          seq: output.seq,
          role: output.role,
          state: output.state,
          turn_id: output.turnId ?? null,
          run_id: output.runId ?? null,
          parts: jsonb(output.parts),
          byte_count: encoded.encode(JSON.stringify(output)).byteLength,
          search_text: messageSearchText(output),
          created_at: output.createdAt,
        }).execute();
        finalizedOutput = output;
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
      await insertOutbox(trx, owner, input.chatId, revision, `run.${input.outcome}` as ChatOutboxEventType, { runId: input.runId });
      return { run: toRun(updated), transitioned: true };
    });
  }
}
