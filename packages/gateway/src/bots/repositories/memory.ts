/**
 * Bot memory (`bot_memory_items`). A bot holds at most 2,000 live items,
 * counted inside the insert transaction under a per-bot advisory lock; the
 * caller decides eviction (episodes are summarized first, preferences never
 * evicted silently). Items from external sources stay unconfirmed until the
 * owner confirms them and are never admitted into context before that.
 * Forgetting an item also flags the bot's transcripts for recompaction.
 */
import { sql, type Selectable } from "kysely";
import type { BotMemoryItemsTable } from "../database.js";
import { createBotSessionsRepository } from "./sessions.js";
import {
  BotStateError,
  isoTimestamp,
  newBotStateId,
  optionalIsoTimestamp,
  toSafeInteger,
  withTransaction,
  type BotExecutor,
} from "./shared.js";

export const MAX_MEMORY_ITEMS_PER_BOT = 2_000;
const MAX_CONTENT_BYTES = 4 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024;
const MAX_SEARCH_RESULTS = 20;
const MAX_QUERY_CHARS = 500;
const MAX_LISTED = 100;
const encoder = new TextEncoder();

export type BotMemoryKind = BotMemoryItemsTable["kind"];

export interface BotMemoryRecord {
  itemId: string;
  ownerId: string;
  botId: string;
  kind: BotMemoryKind;
  scope: string;
  content: string;
  source: Record<string, unknown>;
  confirmed: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

type MemoryRow = Omit<Selectable<BotMemoryItemsTable>, "content_tsv">;

const COLUMNS = [
  "item_id", "owner_id", "bot_id", "kind", "scope", "content", "source", "confirmed", "revision",
  "created_at", "updated_at", "expires_at", "forgotten_at",
] as const;

function fromRow(row: MemoryRow): BotMemoryRecord {
  return {
    itemId: row.item_id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    kind: row.kind,
    scope: row.scope,
    content: row.content,
    source: typeof row.source === "string" ? JSON.parse(row.source) as Record<string, unknown> : row.source,
    confirmed: row.confirmed,
    revision: toSafeInteger(row.revision),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    expiresAt: optionalIsoTimestamp(row.expires_at),
  };
}

export function createBotMemoryRepository(db: BotExecutor) {
  return {
    async remember(input: {
      ownerId: string;
      botId: string;
      kind: BotMemoryKind;
      scope: string;
      content: string;
      source: Record<string, unknown>;
      confirmed: boolean;
      expiresAt?: string;
      now: string;
    }, executor: BotExecutor = db): Promise<BotMemoryRecord> {
      const contentBytes = encoder.encode(input.content).byteLength;
      const source = JSON.stringify(input.source);
      if (contentBytes === 0 || contentBytes > MAX_CONTENT_BYTES || encoder.encode(source).byteLength > MAX_SOURCE_BYTES) {
        throw new BotStateError("too_large");
      }
      return withTransaction(executor, async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-memory:${input.ownerId}:${input.botId}`}, 0))`.execute(trx);
        const live = await trx.selectFrom("bot_memory_items")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
          .where("forgotten_at", "is", null)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", input.now)]))
          .executeTakeFirstOrThrow();
        if (Number(live.count) >= MAX_MEMORY_ITEMS_PER_BOT) throw new BotStateError("capacity_exceeded");
        const row = await trx.insertInto("bot_memory_items").values({
          item_id: newBotStateId("mem"),
          owner_id: input.ownerId,
          bot_id: input.botId,
          kind: input.kind,
          scope: input.scope,
          content: input.content,
          source,
          confirmed: input.confirmed,
          created_at: input.now,
          updated_at: input.now,
          expires_at: input.expiresAt ?? null,
          forgotten_at: null,
        }).returning([...COLUMNS]).executeTakeFirstOrThrow();
        return fromRow(row);
      });
    },
    /**
     * Ranked full-text search over confirmed, live items visible in `scopes`
     * (for example `bot` and `chat:<chatId>`). Unconfirmed items never match.
     */
    async search(input: { ownerId: string; botId: string; query: string; scopes: readonly string[]; limit?: number; now: string }, executor: BotExecutor = db): Promise<BotMemoryRecord[]> {
      const query = input.query.trim().slice(0, MAX_QUERY_CHARS);
      if (query.length === 0 || input.scopes.length === 0) return [];
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 5), MAX_SEARCH_RESULTS));
      const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
      const rows = await executor.selectFrom("bot_memory_items")
        .select([...COLUMNS])
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
        .where("confirmed", "=", true).where("forgotten_at", "is", null)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", input.now)]))
        .where("scope", "in", [...input.scopes])
        .where(sql<boolean>`content_tsv @@ ${tsQuery}`)
        .orderBy(sql`ts_rank(content_tsv, ${tsQuery})`, "desc")
        .orderBy("updated_at", "desc")
        .limit(limit)
        .execute();
      return rows.map(fromRow);
    },
    /** The owner confirms an externally sourced item at its revision. */
    async confirm(input: { ownerId: string; itemId: string; baseRevision: number; now: string }, executor: BotExecutor = db): Promise<BotMemoryRecord> {
      const row = await executor.updateTable("bot_memory_items")
        .set({ confirmed: true, revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("item_id", "=", input.itemId)
        .where("forgotten_at", "is", null).where("revision", "=", input.baseRevision)
        .returning([...COLUMNS])
        .executeTakeFirst();
      if (!row) throw new BotStateError("revision_conflict");
      return fromRow(row);
    },
    /**
     * Forgets an item and flags the bot's transcripts for recompaction in one
     * transaction, so a summary that cited it is regenerated before reuse.
     */
    async forget(input: { ownerId: string; itemId: string; now: string }, executor: BotExecutor = db): Promise<boolean> {
      return withTransaction(executor, async (trx) => {
        const row = await trx.updateTable("bot_memory_items")
          .set({ forgotten_at: input.now, revision: sql<number>`revision + 1`, updated_at: input.now })
          .where("owner_id", "=", input.ownerId).where("item_id", "=", input.itemId).where("forgotten_at", "is", null)
          .returning("bot_id")
          .executeTakeFirst();
        if (!row) return false;
        await createBotSessionsRepository(trx).markNeedsRecompaction({ ownerId: input.ownerId, botId: row.bot_id, now: input.now }, trx);
        return true;
      });
    },
    /** Live items for the owner's memory view, newest first; unconfirmed items included and marked. */
    async list(input: { ownerId: string; botId: string; limit?: number; now: string }, executor: BotExecutor = db): Promise<BotMemoryRecord[]> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_LISTED), MAX_LISTED));
      const rows = await executor.selectFrom("bot_memory_items").select([...COLUMNS])
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("forgotten_at", "is", null)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", input.now)]))
        .orderBy("updated_at", "desc").limit(limit)
        .execute();
      return rows.map(fromRow);
    },
  };
}

export type BotMemoryRepository = ReturnType<typeof createBotMemoryRepository>;
