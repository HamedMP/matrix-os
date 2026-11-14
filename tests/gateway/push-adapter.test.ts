import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { createPushAdapter, PushTokenStorageUnavailableError, type PushAdapter } from "../../packages/gateway/src/channels/push.js";
import { createPushTokenStore, type PushTokenStore } from "../../packages/gateway/src/notifications/push-tokens.js";
import { bootstrapNotificationDatabase, type NotificationDatabase } from "../../packages/gateway/src/notifications/schema.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function expoOk(count = 1): Response {
  return new Response(JSON.stringify({ data: Array.from({ length: count }, (_, i) => ({ id: String(i), status: "ok" })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sentMessages(fetchSpy: ReturnType<typeof vi.spyOn>, call = 0): Array<{ to: string; title: string; body: string; data: Record<string, unknown> }> {
  return JSON.parse(fetchSpy.mock.calls[call][1]?.body as string);
}

describe("push adapter with owner Postgres tokens", () => {
  let pglite: Awaited<ReturnType<typeof createTestPGlite>>;
  let db: Kysely<NotificationDatabase>;
  let store: PushTokenStore;
  let now: number;
  const adapters: PushAdapter[] = [];

  function adapter(options: Partial<Parameters<typeof createPushAdapter>[0]> = {}): PushAdapter {
    const created = createPushAdapter({ tokens: store, now: () => now, ...options });
    adapters.push(created);
    return created;
  }

  async function storedTokens(): Promise<Array<{ token: string; owner_id: string; platform: string }>> {
    return db.selectFrom("notification_push_tokens").select(["token", "owner_id", "platform"]).orderBy("token").execute();
  }

  beforeEach(async () => {
    pglite = await createTestPGlite();
    db = new Kysely<NotificationDatabase>({ dialect: pglite.dialect });
    await bootstrapNotificationDatabase(db);
    store = createPushTokenStore(db);
    now = Date.UTC(2026, 10, 12);
  });

  afterEach(async () => {
    for (const created of adapters.splice(0)) created.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("bootstraps the token table once and records its schema version", async () => {
    expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [] });
    const versions = await db.selectFrom("notification_schema_migrations").select(["version", "name"]).execute();
    expect(versions).toEqual([{ version: 1, name: "push_tokens" }]);
  });

  it("creates the version table under the schema lock, so gateways starting together cannot race on it", async () => {
    const fresh = await createTestPGlite();
    const statements: string[] = [];
    const logged = new Kysely<NotificationDatabase>({
      dialect: fresh.dialect,
      log: (event) => { statements.push(event.query.sql.replace(/\s+/g, " ").trim()); },
    });
    try {
      expect(await bootstrapNotificationDatabase(logged)).toEqual({ applied: [1] });
    } finally {
      await logged.destroy();
    }
    const lock = statements.findIndex((statement) => statement.includes("pg_advisory_xact_lock"));
    const versionTable = statements.findIndex((statement) => statement.includes("CREATE TABLE IF NOT EXISTS notification_schema_migrations"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(versionTable).toBeGreaterThan(lock);
  });

  it("delivers to a token registered before a gateway restart", async () => {
    const beforeRestart = adapter({ handle: "alice" });
    await beforeRestart.registerToken("ExponentPushToken[before-restart]", "ios", "owner_a");
    await beforeRestart.stop();
    beforeRestart.dispose();

    // A restart is a new process: the schema bootstrap runs again and a new adapter reads the same database.
    expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [] });
    const afterRestart = adapter({ tokens: createPushTokenStore(db), handle: "alice" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());

    await afterRestart.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Agent needs approval." });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessages(fetchSpy).map((message) => message.to)).toEqual(["ExponentPushToken[before-restart]"]);
  });

  it("names this computer in every push, after the metadata so callers cannot override it", async () => {
    const push = adapter({ handle: "alice" });
    await push.registerToken("ExponentPushToken[phone]", "ios", "owner_a");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());

    await push.send({
      channelId: "push",
      chatId: "coding-agents",
      ownerId: "owner_a",
      text: "Agent needs approval.",
      metadata: { category: "agent", threadId: "thread_push_attention", handle: "mallory" },
    });
    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Done." });

    expect(sentMessages(fetchSpy, 0)[0].data).toEqual({
      category: "agent",
      threadId: "thread_push_attention",
      type: "message",
      chatId: "coding-agents",
      handle: "alice",
    });
    expect(sentMessages(fetchSpy, 1)[0].data).toEqual({ type: "message", chatId: "coding-agents", handle: "alice" });
  });

  it("leaves the handle out when MATRIX_HANDLE is unset or not a computer handle", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());
    for (const handle of [undefined, "", "Not A Handle"]) {
      const push = adapter({ handle });
      await push.registerToken("ExponentPushToken[phone]", "ios", "owner_a");
      await push.send({
        channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Done.",
        metadata: { category: "agent", handle: "mallory" },
      });
    }

    for (let call = 0; call < 3; call += 1) {
      expect(sentMessages(fetchSpy, call)[0].data).toEqual({ category: "agent", type: "message", chatId: "coding-agents" });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain("Not A Handle");
  });

  it("keeps at most 16 tokens per owner, evicting the least recently seen, without touching other owners", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[other-owner]", "ios", "owner_b");
    for (let i = 0; i < 17; i += 1) {
      now += 1_000;
      await push.registerToken(`ExponentPushToken[device-${String(i).padStart(2, "0")}]`, "ios", "owner_a");
    }

    const tokens = await storedTokens();
    expect(tokens.filter((row) => row.owner_id === "owner_a")).toHaveLength(16);
    expect(tokens.map((row) => row.token)).not.toContain("ExponentPushToken[device-00]");
    expect(tokens.map((row) => row.token)).toContain("ExponentPushToken[device-16]");
    expect(tokens).toContainEqual({ token: "ExponentPushToken[other-owner]", owner_id: "owner_b", platform: "ios" });
  });

  it("refreshes a re-registered token instead of evicting it as the oldest", async () => {
    const push = adapter({ maxRegisteredTokens: 2 });
    await push.registerToken("ExponentPushToken[first]", "ios", "owner_a");
    now += 1_000;
    await push.registerToken("ExponentPushToken[second]", "ios", "owner_a");
    now += 1_000;
    await push.registerToken("ExponentPushToken[first]", "android", "owner_a");
    now += 1_000;
    await push.registerToken("ExponentPushToken[third]", "ios", "owner_a");

    expect(await storedTokens()).toEqual([
      { token: "ExponentPushToken[first]", owner_id: "owner_a", platform: "android" },
      { token: "ExponentPushToken[third]", owner_id: "owner_a", platform: "ios" },
    ]);
  });

  it("moves a token to the owner who registered it last, and only that owner can remove it", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[shared]", "ios", "owner_a");
    await push.registerToken("ExponentPushToken[shared]", "ios", "owner_b");
    expect(await storedTokens()).toEqual([{ token: "ExponentPushToken[shared]", owner_id: "owner_b", platform: "ios" }]);

    await push.removeToken("ExponentPushToken[shared]", "owner_a");
    expect(await storedTokens()).toHaveLength(1);
    await push.removeToken("ExponentPushToken[shared]", "owner_b");
    expect(await storedTokens()).toEqual([]);
  });

  it("holds the cap and one row per token under concurrent registration", async () => {
    const push = adapter();
    await Promise.all([
      ...Array.from({ length: 24 }, (_, i) => push.registerToken(`ExponentPushToken[burst-${i}]`, "ios", "owner_a")),
      ...Array.from({ length: 8 }, () => push.registerToken("ExponentPushToken[repeat]", "android", "owner_c")),
    ]);

    const tokens = await storedTokens();
    expect(tokens.filter((row) => row.owner_id === "owner_a")).toHaveLength(16);
    expect(tokens.filter((row) => row.token === "ExponentPushToken[repeat]")).toHaveLength(1);
  });

  it("does not push to tokens unseen for 30 days", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[stale]", "ios", "owner_a");
    now += 2 * DAY_MS;
    await push.registerToken("ExponentPushToken[fresh]", "ios", "owner_a");
    now += 29 * DAY_MS;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());

    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Done." });

    expect(sentMessages(fetchSpy).map((message) => message.to)).toEqual(["ExponentPushToken[fresh]"]);
  });

  it("sweeps tokens unseen for 30 days every hour and stops sweeping once disposed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sweep = vi.spyOn(store, "deleteUnseenBefore");
    const push = adapter();
    await push.registerToken("ExponentPushToken[stale]", "ios", "owner_a");
    now += 2 * DAY_MS;
    await push.registerToken("ExponentPushToken[fresh]", "ios", "owner_a");
    now += 29 * DAY_MS;

    vi.advanceTimersByTime(HOUR_MS);
    await vi.waitFor(async () => expect((await storedTokens()).map((row) => row.token)).toEqual(["ExponentPushToken[fresh]"]));
    expect(sweep).toHaveBeenCalledWith(new Date(now - 30 * DAY_MS));

    push.dispose();
    vi.advanceTimersByTime(3 * HOUR_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("keeps stored tokens when the channel stops", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[phone]", "ios", "owner_a");
    await push.stop();
    expect(await storedTokens()).toHaveLength(1);
  });

  it("deletes a token Expo reports as DeviceNotRegistered", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[gone]", "ios", "owner_a");
    now += 1_000;
    await push.registerToken("ExponentPushToken[alive]", "ios", "owner_a");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [
        { id: "1", status: "ok" },
        { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Done." });

    expect((await storedTokens()).map((row) => row.token)).toEqual(["ExponentPushToken[alive]"]);
  });

  it("sends owner-scoped pushes only to that owner's newest tokens, within the fanout cap", async () => {
    const push = adapter({ maxFanoutTokens: 2 });
    for (const token of ["one", "two", "three"]) {
      now += 1_000;
      await push.registerToken(`ExponentPushToken[${token}]`, "ios", "owner_a");
    }
    await push.registerToken("ExponentPushToken[other-owner]", "ios", "owner_b");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk(2));

    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Done." });

    expect(sentMessages(fetchSpy).map((message) => message.to)).toEqual(["ExponentPushToken[three]", "ExponentPushToken[two]"]);
  });

  it("sends a push that names no owner only to this computer owner's tokens", async () => {
    const push = adapter({ ownerId: "owner_a" });
    await push.registerToken("ExponentPushToken[owner-a]", "ios", "owner_a");
    await push.registerToken("ExponentPushToken[owner-b]", "ios", "owner_b");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());

    await push.send({ channelId: "push", chatId: "daily-summary", text: "Your daily summary is ready." });

    expect(sentMessages(fetchSpy).map((message) => message.to)).toEqual(["ExponentPushToken[owner-a]"]);
  });

  it.each([
    ["is not configured", undefined],
    ["is not a valid user id", "owner a/../b"],
  ])("sends a push that names no owner to nobody when this computer's owner %s", async (_case, ownerId) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const push = adapter({ ownerId });
    await push.registerToken("ExponentPushToken[owner-a]", "ios", "owner_a");
    await push.registerToken("ExponentPushToken[owner-b]", "ios", "owner_b");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await push.send({ channelId: "push", chatId: "daily-summary", text: "Your daily summary is ready." });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("names no owner"));
  });

  it("calls the Expo Push API with a timeout and truncates long bodies", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[test]", "ios", "owner_a");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());

    await push.send({ channelId: "push", chatId: "chat1", ownerId: "owner_a", text: "x".repeat(300) });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const [message] = sentMessages(fetchSpy);
    expect(message.title).toBe("Matrix OS");
    expect(message.body.length).toBeLessThanOrEqual(200);
    expect(message.body.endsWith("...")).toBe(true);
  });

  it("drops unsafe reply metadata before calling the Expo Push API", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[test]", "ios", "owner_a");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());

    await push.send({
      channelId: "push",
      chatId: "coding-agents",
      ownerId: "owner_a",
      text: "Agent needs approval.",
      metadata: { category: "agent", unsafe: "/home/matrix/secret".repeat(20), nested: { raw: "value" }, "bad key": "value" },
    });

    expect(sentMessages(fetchSpy)[0].data).toEqual({ chatId: "coding-agents", type: "message" });
  });

  it("does not call Expo when the owner has no tokens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await adapter().send({ channelId: "push", chatId: "test", ownerId: "owner_a", text: "Hello" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the injected clock for push rate limiting", async () => {
    const push = adapter();
    await push.registerToken("ExponentPushToken[owner-a]", "ios", "owner_a");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => expoOk());
    const reply = { channelId: "push" as const, chatId: "coding-agents", ownerId: "owner_a", text: "Agent needs approval." };

    for (let i = 0; i < 31; i += 1) await push.send(reply);
    expect(fetchSpy).toHaveBeenCalledTimes(30);

    now += 60_001;
    await push.send(reply);
    expect(fetchSpy).toHaveBeenCalledTimes(31);
  });

  it("treats a missing owner database as misconfiguration, not as having no tokens", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const push = adapter({ tokens: null });

    await expect(push.registerToken("ExponentPushToken[phone]", "ios", "owner_a")).rejects.toBeInstanceOf(PushTokenStorageUnavailableError);
    await expect(push.removeToken("ExponentPushToken[phone]", "owner_a")).rejects.toBeInstanceOf(PushTokenStorageUnavailableError);
    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Done." });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Owner database unavailable"));
  });
});
