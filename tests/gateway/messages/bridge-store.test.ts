import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely, sql, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type UnknownRow } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { MessagingKyselyRepository } from "../../../packages/gateway/src/messages/repository.js";
import {
  BridgeSyncPositionConflictError,
  MessagingBridgeStore,
  type BridgeSyncBatch,
  type MessagingBridgeDatabase,
} from "../../../packages/gateway/src/messages/bridge-store.js";

const ownerId = "user_a";
const otherOwnerId = "user_b";
const room = "!portal1:bridge.example.test";
const room2 = "!portal2:bridge.example.test";

/** Fails any INSERT into `table`, simulating a crash part-way through a batch transaction. */
class FailInsertInto implements KyselyPlugin {
  constructor(private readonly table: string) {}
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const node = args.node as RootOperationNode & { into?: { table?: { identifier?: { name?: string } } } };
    if (node.kind === "InsertQueryNode" && node.into?.table?.identifier?.name === this.table) {
      throw new Error("injected failure");
    }
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

function message(eventId: string, at: string, overrides: Partial<BridgeSyncBatch["messages"][number]> = {}): BridgeSyncBatch["messages"][number] {
  return {
    roomId: room,
    eventId,
    direction: "incoming",
    senderName: "Sara",
    kind: "text",
    body: `body ${eventId}`,
    occurredAt: at,
    ...overrides,
  };
}

describe("MessagingBridgeStore", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let kysely: Kysely<MessagingBridgeDatabase>;
  let store: MessagingBridgeStore;
  let accountId: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    kysely = new Kysely<MessagingBridgeDatabase>({ dialect: pglite.dialect });
    await new MessagingKyselyRepository(kysely as never).bootstrap();
    store = new MessagingBridgeStore(kysely);
    await store.bootstrap();
    ({ accountId } = await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa", displayName: "+49 555" }));
  });

  afterEach(async () => {
    await kysely.destroy();
  });

  function batch(previousBatch: string | null, nextBatch: string, messages: BridgeSyncBatch["messages"]): BridgeSyncBatch {
    return {
      ownerId,
      previousBatch,
      nextBatch,
      conversations: [{ roomId: room, network: "whatsapp", accountId, displayName: "Sara" }],
      messages,
    };
  }

  it("bootstraps idempotently and widens the 077 network check to accept linkedin", async () => {
    await store.bootstrap();
    await expect(store.recordLinkedAccount({ ownerId, network: "linkedin", loginId: "li_1" })).resolves.toMatchObject({
      accountId: expect.stringMatching(/^acct_/),
    });
    const constraint = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'messaging_conversations_network_slug_check'
    `.execute(kysely);
    expect(constraint.rows[0]?.def).toContain("linkedin");
  });

  it("widens a pre-existing 077 check constraint on an old database", async () => {
    const legacy = await KyselyPGlite.create();
    const legacyKysely = new Kysely<MessagingBridgeDatabase>({ dialect: legacy.dialect });
    try {
      await sql`
        CREATE TABLE messaging_accounts (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
          network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
          external_account_id TEXT, display_name TEXT,
          status TEXT NOT NULL, status_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(legacyKysely);
      await new MessagingKyselyRepository(legacyKysely as never).bootstrap();
      const legacyStore = new MessagingBridgeStore(legacyKysely);
      await legacyStore.bootstrap();
      await expect(legacyStore.recordLinkedAccount({ ownerId, network: "linkedin", loginId: "li_1" })).resolves.toBeTruthy();
    } finally {
      await legacyKysely.destroy();
    }
  });

