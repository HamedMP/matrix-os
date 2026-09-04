import { randomUUID } from "node:crypto";
import {
  CanonicalChatRunActivitySchema,
  CanonicalChatIdSchema,
  CanonicalChatMessageSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatRunSchema,
  CanonicalChatTurnSchema,
  CanonicalOwnerScopeSchema,
  TerminalSessionIdSchema,
  type CanonicalChatMessage,
  type CanonicalChatQueuedTurn,
  type CanonicalChatModelSelection,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatTurn,
  type CanonicalChatUserState,
} from "@matrix-os/contracts";
import { Kysely, sql, type Dialect, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import { bootstrapChatDatabase, type ChatDatabase, type ChatRunsTable, type ChatsTable } from "./database.js";
import { ChatDetailRepository, type ChatDetailPage } from "./detail-repository.js";
import {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatProviderInstanceLockedError,
  ChatRunNotAcknowledgeableError,
} from "./errors.js";
import {
  asIso,
  jsonb,
  messageSearchText,
  toActivities,
  toChatRecord,
  toLegacyImport,
  toMessage,
  toMigration,
  toOutbox,
  toRun,
  toTurn,
  type ChatExport,
  type ChatLegacyImportRecord,
  type ChatMigrationRecord,
  type ChatOutboxEvent,
  type ChatOutboxEventType,
  type ChatOwner,
  type ChatRecord,
} from "./records.js";
import { ChatRunLifecycleRepository } from "./run-lifecycle-repository.js";
import {
  ChatQueueRepository,
  type EnqueueQueuedTurnInput,
  type EnqueuedQueuedTurn,
  type CancelQueuedTurnInput,
  type ReorderQueuedTurnsInput,
  type UpdateQueuedTurnInput,
  type ClaimNextQueuedTurnInput,
  type ClaimedQueuedTurn,
} from "./queue-repository.js";
import {
  ChatSteeringRepository,
  type BeginSteerInput,
  type BegunSteer,
  type BeginQueuedTurnSteerInput,
  type BegunQueuedTurnSteer,
} from "./steering-repository.js";
import {
  ChatOutboxDelivery,
  type ChatOutboxSink,
} from "./outbox-delivery.js";

export type { ChatOutboxSink } from "./outbox-delivery.js";

export {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatProviderInstanceLockedError,
  ChatRunNotAcknowledgeableError,
  ChatRunNotActiveError,
} from "./errors.js";
export type { ChatDetailPage } from "./detail-repository.js";
export type {
  EnqueueQueuedTurnInput,
  EnqueuedQueuedTurn,
  CancelQueuedTurnInput,
  ReorderQueuedTurnsInput,
  ClaimNextQueuedTurnInput,
  ClaimedQueuedTurn,
} from "./queue-repository.js";
export type { BeginSteerInput, BegunSteer } from "./steering-repository.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
const ACTIVE_RUNS = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;
const SAFE_INTERNAL_REF = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const encoded = new TextEncoder();

export interface CreateChatInput {
  id: string;
  clientRequestId: string;
  title: string;
  projectId?: string;
  currentSelection?: CanonicalChatModelSelection;
}

export interface UpdateChatInput {
  baseRevision: number;
  title?: string;
  projectId?: string | null;
  lifecycle?: "active" | "archived";
  currentSelection?: CanonicalChatModelSelection;
}

export interface AdmitTurnInput {
  chatId: string;
  baseRevision: number;
  message: CanonicalChatMessage;
  turn: CanonicalChatTurn;
  run: CanonicalChatRun;
  adapterState?: { schemaVersion: number; state: unknown };
}

export interface AdmittedTurn {
  chat: ChatRecord;
  message: CanonicalChatMessage;
  turn: CanonicalChatTurn;
  run: CanonicalChatRun;
  alreadyAccepted: boolean;
}

export interface AdmitRetryInput {
  chatId: string;
  turnId: string;
  clientRequestId: string;
  baseRevision: number;
  run: CanonicalChatRun;
  adapterState?: { schemaVersion: number; state: unknown };
}

export interface AdmittedRun {
  chat: ChatRecord;
  turn: CanonicalChatTurn;
  run: CanonicalChatRun;
  alreadyAccepted: boolean;
}

export interface ChatTurnRunContext {
  chat: ChatRecord;
  message: CanonicalChatMessage;
  userMessages: CanonicalChatMessage[];
  turn: CanonicalChatTurn;
  latestRun: CanonicalChatRun;
}

export interface ChatListCursor {
  updatedAt: string;
  chatId: string;
}

export interface ChatListPage {
  items: ChatRecord[];
  nextCursor?: ChatListCursor;
}

function validateOwner(owner: ChatOwner): ChatOwner {
  return CanonicalOwnerScopeSchema.parse(owner);
}

function requireSafeRef(value: string): string {
  return SAFE_INTERNAL_REF.parse(value);
}

function postgresUniqueConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)
    || (error as { code?: unknown }).code !== "23505") return null;
  const constraint = "constraint" in error ? (error as { constraint?: unknown }).constraint : undefined;
  return typeof constraint === "string" ? constraint : "";
}

function preview(message: CanonicalChatMessage): string | null {
  const text = message.parts.find((part) => part.type === "text");
  return text?.type === "text" ? text.text.slice(0, 280) : null;
}

function activeRunQuery(executor: Executor, chatId: string) {
  return executor.selectFrom("chat_runs").selectAll()
    .where("chat_id", "=", chatId)
    .where("status", "in", [...ACTIVE_RUNS])
    .executeTakeFirst();
}

function userStateQuery(executor: Executor, owner: ChatOwner, chatId: string) {
  return executor.selectFrom("chat_user_state").selectAll()
    .where("chat_id", "=", chatId)
    .where("principal_id", "=", owner.ownerId)
    .executeTakeFirst();
}

function latestSuccessfulCompletionQuery(executor: Executor, chatId: string) {
  return executor.selectFrom("chat_runs")
    .select(["id", "completed_at"])
    .where("chat_id", "=", chatId)
    .where("status", "=", "completed")
    .where("outcome", "=", "completed")
    .where("completed_at", "is not", null)
    .orderBy("completed_at", "desc")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
}

function toUserState(row: {
  read_through_seq: number;
  pinned: boolean;
  muted: boolean;
}): CanonicalChatUserState {
  return {
    readThroughSeq: Number(row.read_through_seq),
    pinned: row.pinned,
    muted: row.muted,
  };
}

