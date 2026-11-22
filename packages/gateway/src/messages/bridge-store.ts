import { randomUUID } from "node:crypto";
import { sql, type ColumnType, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  MessagingBridgeConversation,
  MessagingBridgeMessage,
  MessagingBridgeNetwork,
} from "@matrix-os/contracts/messaging-bridge";
import { MESSAGING_BRIDGE_NETWORKS } from "@matrix-os/contracts/messaging-bridge";
import { sanitizeAuditSummary, type MessagingAuditType } from "./audit.js";
import type { MessagingConversationsTable, MessagingDatabase } from "./repository.js";

/** Owner-Postgres persistence for the bridge data plane (spec 2701). */

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;

export interface MessagingBridgeSyncStateTable {
  owner_id: string;
  next_batch: string;
  updated_at: Timestamp;
}

export interface MessagingMessagesTable {
  id: string;
  owner_id: string;
  room_id: string;
  event_id: string | null;
  direction: "incoming" | "outgoing";
  sender_name: string;
  kind: "text" | "media" | "other";
  body: string;
  occurred_at: Timestamp;
  delivery: "sending" | "sent" | "failed" | null;
  client_txn_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MessagingBridgeConversationsTable extends MessagingConversationsTable {
  last_message_preview: string | null;
  unread_count: ColumnType<number, number | undefined, number>;
}

export type MessagingBridgeDatabase = Omit<MessagingDatabase, "messaging_conversations"> & {
  messaging_conversations: MessagingBridgeConversationsTable;
  messaging_bridge_sync_state: MessagingBridgeSyncStateTable;
  messaging_messages: MessagingMessagesTable;
};

export interface BridgeConversationUpsert {
  roomId: string;
  network: MessagingBridgeNetwork;
  accountId: string;
  displayName: string;
}

export interface BridgeMessageInsert {
  roomId: string;
  eventId: string;
  direction: "incoming" | "outgoing";
  senderName: string;
  kind: "text" | "media" | "other";
  body: string;
  occurredAt: string;
  transactionId?: string;
}

export interface BridgeSyncBatch {
  ownerId: string;
  previousBatch: string | null;
  nextBatch: string;
  conversations: BridgeConversationUpsert[];
  messages: BridgeMessageInsert[];
}

export interface BridgeAccountRow {
  id: string;
  network: MessagingBridgeNetwork;
  loginId: string | null;
  displayName: string | null;
  status: "setup_required" | "connecting" | "connected" | "disconnected" | "error";
}

export interface KnownBridgeRoom {
  network: MessagingBridgeNetwork;
  accountId: string;
  displayName: string;
}

/** The stored sync position moved under us: another writer advanced it. */
export class BridgeSyncPositionConflictError extends Error {
  constructor() {
    super("Messaging bridge sync position changed concurrently");
    this.name = "BridgeSyncPositionConflictError";
  }
}

const NETWORK_SLUG_TABLES = [
  "messaging_accounts",
  "messaging_conversations",
  "messaging_conversation_mappings",
  "messaging_event_cursors",
] as const;
const PREVIEW_MAX = 280;
const UNREAD_MAX = 9_999;
const CONVERSATION_CURSOR = /^\d{1,6}$/;
const MESSAGE_CURSOR = /^(\d{1,15})_(msg_[0-9a-f]{32})$/;
const BRIDGE_NETWORKS: readonly string[] = MESSAGING_BRIDGE_NETWORKS;

function prefixedId(prefix: "msg" | "acct" | "audit" | "conv"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toBridgeMessage(row: Selectable<MessagingMessagesTable>): MessagingBridgeMessage {
  return {
    ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.client_txn_id ? { clientTxnId: row.client_txn_id } : {}),
    direction: row.direction,
    senderName: row.sender_name.slice(0, PREVIEW_MAX),
    kind: row.kind,
    body: row.body,
    occurredAt: toIso(row.occurred_at),
    ...(row.delivery ? { delivery: row.delivery } : {}),
  };
}

export class MessagingBridgeStore {
  constructor(readonly database: Kysely<MessagingBridgeDatabase>) {}

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS messaging_bridge_sync_state (
        owner_id TEXT PRIMARY KEY,
        next_batch TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.database);
    await sql`
      CREATE TABLE IF NOT EXISTS messaging_messages (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
        sender_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'media', 'other')),
        body TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        delivery TEXT CHECK (delivery IN ('sending', 'sent', 'failed')),
        client_txn_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.database);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_messages_event ON messaging_messages(owner_id, event_id)`.execute(this.database);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_messages_txn
      ON messaging_messages(owner_id, client_txn_id) WHERE client_txn_id IS NOT NULL
    `.execute(this.database);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messaging_messages_room
      ON messaging_messages(owner_id, room_id, occurred_at DESC, id DESC)
    `.execute(this.database);
    await sql`ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS last_message_preview TEXT`.execute(this.database);
    await sql`ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0`.execute(this.database);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messaging_conversations_recent
      ON messaging_conversations(owner_id, last_event_at DESC NULLS LAST, room_id)
    `.execute(this.database);
    // 077 created inline CHECKs without linkedin; widen them once, idempotently.
    for (const table of NETWORK_SLUG_TABLES) {
      const constraint = `${table}_network_slug_check`;
      const result = await sql<{ definition: string }>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = to_regclass(${table}) AND conname = ${constraint}
      `.execute(this.database);
      const definition = result.rows[0]?.definition;
      if (definition === undefined || definition.includes("linkedin")) continue;
      await this.database.transaction().execute(async (trx) => {
        await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${sql.ref(constraint)}`.execute(trx);
        await sql`
          ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.ref(constraint)}
          CHECK (network_slug IN ('telegram', 'whatsapp', 'linkedin'))
        `.execute(trx);
      });
    }
  }

  async getSyncPosition(ownerId: string): Promise<string | null> {
    const row = await this.database
      .selectFrom("messaging_bridge_sync_state")
      .select("next_batch")
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    return row?.next_batch ?? null;
  }

  async getKnownRooms(ownerId: string, roomIds: string[]): Promise<Map<string, KnownBridgeRoom>> {
    // Bounded by one sync batch's joined rooms.
    const known = new Map<string, KnownBridgeRoom>();
    if (roomIds.length === 0) return known;
    const rows = await this.database
      .selectFrom("messaging_conversations")
      .select(["room_id", "network_slug", "account_id", "display_name"])
      .where("owner_id", "=", ownerId)
      .where("room_id", "in", roomIds)
      .execute();
    for (const row of rows) {
      if (!BRIDGE_NETWORKS.includes(row.network_slug)) continue;
      known.set(row.room_id, { network: row.network_slug as MessagingBridgeNetwork, accountId: row.account_id, displayName: row.display_name });
    }
    return known;
  }

  /**
   * Applies one sync batch atomically: conversations, messages and the new
   * position commit together, and the position only advances from the
   * position the batch was fetched with.
   */
  async applySyncBatch(batch: BridgeSyncBatch): Promise<{ changedRoomIds: string[]; conversationsChanged: boolean }> {
    return this.database.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      for (const conversation of batch.conversations) {
        await this.upsertConversation(trx, batch.ownerId, conversation, now);
      }
      const perRoom = new Map<string, { latest: BridgeMessageInsert; incoming: number }>();
      // Rooms whose outgoing row was confirmed by its echo (e.g. failed -> sent after a timeout).
      const confirmedRooms = new Set<string>();
      for (const message of batch.messages) {
        if (message.direction === "outgoing" && message.transactionId) {
          const matched = await trx
            .updateTable("messaging_messages")
            .set({ event_id: message.eventId, delivery: "sent", updated_at: now })
            .where("owner_id", "=", batch.ownerId)
            .where("client_txn_id", "=", message.transactionId)
            .where((eb) => eb.or([eb("event_id", "is", null), eb("event_id", "=", message.eventId)]))
            .returning("id")
            .executeTakeFirst();
          if (matched) {
            confirmedRooms.add(message.roomId);
            continue;
          }
        }
        const inserted = await trx
          .insertInto("messaging_messages")
          .values({
            id: prefixedId("msg"),
            owner_id: batch.ownerId,
            room_id: message.roomId,
            event_id: message.eventId,
            direction: message.direction,
            sender_name: message.senderName.slice(0, PREVIEW_MAX),
            kind: message.kind,
            body: message.body,
            occurred_at: message.occurredAt,
            delivery: null,
            client_txn_id: null,
          })
          .onConflict((oc) => oc.columns(["owner_id", "event_id"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (!inserted) continue;
        const entry = perRoom.get(message.roomId) ?? { latest: message, incoming: 0 };
        if (message.occurredAt >= entry.latest.occurredAt) entry.latest = message;
        if (message.direction === "incoming") entry.incoming += 1;
        perRoom.set(message.roomId, entry);
      }
      for (const [roomId, entry] of perRoom) {
        await this.applyConversationActivity(trx, batch.ownerId, roomId, entry.latest, entry.incoming, now);
      }
      await this.advancePosition(trx, batch, now);
      return {
        changedRoomIds: [...new Set([...perRoom.keys(), ...confirmedRooms])],
        conversationsChanged: batch.conversations.length > 0 || perRoom.size > 0,
      };
    });
  }

  async getConversationNetwork(ownerId: string, roomId: string): Promise<MessagingBridgeNetwork | null> {
    const row = await this.database
      .selectFrom("messaging_conversations")
      .select("network_slug")
      .where("owner_id", "=", ownerId)
      .where("room_id", "=", roomId)
      .executeTakeFirst();
    return row && BRIDGE_NETWORKS.includes(row.network_slug) ? row.network_slug as MessagingBridgeNetwork : null;
  }

  async listConversations(
    ownerId: string,
    options: { network?: MessagingBridgeNetwork; cursor?: string; limit: number },
  ): Promise<{ items: MessagingBridgeConversation[]; nextCursor?: string }> {
    if (options.cursor !== undefined && !CONVERSATION_CURSOR.test(options.cursor)) throw new InvalidBridgeCursorError();
    const offset = options.cursor ? Number(options.cursor) : 0;
    let query = this.database
      .selectFrom("messaging_conversations")
      .select(["room_id", "network_slug", "display_name", "last_message_preview", "last_event_at", "unread_count"])
      .where("owner_id", "=", ownerId)
      .where("network_slug", "in", [...MESSAGING_BRIDGE_NETWORKS]);
    if (options.network) query = query.where("network_slug", "=", options.network);
    const rows = await query
      .orderBy(sql`last_event_at DESC NULLS LAST`)
      .orderBy("room_id")
      .limit(options.limit + 1)
      .offset(offset)
      .execute();
    return {
      items: rows.slice(0, options.limit).map((row) => ({
        roomId: row.room_id,
        network: row.network_slug as MessagingBridgeNetwork,
        displayName: row.display_name.slice(0, PREVIEW_MAX),
        ...(row.last_message_preview ? { lastMessagePreview: row.last_message_preview.slice(0, PREVIEW_MAX) } : {}),
        ...(row.last_event_at ? { lastEventAt: toIso(row.last_event_at) } : {}),
        unreadCount: Math.min(Number(row.unread_count), UNREAD_MAX),
      })),
      ...(rows.length > options.limit ? { nextCursor: String(offset + options.limit) } : {}),
    };
  }

  async listMessages(
    ownerId: string,
    roomId: string,
    options: { cursor?: string; limit: number },
    executor: Kysely<MessagingBridgeDatabase> = this.database,
  ): Promise<{ items: MessagingBridgeMessage[]; nextCursor?: string }> {
    let query = executor
      .selectFrom("messaging_messages")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("room_id", "=", roomId);
    if (options.cursor !== undefined) {
      const match = MESSAGE_CURSOR.exec(options.cursor);
      if (!match) throw new InvalidBridgeCursorError();
      const before = new Date(Number(match[1])).toISOString();
      const id = match[2]!;
      query = query.where((eb) => eb.or([
        eb("occurred_at", "<", before),
        eb.and([eb("occurred_at", "=", before), eb("id", "<", id)]),
      ]));
    }
    const rows = await query.orderBy("occurred_at", "desc").orderBy("id", "desc").limit(options.limit + 1).execute();
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map(toBridgeMessage),
      ...(rows.length > options.limit && last ? { nextCursor: `${new Date(last.occurred_at).getTime()}_${last.id}` } : {}),
    };
  }

  /**
   * Reads the newest page and clears the unread count together. The read mark
   * runs first and row-locks the conversation, so a sync batch that commits
   * before it is visible to the page read that follows, and one that commits
   * after it waits for this transaction and then adds its own unread count:
   * a message the page did not return is never marked read.
   */
  async readLatestMessages(
    ownerId: string,
    roomId: string,
    limit: number,
  ): Promise<{ page: { items: MessagingBridgeMessage[]; nextCursor?: string }; markedRead: boolean }> {
    return this.database.transaction().execute(async (trx) => {
      const marked = await trx
        .updateTable("messaging_conversations")
        .set({ unread_count: 0 })
        .where("owner_id", "=", ownerId)
        .where("room_id", "=", roomId)
        .where("unread_count", ">", 0)
        .returning("id")
        .executeTakeFirst();
      const page = await this.listMessages(ownerId, roomId, { limit }, trx);
      return { page, markedRead: marked !== undefined };
    });
  }

  async markConversationRead(ownerId: string, roomId: string): Promise<boolean> {
    const result = await this.database
      .updateTable("messaging_conversations")
      .set({ unread_count: 0 })
      .where("owner_id", "=", ownerId)
      .where("room_id", "=", roomId)
      .where("unread_count", ">", 0)
      .returning("id")
      .executeTakeFirst();
    return result !== undefined;
  }

  /** Inserts a `sending` row keyed by clientTxnId, or returns the existing row for a retry. */
  async claimOutgoing(input: {
    ownerId: string;
    roomId: string;
    clientTxnId: string;
    body: string;
  }): Promise<{ message: Selectable<MessagingMessagesTable>; created: boolean }> {
    return this.database.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      const inserted = await trx
        .insertInto("messaging_messages")
        .values({
          id: prefixedId("msg"),
          owner_id: input.ownerId,
          room_id: input.roomId,
          event_id: null,
          direction: "outgoing",
          sender_name: "You",
          kind: "text",
          body: input.body,
          occurred_at: now,
          delivery: "sending",
          client_txn_id: input.clientTxnId,
        })
        .onConflict((oc) => oc.columns(["owner_id", "client_txn_id"]).where("client_txn_id", "is not", null).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        await this.applyConversationActivity(trx, input.ownerId, input.roomId, {
          roomId: input.roomId,
          eventId: "",
          direction: "outgoing",
          senderName: "You",
          kind: "text",
          body: input.body,
          occurredAt: now,
        }, 0, now);
        return { message: inserted, created: true };
      }
      const existing = await trx
        .selectFrom("messaging_messages")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("client_txn_id", "=", input.clientTxnId)
        .executeTakeFirstOrThrow();
      return { message: existing, created: false };
    });
  }

  /** failed -> sending for an explicit retry; returns false when the row is not failed. */
  async retryOutgoing(ownerId: string, clientTxnId: string): Promise<boolean> {
    const result = await this.database
      .updateTable("messaging_messages")
      .set({ delivery: "sending", updated_at: new Date().toISOString() })
      .where("owner_id", "=", ownerId)
      .where("client_txn_id", "=", clientTxnId)
      .where("delivery", "=", "failed")
      .returning("id")
      .executeTakeFirst();
    return result !== undefined;
  }

  async markOutgoingSent(ownerId: string, clientTxnId: string, eventId: string): Promise<MessagingBridgeMessage> {
    return this.database.transaction().execute(async (trx) => {
      // Sync may already have stored the echo without our transaction id.
      await trx
        .deleteFrom("messaging_messages")
        .where("owner_id", "=", ownerId)
        .where("event_id", "=", eventId)
        .where("client_txn_id", "is", null)
        .execute();
      const row = await trx
        .updateTable("messaging_messages")
        .set({ event_id: eventId, delivery: "sent", updated_at: new Date().toISOString() })
        .where("owner_id", "=", ownerId)
        .where("client_txn_id", "=", clientTxnId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toBridgeMessage(row);
    });
  }

  async getOutgoing(ownerId: string, clientTxnId: string): Promise<MessagingBridgeMessage | null> {
    const row = await this.database
      .selectFrom("messaging_messages")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("client_txn_id", "=", clientTxnId)
      .executeTakeFirst();
    return row ? toBridgeMessage(row) : null;
  }

  async markOutgoingFailed(ownerId: string, clientTxnId: string): Promise<MessagingBridgeMessage> {
    await this.database
      .updateTable("messaging_messages")
      .set({ delivery: "failed", updated_at: new Date().toISOString() })
      .where("owner_id", "=", ownerId)
      .where("client_txn_id", "=", clientTxnId)
      .where("delivery", "=", "sending")
      .execute();
    const row = await this.database
      .selectFrom("messaging_messages")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("client_txn_id", "=", clientTxnId)
      .executeTakeFirstOrThrow();
    return toBridgeMessage(row);
  }

  async listBridgeAccounts(ownerId: string): Promise<BridgeAccountRow[]> {
    const rows = await this.database
      .selectFrom("messaging_accounts")
      .select(["id", "network_slug", "external_account_id", "display_name", "status"])
      .where("owner_id", "=", ownerId)
      .where("status", "!=", "disconnected")
      .where("network_slug", "in", [...MESSAGING_BRIDGE_NETWORKS])
      .orderBy("updated_at", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      network: row.network_slug as MessagingBridgeNetwork,
      loginId: row.external_account_id,
      displayName: row.display_name,
      status: row.status,
    }));
  }

  /** Records (or revives) the account for a completed bridge login, with an audit event. */
  async recordLinkedAccount(input: {
    ownerId: string;
    network: MessagingBridgeNetwork;
    loginId: string;
    displayName?: string;
  }): Promise<{ accountId: string }> {
    return this.database.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      const row = await trx
        .insertInto("messaging_accounts")
        .values({
          id: prefixedId("acct"),
          owner_id: input.ownerId,
          network_slug: input.network,
          external_account_id: input.loginId,
          display_name: input.displayName ?? null,
          status: "connected",
          status_reason: null,
        })
        .onConflict((oc) => oc.columns(["owner_id", "network_slug", "external_account_id"]).doUpdateSet({
          display_name: input.displayName ?? null,
          status: "connected",
          status_reason: null,
          updated_at: now,
        }))
        .returning("id")
        .executeTakeFirstOrThrow();
      await this.insertAudit(trx, input.ownerId, "account_connected", "Messaging account connected", input.network, row.id);
      return { accountId: row.id };
    });
  }

  /**
   * Records a login the bridge reports but this owner never recorded (e.g. a
   * crash right after linking). An existing row, including one the owner
   * removed, is left alone: only a new completed link revives an account.
   */
  async recordDiscoveredAccount(input: {
    ownerId: string;
    network: MessagingBridgeNetwork;
    loginId: string;
    displayName?: string;
  }): Promise<{ accountId: string } | null> {
    return this.database.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("messaging_accounts")
        .values({
          id: prefixedId("acct"),
          owner_id: input.ownerId,
          network_slug: input.network,
          external_account_id: input.loginId,
          display_name: input.displayName ?? null,
          status: "connected",
          status_reason: null,
        })
        .onConflict((oc) => oc.columns(["owner_id", "network_slug", "external_account_id"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!row) return null;
      await this.insertAudit(trx, input.ownerId, "account_connected", "Messaging account connected", input.network, row.id);
      return { accountId: row.id };
    });
  }

  async markAccountRemoved(ownerId: string, accountId: string): Promise<boolean> {
    return this.database.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("messaging_accounts")
        .set({ status: "disconnected", status_reason: null, updated_at: new Date().toISOString() })
        .where("owner_id", "=", ownerId)
        .where("id", "=", accountId)
        .where("status", "!=", "disconnected")
        .returning(["id", "network_slug"])
        .executeTakeFirst();
      if (!row) return false;
      await this.insertAudit(trx, ownerId, "account_disconnected", "Messaging account disconnected", row.network_slug as MessagingBridgeNetwork, row.id);
      return true;
    });
  }

  /** Mirrors the bridge's view of a login onto the local account state. */
  async setAccountHealth(ownerId: string, accountId: string, health: "connected" | "connecting" | "needs_relink"): Promise<void> {
    const status = health === "needs_relink" ? "error" : health;
    await this.database
      .updateTable("messaging_accounts")
      .set({ status, status_reason: health === "needs_relink" ? "needs_relink" : null, updated_at: new Date().toISOString() })
      .where("owner_id", "=", ownerId)
      .where("id", "=", accountId)
      .where("status", "!=", "disconnected")
      .where("status", "!=", status)
      .execute();
  }

  private async upsertConversation(
    trx: Transaction<MessagingBridgeDatabase>,
    ownerId: string,
    conversation: BridgeConversationUpsert,
    now: string,
  ): Promise<void> {
    await trx
      .insertInto("messaging_conversations")
      .values({
        id: prefixedId("conv"),
        owner_id: ownerId,
        room_id: conversation.roomId,
        network_slug: conversation.network,
        account_id: conversation.accountId,
        display_name: conversation.displayName,
        avatar_url: null,
        last_event_at: null,
      })
      .onConflict((oc) => oc.columns(["owner_id", "room_id"]).doUpdateSet({
        network_slug: conversation.network,
        account_id: conversation.accountId,
        display_name: conversation.displayName,
        updated_at: now,
      }))
      .execute();
    // Same default as the 077 path: a new room grants the agent nothing.
    await trx
      .insertInto("messaging_permissions")
      .values({
        owner_id: ownerId,
        room_id: conversation.roomId,
        read_enabled: false,
        reply_enabled: false,
        automation_enabled: false,
        mention_only: true,
        revision: 1,
      })
      .onConflict((oc) => oc.columns(["owner_id", "room_id"]).doNothing())
      .execute();
  }

  private async applyConversationActivity(
    trx: Transaction<MessagingBridgeDatabase>,
    ownerId: string,
    roomId: string,
    latest: BridgeMessageInsert,
    incoming: number,
    now: string,
  ): Promise<void> {
    const at = latest.occurredAt;
    await trx
      .updateTable("messaging_conversations")
      .set({
        last_message_preview: sql`CASE WHEN last_event_at IS NULL OR last_event_at <= ${at}::timestamptz THEN ${latest.body.slice(0, PREVIEW_MAX)} ELSE last_message_preview END`,
        last_event_at: sql`GREATEST(COALESCE(last_event_at, ${at}::timestamptz), ${at}::timestamptz)`,
        unread_count: sql`LEAST(unread_count + ${incoming}, ${UNREAD_MAX})`,
        updated_at: now,
      })
      .where("owner_id", "=", ownerId)
      .where("room_id", "=", roomId)
      .execute();
  }

  private async advancePosition(trx: Transaction<MessagingBridgeDatabase>, batch: BridgeSyncBatch, now: string): Promise<void> {
    const insert = trx
      .insertInto("messaging_bridge_sync_state")
      .values({ owner_id: batch.ownerId, next_batch: batch.nextBatch, updated_at: now });
    const row = batch.previousBatch === null
      ? await insert.onConflict((oc) => oc.column("owner_id").doNothing()).returning("owner_id").executeTakeFirst()
      : await insert
        .onConflict((oc) => oc.column("owner_id")
          .doUpdateSet({ next_batch: batch.nextBatch, updated_at: now })
          .where("messaging_bridge_sync_state.next_batch", "=", batch.previousBatch!))
        .returning("owner_id")
        .executeTakeFirst();
    if (!row) throw new BridgeSyncPositionConflictError();
  }

  private async insertAudit(
    trx: Transaction<MessagingBridgeDatabase>,
    ownerId: string,
    type: MessagingAuditType,
    summary: string,
    network: MessagingBridgeNetwork,
    accountId: string,
  ): Promise<void> {
    await trx
      .insertInto("messaging_audit_events")
      .values({
        id: prefixedId("audit"),
        owner_id: ownerId,
        type,
        network_slug: network,
        room_id: null,
        account_id: accountId,
        actor: "owner",
        safe_summary: sanitizeAuditSummary(summary),
        metadata: sql`'{}'::jsonb`,
      })
      .execute();
  }
}

export class InvalidBridgeCursorError extends Error {
  constructor() {
    super("Invalid messaging bridge cursor");
    this.name = "InvalidBridgeCursorError";
  }
}