  it("commits a batch's conversations, messages and position together", async () => {
    const result = await store.applySyncBatch(batch(null, "s1", [
      message("$e1", "2026-11-22T10:00:00.000Z"),
      message("$e2", "2026-11-22T10:01:00.000Z", { direction: "outgoing", senderName: "You", body: "from phone" }),
    ]));

    expect(result).toEqual({ changedRoomIds: [room], conversationsChanged: true });
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s1");
    const conversations = await store.listConversations(ownerId, { limit: 50 });
    expect(conversations.items).toEqual([{
      roomId: room,
      network: "whatsapp",
      displayName: "Sara",
      lastMessagePreview: "from phone",
      lastEventAt: "2026-11-22T10:01:00.000Z",
      unreadCount: 1,
    }]);
    const messages = await store.listMessages(ownerId, room, { limit: 50 });
    expect(messages.items.map((item) => [item.eventId, item.direction])).toEqual([["$e2", "outgoing"], ["$e1", "incoming"]]);
    const permission = await kysely.selectFrom("messaging_permissions").selectAll().where("room_id", "=", room).executeTakeFirst();
    expect(permission).toMatchObject({ read_enabled: false, reply_enabled: false, automation_enabled: false });
  });

  it("rolls back the whole batch when a write fails mid-batch, and a replay stores each message once", async () => {
    const failing = new MessagingBridgeStore(kysely.withPlugin(new FailInsertInto("messaging_bridge_sync_state")));
    const first = batch(null, "s1", [message("$e1", "2026-11-22T10:00:00.000Z"), message("$e2", "2026-11-22T10:01:00.000Z")]);

    await expect(failing.applySyncBatch(first)).rejects.toThrow("injected failure");
    await expect(store.getSyncPosition(ownerId)).resolves.toBeNull();
    await expect(store.listMessages(ownerId, room, { limit: 50 })).resolves.toMatchObject({ items: [] });
    await expect(store.listConversations(ownerId, { limit: 50 })).resolves.toMatchObject({ items: [] });

    await store.applySyncBatch(first);
    // The next batch overlaps the previous timeline (as a replay after a crash would).
    await store.applySyncBatch(batch("s1", "s2", [message("$e2", "2026-11-22T10:01:00.000Z"), message("$e3", "2026-11-22T10:02:00.000Z")]));

    const messages = await store.listMessages(ownerId, room, { limit: 50 });
    expect(messages.items.map((item) => item.eventId)).toEqual(["$e3", "$e2", "$e1"]);
    const [conversation] = (await store.listConversations(ownerId, { limit: 50 })).items;
    expect(conversation?.unreadCount).toBe(3);
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s2");
  });

  it("refuses to advance from a stale position and writes nothing", async () => {
    await store.applySyncBatch(batch(null, "s1", [message("$e1", "2026-11-22T10:00:00.000Z")]));

    await expect(store.applySyncBatch(batch(null, "s1b", [message("$x", "2026-11-22T10:05:00.000Z")])))
      .rejects.toBeInstanceOf(BridgeSyncPositionConflictError);
    await expect(store.applySyncBatch(batch("s0", "s2", [message("$y", "2026-11-22T10:05:00.000Z")])))
      .rejects.toBeInstanceOf(BridgeSyncPositionConflictError);

    expect((await store.listMessages(ownerId, room, { limit: 50 })).items.map((item) => item.eventId)).toEqual(["$e1"]);
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s1");
  });

  it("merges the sync echo of an outgoing send into the pending row, in either order", async () => {
    await store.applySyncBatch(batch(null, "s1", []));
    const claimed = await store.claimOutgoing({ ownerId, roomId: room, clientTxnId: "txn_echo_0001", body: "hello" });
    expect(claimed.created).toBe(true);
    await store.applySyncBatch(batch("s1", "s2", [
      message("$sent1", "2026-11-22T10:03:00.000Z", { direction: "outgoing", senderName: "You", body: "hello", transactionId: "txn_echo_0001" }),
    ]));
    await store.markOutgoingSent(ownerId, "txn_echo_0001", "$sent1");

    await store.claimOutgoing({ ownerId, roomId: room, clientTxnId: "txn_echo_0002", body: "second" });
    // Echo seen without the transaction id (another device) before the send call returns.
    await store.applySyncBatch(batch("s2", "s3", [
      message("$sent2", "2026-11-22T10:04:00.000Z", { direction: "outgoing", senderName: "You", body: "second" }),
    ]));
    await store.markOutgoingSent(ownerId, "txn_echo_0002", "$sent2");

    const items = (await store.listMessages(ownerId, room, { limit: 50 })).items;
    expect(items.filter((item) => item.eventId === "$sent1")).toEqual([expect.objectContaining({ delivery: "sent", body: "hello" })]);
    expect(items.filter((item) => item.eventId === "$sent2")).toEqual([expect.objectContaining({ delivery: "sent", body: "second" })]);
    expect(items).toHaveLength(2);
  });

