import { randomBytes } from "node:crypto";
import type { Transaction, Selectable } from "kysely";
import type { BoardActor, BoardEvent, BoardEventType, BoardMessage, BoardReaction } from "@matrix-os/contracts/message-board";
import type { BoardBoardsTable, BoardMessagesTable, MessageBoardDatabase, StoredBoardActor } from "./database.js";

export type BoardRow = Selectable<BoardBoardsTable>;
export type MessageRow = Selectable<BoardMessagesTable>;
export type BoardTrx = Transaction<MessageBoardDatabase>;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Opaque, unguessable IDs such as `msg_3fK9…`. */
export function newBoardId(prefix: "msg" | "brd" | "wat" | "sch"): string {
  const bytes = randomBytes(20);
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function storedActor(actor: BoardActor): StoredBoardActor {
  return { id: actor.id, kind: actor.kind, name: actor.name, ...(actor.profile ? { profile: actor.profile } : {}) };
}

export function parseActor(value: unknown): BoardActor {
  const raw = (typeof value === "string" ? JSON.parse(value) : value) as StoredBoardActor;
  return { id: raw.id, kind: raw.kind as BoardActor["kind"], name: raw.name, ...(raw.profile ? { profile: raw.profile } : {}) };
}

export function parseJsonArray(value: unknown): string[] {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

const MENTION = /(^|[^A-Za-z0-9_.-])@([a-z0-9_.-]{1,64})/gi;
const MAX_MENTIONS = 20;

export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    found.add(match[2]!.toLowerCase().replace(/\.+$/, ""));
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found].filter(Boolean);
}

export function toBoardMessage(
  row: MessageRow,
  labels: Record<string, string> = {},
  reactions: BoardReaction[] = [],
): BoardMessage {
  const deleted = row.deleted_at != null;
  return {
    id: row.id,
    channel: row.channel,
    text: deleted ? "" : row.text,
    re: row.root_id,
    replyTo: row.reply_to,
    by: parseActor(row.author_actor),
    labels: deleted ? {} : labels,
    reactions: deleted ? [] : reactions,
    revision: row.revision,
    createdAt: toIso(row.created_at)!,
    ...(row.edited_at ? { editedAt: toIso(row.edited_at)! } : {}),
    deletedAt: toIso(row.deleted_at),
  };
}

/** Loads labels and reactions for a page of messages in two queries. */
export async function hydrateMessages(trx: BoardTrx, rows: readonly MessageRow[]): Promise<BoardMessage[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [labels, reactions] = await Promise.all([
    trx.selectFrom("board_labels").select(["message_id", "key", "value"]).where("message_id", "in", ids).execute(),
    trx.selectFrom("board_reactions").select(["message_id", "emoji", "actor"]).where("message_id", "in", ids)
      .orderBy("created_at").orderBy("actor").execute(),
  ]);
  const labelsById = new Map<string, Record<string, string>>();
  for (const label of labels) {
    const bucket = labelsById.get(label.message_id) ?? {};
    bucket[label.key] = label.value;
    labelsById.set(label.message_id, bucket);
  }
  const reactionsById = new Map<string, BoardReaction[]>();
  for (const reaction of reactions) {
    const bucket = reactionsById.get(reaction.message_id) ?? [];
    const existing = bucket.find((item) => item.emoji === reaction.emoji);
    if (existing) existing.actors.push(reaction.actor);
    else bucket.push({ emoji: reaction.emoji, actors: [reaction.actor] });
    reactionsById.set(reaction.message_id, bucket);
  }
  return rows.map((row) => toBoardMessage(row, labelsById.get(row.id) ?? {}, reactionsById.get(row.id) ?? []));
}

export interface PendingBoardEvent {
  type: BoardEventType;
  actor: BoardActor;
  channel?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Appends events under the board row lock taken by `lockBoard`, so cursors are
 * gapless and commit in order: a reader resuming `after` a cursor never skips
 * an event that commits later with a smaller cursor.
 */
export async function appendEvents(trx: BoardTrx, board: BoardRow, pending: readonly PendingBoardEvent[], now: Date): Promise<BoardEvent[]> {
  if (pending.length === 0) return [];
  const start = Number(board.last_cursor);
  const rows = pending.map((event, index) => ({
    owner_id: board.owner_id,
    board_id: board.id,
    cursor: String(start + index + 1),
    type: event.type,
    actor: JSON.stringify(storedActor(event.actor)),
    channel: event.channel ?? null,
    message_id: event.messageId ?? null,
    thread_id: event.threadId ?? null,
    payload: JSON.stringify(event.payload ?? {}),
    created_at: now,
  }));
  await trx.insertInto("board_events").values(rows).execute();
  const last = start + pending.length;
  await trx.updateTable("board_boards").set({ last_cursor: String(last) }).where("id", "=", board.id).execute();
  board.last_cursor = String(last);
  return pending.map((event, index) => ({
    cursor: String(start + index + 1),
    type: event.type,
    board: board.name,
    createdAt: now.toISOString(),
    actor: event.actor,
    ...(event.channel ? { channel: event.channel } : {}),
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.payload && Object.keys(event.payload).length ? { payload: event.payload } : {}),
  }));
}

/** Serializes writes to one board; every write transaction starts here. */
export async function lockBoard(trx: BoardTrx, boardId: string): Promise<BoardRow> {
  const row = await trx.selectFrom("board_boards").selectAll().where("id", "=", boardId).forUpdate().executeTakeFirst();
  if (!row) throw new Error("board vanished");
  return row;
}
