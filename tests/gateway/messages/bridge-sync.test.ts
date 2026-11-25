import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type { MessagingBridgeChangedEvent } from "@matrix-os/contracts/messaging-bridge";
import { MessagingKyselyRepository } from "../../../packages/gateway/src/messages/repository.js";
import { MessagingBridgeStore, type MessagingBridgeDatabase } from "../../../packages/gateway/src/messages/bridge-store.js";
import { createBridgeMatrixClient } from "../../../packages/gateway/src/messages/bridge-matrix-client.js";
import { createBridgeSessionProvider } from "../../../packages/gateway/src/messages/bridge-session.js";
import {
  createBridgeSyncService,
  createPostgresAdvisoryLock,
  syncBackoffMs,
  type BridgeSyncLock,
} from "../../../packages/gateway/src/messages/bridge-sync.js";
import {
  bridgeServer,
  bridgeSession,
  fakeHomeserver,
  json,
  memorySessionStore,
  ownUserId,
  platformMock,
  portalState,
  syncResponse,
  textEvent,
} from "./bridge-fixtures.js";

const ownerId = "user_a";
const portal = `!portal:${bridgeServer}`;
const managementRoom = `!management:${bridgeServer}`;
const ghost = `@whatsapp_4915550001:${bridgeServer}`;

const freeLock: BridgeSyncLock = {
  async tryAcquire() {
    return { lost: new AbortController().signal, release: async () => {} };
  },
};