  it("returns the existing row for a repeated clientTxnId and keeps failed state until retried", async () => {
    await store.applySyncBatch(batch(null, "s1", []));
    const first = await store.claimOutgoing({ ownerId, roomId: room, clientTxnId: "txn_retry_001", body: "hi" });
    const again = await store.claimOutgoing({ ownerId, roomId: room, clientTxnId: "txn_retry_001", body: "hi" });
    expect(again).toMatchObject({ created: false, message: { id: first.message.id } });

    await expect(store.markOutgoingFailed(ownerId, "txn_retry_001")).resolves.toEqual(expect.objectContaining({ delivery: "failed", clientTxnId: "txn_retry_001" }));
    expect(await store.getOutgoing(ownerId, "txn_retry_001")).not.toHaveProperty("eventId");
    await expect(store.retryOutgoing(ownerId, "txn_retry_001")).resolves.toBe(true);
    await expect(store.retryOutgoing(ownerId, "txn_retry_001")).resolves.toBe(false);
  });

  it("pages messages newest first with a stable cursor and isolates owners", async () => {
    const messages = Array.from({ length: 5 }, (_, index) => message(`$p${index}`, `2026-11-22T10:0${index}:00.000Z`));
    await store.applySyncBatch(batch(null, "s1", messages));

    const page1 = await store.listMessages(ownerId, room, { limit: 2 });
    const page2 = await store.listMessages(ownerId, room, { limit: 2, cursor: page1.nextCursor });
    const page3 = await store.listMessages(ownerId, room, { limit: 2, cursor: page2.nextCursor });
    expect([...page1.items, ...page2.items, ...page3.items].map((item) => item.eventId)).toEqual(["$p4", "$p3", "$p2", "$p1", "$p0"]);
    expect(page3.nextCursor).toBeUndefined();

    await expect(store.listMessages(otherOwnerId, room, { limit: 50 })).resolves.toEqual({ items: [] });
    await expect(store.listConversations(otherOwnerId, { limit: 50 })).resolves.toEqual({ items: [] });
    await expect(store.getConversationNetwork(otherOwnerId, room)).resolves.toBeNull();
    await expect(store.listMessages(ownerId, room, { limit: 2, cursor: "nope" })).rejects.toThrow();
  });

  it("orders conversations newest first and filters by network", async () => {
    const { accountId: telegramAccount } = await store.recordLinkedAccount({ ownerId, network: "telegram", loginId: "login_tg" });
    await store.applySyncBatch({
      ownerId,
      previousBatch: null,
      nextBatch: "s1",
      conversations: [
        { roomId: room, network: "whatsapp", accountId, displayName: "Sara" },
        { roomId: room2, network: "telegram", accountId: telegramAccount, displayName: "Team" },
      ],
      messages: [
        message("$a", "2026-11-22T09:00:00.000Z"),
        message("$b", "2026-11-22T11:00:00.000Z", { roomId: room2 }),
      ],
    });

    expect((await store.listConversations(ownerId, { limit: 50 })).items.map((item) => item.roomId)).toEqual([room2, room]);
    expect((await store.listConversations(ownerId, { limit: 50, network: "whatsapp" })).items.map((item) => item.roomId)).toEqual([room]);
    await expect(store.markConversationRead(ownerId, room)).resolves.toBe(true);
    expect((await store.listConversations(ownerId, { limit: 50, network: "whatsapp" })).items[0]?.unreadCount).toBe(0);
  });

