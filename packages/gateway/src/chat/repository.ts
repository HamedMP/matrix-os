import {
  CanonicalChatIdSchema,
  CanonicalChatMessageSchema,
  CanonicalChatModelSelectionSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunActivitySchema,
  CanonicalChatRunSchema,
  CanonicalChatTurnSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessage,
  type CanonicalChatModelSelection,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatTurn,
} from "@matrix-os/contracts";
import { Kysely, sql, type Dialect, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import { bootstrapChatDatabase, type ChatDatabase, type ChatRunsTable, type ChatsTable } from "./database.js";
import {
  asIso,
  jsonb,
  messageSearchText,
  toActivity,
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
}

export interface ChatListCursor {
  updatedAt: string;
  chatId: string;
}

export interface ChatListPage {
  items: ChatRecord[];
  nextCursor?: ChatListCursor;
}

export interface ChatDetailPage {
  record: ChatRecord;
  messages: CanonicalChatMessage[];
  turns: CanonicalChatTurn[];
  runs: CanonicalChatRun[];
  activities: CanonicalChatRunActivity[];
  nextBeforeSeq?: number;
}

export class ChatNotFoundError extends Error {
  constructor(readonly chatId: string) {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

export class ChatConflictError extends Error {
  constructor(readonly chatId: string, readonly latestRevision: number) {
    super("Chat conflict");
    this.name = "ChatConflictError";
  }
}

export class ChatBusyError extends Error {
  constructor(readonly chatId: string) {
    super("Chat is busy");
    this.name = "ChatBusyError";
  }
}

export class ChatProviderInstanceLockedError extends Error {
  constructor(readonly chatId: string) {
    super("Provider Instance is locked");
    this.name = "ChatProviderInstanceLockedError";
  }
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
  return toChatRecord(row, await activeRunQuery(executor, chatId));
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
  return { chat, message: toMessage(messageRow), turn: existingTurn, run: toRun(runRow) };
}

export class ChatRepository {
  readonly kysely: Kysely<ChatDatabase>;
  private readonly transactionScoped: boolean;

  constructor(dialectOrKysely: Dialect | Kysely<ChatDatabase>, transactionScoped = false) {
    this.kysely = dialectOrKysely instanceof Kysely
      ? dialectOrKysely
      : new Kysely<ChatDatabase>({ dialect: dialectOrKysely });
    this.transactionScoped = transactionScoped;
  }

  async bootstrap(): Promise<void> {
    await bootstrapChatDatabase(this.kysely);
  }

  async release(): Promise<void> {
    // The Gateway owns and closes the shared Kysely instance after Chat drains.
  }

  async withTransaction<T>(fn: (repository: ChatRepository) => Promise<T>): Promise<T> {
    return this.transact((trx) => fn(new ChatRepository(trx, true)));
  }

  private async transact<T>(fn: (trx: Executor) => Promise<T>): Promise<T> {
    if (this.transactionScoped) return fn(this.kysely);
    return this.kysely.transaction().execute(fn);
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
        return toChatRecord(existing, await activeRunQuery(trx, existing.id));
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
      await insertOutbox(trx, owner, inserted.id, 0, "chat.created");
      return toChatRecord(inserted);
    });
  }

  async get(ownerInput: ChatOwner, chatId: string): Promise<ChatRecord | null> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(chatId);
    return hydrateRecord(this.kysely, owner, chatId);
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
    const items = await Promise.all(pageRows.map(async (row) => (
      toChatRecord(row, await activeRunQuery(this.kysely, row.id))
    )));
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
      const record = toChatRecord(updated, await activeRunQuery(trx, chatId));
      await insertOutbox(trx, owner, chatId, record.chat.revision, "chat.updated");
      return record;
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
          owner_reference: null,
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
        attempt: run.attempt,
        driver_kind: run.driverKind,
        instance_id: run.instanceId,
        selection: jsonb(run.selection),
        interaction_mode: run.interactionMode,
        permission_mode: run.permissionMode,
        execution_root: run.executionRoot ? jsonb(run.executionRoot) : null,
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
      await insertOutbox(trx, owner, input.chatId, revision, "turn.accepted", { runId: run.id, turnId: turn.id });
      return {
        chat: toChatRecord(updated, await activeRunQuery(trx, input.chatId)),
        message,
        turn,
        run,
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

  async getDetailPage(ownerInput: ChatOwner, chatId: string, input: {
    beforeSeq?: number;
    limit: number;
  }): Promise<ChatDetailPage | null> {
    const owner = validateOwner(ownerInput);
    const parsedChatId = CanonicalChatIdSchema.parse(chatId);
    const record = await hydrateRecord(this.kysely, owner, parsedChatId);
    if (!record) return null;
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit)));
    const beforeSeq = input.beforeSeq === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.trunc(input.beforeSeq));
    const messageRows = await this.kysely.selectFrom("chat_messages").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("seq", "<", beforeSeq)
      .orderBy("seq", "desc")
      .limit(limit + 1)
      .execute();
    const hasOlder = messageRows.length > limit;
    const selectedMessageRows = messageRows.slice(0, limit).reverse();
    const turnIds = [...new Set(selectedMessageRows.flatMap((row) => row.turn_id ? [row.turn_id] : []))];
    const turnRows = turnIds.length === 0 ? [] : await this.kysely.selectFrom("chat_turns").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("id", "in", turnIds)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    turnRows.reverse();
    const selectedRunIds = selectedMessageRows.flatMap((row) => row.run_id ? [row.run_id] : []);
    const runTurnIds = turnRows.map((row) => row.id);
    const runRows = runTurnIds.length === 0 && selectedRunIds.length === 0 ? [] : await this.kysely
      .selectFrom("chat_runs")
      .selectAll()
      .where("chat_id", "=", parsedChatId)
      .where(({ eb, or }) => or([
        ...(runTurnIds.length > 0 ? [eb("turn_id", "in", runTurnIds)] : []),
        ...(selectedRunIds.length > 0 ? [eb("id", "in", selectedRunIds)] : []),
      ]))
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    runRows.reverse();
    const runIds = runRows.map((row) => row.id);
    const activityRows = runIds.length === 0 ? [] : await this.kysely.selectFrom("chat_run_events").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("run_id", "in", runIds)
      .orderBy("occurred_at", "desc")
      .limit(500)
      .execute();
    activityRows.reverse();
    return {
      record,
      messages: selectedMessageRows.map(toMessage),
      turns: turnRows.map(toTurn),
      runs: runRows.map(toRun),
      activities: activityRows.map(toActivity),
      ...(hasOlder && selectedMessageRows[0]
        ? { nextBeforeSeq: Number(selectedMessageRows[0].seq) }
        : {}),
    };
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
        .where("id", "=", runId).where("chat_id", "=", chatId).executeTakeFirst();
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
      if (Number(count.count) + unseenCount > 500) throw new ChatConflictError(chatId, Number(current.revision));
      let inserted = 0;
      for (const activity of activities) {
        const row = await trx.insertInto("chat_run_events").values({
          id: activity.id,
          chat_id: chatId,
          run_id: runId,
          event: jsonb(activity),
          occurred_at: activity.occurredAt,
        }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
        if (row) inserted += 1;
      }
      if (inserted > 0) {
        const revision = Number(current.revision) + 1;
        await trx.updateTable("chats").set({ revision, updated_at: sql`now()` }).where("id", "=", chatId).execute();
        await insertOutbox(trx, owner, chatId, revision, "run.activity", { runId });
      }
      return inserted;
    });
  }

  async finishRun(ownerInput: ChatOwner, input: {
    chatId: string;
    runId: string;
    outcome: "completed" | "failed" | "aborted";
    completedAt: string;
  }): Promise<CanonicalChatRun> {
    const owner = validateOwner(ownerInput);
    const completedAt = new Date(input.completedAt).toISOString();
    return this.transact(async (trx) => {
      const chat = await selectOwnedChat(trx, owner, CanonicalChatIdSchema.parse(input.chatId), true);
      if (!chat) throw new ChatNotFoundError(input.chatId);
      const current = await trx.selectFrom("chat_runs").selectAll()
        .where("id", "=", input.runId).where("chat_id", "=", input.chatId).forUpdate().executeTakeFirst();
      if (!current) throw new ChatNotFoundError(input.chatId);
      if (!ACTIVE_RUNS.includes(current.status as typeof ACTIVE_RUNS[number])) {
        return toRun(current);
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
        attention: input.outcome === "failed" ? "failed" : "none",
        updated_at: completedAt,
      }).where("id", "=", input.chatId).execute();
      await insertOutbox(trx, owner, input.chatId, revision, `run.${input.outcome}` as ChatOutboxEventType, { runId: input.runId });
      return toRun(updated);
    });
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

  async search(ownerInput: ChatOwner, queryInput: string, limitInput = 20): Promise<ChatRecord[]> {
    const owner = validateOwner(ownerInput);
    const query = queryInput.trim().slice(0, 200);
    if (!query) return [];
    const rows = await this.kysely.selectFrom("chats")
      .innerJoin("chat_messages", "chat_messages.chat_id", "chats.id")
      .selectAll("chats")
      .distinct()
      .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
      .where("chat_messages.state", "=", "committed")
      .where(sql<boolean>`to_tsvector('simple', chat_messages.search_text) @@ plainto_tsquery('simple', ${query})`)
      .orderBy("chats.updated_at", "desc").limit(Math.max(1, Math.min(100, Math.trunc(limitInput)))).execute();
    return Promise.all(rows.map(async (row) => toChatRecord(row, await activeRunQuery(this.kysely, row.id))));
  }

  async exportChat(ownerInput: ChatOwner, chatId: string): Promise<ChatExport | null> {
    const owner = validateOwner(ownerInput);
    const chat = await hydrateRecord(this.kysely, owner, CanonicalChatIdSchema.parse(chatId));
    if (!chat) return null;
    const [messages, turns, runs, activities, attachments] = await Promise.all([
      this.kysely.selectFrom("chat_messages").selectAll().where("chat_id", "=", chatId).orderBy("seq").execute(),
      this.kysely.selectFrom("chat_turns").selectAll().where("chat_id", "=", chatId).orderBy("created_at").execute(),
      this.kysely.selectFrom("chat_runs").selectAll().where("chat_id", "=", chatId).orderBy("created_at").execute(),
      this.kysely.selectFrom("chat_run_events").selectAll().where("chat_id", "=", chatId).orderBy("occurred_at").execute(),
      this.kysely.selectFrom("chat_attachments").selectAll().where("chat_id", "=", chatId).orderBy("created_at").execute(),
    ]);
    return {
      chat,
      messages: messages.map(toMessage),
      turns: turns.map(toTurn),
      runs: runs.map(toRun),
      activities: activities.map(toActivity),
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
      await insertOutbox(trx, owner, input.chatId, Number(chat.revision) + 1, "chat.deleted");
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
