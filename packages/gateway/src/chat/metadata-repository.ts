import { CanonicalChatIdSchema, CanonicalChatModelSelectionSchema, CanonicalOwnerScopeSchema, CanonicalUpdateChatTitleRequestSchema, type CanonicalUpdateChatTitleRequest } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase, ChatsTable, ChatRunsTable } from "./database.js";
import { ChatBusyError, ChatConflictError, ChatNotFoundError, ChatProviderInstanceLockedError } from "./errors.js";
import { jsonb, type ChatOwner, type ChatRecord, type ChatOutboxEventType } from "./records.js";
import type { ChatListCursor, ChatListPage, UpdateChatInput } from "./repository.js";
import { unreadChatPredicate } from "./read-state-repository.js";
type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
interface MetadataDependencies {
  kysely: Kysely<ChatDatabase>;
  transact<T>(fn: (trx: Executor) => Promise<T>): Promise<T>;
  selectOwnedChat(executor: Executor, owner: ChatOwner, chatId: string, lock?: boolean): Promise<Selectable<ChatsTable> | undefined>;
  toPrincipalRecord(executor: Executor, owner: ChatOwner, row: Selectable<ChatsTable>): Promise<ChatRecord>;
  activeRunQuery(executor: Executor, chatId: string): Promise<Selectable<ChatRunsTable> | undefined>;
  appendOutbox(executor: Executor, owner: ChatOwner, chatId: string, revision: number, type: ChatOutboxEventType): Promise<void>;
}
const validateOwner = (owner: ChatOwner) => CanonicalOwnerScopeSchema.parse(owner);
const requireSafeRef = (value: string) => z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(value);

export async function listChats(deps: MetadataDependencies, ownerInput: ChatOwner, input: {
    unreadOnly?: boolean;
    limit: number;
    lifecycle?: "active" | "archived";
    projectId?: string | null;
    cursor?: ChatListCursor;
  }): Promise<ChatListPage> {
    const owner = validateOwner(ownerInput);
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    let query = deps.kysely.selectFrom("chats").selectAll()
      .select(sql<string>`to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        .as("cursor_activity_at"))
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId);
    if (input.unreadOnly) query = query.where(unreadChatPredicate(owner.ownerId));
    if (input.lifecycle) query = query.where("lifecycle", "=", input.lifecycle);
    if (input.projectId !== undefined) query = input.projectId === null
      ? query.where("project_id", "is", null)
      : query.where("project_id", "=", requireSafeRef(input.projectId));
    if (input.cursor) {
      const cursorTimestamp = z.iso.datetime({ offset: true }).parse(input.cursor.activityAt);
      const cursorAt = sql<Date>`${cursorTimestamp}::timestamptz`;
      const cursorChatId = CanonicalChatIdSchema.parse(input.cursor.chatId);
      query = query.where(({ and, eb, or }) => or([
        eb("activity_at", "<", cursorAt),
        and([eb("activity_at", "=", cursorAt), eb("id", ">", cursorChatId)]),
      ]));
    }
    const rows = await query.orderBy("activity_at", "desc").orderBy("id").limit(limit + 1).execute();
    const pageRows = rows.slice(0, limit);
    const items = await Promise.all(pageRows.map((row) => deps.toPrincipalRecord(deps.kysely, owner, row)));
    const last = rows.length > limit ? pageRows.at(-1) : undefined;
    return {
      items,
      ...(last ? { nextCursor: { activityAt: last.cursor_activity_at, chatId: last.id } } : {}),
    };
  }

export async function updateChat(deps: MetadataDependencies, ownerInput: ChatOwner, chatId: string, input: UpdateChatInput): Promise<ChatRecord> {
    const owner = validateOwner(ownerInput);
    CanonicalChatIdSchema.parse(chatId);
    if (input.currentSelection) CanonicalChatModelSelectionSchema.parse(input.currentSelection);
    if (typeof input.projectId === "string") requireSafeRef(input.projectId);

    return deps.transact(async (trx) => {
      const current = await deps.selectOwnedChat(trx, owner, chatId, true);
      if (!current) throw new ChatNotFoundError(chatId);
      if (Number(current.revision) !== input.baseRevision) {
        throw new ChatConflictError(chatId, Number(current.revision));
      }
      const contextChanges = ("projectId" in input && (input.projectId ?? null) !== current.project_id)
        || (input.lifecycle !== undefined && input.lifecycle !== current.lifecycle);
      if (contextChanges && await deps.activeRunQuery(trx, chatId)) throw new ChatBusyError(chatId);
      if (current.bound_instance_id && input.currentSelection
        && input.currentSelection.instanceId !== current.bound_instance_id) {
        throw new ChatProviderInstanceLockedError(chatId);
      }

      const revision = input.baseRevision + 1;
      const updated = await trx.updateTable("chats").set({
        ...(input.title === undefined ? {} : { title: input.title, title_version: sql<number>`title_version + 1`, title_manual: true }),
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
      const record = await deps.toPrincipalRecord(trx, owner, updated);
      await deps.appendOutbox(trx, owner, chatId, record.chat.revision, "chat.updated");
      return record;
    });
  }


/** Title CAS and its durable event commit together; run revisions never reject a rename. */
export async function renameChat(deps: MetadataDependencies, ownerInput: ChatOwner, chatId: string,
  input: CanonicalUpdateChatTitleRequest, automatic = false): Promise<ChatRecord> {
  const owner = validateOwner(ownerInput);
  CanonicalChatIdSchema.parse(chatId);
  const request = CanonicalUpdateChatTitleRequestSchema.parse(input);
  return deps.transact(async (trx) => {
    let update = trx.updateTable("chats").set({
      title: request.title,
      title_version: sql<number>`title_version + 1`,
      title_manual: !automatic,
      revision: sql<number>`revision + 1`,
      updated_at: sql`now()`,
    }).where("id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
      .where("title_version", "=", request.expectedTitleVersion);
    if (automatic) update = update.where("title_manual", "=", false);
    const updated = await update.returningAll().executeTakeFirst();
    if (!updated) {
      const current = await deps.selectOwnedChat(trx, owner, chatId);
      if (!current) throw new ChatNotFoundError(chatId);
      if (automatic) return deps.toPrincipalRecord(trx, owner, current);
      throw new ChatConflictError(chatId, Number(current.revision));
    }
    const record = await deps.toPrincipalRecord(trx, owner, updated);
    await deps.appendOutbox(trx, owner, chatId, record.chat.revision, "chat.updated");
    return record;
  });
}