describe("messaging bridge sync service", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let kysely: Kysely<MessagingBridgeDatabase>;
  let store: MessagingBridgeStore;
  let homeserver: ReturnType<typeof fakeHomeserver>;
  let events: MessagingBridgeChangedEvent[];
  let platform: ReturnType<typeof platformMock>;
  let sessionStore: ReturnType<typeof memorySessionStore>;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    kysely = new Kysely<MessagingBridgeDatabase>({ dialect: pglite.dialect });
    await new MessagingKyselyRepository(kysely as never).bootstrap();
    store = new MessagingBridgeStore(kysely);
    await store.bootstrap();
    await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa" });
    homeserver = fakeHomeserver();
    events = [];
    platform = platformMock();
    sessionStore = memorySessionStore({ [ownerId]: bridgeSession() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await kysely.destroy();
  });

  function service(overrides: Partial<Parameters<typeof createBridgeSyncService>[0]> = {}) {
    return createBridgeSyncService({
      ownerId,
      store,
      sessions: createBridgeSessionProvider({ ownerId, store: sessionStore, platform }),
      matrix: createBridgeMatrixClient({ fetchImpl: homeserver.fetchImpl }),
      lock: freeLock,
      onChanged: (event) => events.push(event),
      ...overrides,
    });
  }

  it("stores portal conversations and messages, ignores management rooms, and joins only bridge invites", async () => {
    homeserver.roomState[managementRoom] = [{ type: "m.room.member", state_key: ownUserId, content: { membership: "join" } }];
    homeserver.syncQueue.push(syncResponse("s1", {
      join: {
        [portal]: {
          state: { events: portalState("whatsapp", [
            { type: "m.room.member", state_key: ghost, sender: ghost, content: { membership: "join", displayname: "Sara" } },
          ]) },
          timeline: { events: [
            textEvent("$in1", ghost, "hello from WhatsApp", "2026-11-22T10:00:00.000Z"),
            textEvent("$out1", ownUserId, "typed on my phone", "2026-11-22T10:01:00.000Z", {
              content: { msgtype: "m.text", body: "typed on my phone", "fi.mau.double_puppet_source": "mautrix-whatsapp" },
            }),
            { type: "m.reaction", event_id: "$r1", sender: ghost, origin_server_ts: 1, content: {} },
          ] },
        },
        [managementRoom]: {
          timeline: { events: [textEvent("$bot1", `@whatsappbot:${bridgeServer}`, "Successfully logged in", "2026-11-22T10:00:00.000Z")] },
        },
      },
      invite: {
        [`!newportal:${bridgeServer}`]: { invite_state: { events: [
          { type: "m.room.member", state_key: ownUserId, sender: `@whatsappbot:${bridgeServer}`, content: { membership: "invite" } },
        ] } },
        [`!spam:${bridgeServer}`]: { invite_state: { events: [
          { type: "m.room.member", state_key: ownUserId, sender: `@stranger:${bridgeServer}`, content: { membership: "invite" } },
        ] } },
      },
    }));

    const sync = service();
    await sync.syncOnce();

    expect(homeserver.joined).toEqual([`!newportal:${bridgeServer}`]);
    const conversations = await store.listConversations(ownerId, { limit: 50 });
    expect(conversations.items).toEqual([expect.objectContaining({
      roomId: portal, network: "whatsapp", displayName: "Sara", lastMessagePreview: "typed on my phone", unreadCount: 1,
    })]);
    const messages = await store.listMessages(ownerId, portal, { limit: 50 });
    expect(messages.items).toEqual([
      expect.objectContaining({ eventId: "$out1", direction: "outgoing", senderName: "You", kind: "text" }),
      expect.objectContaining({ eventId: "$in1", direction: "incoming", senderName: "Sara", body: "hello from WhatsApp" }),
    ]);
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s1");
    expect(events.map((event) => [event.scope, event.roomId])).toEqual([["conversations", undefined], ["messages", portal]]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(event.roomId ? ["roomId", "scope", "type", "updatedAt"] : ["scope", "type", "updatedAt"]);
    }

    // The management room was checked once and is not fetched again.
    homeserver.syncQueue.push(syncResponse("s2", { join: {
      [managementRoom]: { timeline: { events: [textEvent("$bot2", `@whatsappbot:${bridgeServer}`, "ping", "2026-11-22T10:05:00.000Z")] } },
    } }));
    await sync.syncOnce();
    const stateFetches = vi.mocked(homeserver.fetchImpl).mock.calls.filter((call) => String(call[0]).includes("management") && String(call[0]).endsWith("/state"));
    expect(stateFetches).toHaveLength(1);
    expect((await store.listConversations(ownerId, { limit: 50 })).items).toHaveLength(1);
  });

  it("labels a room first seen without bridge state by fetching its state", async () => {
    homeserver.roomState[portal] = portalState("telegram", [{ type: "m.room.name", state_key: "", content: { name: "Climbing group" } }]);
    await store.recordLinkedAccount({ ownerId, network: "telegram", loginId: "login_tg" });
    homeserver.syncQueue.push(syncResponse("s1", { join: {
      [portal]: { timeline: { events: [textEvent("$t1", `@telegram_77:${bridgeServer}`, "see you at 6", "2026-11-22T10:00:00.000Z")] } },
    } }));

    await service().syncOnce();

    expect((await store.listConversations(ownerId, { limit: 50 })).items).toEqual([
      expect.objectContaining({ roomId: portal, network: "telegram", displayName: "Climbing group" }),
    ]);
  });

  it("resumes from the stored position after a restart without duplicating messages", async () => {
    const first = syncResponse("s1", { join: { [portal]: {
      state: { events: portalState("whatsapp") },
      timeline: { events: [textEvent("$a", ghost, "one", "2026-11-22T10:00:00.000Z")] },
    } } });
    homeserver.syncQueue.push(first);
    await service().syncOnce();

    // A fresh service (gateway restart) with the same database.
    homeserver.syncQueue.push(syncResponse("s2", { join: { [portal]: {
      timeline: { events: [
        textEvent("$a", ghost, "one", "2026-11-22T10:00:00.000Z"),
        textEvent("$b", ghost, "two", "2026-11-22T10:01:00.000Z"),
      ] },
    } } }));
    await service().syncOnce();

    expect(homeserver.syncCalls.map((call) => call.since)).toEqual([null, "s1"]);
    expect((await store.listMessages(ownerId, portal, { limit: 50 })).items.map((item) => item.eventId)).toEqual(["$b", "$a"]);
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s2");
  });

  it("keeps the position when a batch fails so the same batch is fetched again", async () => {
    homeserver.syncQueue.push(syncResponse("s1", { join: { [portal]: { state: { events: portalState("whatsapp") }, timeline: { events: [] } } } }));
    await service().syncOnce();
    homeserver.syncQueue.push(json(502, {}));
    await expect(service().syncOnce()).rejects.toMatchObject({ retryable: true });
    homeserver.syncQueue.push(syncResponse("s2"));
    await service().syncOnce();
    expect(homeserver.syncCalls.map((call) => call.since)).toEqual([null, "s1", "s1"]);
  });

  it("requests a new session once when the homeserver rejects the token", async () => {
    vi.mocked(platform.createSession).mockResolvedValue(bridgeSession("syt_owner_secret_token_2"));
    homeserver.syncQueue.push(json(401, { errcode: "M_UNKNOWN_TOKEN" }), syncResponse("s1"));

    await service().syncOnce();

    expect(homeserver.syncCalls.map((call) => call.token)).toEqual(["syt_owner_secret_token_1", "syt_owner_secret_token_2"]);
    expect(platform.createSession).toHaveBeenCalledOnce();
    expect(sessionStore.data[ownerId]?.accessToken).toBe("syt_owner_secret_token_2");
  });

  it("backs off with jitter between 1 s and 60 s and stops before shutdown completes", async () => {
    expect(syncBackoffMs(1, () => 0)).toBe(1_000);
    expect(syncBackoffMs(1, () => 0.999)).toBeLessThan(2_000);
    expect(syncBackoffMs(4, () => 0.5)).toBe(12_000);
    expect(syncBackoffMs(30, () => 1)).toBe(60_000);

    const waits: number[] = [];
    homeserver.syncQueue.push(json(503, {}), json(503, {}));
    const sync = service({
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    sync.ensureRunning();
    sync.ensureRunning();
    await vi.waitFor(() => expect(homeserver.syncCalls.length).toBe(3));
    expect(sync.running()).toBe(true);
    // The third sync is an in-flight long-poll; stop must abort it.
    await sync.stop();
    expect(sync.running()).toBe(false);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("does not sync while another process holds the owner lock", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const heldElsewhere: BridgeSyncLock = {
      async tryAcquire() {
        attempts += 1;
        return null;
      },
    };
    const sync = service({ lock: heldElsewhere, sleep: async (ms) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, 1)); } });
    sync.ensureRunning();
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    await sync.stop();
    expect(homeserver.syncCalls).toHaveLength(0);
    expect(waits.every((ms) => ms === 30_000)).toBe(true);
  });

  it("takes and releases a Postgres advisory lock on a pinned connection", async () => {
    const lock = createPostgresAdvisoryLock(kysely);
    const handle = await lock.tryAcquire(ownerId);
    expect(handle).not.toBeNull();
    const held = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'`.execute(kysely);
    expect(held.rows[0]?.count).toBe(1);
    await handle!.release();
    const released = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'`.execute(kysely);
    expect(released.rows[0]?.count).toBe(0);
  });

  it("fills a limited timeline's gap from prev_batch back to the stored position before advancing", async () => {
    homeserver.syncQueue.push(syncResponse("s1", { join: { [portal]: {
      state: { events: portalState("whatsapp") },
      timeline: { events: [textEvent("$a", ghost, "one", "2026-11-22T10:00:00.000Z")] },
    } } }));
    const sync = service();
    await sync.syncOnce();

    // Offline for a while: the next batch keeps only the newest event and marks the timeline limited.
    homeserver.historyPages[portal] = [
      {
        chunk: [textEvent("$c", ghost, "three", "2026-11-22T10:02:00.000Z"), textEvent("$b", "@whatsapp_4915550002:" + bridgeServer, "two", "2026-11-22T10:01:00.000Z")],
        start: "t_prev",
        end: "t_older",
        state: [{ type: "m.room.member", state_key: "@whatsapp_4915550002:" + bridgeServer, content: { membership: "join", displayname: "Omid" } }],
      },
      { chunk: [], start: "t_older" },
    ];
    homeserver.syncQueue.push(syncResponse("s2", { join: { [portal]: {
      timeline: { events: [textEvent("$d", ghost, "four", "2026-11-22T10:03:00.000Z")], limited: true, prev_batch: "t_prev" },
    } } }));
    await sync.syncOnce();

    expect(homeserver.historyCalls).toEqual([
      { roomId: portal, from: "t_prev", to: "s1", dir: "b" },
      { roomId: portal, from: "t_older", to: "s1", dir: "b" },
    ]);
    const messages = (await store.listMessages(ownerId, portal, { limit: 50 })).items;
    expect(messages.map((item) => item.eventId)).toEqual(["$d", "$c", "$b", "$a"]);
    expect(messages.find((item) => item.eventId === "$b")?.senderName).toBe("Omid");
    expect((await store.listConversations(ownerId, { limit: 50 })).items[0]).toMatchObject({ lastMessagePreview: "four", unreadCount: 4 });
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s2");
  });

  it("keeps the stored position when filling the gap fails transiently", async () => {
    homeserver.syncQueue.push(syncResponse("s1", { join: { [portal]: { state: { events: portalState("whatsapp") }, timeline: { events: [] } } } }));
    const sync = service();
    await sync.syncOnce();
    homeserver.historyPages[portal] = [json(502, {})];
    homeserver.syncQueue.push(syncResponse("s2", { join: { [portal]: {
      timeline: { events: [textEvent("$d", ghost, "four", "2026-11-22T10:03:00.000Z")], limited: true, prev_batch: "t_prev" },
    } } }));
    await expect(sync.syncOnce()).rejects.toMatchObject({ retryable: true });
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s1");
    expect((await store.listMessages(ownerId, portal, { limit: 50 })).items).toEqual([]);
  });

  it("stops filling a gap at the page cap", async () => {
    homeserver.syncQueue.push(syncResponse("s1", { join: { [portal]: { state: { events: portalState("whatsapp") }, timeline: { events: [] } } } }));
    const sync = service();
    await sync.syncOnce();
    homeserver.historyPages[portal] = Array.from({ length: 12 }, (_unused, index) => ({
      chunk: [textEvent(`$h${index}`, ghost, `old ${index}`, new Date(Date.parse("2026-11-22T09:00:00.000Z") - index * 60_000).toISOString())],
      start: `t${index}`,
      end: `t${index + 1}`,
    }));
    homeserver.syncQueue.push(syncResponse("s2", { join: { [portal]: {
      timeline: { events: [], limited: true, prev_batch: "t0" },
    } } }));
    await sync.syncOnce();
    expect(homeserver.historyCalls).toHaveLength(10);
    expect((await store.listMessages(ownerId, portal, { limit: 50 })).items).toHaveLength(10);
    await expect(store.getSyncPosition(ownerId)).resolves.toBe("s2");
  });

  it("keeps a known room on its account when an incremental batch carries no receiver", async () => {
    const work = await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa_work" });
    const personal = (await store.listBridgeAccounts(ownerId)).find((account) => account.loginId === "login_wa")!;
    homeserver.syncQueue.push(syncResponse("s1", { join: { [portal]: {
      state: { events: portalState("whatsapp").map((event) => event.type === "m.bridge"
        ? { ...event, content: { ...(event.content as Record<string, unknown>), channel: { id: "4915550001", receiver: "login_wa" } } }
        : event) },
      timeline: { events: [textEvent("$a", ghost, "one", "2026-11-22T10:00:00.000Z")] },
    } } }));
    const sync = service();
    await sync.syncOnce();
    const accountOf = async () => (await kysely.selectFrom("messaging_conversations").select("account_id").where("room_id", "=", portal).executeTakeFirstOrThrow()).account_id;
    expect(await accountOf()).toBe(personal.id);

    // The work account is now the most recently updated one for WhatsApp.
    await store.setAccountHealth(ownerId, work.accountId, "connecting");
    homeserver.syncQueue.push(syncResponse("s2", { join: { [portal]: {
      timeline: { events: [textEvent("$b", ghost, "two", "2026-11-22T10:01:00.000Z")] },
    } } }));
    await sync.syncOnce();
    expect(await accountOf()).toBe(personal.id);
  });
});