  it("records linked accounts idempotently by login id and audits connect and removal safely", async () => {
    const again = await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa", displayName: "Renamed" });
    expect(again.accountId).toBe(accountId);
    expect(await store.listBridgeAccounts(ownerId)).toEqual([
      { id: accountId, network: "whatsapp", loginId: "login_wa", displayName: "Renamed", status: "connected" },
    ]);

    await expect(store.markAccountRemoved(otherOwnerId, accountId)).resolves.toBe(false);
    await expect(store.markAccountRemoved(ownerId, accountId)).resolves.toBe(true);
    await expect(store.markAccountRemoved(ownerId, accountId)).resolves.toBe(false);
    await expect(store.listBridgeAccounts(ownerId)).resolves.toEqual([]);

    const audit = await kysely.selectFrom("messaging_audit_events").select(["type", "safe_summary", "metadata", "account_id"]).orderBy("created_at").execute();
    expect(audit.map((row) => row.type)).toEqual(["account_connected", "account_connected", "account_disconnected"]);
    expect(JSON.stringify(audit)).not.toContain("+49");
  });

  it("reports a room changed when a late echo confirms a failed send", async () => {
    await store.applySyncBatch({ ownerId, previousBatch: null, nextBatch: "s1", conversations: [{ roomId: room, network: "whatsapp", accountId, displayName: "Sara" }], messages: [] });
    await store.claimOutgoing({ ownerId, roomId: room, clientTxnId: "txn_late0001", body: "hello" });
    await store.markOutgoingFailed(ownerId, "txn_late0001");

    const result = await store.applySyncBatch({
      ownerId, previousBatch: "s1", nextBatch: "s2", conversations: [],
      messages: [message("$echo", "2026-11-22T10:00:00.000Z", { direction: "outgoing", senderName: "You", body: "hello", transactionId: "txn_late0001" })],
    });
    expect(result.changedRoomIds).toEqual([room]);
    await expect(store.getOutgoing(ownerId, "txn_late0001")).resolves.toMatchObject({ delivery: "sent", eventId: "$echo" });
  });

  it("reads the newest page and clears unread in one step, keeping later messages unread", async () => {
    await store.applySyncBatch({
      ownerId, previousBatch: null, nextBatch: "s1",
      conversations: [{ roomId: room, network: "whatsapp", accountId, displayName: "Sara" }],
      messages: [message("$m1", "2026-11-22T10:00:00.000Z"), message("$m2", "2026-11-22T10:01:00.000Z")],
    });
    const read = await store.readLatestMessages(ownerId, room, 50);
    expect(read.markedRead).toBe(true);
    expect(read.page.items.map((item) => item.eventId)).toEqual(["$m2", "$m1"]);
    await store.applySyncBatch({ ownerId, previousBatch: "s1", nextBatch: "s2", conversations: [], messages: [message("$m3", "2026-11-22T10:02:00.000Z")] });
    expect((await store.listConversations(ownerId, { limit: 10 })).items[0]?.unreadCount).toBe(1);
    expect((await store.readLatestMessages(otherOwnerId, room, 50)).page.items).toEqual([]);
  });

  it("records a discovered login once and never revives an account the owner removed", async () => {
    const discovered = await store.recordDiscoveredAccount({ ownerId, network: "telegram", loginId: "login_tg" });
    expect(discovered?.accountId).toMatch(/^acct_/);
    await expect(store.recordDiscoveredAccount({ ownerId, network: "telegram", loginId: "login_tg" })).resolves.toBeNull();
    await store.markAccountRemoved(ownerId, accountId);
    await expect(store.recordDiscoveredAccount({ ownerId, network: "whatsapp", loginId: "login_wa" })).resolves.toBeNull();
    expect((await store.listBridgeAccounts(ownerId)).map((account) => account.loginId)).toEqual(["login_tg"]);
  });
});
