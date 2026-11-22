import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessagingKyselyRepository } from "../../../packages/gateway/src/messages/repository.js";
import {
  MessagingBridgeStore,
  lockOwnerMessages,
  type MessagingBridgeDatabase,
} from "../../../packages/gateway/src/messages/bridge-store.js";

/**
 * Competing writes on independent PostgreSQL connections (docs/dev/testing-effectiveness.md).
 * Root must supply a disposable PostgreSQL URL. A skipped suite is not acceptance.
 */
describe.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL))("bridge store on PostgreSQL", () => {
  const ownerId = "user_a";
  const room = "!portal:bridge.example.test";
  let admin: Kysely<MessagingBridgeDatabase>;
  let db: Kysely<MessagingBridgeDatabase>;
  let store: MessagingBridgeStore;
  let schema: string;
  let accountId: string;

  beforeEach(async () => {
    schema = `bridge_store_test_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely<MessagingBridgeDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({
      connectionString: process.env.MATRIX_TEST_POSTGRES_URL, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000,
    }) }) });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = new Kysely<MessagingBridgeDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({
      connectionString: process.env.MATRIX_TEST_POSTGRES_URL, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 5000,
      options: `-c search_path=${schema}`,
    }) }) });
    await new MessagingKyselyRepository(db as never).bootstrap();
    store = new MessagingBridgeStore(db);
    await store.bootstrap();
    ({ accountId } = await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa" }));
    await store.applySyncBatch({
      ownerId, previousBatch: null, nextBatch: "s1",
      conversations: [{ roomId: room, network: "whatsapp", accountId, displayName: "Sara" }],
      messages: [],
    });
  });

  afterEach(async () => {
    await db?.destroy();
    if (admin) {
      await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
      await admin.destroy();
    }
  });

  it("confirms a send even when the sync echo commits while the confirmation runs", async () => {
    await store.claimOutgoing({ ownerId, roomId: room, clientTxnId: "txn_race0001", body: "hello" });
    let confirmed: Promise<unknown> | undefined;
    let syncStored!: () => void;
    const echoStored = new Promise<void>((resolve) => { syncStored = resolve; });
    // A sync batch on its own connection holds the owner lock while storing the echo.
    const sync = db.transaction().execute(async (trx) => {
      await lockOwnerMessages(trx, ownerId);
      await trx.insertInto("messaging_messages").values({
        id: `msg_${randomUUID().replaceAll("-", "")}`, owner_id: ownerId, room_id: room, event_id: "$echo",
        direction: "outgoing", sender_name: "You", kind: "text", body: "hello",
        occurred_at: new Date().toISOString(), delivery: null, client_txn_id: null,
      }).execute();
      syncStored();
      // The confirmation starts on another connection before this batch commits.
      confirmed = store.markOutgoingSent(ownerId, "txn_race0001", "$echo");
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await echoStored;
    await sync;
    await expect(confirmed).resolves.toMatchObject({ eventId: "$echo", delivery: "sent", clientTxnId: "txn_race0001" });
    const rows = await db.selectFrom("messaging_messages").select(["event_id", "client_txn_id"]).where("event_id", "=", "$echo").execute();
    expect(rows).toEqual([{ event_id: "$echo", client_txn_id: "txn_race0001" }]);
  });

  it("never marks read a message that commits while the newest page is read", async () => {
    let read: ReturnType<MessagingBridgeStore["readLatestMessages"]> | undefined;
    // A sync batch stores a message and bumps unread on its own connection, then commits late.
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("messaging_messages").values({
        id: `msg_${randomUUID().replaceAll("-", "")}`, owner_id: ownerId, room_id: room, event_id: "$late",
        direction: "incoming", sender_name: "Sara", kind: "text", body: "late",
        occurred_at: new Date().toISOString(), delivery: null, client_txn_id: null,
      }).execute();
      await trx.updateTable("messaging_conversations").set({ unread_count: sql`unread_count + 1` })
        .where("owner_id", "=", ownerId).where("room_id", "=", room).execute();
      read = store.readLatestMessages(ownerId, room, 50);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const result = await read!;
    const unread = (await store.listConversations(ownerId, { limit: 10 })).items[0]?.unreadCount;
    // The read mark waited for the batch, so the page it returns includes the late message.
    expect(result.page.items.map((item) => item.eventId)).toContain("$late");
    expect(unread).toBe(0);
  });

  it("applies two concurrent batches from the same position exactly once", async () => {
    const batch = (next: string, eventId: string) => store.applySyncBatch({
      ownerId, previousBatch: "s1", nextBatch: next, conversations: [],
      messages: [{ roomId: room, eventId, direction: "incoming", senderName: "Sara", kind: "text", body: eventId, occurredAt: new Date().toISOString() }],
    });
    const results = await Promise.allSettled([batch("s2a", "$a"), batch("s2b", "$b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = await db.selectFrom("messaging_messages").select("event_id").where("room_id", "=", room).execute();
    expect(stored).toHaveLength(1);
  });
});