async function insertOutbox(
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
  revision: number,
  eventType: ChatOutboxEventType,
  payload: Record<string, unknown> = {},
): Promise<ChatOutboxEvent> {
  const row = await executor.insertInto("chat_outbox").values({
    owner_type: owner.type,
    owner_id: owner.ownerId,
    chat_id: chatId,
    revision,
    event_type: eventType,
    payload: jsonb(payload),
  }).returningAll().executeTakeFirstOrThrow();
  return toOutbox(row);
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

async function hydrateRecord(
  executor: Executor,
  owner: ChatOwner,
  chatId: string,
): Promise<ChatRecord | null> {
  const row = await selectOwnedChat(executor, owner, chatId);
  if (!row) return null;
  return toPrincipalRecord(executor, owner, row);
}

async function toPrincipalRecord(
  executor: Executor,
  owner: ChatOwner,
  row: Selectable<ChatsTable>,
): Promise<ChatRecord> {
  const [activeRun, userState, latestSuccessfulCompletion] = await Promise.all([
    activeRunQuery(executor, row.id),
    userStateQuery(executor, owner, row.id),
    latestSuccessfulCompletionQuery(executor, row.id),
  ]);
  return toChatRecord(
    row,
    activeRun,
    userState ? toUserState(userState) : undefined,
    latestSuccessfulCompletion,
    userState?.attention_acknowledged_at,
  );
}

async function hydrateAdmission(
  executor: Executor,
  owner: ChatOwner,
  existingTurn: CanonicalChatTurn,
): Promise<AdmittedTurn> {
  const [chat, messageRow, runRow] = await Promise.all([
    hydrateRecord(executor, owner, existingTurn.chatId),
    executor.selectFrom("chat_messages").selectAll().where("id", "=", existingTurn.inputMessageId).executeTakeFirst(),
    executor.selectFrom("chat_runs").selectAll().where("turn_id", "=", existingTurn.id).orderBy("attempt", "desc").executeTakeFirst(),
  ]);
  if (!chat || !messageRow || !runRow) throw new ChatNotFoundError(existingTurn.chatId);
  return {
    chat,
    message: toMessage(messageRow),
    turn: existingTurn,
    run: toRun(runRow),
    alreadyAccepted: true,
  };
}

export class ChatRepository {
  readonly kysely: Kysely<ChatDatabase>;
  private readonly transactionScoped: boolean;
  private readonly detail: ChatDetailRepository;
  private readonly runLifecycle: ChatRunLifecycleRepository;
  private readonly queue: ChatQueueRepository;
  private readonly steering: ChatSteeringRepository;
  private readonly outboxDelivery: ChatOutboxDelivery;

  constructor(
    dialectOrKysely: Dialect | Kysely<ChatDatabase>,
    transactionScoped = false,
    outboxDelivery?: ChatOutboxDelivery,
  ) {
    this.kysely = dialectOrKysely instanceof Kysely
      ? dialectOrKysely
      : new Kysely<ChatDatabase>({ dialect: dialectOrKysely });
    this.transactionScoped = transactionScoped;
    this.outboxDelivery = outboxDelivery ?? new ChatOutboxDelivery();
    this.detail = new ChatDetailRepository(this.kysely, hydrateRecord.bind(null, this.kysely));
    this.runLifecycle = new ChatRunLifecycleRepository(
      this.kysely,
      (fn) => this.transact(fn),
      (executor, owner, chatId, revision, eventType, payload) => this.appendOutbox(
        executor,
        owner,
        chatId,
        revision,
        eventType,
        payload,
      ),
    );
    this.queue = new ChatQueueRepository(
      this.kysely,
      (fn) => this.transact(fn),
      (executor, owner, chatId, revision, eventType, payload) => this.appendOutbox(
        executor,
        owner,
        chatId,
        revision,
        eventType,
        payload,
      ),
    );
    this.steering = new ChatSteeringRepository(
      (fn) => this.transact(fn),
      (executor, owner, chatId, revision, eventType, payload) => this.appendOutbox(
        executor,
        owner,
        chatId,
        revision,
        eventType,
        payload,
      ),
    );
  }

  async bootstrap(): Promise<void> {
    await bootstrapChatDatabase(this.kysely);
  }

  async release(): Promise<void> {
    this.outboxDelivery.release();
    // The Gateway owns and closes the shared Kysely instance after Chat drains.
  }

  registerOutboxSink(sink: ChatOutboxSink): { dispose(): void } {
    return this.outboxDelivery.registerSink(sink);
  }

  async withTransaction<T>(fn: (repository: ChatRepository) => Promise<T>): Promise<T> {
    return this.transact((trx) => fn(new ChatRepository(trx, true, this.outboxDelivery)));
  }

  private async transact<T>(fn: (trx: Executor) => Promise<T>): Promise<T> {
    if (this.transactionScoped) return fn(this.kysely);
    const result = await this.kysely.transaction().execute(async (trx) => {
      const pending = this.outboxDelivery.begin(trx);
      try {
        return { value: await fn(trx), pending };
      } finally {
        this.outboxDelivery.end(trx);
      }
    });
    this.outboxDelivery.flush(result.pending);
    return result.value;
  }

  private async appendOutbox(
    executor: Executor,
    owner: ChatOwner,
    chatId: string,
    revision: number,
    eventType: ChatOutboxEventType,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const event = await insertOutbox(executor, owner, chatId, revision, eventType, payload);
    this.outboxDelivery.capture(executor, { owner, event });
  }

  async create(ownerInput: ChatOwner, input: CreateChatInput): Promise<ChatRecord> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(input.id);
    CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    if (input.projectId !== undefined) requireSafeRef(input.projectId);
    if (input.currentSelection !== undefined) CanonicalChatModelSelectionSchema.parse(input.currentSelection);
    const timestamp = new Date().toISOString();

    return this.transact(async (trx) => {
      const candidate = toChatRecord({
        id: input.id,
        owner_type: owner.type,
        owner_id: owner.ownerId,
        create_request_id: input.clientRequestId,
        project_id: input.projectId ?? null,
        title: input.title,
        lifecycle: "active",
        attention: "none",
        revision: 0,
        message_count: 0,
        collaboration: null,
        user_state: null,
        shell_state: null,
        fork_provenance: null,
        last_message_preview: null,
        current_selection: input.currentSelection ?? null,
        bound_driver_kind: null,
        bound_instance_id: null,
        bound_at_turn_id: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      const inserted = await trx.insertInto("chats").values({
        id: candidate.chat.id,
        owner_type: owner.type,
        owner_id: owner.ownerId,
        create_request_id: input.clientRequestId,
        project_id: input.projectId ?? null,
        title: candidate.chat.title,
        lifecycle: candidate.chat.lifecycle,
        attention: candidate.chat.attention,
        revision: 0,
        message_count: 0,
        collaboration: null,
        user_state: null,
        shell_state: null,
        fork_provenance: null,
        last_message_preview: null,
        current_selection: input.currentSelection ? jsonb(input.currentSelection) : null,
        bound_driver_kind: null,
        bound_instance_id: null,
        bound_at_turn_id: null,
      }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "create_request_id"]).doNothing())
        .returningAll().executeTakeFirst();

      if (!inserted) {
        const existing = await trx.selectFrom("chats").selectAll()
          .where("owner_type", "=", owner.type)
          .where("owner_id", "=", owner.ownerId)
          .where("create_request_id", "=", input.clientRequestId)
          .executeTakeFirst();
        if (!existing) throw new ChatConflictError(input.id, 0);
        const record = await hydrateRecord(trx, owner, existing.id);
        if (!record) throw new ChatNotFoundError(existing.id);
        return record;
      }

      await trx.insertInto("chat_members").values({
        chat_id: inserted.id,
        principal_type: owner.type === "organization" ? "organization" : "user",
        principal_id: owner.ownerId,
        role: "owner",
      }).execute();
      await trx.insertInto("chat_user_state").values({
        chat_id: inserted.id,
        principal_id: owner.ownerId,
        read_through_seq: 0,
        pinned: false,
        muted: false,
        attention_acknowledged_at: null,
        last_opened_at: null,
      }).execute();
      await this.appendOutbox(trx, owner, inserted.id, 0, "chat.created");
      return toChatRecord(inserted, undefined, {
        readThroughSeq: 0,
        pinned: false,
        muted: false,
      });
    });
  }

  async get(ownerInput: ChatOwner, chatId: string): Promise<ChatRecord | null> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(chatId);
    return hydrateRecord(this.kysely, owner, chatId);
  }

  async getTerminalBinding(
    ownerInput: ChatOwner,
    chatId: string,
    sessionId: string,
  ): Promise<{ sessionCreatedAt: string | null } | null> {
    const owner = validateOwner(ownerInput);
    const parsedChatId = CanonicalChatIdSchema.parse(chatId);
    const parsedSessionId = TerminalSessionIdSchema.parse(sessionId);
    const durableMatch = await this.kysely.selectFrom("chat_terminal_bindings")
      .innerJoin("chats", "chats.id", "chat_terminal_bindings.chat_id")
      .select("chat_terminal_bindings.session_created_at")
      .where("chats.owner_type", "=", owner.type)
      .where("chats.owner_id", "=", owner.ownerId)
      .where("chat_terminal_bindings.chat_id", "=", parsedChatId)
      .where("chat_terminal_bindings.session_id", "=", parsedSessionId)
      .executeTakeFirst();
    return durableMatch
      ? { sessionCreatedAt: durableMatch.session_created_at }
      : null;
  }

  async getChatForTerminalBinding(
    ownerInput: ChatOwner,
    chatId: string,
  ): Promise<{ projectId?: string } | null> {
    const owner = validateOwner(ownerInput);
    const parsedChatId = CanonicalChatIdSchema.parse(chatId);
    const chat = await this.kysely.selectFrom("chats")
      .select("project_id")
      .where("id", "=", parsedChatId)
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    if (!chat) return null;
    return chat.project_id ? { projectId: chat.project_id } : {};
  }

  async getLatestRunForTerminalBinding(
    ownerInput: ChatOwner,
    chatId: string,
  ): Promise<Pick<CanonicalChatRun, "id" | "executionRoot"> | null> {
    const owner = validateOwner(ownerInput);
    const parsedChatId = CanonicalChatIdSchema.parse(chatId);
    const row = await this.kysely.selectFrom("chat_runs")
      .innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .selectAll("chat_runs")
      .where("chats.owner_type", "=", owner.type)
      .where("chats.owner_id", "=", owner.ownerId)
      .where("chat_runs.chat_id", "=", parsedChatId)
      .orderBy("chat_runs.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const run = toRun(row);
    return { id: run.id, ...(run.executionRoot ? { executionRoot: run.executionRoot } : {}) };
  }

  async bindTerminalSession(ownerInput: ChatOwner, input: {
    chatId: string;
    runId?: string;
    sessionId: string;
    sessionCreatedAt: string;
  }): Promise<boolean> {
    const owner = validateOwner(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const runId = input.runId === undefined ? undefined : requireSafeRef(input.runId);
    const sessionId = TerminalSessionIdSchema.parse(input.sessionId);
    const sessionCreatedAt = z.iso.datetime().parse(input.sessionCreatedAt);
    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, chatId, true);
      if (!chat) throw new ChatNotFoundError(chatId);
      if (runId) {
        const run = await trx.selectFrom("chat_runs").select("id")
          .where("id", "=", runId)
          .where("chat_id", "=", chatId)
          .executeTakeFirst();
        if (!run) throw new ChatNotFoundError(chatId);
      }
      const occurredAt = new Date().toISOString();
      const binding = await trx.insertInto("chat_terminal_bindings").values({
        chat_id: chatId,
        session_id: sessionId,
        session_created_at: sessionCreatedAt,
        run_id: runId ?? null,
        bound_at: occurredAt,
      }).onConflict((conflict) => conflict.columns(["chat_id", "session_id"]).doUpdateSet({
        session_created_at: sessionCreatedAt,
        run_id: runId ?? null,
        bound_at: occurredAt,
      }).where(sql<boolean>`chat_terminal_bindings.session_created_at IS DISTINCT FROM ${sessionCreatedAt}`))
        .returning("session_id")
        .executeTakeFirst();
      if (!binding) return false;
      if (runId) {
        const count = await trx.selectFrom("chat_run_events")
          .select(({ fn }) => fn.countAll().as("count"))
          .where("run_id", "=", runId)
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= 500) throw new ChatConflictError(chatId, Number(chat.revision));
        const activity = CanonicalChatRunActivitySchema.parse({
          id: `activity_${randomUUID()}`,
          chatId,
          runId,
          occurredAt,
          type: "terminal.bound",
          terminalSessionId: sessionId,
          terminalSessionCreatedAt: sessionCreatedAt,
        });
        const latestSequence = await trx.selectFrom("chat_run_events")
          .select(({ fn }) => fn.max("run_seq").as("sequence"))
          .where("run_id", "=", runId)
          .executeTakeFirst();
        const sequence = Number(latestSequence?.sequence ?? 0) + 1;
        const sequenced = CanonicalChatRunActivitySchema.parse({ ...activity, sequence });
        await trx.insertInto("chat_run_events").values({
          id: sequenced.id,
          chat_id: chatId,
          run_id: runId,
          run_seq: sequence,
          event: jsonb(sequenced),
          occurred_at: occurredAt,
        }).execute();
      }
      const revision = Number(chat.revision) + 1;
      await trx.updateTable("chats").set({ revision, updated_at: sql`now()` })
        .where("id", "=", chatId)
        .execute();
      await this.appendOutbox(
        trx,
        owner,
        chatId,
        revision,
        runId ? "run.activity" : "chat.terminal_bound",
        runId ? { runId } : { terminalSessionId: sessionId },
      );
      return true;
    });
  }

  async listBoundTerminalSessionIds(
    ownerInput: ChatOwner,
    sessionIds: readonly string[],
  ): Promise<string[]> {
    const owner = validateOwner(ownerInput);
    const parsedIds = z.array(TerminalSessionIdSchema).max(100).parse(sessionIds);
    if (parsedIds.length === 0) return [];
    const [durableRows, legacyRows] = await Promise.all([
      this.kysely.selectFrom("chat_terminal_bindings")
        .innerJoin("chats", "chats.id", "chat_terminal_bindings.chat_id")
        .select("chat_terminal_bindings.session_id")
        .distinct()
        .where("chats.owner_type", "=", owner.type)
        .where("chats.owner_id", "=", owner.ownerId)
        .where("chat_terminal_bindings.session_id", "in", parsedIds)
        .execute(),
      this.kysely.selectFrom("chat_run_events")
        .innerJoin("chats", "chats.id", "chat_run_events.chat_id")
        .select(sql<string>`chat_run_events.event ->> 'terminalSessionId'`.as("session_id"))
        .distinct()
        .where("chats.owner_type", "=", owner.type)
        .where("chats.owner_id", "=", owner.ownerId)
        .where(sql<boolean>`chat_run_events.event ->> 'type' = 'terminal.bound'`)
        .where(sql<string>`chat_run_events.event ->> 'terminalSessionId'`, "in", parsedIds)
        .execute(),
    ]);
    const bound = new Set([
      ...durableRows.map((row) => row.session_id),
      ...legacyRows.map((row) => row.session_id),
    ]);
    return parsedIds.filter((sessionId) => bound.has(sessionId));
  }

  async list(ownerInput: ChatOwner, input: {
    limit: number;
    lifecycle?: "active" | "archived";
    projectId?: string | null;
    cursor?: ChatListCursor;
  }): Promise<ChatListPage> {
    const owner = validateOwner(ownerInput);
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    let query = this.kysely.selectFrom("chats").selectAll()
      .select(sql<string>`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        .as("cursor_updated_at"))
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId);
    if (input.lifecycle) query = query.where("lifecycle", "=", input.lifecycle);
    if (input.projectId !== undefined) query = input.projectId === null
      ? query.where("project_id", "is", null)
      : query.where("project_id", "=", requireSafeRef(input.projectId));
    if (input.cursor) {
      const cursorTimestamp = z.iso.datetime({ offset: true }).parse(input.cursor.updatedAt);
      const cursorAt = sql<Date>`${cursorTimestamp}::timestamptz`;
      const cursorChatId = CanonicalChatIdSchema.parse(input.cursor.chatId);
      query = query.where(({ and, eb, or }) => or([
        eb("updated_at", "<", cursorAt),
        and([eb("updated_at", "=", cursorAt), eb("id", ">", cursorChatId)]),
      ]));
    }
    const rows = await query.orderBy("updated_at", "desc").orderBy("id").limit(limit + 1).execute();
    const pageRows = rows.slice(0, limit);
    const items = await Promise.all(pageRows.map((row) => toPrincipalRecord(this.kysely, owner, row)));
    const last = rows.length > limit ? pageRows.at(-1) : undefined;
    return {
      items,
      ...(last ? { nextCursor: { updatedAt: last.cursor_updated_at, chatId: last.id } } : {}),
    };
  }

  async update(ownerInput: ChatOwner, chatId: string, input: UpdateChatInput): Promise<ChatRecord> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(chatId);
    if (input.currentSelection) CanonicalChatModelSelectionSchema.parse(input.currentSelection);
    if (typeof input.projectId === "string") requireSafeRef(input.projectId);

    return this.transact(async (trx) => {
      const current = await selectOwnedChat(trx, owner, chatId, true);
      if (!current) throw new ChatNotFoundError(chatId);
      if (Number(current.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      const contextChanges = ("projectId" in input && (input.projectId ?? null) !== current.project_id)
        || (input.lifecycle !== undefined && input.lifecycle !== current.lifecycle);
      if (contextChanges && await activeRunQuery(trx, chatId)) throw new ChatBusyError(chatId);
      if (current.bound_instance_id && input.currentSelection
        && input.currentSelection.instanceId !== current.bound_instance_id) {
        throw new ChatProviderInstanceLockedError(chatId);
      }

      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...("projectId" in input ? { project_id: input.projectId ?? null } : {}),
        ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
        ...(input.currentSelection === undefined ? {} : { current_selection: jsonb(input.currentSelection) }),
        revision,
        updated_at: sql`now()`,
      }).where("id", "=", chatId)
        .where("owner_type", "=", owner.type)
        .where("owner_id", "=", owner.ownerId)
        .where("revision", "=", input.baseRevision)
        .returningAll().executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(current.revision));
      const record = await toPrincipalRecord(trx, owner, updated);
      await this.appendOutbox(trx, owner, chatId, record.chat.revision, "chat.updated");
      return record;
    });
  }

  async updateUserState(
    ownerInput: ChatOwner,
    chatId: string,
    input: { pinned: boolean },
  ): Promise<ChatRecord> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(chatId);

    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, chatId);
      if (!chat) throw new ChatNotFoundError(chatId);
      const changedState = await trx.insertInto("chat_user_state").values({
        chat_id: chatId,
        principal_id: owner.ownerId,
        read_through_seq: 0,
        pinned: input.pinned,
        muted: false,
        attention_acknowledged_at: null,
        last_opened_at: null,
      }).onConflict((conflict) => conflict.columns(["chat_id", "principal_id"]).doUpdateSet({
        pinned: input.pinned,
        updated_at: sql`now()`,
      }).where(sql<boolean>`chat_user_state.pinned IS DISTINCT FROM ${input.pinned}`))
        .returningAll().executeTakeFirst();
      if (changedState) {
        await this.appendOutbox(trx, owner, chatId, Number(chat.revision), "chat.user_state_updated", {
          pinned: input.pinned,
        });
      }
      return toPrincipalRecord(trx, owner, chat);
    });
  }

  async acknowledgeCompletion(
    ownerInput: ChatOwner,
    chatId: string,
    runId: string,
  ): Promise<ChatRecord> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(chatId);
    const parsedRunId = CanonicalChatRunIdSchema.parse(runId);

    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, chatId, true);
      if (!chat) throw new ChatNotFoundError(chatId);
      const completedRun = await trx.selectFrom("chat_runs")
        .select(["id", "status", "outcome", "completed_at"])
        .where("id", "=", parsedRunId)
        .where("chat_id", "=", chatId)
        .executeTakeFirst();
      if (!completedRun) throw new ChatNotFoundError(chatId);
      if (completedRun.status !== "completed"
        || completedRun.outcome !== "completed"
        || completedRun.completed_at === null) {
        throw new ChatRunNotAcknowledgeableError(chatId, parsedRunId);
      }
      const completedAt = asIso(completedRun.completed_at)!;
      const changedState = await trx.insertInto("chat_user_state").values({
        chat_id: chatId,
        principal_id: owner.ownerId,
        read_through_seq: 0,
        pinned: false,
        muted: false,
        attention_acknowledged_at: completedAt,
        last_opened_at: null,
      }).onConflict((conflict) => conflict.columns(["chat_id", "principal_id"]).doUpdateSet({
        attention_acknowledged_at: completedAt,
        updated_at: sql`now()`,
      }).where(sql<boolean>`chat_user_state.attention_acknowledged_at IS NULL
        OR chat_user_state.attention_acknowledged_at < ${completedAt}::timestamptz`))
        .returning("attention_acknowledged_at")
        .executeTakeFirst();
      if (changedState) {
        await this.appendOutbox(trx, owner, chatId, Number(chat.revision), "chat.user_state_updated", {
          runId: parsedRunId,
          completedAt,
        });
      }
      return toPrincipalRecord(trx, owner, chat);
    });
  }

  async admitTurn(ownerInput: ChatOwner, input: AdmitTurnInput): Promise<AdmittedTurn> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(input.chatId);
    const message = CanonicalChatMessageSchema.parse(input.message);
    const turn = CanonicalChatTurnSchema.parse(input.turn);
    const run = CanonicalChatRunSchema.parse(input.run);
    if (message.chatId !== input.chatId || turn.chatId !== input.chatId || run.chatId !== input.chatId
      || turn.inputMessageId !== message.id || message.turnId !== turn.id || message.runId !== undefined
      || message.role !== "user" || message.state !== "committed" || run.turnId !== turn.id) {
      throw new ChatConflictError(input.chatId, input.baseRevision);
    }
    if (turn.status !== "accepted" || run.status !== "accepted") throw new ChatConflictError(input.chatId, input.baseRevision);
    const stateBytes = input.adapterState ? encoded.encode(JSON.stringify(input.adapterState.state)).byteLength : 0;
    if (input.adapterState && (!Number.isInteger(input.adapterState.schemaVersion)
      || input.adapterState.schemaVersion < 1 || stateBytes > 64 * 1024)) {
      throw new ChatConflictError(input.chatId, input.baseRevision);
    }

    return this.transact(async (trx) => {
      const current = await selectOwnedChat(trx, owner, input.chatId, true);
      if (!current) throw new ChatNotFoundError(input.chatId);
      const duplicate = await trx.selectFrom("chat_turns").selectAll()
        .where("chat_id", "=", input.chatId)
        .where("client_request_id", "=", turn.clientRequestId)
        .executeTakeFirst();
      if (duplicate) return hydrateAdmission(trx, owner, toTurn(duplicate));
      if (current.lifecycle !== "active") {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }
      if (Number(current.revision) !== input.baseRevision) {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }
      if (await activeRunQuery(trx, input.chatId)) throw new ChatBusyError(input.chatId);
      if (current.bound_instance_id && (current.bound_instance_id !== run.instanceId
        || current.bound_driver_kind !== run.driverKind)) {
        throw new ChatProviderInstanceLockedError(input.chatId);
      }
      const latest = await trx.selectFrom("chat_messages")
        .select(({ fn }) => fn.max("seq").as("seq"))
        .where("chat_id", "=", input.chatId).executeTakeFirst();
      const lastSeq = Number(latest?.seq ?? 0);
      if (message.seq !== lastSeq + 1 || turn.baseMessageSeq !== lastSeq) {
        throw new ChatConflictError(input.chatId, Number(current.revision));
      }

      await trx.insertInto("chat_messages").values({
        id: message.id,
        chat_id: input.chatId,
        seq: message.seq,
        role: message.role,
        state: message.state,
        turn_id: message.turnId ?? null,
        run_id: message.runId ?? null,
        parts: jsonb(message.parts),
        byte_count: encoded.encode(JSON.stringify(message)).byteLength,
        search_text: messageSearchText(message),
        created_at: message.createdAt,
      }).execute();
      for (const part of message.parts) {
        if (part.type !== "attachment_reference") continue;
        await trx.insertInto("chat_attachments").values({
          id: part.attachmentId,
          chat_id: input.chatId,
          message_id: message.id,
          kind: part.kind,
          label: part.label,
          mime_type: part.mimeType ?? null,
          size_bytes: part.sizeBytes ?? null,
          owner_reference: part.ownerReference ?? null,
        }).execute();
      }
      await trx.insertInto("chat_turns").values({
        id: turn.id,
        chat_id: input.chatId,
        client_request_id: turn.clientRequestId,
        base_message_seq: turn.baseMessageSeq,
        input_message_id: turn.inputMessageId,
        status: turn.status,
        created_at: turn.createdAt,
        updated_at: turn.updatedAt,
      }).execute();
      await trx.insertInto("chat_runs").values({
        id: run.id,
        chat_id: input.chatId,
        turn_id: run.turnId,
        client_request_id: turn.clientRequestId,
        attempt: run.attempt,
        driver_kind: run.driverKind,
        instance_id: run.instanceId,
        selection: jsonb(run.selection),
        interaction_mode: run.interactionMode,
        permission_mode: run.permissionMode,
        execution_root: run.executionRoot ? jsonb(run.executionRoot) : null,
        execution_root_fingerprint: run.executionRootFingerprint ?? null,
        status: run.status,
        outcome: run.outcome ?? null,
        started_at: run.startedAt ?? null,
        completed_at: run.completedAt ?? null,
        history_boundary_seq: run.historyBoundarySeq,
        capability_snapshot: jsonb(run.capabilitySnapshot),
        created_at: run.createdAt,
        updated_at: run.updatedAt,
      }).execute();
      if (input.adapterState) {
        await trx.insertInto("chat_run_adapter_state").values({
          run_id: run.id,
          driver_kind: run.driverKind,
          instance_id: run.instanceId,
          schema_version: input.adapterState.schemaVersion,
          state: jsonb(input.adapterState.state),
          byte_count: stateBytes,
        }).execute();
      }

      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({
        revision,
        message_count: sql<number>`message_count + 1`,
        last_message_preview: preview(message),
        current_selection: jsonb(run.selection),
        bound_driver_kind: current.bound_driver_kind ?? run.driverKind,
        bound_instance_id: current.bound_instance_id ?? run.instanceId,
        bound_at_turn_id: current.bound_at_turn_id ?? turn.id,
        updated_at: sql`now()`,
      }).where("id", "=", input.chatId).where("revision", "=", input.baseRevision)
        .returningAll().executeTakeFirst();
      if (!updated) throw new ChatConflictError(input.chatId, Number(current.revision));
      await this.appendOutbox(trx, owner, input.chatId, revision, "turn.accepted", { runId: run.id, turnId: turn.id });
      return {
        chat: await toPrincipalRecord(trx, owner, updated),
        message,
        turn,
        run,
        alreadyAccepted: false,
      };
    }).catch((error: unknown) => {
      if (error instanceof ChatNotFoundError || error instanceof ChatConflictError
        || error instanceof ChatBusyError || error instanceof ChatProviderInstanceLockedError) throw error;
      const constraint = postgresUniqueConstraint(error);
      if (constraint === "idx_chat_runs_one_active") throw new ChatBusyError(input.chatId);
      if (constraint !== null) throw new ChatConflictError(input.chatId, input.baseRevision);
      throw error;
    });
  }

  async enqueueQueuedTurn(
    owner: ChatOwner,
    input: EnqueueQueuedTurnInput,
  ): Promise<EnqueuedQueuedTurn> {
    return this.queue.enqueue(owner, input);
  }

  async listQueuedTurns(owner: ChatOwner, chatId: string): Promise<CanonicalChatQueuedTurn[]> {
    return this.queue.list(owner, chatId);
  }

  async cancelQueuedTurn(owner: ChatOwner, input: CancelQueuedTurnInput) {
    return this.queue.cancel(owner, input);
  }

  async reorderQueuedTurns(owner: ChatOwner, input: ReorderQueuedTurnsInput) {
    return this.queue.reorder(owner, input);
  }

  async updateQueuedTurn(owner: ChatOwner, input: UpdateQueuedTurnInput) {
    return this.queue.update(owner, input);
  }

  async claimNextQueuedTurn(
    owner: ChatOwner,
    input: ClaimNextQueuedTurnInput,
  ): Promise<ClaimedQueuedTurn | null> {
    return this.queue.claimNext(owner, input);
  }

  async listQueuedChatIds(owner: ChatOwner, limit?: number): Promise<string[]> {
    return this.queue.listQueuedChatIds(owner, limit);
  }

  async beginSteer(owner: ChatOwner, input: BeginSteerInput): Promise<BegunSteer> {
    return this.steering.begin(owner, input);
  }

  async beginQueuedTurnSteer(
    owner: ChatOwner,
    input: BeginQueuedTurnSteerInput,
  ): Promise<BegunQueuedTurnSteer> {
    return this.steering.beginQueuedTurn(owner, input);
  }

  async acceptSteer(
    owner: ChatOwner,
    input: { chatId: string; runId: string; clientRequestId: string; acceptedAt: string },
  ): Promise<CanonicalChatMessage> {
    return this.steering.accept(owner, input);
  }

  async failSteer(
    owner: ChatOwner,
    input: { chatId: string; runId: string; clientRequestId: string; acceptedAt: string },
  ): Promise<void> {
    return this.steering.fail(owner, input);
  }

  async acceptQueuedTurnSteer(
    owner: ChatOwner,
    input: {
      chatId: string;
      runId: string;
      queuedTurnId: string;
      clientRequestId: string;
      acceptedAt: string;
    },
  ): Promise<CanonicalChatMessage> {
    return this.steering.acceptQueuedTurn(owner, input);
  }

  async failQueuedTurnSteer(
    owner: ChatOwner,
    input: {
      chatId: string;
      runId: string;
      queuedTurnId: string;
      clientRequestId: string;
      acceptedAt: string;
    },
  ): Promise<void> {
    return this.steering.failQueuedTurn(owner, input);
  }

  async admitRetry(ownerInput: ChatOwner, input: AdmitRetryInput): Promise<AdmittedRun> {
    const owner = validateOwner(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const turnId = requireSafeRef(input.turnId);
    const clientRequestId = CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    const run = CanonicalChatRunSchema.parse(input.run);
    const stateBytes = input.adapterState ? encoded.encode(JSON.stringify(input.adapterState.state)).byteLength : 0;
    if (run.chatId !== chatId || run.turnId !== turnId || run.status !== "accepted" || run.attempt < 2) {
      throw new ChatConflictError(chatId, input.baseRevision);
    }
    if (input.adapterState && (!Number.isInteger(input.adapterState.schemaVersion)
      || input.adapterState.schemaVersion < 1 || stateBytes > 64 * 1024)) {
      throw new ChatConflictError(chatId, input.baseRevision);
    }
    return this.transact(async (trx) => {
      const current = await selectOwnedChat(trx, owner, chatId, true);
      if (!current) throw new ChatNotFoundError(chatId);
      const existing = await trx.selectFrom("chat_runs").selectAll()
        .where("turn_id", "=", turnId)
        .where("client_request_id", "=", clientRequestId)
        .executeTakeFirst();
      if (existing) {
        const turnRow = await trx.selectFrom("chat_turns").selectAll()
          .where("id", "=", turnId).where("chat_id", "=", chatId).executeTakeFirst();
        if (!turnRow) throw new ChatNotFoundError(chatId);
        return {
          chat: await toPrincipalRecord(trx, owner, current),
          turn: toTurn(turnRow),
          run: toRun(existing),
          alreadyAccepted: true,
        };
      }
      if (current.lifecycle !== "active") {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      if (Number(current.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      if (await activeRunQuery(trx, chatId)) throw new ChatBusyError(chatId);
      const turnRow = await trx.selectFrom("chat_turns").selectAll()
        .where("id", "=", turnId).where("chat_id", "=", chatId).forUpdate().executeTakeFirst();
      if (!turnRow) throw new ChatNotFoundError(chatId);
      const latest = await trx.selectFrom("chat_runs").selectAll()
        .where("turn_id", "=", turnId).orderBy("attempt", "desc").forUpdate().executeTakeFirst();
      if (!latest || ACTIVE_RUNS.includes(latest.status as typeof ACTIVE_RUNS[number])
        || run.attempt !== latest.attempt + 1 || latest.attempt >= 100
        || run.driverKind !== latest.driver_kind || run.instanceId !== latest.instance_id) {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      if (current.bound_driver_kind !== run.driverKind || current.bound_instance_id !== run.instanceId) {
        throw new ChatProviderInstanceLockedError(chatId);
      }
      await trx.insertInto("chat_runs").values({
        id: run.id,
        chat_id: chatId,
        turn_id: turnId,
        client_request_id: clientRequestId,
        attempt: run.attempt,
        driver_kind: run.driverKind,
        instance_id: run.instanceId,
        selection: jsonb(run.selection),
        interaction_mode: run.interactionMode,
        permission_mode: run.permissionMode,
        execution_root: run.executionRoot ? jsonb(run.executionRoot) : null,
        execution_root_fingerprint: run.executionRootFingerprint ?? null,
        status: "accepted",
        outcome: null,
        started_at: null,
        completed_at: null,
        history_boundary_seq: run.historyBoundarySeq,
        capability_snapshot: jsonb(run.capabilitySnapshot),
        created_at: run.createdAt,
        updated_at: run.updatedAt,
      }).execute();
      if (input.adapterState) {
        await trx.insertInto("chat_run_adapter_state").values({
          run_id: run.id,
          driver_kind: run.driverKind,
          instance_id: run.instanceId,
          schema_version: input.adapterState.schemaVersion,
          state: jsonb(input.adapterState.state),
          byte_count: stateBytes,
        }).execute();
      }
      await trx.updateTable("chat_turns").set({ status: "accepted", updated_at: run.updatedAt })
        .where("id", "=", turnId).execute();
      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({
        revision,
        current_selection: jsonb(run.selection),
        attention: "none",
        updated_at: run.updatedAt,
      }).where("id", "=", chatId).where("revision", "=", input.baseRevision)
        .returningAll().executeTakeFirst();
      if (!updated) throw new ChatConflictError(chatId, Number(current.revision));
      await this.appendOutbox(trx, owner, chatId, revision, "turn.accepted", {
        runId: run.id,
        turnId,
        attempt: run.attempt,
      });
      return {
        chat: await toPrincipalRecord(trx, owner, updated),
        turn: toTurn({ ...turnRow, status: "accepted", updated_at: run.updatedAt }),
        run,
        alreadyAccepted: false,
      };
    }).catch((error: unknown) => {
      if (error instanceof ChatNotFoundError || error instanceof ChatConflictError
        || error instanceof ChatBusyError || error instanceof ChatProviderInstanceLockedError) throw error;
      const constraint = postgresUniqueConstraint(error);
      if (constraint === "idx_chat_runs_one_active") throw new ChatBusyError(chatId);
      if (constraint !== null) throw new ChatConflictError(chatId, input.baseRevision);
      throw error;
    });
  }

  async getMessages(ownerInput: ChatOwner, chatId: string, input: {
    afterSeq: number;
    limit: number;
  }): Promise<CanonicalChatMessage[]> {
    const owner = validateOwner(ownerInput);
    if (!await selectOwnedChat(this.kysely, owner, CanonicalChatIdSchema.parse(chatId))) return [];
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit)));
    const rows = await this.kysely.selectFrom("chat_messages").selectAll()
      .where("chat_id", "=", chatId).where("seq", ">", Math.max(0, Math.trunc(input.afterSeq)))
      .orderBy("seq").limit(limit).execute();
    return rows.map(toMessage);
  }

  async getTurnRunContext(
    ownerInput: ChatOwner,
    chatId: string,
    turnId: string,
  ): Promise<ChatTurnRunContext | null> {
    const owner = validateOwner(ownerInput);
    const parsedChatId = CanonicalChatIdSchema.parse(chatId);
    const parsedTurnId = requireSafeRef(turnId);
    const chat = await hydrateRecord(this.kysely, owner, parsedChatId);
    if (!chat) return null;
    const turnRow = await this.kysely.selectFrom("chat_turns").selectAll()
      .where("id", "=", parsedTurnId).where("chat_id", "=", parsedChatId).executeTakeFirst();
    if (!turnRow) return null;
    const [messageRow, userMessageRows, runRow] = await Promise.all([
      this.kysely.selectFrom("chat_messages").selectAll()
        .where("id", "=", turnRow.input_message_id).where("chat_id", "=", parsedChatId).executeTakeFirst(),
      this.kysely.selectFrom("chat_messages").selectAll()
        .where("chat_id", "=", parsedChatId)
        .where("turn_id", "=", parsedTurnId)
        .where("role", "=", "user")
        .where("state", "=", "committed")
        .orderBy("seq")
        .execute(),
      this.kysely.selectFrom("chat_runs").selectAll()
        .where("turn_id", "=", parsedTurnId).where("chat_id", "=", parsedChatId)
        .orderBy("attempt", "desc").executeTakeFirst(),
    ]);
    if (!messageRow || !runRow) return null;
    return {
      chat,
      message: toMessage(messageRow),
      userMessages: userMessageRows.map(toMessage),
      turn: toTurn(turnRow),
      latestRun: toRun(runRow),
    };
  }

  async listActiveRunContexts(
    ownerInput: ChatOwner,
    limit = 64,
  ): Promise<ChatTurnRunContext[]> {
    const owner = validateOwner(ownerInput);
    const boundedLimit = Math.max(1, Math.min(64, Math.trunc(limit)));
    const rows = await this.kysely.selectFrom("chat_runs")
      .innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .select(["chat_runs.chat_id", "chat_runs.turn_id", "chat_runs.id"])
      .where("chats.owner_type", "=", owner.type)
      .where("chats.owner_id", "=", owner.ownerId)
      .where("chat_runs.status", "in", [...ACTIVE_RUNS])
      .orderBy("chat_runs.created_at")
      .limit(boundedLimit)
      .execute();
    const contexts: ChatTurnRunContext[] = [];
    for (const row of rows) {
      const context = await this.getTurnRunContext(owner, row.chat_id, row.turn_id);
      if (context?.latestRun.id === row.id) contexts.push(context);
    }
    return contexts;
  }

  async getDetailPage(ownerInput: ChatOwner, chatId: string, input: {
    beforeSeq?: number;
    limit: number;
  }): Promise<ChatDetailPage | null> {
    return this.detail.getDetailPage(ownerInput, chatId, input);
  }

  async getAdapterState(ownerInput: ChatOwner, input: {
    runId: string;
    driverKind: string;
    instanceId: string;
  }): Promise<{ schemaVersion: number; state: unknown } | null> {
    return this.runLifecycle.getAdapterState(ownerInput, input);
  }

  async getPendingApproval(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    approvalId: string;
  }): Promise<Extract<CanonicalChatRunActivity, { type: "approval.requested" }> | null> {
    return this.runLifecycle.getPendingApproval(ownerInput, input);
  }

  async getLatestAdapterStateForChat(ownerInput: ChatOwner, input: {
    chatId: string;
    driverKind: string;
    instanceId: string;
  }): Promise<{ schemaVersion: number; state: unknown; executionRootFingerprint?: string } | null> {
    return this.runLifecycle.getLatestAdapterStateForChat(ownerInput, input);
  }

  async markRunRunning(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    startedAt: string;
  }): Promise<CanonicalChatRun> {
    return this.runLifecycle.markRunRunning(ownerInput, input);
  }

  async updateAdapterState(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    driverKind: string;
    instanceId: string;
    schemaVersion: number;
    state: unknown;
  }): Promise<void> {
    return this.runLifecycle.updateAdapterState(ownerInput, input);
  }

  async appendRunActivities(
    ownerInput: ChatOwner,
    chatId: string,
    runId: string,
    input: CanonicalChatRunActivity[],
  ): Promise<number> {
    return this.runLifecycle.appendRunActivities(ownerInput, chatId, runId, input);
  }

  async appendAssistantDelta(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    messageId: string;
    delta: string;
    createdAt: string;
  }): Promise<CanonicalChatMessage> {
    return this.runLifecycle.appendAssistantDelta(ownerInput, input);
  }

  async finishRun(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    outcome: "completed" | "failed" | "aborted";
    completedAt: string;
    output?: CanonicalChatMessage;
  }): Promise<{ run: CanonicalChatRun; transitioned: boolean }> {
    return this.runLifecycle.finishRun(ownerInput, input);
  }

  async replayOutbox(ownerInput: ChatOwner, input: {
    afterCursor: number;
    limit: number;
  }): Promise<ChatOutboxEvent[]> {
    const owner = validateOwner(ownerInput);
    const rows = await this.kysely.selectFrom("chat_outbox").selectAll()
      .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("cursor", ">", Math.max(0, Math.trunc(input.afterCursor)))
      .orderBy("cursor").limit(Math.max(1, Math.min(100, Math.trunc(input.limit)))).execute();
    return rows.map(toOutbox);
  }

  async replayOutboxWindow(ownerInput: ChatOwner, input: {
    afterCursor?: number;
    limit: number;
  }): Promise<{ events: ChatOutboxEvent[]; gap: boolean; nextCursor?: number }> {
    const owner = validateOwner(ownerInput);
    const afterCursor = input.afterCursor === undefined
      ? undefined
      : Math.max(0, Math.trunc(input.afterCursor));
    if (afterCursor !== undefined && afterCursor > 0) {
      const cursorExists = await this.kysely.selectFrom("chat_outbox").select("cursor")
        .where("owner_type", "=", owner.type)
        .where("owner_id", "=", owner.ownerId)
        .where("cursor", "=", afterCursor)
        .executeTakeFirst();
      if (!cursorExists) return { events: [], gap: true };
    }
    const events = await this.replayOutbox(owner, {
      afterCursor: afterCursor ?? 0,
      limit: Math.max(1, Math.min(100, Math.trunc(input.limit))),
    });
    const nextCursor = events.at(-1)?.cursor;
    return {
      events,
      gap: false,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async search(
    ownerInput: ChatOwner,
    queryInput: string,
    limitInput = 20,
    projectId?: string | null,
  ): Promise<ChatRecord[]> {
    const owner = validateOwner(ownerInput);
    const searchText = queryInput.trim().slice(0, 200);
    if (!searchText) return [];
    let query = this.kysely.selectFrom("chats")
      .innerJoin("chat_messages", "chat_messages.chat_id", "chats.id")
      .selectAll("chats")
      .distinct()
      .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
      .where("chat_messages.state", "=", "committed")
      .where(sql<boolean>`to_tsvector('simple', chat_messages.search_text) @@ plainto_tsquery('simple', ${searchText})`);
    if (projectId !== undefined) {
      query = projectId === null
        ? query.where("chats.project_id", "is", null)
        : query.where("chats.project_id", "=", requireSafeRef(projectId));
    }
    const rows = await query.orderBy("chats.updated_at", "desc")
      .limit(Math.max(1, Math.min(100, Math.trunc(limitInput)))).execute();
    return Promise.all(rows.map((row) => toPrincipalRecord(this.kysely, owner, row)));
  }

  async exportChat(ownerInput: ChatOwner, chatId: string): Promise<ChatExport | null> {
    const owner = validateOwner(ownerInput);
    const chat = await hydrateRecord(this.kysely, owner, CanonicalChatIdSchema.parse(chatId));
    if (!chat) return null;
    const [messages, turns, runs, activities, attachments] = await Promise.all([
      this.kysely.selectFrom("chat_messages").selectAll().where("chat_id", "=", chatId).orderBy("seq").execute(),
      this.kysely.selectFrom("chat_turns").selectAll().where("chat_id", "=", chatId).orderBy("created_at").execute(),
      this.kysely.selectFrom("chat_runs").selectAll().where("chat_id", "=", chatId).orderBy("created_at").execute(),
      this.kysely.selectFrom("chat_run_events").selectAll().where("chat_id", "=", chatId)
        .orderBy("occurred_at").orderBy("run_id").orderBy("run_seq").orderBy("id").execute(),
      this.kysely.selectFrom("chat_attachments").selectAll().where("chat_id", "=", chatId).orderBy("created_at").execute(),
    ]);
    return {
      chat,
      messages: messages.map(toMessage),
      turns: turns.map(toTurn),
      runs: runs.map(toRun),
      activities: toActivities(activities),
      attachments: attachments.map((row) => ({
        id: row.id,
        messageId: row.message_id,
        kind: row.kind,
        label: row.label,
        ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
        ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
      })),
    };
  }

  async hardDelete(ownerInput: ChatOwner, input: {
    chatId: string;
    clientRequestId: string;
  }): Promise<{ chatId: string; deletedAt: string }> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(input.chatId);
    CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    return this.transact(async (trx) => {
      const priorRequest = await trx.selectFrom("chat_deletions").selectAll()
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .where("request_id", "=", input.clientRequestId)
        .executeTakeFirst();
      if (priorRequest) {
        if (priorRequest.chat_id !== input.chatId) throw new ChatConflictError(input.chatId, 0);
        return { chatId: priorRequest.chat_id, deletedAt: asIso(priorRequest.deleted_at) ?? new Date(0).toISOString() };
      }
      const priorChat = await trx.selectFrom("chat_deletions").selectAll()
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .where("chat_id", "=", input.chatId).executeTakeFirst();
      if (priorChat) {
        return { chatId: priorChat.chat_id, deletedAt: asIso(priorChat.deleted_at) ?? new Date(0).toISOString() };
      }
      const chat = await selectOwnedChat(trx, owner, input.chatId, true);
      if (!chat) {
        const committedDeletion = await trx.selectFrom("chat_deletions").selectAll()
          .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
          .where("chat_id", "=", input.chatId).executeTakeFirst();
        if (committedDeletion) {
          return {
            chatId: committedDeletion.chat_id,
            deletedAt: asIso(committedDeletion.deleted_at) ?? new Date(0).toISOString(),
          };
        }
        throw new ChatNotFoundError(input.chatId);
      }
      if (await activeRunQuery(trx, input.chatId)) throw new ChatBusyError(input.chatId);
      const deletion = await trx.insertInto("chat_deletions").values({
        owner_type: owner.type,
        owner_id: owner.ownerId,
        chat_id: input.chatId,
        request_id: input.clientRequestId,
      }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "request_id"]).doNothing())
        .returningAll().executeTakeFirst();
      if (!deletion) {
        const conflictingRequest = await trx.selectFrom("chat_deletions").selectAll()
          .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
          .where("request_id", "=", input.clientRequestId).executeTakeFirst();
        if (conflictingRequest?.chat_id === input.chatId) {
          return {
            chatId: conflictingRequest.chat_id,
            deletedAt: asIso(conflictingRequest.deleted_at) ?? new Date(0).toISOString(),
          };
        }
        throw new ChatConflictError(input.chatId, Number(chat.revision));
      }
      await this.appendOutbox(trx, owner, input.chatId, Number(chat.revision) + 1, "chat.deleted");
      await trx.deleteFrom("chats").where("id", "=", input.chatId)
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId).execute();
      return { chatId: input.chatId, deletedAt: asIso(deletion.deleted_at) ?? new Date(0).toISOString() };
    });
  }

  async upsertLegacyImport(ownerInput: ChatOwner, input: {
    sourceKind: string;
    sourceId: string;
    chatId: string;
    sourceHash: string;
    importVersion: number;
    verificationStatus: "pending" | "verified" | "failed";
  }): Promise<ChatLegacyImportRecord> {
    const owner = validateOwner(ownerInput);
    [input.sourceKind, input.sourceId, input.sourceHash].forEach(requireSafeRef);
    CanonicalChatIdSchema.parse(input.chatId);
    const row = await this.kysely.insertInto("chat_legacy_imports").values({
      owner_type: owner.type,
      owner_id: owner.ownerId,
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      chat_id: input.chatId,
      source_hash: input.sourceHash,
      import_version: input.importVersion,
      verification_status: input.verificationStatus,
    }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "source_kind", "source_id"]).doUpdateSet({
      chat_id: input.chatId,
      source_hash: input.sourceHash,
      import_version: input.importVersion,
      verification_status: input.verificationStatus,
      updated_at: sql`now()`,
    })).returningAll().executeTakeFirstOrThrow();
    return toLegacyImport(row);
  }

  async getLegacyImport(ownerInput: ChatOwner, sourceKind: string, sourceId: string): Promise<ChatLegacyImportRecord | null> {
    const owner = validateOwner(ownerInput);
    const row = await this.kysely.selectFrom("chat_legacy_imports").selectAll()
      .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("source_kind", "=", requireSafeRef(sourceKind)).where("source_id", "=", requireSafeRef(sourceId))
      .executeTakeFirst();
    return row ? toLegacyImport(row) : null;
  }

  async recordMigration(ownerInput: ChatOwner, input: {
    migrationId: string;
    phase: string;
    sourceFingerprint: string;
    importedCount: number;
    errorCount: number;
    cutoverAt?: string;
    legacyAliasExpiresAt?: string;
  }): Promise<ChatMigrationRecord> {
    const owner = validateOwner(ownerInput);
    [input.migrationId, input.phase, input.sourceFingerprint].forEach(requireSafeRef);
    const row = await this.kysely.insertInto("chat_migrations").values({
      owner_type: owner.type,
      owner_id: owner.ownerId,
      migration_id: input.migrationId,
      phase: input.phase,
      source_fingerprint: input.sourceFingerprint,
      imported_count: input.importedCount,
      error_count: input.errorCount,
      cutover_at: input.cutoverAt ?? null,
      legacy_alias_expires_at: input.legacyAliasExpiresAt ?? null,
    }).onConflict((oc) => oc.columns(["owner_type", "owner_id", "migration_id"]).doUpdateSet({
      phase: input.phase,
      source_fingerprint: input.sourceFingerprint,
      imported_count: input.importedCount,
      error_count: input.errorCount,
      cutover_at: input.cutoverAt ?? null,
      legacy_alias_expires_at: input.legacyAliasExpiresAt ?? null,
      updated_at: sql`now()`,
    })).returningAll().executeTakeFirstOrThrow();
    return toMigration(row);
  }

  async getMigration(ownerInput: ChatOwner, migrationId: string): Promise<ChatMigrationRecord | null> {
    const owner = validateOwner(ownerInput);
    const row = await this.kysely.selectFrom("chat_migrations").selectAll()
      .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("migration_id", "=", requireSafeRef(migrationId)).executeTakeFirst();
    return row ? toMigration(row) : null;
  }

  async pruneOutbox(ownerInput: ChatOwner, beforeCursor: number, limitInput = 1_000): Promise<number> {
    const owner = validateOwner(ownerInput);
    const rows = await this.kysely.selectFrom("chat_outbox").select("cursor")
      .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("cursor", "<", Math.max(0, Math.trunc(beforeCursor))).orderBy("cursor")
      .limit(Math.max(1, Math.min(1_000, Math.trunc(limitInput)))).execute();
    if (rows.length === 0) return 0;
    const result = await this.kysely.deleteFrom("chat_outbox").where("cursor", "in", rows.map((row) => row.cursor)).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

export type { ChatDatabase, ChatExport, ChatOutboxEvent, ChatOwner, ChatRecord };
