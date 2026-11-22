import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {
  MessagingBridgeConversationsResponseSchema,
  MessagingBridgeErrorSchema,
  MessagingBridgeLinkProgressSchema,
  MessagingBridgeMessageSchema,
  MessagingBridgeMessagesResponseSchema,
  MessagingBridgeStatusSchema,
  type MessagingBridgeChangedEvent,
} from "@matrix-os/contracts/messaging-bridge";
import { MessagingKyselyRepository } from "../../../packages/gateway/src/messages/repository.js";
import { MessagingBridgeStore, type MessagingBridgeDatabase } from "../../../packages/gateway/src/messages/bridge-store.js";
import { createMessagingBridgePlatformClient } from "../../../packages/gateway/src/messages/bridge-platform-client.js";
import { createBridgeMatrixClient } from "../../../packages/gateway/src/messages/bridge-matrix-client.js";
import { createBridgeSessionProvider } from "../../../packages/gateway/src/messages/bridge-session.js";
import { createBridgeSyncService, type BridgeSyncLock } from "../../../packages/gateway/src/messages/bridge-sync.js";
import { createMessagingBridgeService, type MessagingBridgeService } from "../../../packages/gateway/src/messages/bridge-service.js";
import { createMessagingBridgeRoutes } from "../../../packages/gateway/src/messages/bridge-routes.js";
import { BridgeLinkSessions } from "../../../packages/gateway/src/messages/bridge-link-sessions.js";
import { bridgeServer, bridgeSession, fakeHomeserver, json, memorySessionStore } from "./bridge-fixtures.js";

const ownerId = "user_owner";
const intruder = "user_intruder";
const room = `!portal:${bridgeServer}`;
const base = "/api/messages/bridge";
const machineToken = "f".repeat(64);
const secretFieldValue = "hunter2-very-secret";

type PlatformReply = { status: number; body: unknown };

/** Fake platform behind the real platform client: per-route reply queues and recorded calls. */
function fakePlatform() {
  const replies = new Map<string, PlatformReply[]>();
  const calls: Array<{ route: string; body: unknown; headers: Headers }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === bridgeServer) return homeserver.fetchImpl(input, init);
    const route = `${init.method ?? "GET"} ${url.pathname.replace("/internal/messaging-bridge", "")}`;
    calls.push({ route, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) });
    const queue = replies.get(route) ?? [];
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (!reply) return json(404, { error: { code: "not_found", message: "Not found" } });
    return json(reply.status, reply.body);
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
    reply(route: string, ...queue: PlatformReply[]) {
      replies.set(route, queue);
    },
  };
}

let homeserver: ReturnType<typeof fakeHomeserver>;

const freeLock: BridgeSyncLock = {
  async tryAcquire() {
    return { lost: new AbortController().signal, release: async () => {} };
  },
};

describe("messaging bridge owner routes", () => {
  let kysely: Kysely<MessagingBridgeDatabase>;
  let store: MessagingBridgeStore;
  let platform: ReturnType<typeof fakePlatform>;
  let events: Array<{ ownerId: string; event: MessagingBridgeChangedEvent }>;
  let clock: number;
  let service: MessagingBridgeService;
  let app: Hono;
  let principal: string;
  let logs: string[];

  beforeEach(async () => {
    const pglite = await KyselyPGlite.create();
    kysely = new Kysely<MessagingBridgeDatabase>({ dialect: pglite.dialect });
    await new MessagingKyselyRepository(kysely as never).bootstrap();
    store = new MessagingBridgeStore(kysely);
    await store.bootstrap();
    homeserver = fakeHomeserver();
    platform = fakePlatform();
    platform.reply("POST /session", { status: 200, body: bridgeSession() });
    events = [];
    clock = Date.parse("2026-11-22T10:00:00.000Z");
    principal = ownerId;
    logs = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    service = buildService();
    app = mount(service);
  });

  afterEach(async () => {
    await service.close();
    await kysely.destroy();
    vi.restoreAllMocks();
  });

  function buildService(): MessagingBridgeService {
    const platformClient = createMessagingBridgePlatformClient({
      platformUrl: "http://platform:9000",
      machineToken,
      handle: "owner",
      fetchImpl: platform.fetchImpl,
    });
    const sessions = createBridgeSessionProvider({ ownerId, store: memorySessionStore(), platform: platformClient });
    const matrix = createBridgeMatrixClient({ fetchImpl: platform.fetchImpl });
    const sync = createBridgeSyncService({ ownerId, store, sessions, matrix, lock: freeLock, onChanged: () => {} });
    return createMessagingBridgeService({
      ownerId,
      platform: platformClient,
      store,
      sessions,
      matrix,
      sync,
      broadcast: (target, event) => events.push({ ownerId: target, event }),
      now: () => clock,
    });
  }

  function mount(bridge: MessagingBridgeService | null): Hono {
    const root = new Hono();
    root.route(base, createMessagingBridgeRoutes({ getOwnerId: () => principal, service: bridge }));
    return root;
  }

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(`${base}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() as unknown };
  }

  async function seedConversation(): Promise<void> {
    const { accountId } = await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa" });
    await store.applySyncBatch({
      ownerId,
      previousBatch: null,
      nextBatch: "s1",
      conversations: [{ roomId: room, network: "whatsapp", accountId, displayName: "Sara" }],
      messages: [{ roomId: room, eventId: "$in1", direction: "incoming", senderName: "Sara", kind: "text", body: "hi", occurredAt: "2026-11-22T09:00:00.000Z" }],
    });
  }

  it("reports unavailable status and 503 misconfigured when dependencies are missing", async () => {
    app = mount(null);
    const status = await call("GET", "/status");
    expect(status).toEqual({ status: 200, body: { availability: "unavailable", networks: [] } });
    MessagingBridgeStatusSchema.parse(status.body);
    for (const [method, path, body] of [
      ["POST", "/whatsapp/link", {}],
      ["GET", "/conversations", undefined],
      ["POST", `/conversations/${encodeURIComponent(room)}/send`, { body: "x", clientTxnId: "txn_00000001" }],
      ["DELETE", "/whatsapp/accounts/acct_0123456789abcdef0123456789abcdef", undefined],
    ] as const) {
      const res = await call(method, path, body);
      expect(res).toEqual({ status: 503, body: { error: { code: "misconfigured", message: "Messaging is not configured" } } });
    }
  });

  it("reports not_enabled when the platform refuses the owner", async () => {
    platform.reply("POST /session", { status: 403, body: { error: { code: "not_enabled", message: "Not enabled" } } });
    platform.reply("POST /whatsapp/login/start", { status: 403, body: { error: { code: "not_enabled", message: "Not enabled" } } });

    expect(await call("GET", "/status")).toEqual({ status: 200, body: { availability: "not_enabled", networks: [] } });
    const link = await call("POST", "/whatsapp/link", {});
    expect(link.status).toBe(403);
    expect(MessagingBridgeErrorSchema.parse(link.body).error.code).toBe("not_enabled");
  });

  it("authenticates platform calls with the machine credential and reconciles logins into status", async () => {
    platform.reply("GET /whatsapp/logins", { status: 200, body: { logins: [{ loginId: "login_wa", displayName: "Phone", state: "connected" }] } });
    platform.reply("GET /telegram/logins", { status: 200, body: { logins: [] } });
    platform.reply("GET /linkedin/logins", { status: 200, body: { logins: [] } });

    const status = await call("GET", "/status");

    expect(status.status).toBe(200);
    const parsed = MessagingBridgeStatusSchema.parse(status.body);
    expect(parsed.availability).toBe("ready");
    expect(parsed.networks.find((entry) => entry.network === "whatsapp")?.accounts).toEqual([
      { accountId: expect.stringMatching(/^acct_/), displayName: "Phone", state: "connected" },
    ]);
    for (const recorded of platform.calls) {
      expect(recorded.headers.get("authorization")).toBe(`Bearer ${machineToken}`);
      expect(recorded.headers.get("x-matrix-handle")).toBe("owner");
    }
    expect(JSON.stringify(status.body)).not.toContain("syt_");
  });

  it("links WhatsApp through a long-polled QR step and starts sync", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const qr = { type: "display_and_wait", stepId: "fi.mau.whatsapp.qr", display: { kind: "qr", data: "2@first" } };
    platform.reply("POST /whatsapp/login/start", { status: 200, body: { loginProcessId: "proc_wa", step: qr } });
    platform.reply("POST /whatsapp/login/step",
      { status: 200, body: { loginProcessId: "proc_wa", step: { ...qr, display: { kind: "qr", data: "2@refreshed" } } } },
      { status: 200, body: { loginProcessId: "proc_wa", step: { type: "complete", loginId: "login_wa", displayName: "My phone" } } });

    const started = await call("POST", "/whatsapp/link", {});
    const progress = MessagingBridgeLinkProgressSchema.parse(started.body);
    expect(progress.step).toEqual(qr);

    const refreshed = MessagingBridgeLinkProgressSchema.parse((await call("POST", `/whatsapp/link/${progress.linkId}/step`, { stepId: qr.stepId })).body);
    expect(refreshed.step).toMatchObject({ type: "display_and_wait", display: { data: "2@refreshed" } });
    const done = MessagingBridgeLinkProgressSchema.parse((await call("POST", `/whatsapp/link/${progress.linkId}/step`, { stepId: qr.stepId })).body);
    expect(done.step).toEqual({ type: "complete", loginId: "login_wa", displayName: "My phone" });

    expect(platform.calls.filter((entry) => entry.route === "POST /whatsapp/login/step").map((entry) => entry.body)).toEqual([
      { loginProcessId: "proc_wa", stepId: qr.stepId },
      { loginProcessId: "proc_wa", stepId: qr.stepId },
    ]);
    expect(timeoutSpy.mock.calls.filter((args) => args[0] === 35_000).length).toBeGreaterThanOrEqual(2);
    await expect(store.listBridgeAccounts(ownerId)).resolves.toEqual([
      expect.objectContaining({ network: "whatsapp", loginId: "login_wa", displayName: "My phone", status: "connected" }),
    ]);
    expect(events.map((entry) => entry.event.scope)).toContain("accounts");
    await vi.waitFor(() => expect(homeserver.syncCalls.length).toBe(1));
    // A completed link cannot be stepped again.
    expect((await call("POST", `/whatsapp/link/${progress.linkId}/step`, { stepId: qr.stepId })).status).toBe(404);
  });

  it("links Telegram through phone, code and password inputs without logging field values", async () => {
    const phone = { type: "user_input", stepId: "tg.phone", fields: [{ id: "phone", label: "Phone number", kind: "phone", required: true }] };
    const code = { type: "user_input", stepId: "tg.code", fields: [{ id: "code", label: "Code", kind: "code", required: true }] };
    const password = { type: "user_input", stepId: "tg.password", fields: [{ id: "password", label: "Password", kind: "secret", required: true }] };
    platform.reply("POST /telegram/login/start", { status: 200, body: { loginProcessId: "proc_tg", step: phone } });
    platform.reply("POST /telegram/login/step",
      { status: 200, body: { loginProcessId: "proc_tg", step: code } },
      { status: 200, body: { loginProcessId: "proc_tg", step: password } },
      { status: 200, body: { loginProcessId: "proc_tg", step: { type: "complete", loginId: "login_tg" } } });

    const { linkId } = MessagingBridgeLinkProgressSchema.parse((await call("POST", "/telegram/link", { flowId: "phone" })).body);
    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.phone", fields: { phone: "+15550001" } })).body).toMatchObject({ step: { stepId: "tg.code" } });
    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.code", fields: { code: "12345" } })).body).toMatchObject({ step: { stepId: "tg.password" } });
    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.password", fields: { password: secretFieldValue } })).body).toMatchObject({ step: { type: "complete" } });

    const stepBodies = platform.calls.filter((entry) => entry.route === "POST /telegram/login/step").map((entry) => entry.body);
    expect(stepBodies).toEqual([
      { loginProcessId: "proc_tg", stepId: "tg.phone", fields: { phone: "+15550001" } },
      { loginProcessId: "proc_tg", stepId: "tg.code", fields: { code: "12345" } },
      { loginProcessId: "proc_tg", stepId: "tg.password", fields: { password: secretFieldValue } },
    ]);
    expect(platform.calls.find((entry) => entry.route === "POST /telegram/login/start")?.body).toEqual({ flowId: "phone" });
    expect(logs.join("\n")).not.toMatch(/hunter2|\+15550001|syt_/);
    const audit = await kysely.selectFrom("messaging_audit_events").selectAll().execute();
    expect(JSON.stringify(audit)).not.toMatch(/hunter2|\+15550001/);
  });

  it("rejects stale, unknown, foreign and expired link attempts", async () => {
    const phone = { type: "user_input", stepId: "tg.phone", fields: [{ id: "phone", label: "Phone", kind: "phone", required: true }] };
    platform.reply("POST /telegram/login/start", { status: 200, body: { loginProcessId: "proc_tg", step: phone } });
    platform.reply("POST /telegram/login/step", { status: 500, body: { error: { code: "internal", message: `bridge said ${secretFieldValue}` } } });
    const { linkId } = MessagingBridgeLinkProgressSchema.parse((await call("POST", "/telegram/link", {})).body);

    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.code", fields: {} })).status).toBe(409);
    expect((await call("POST", `/whatsapp/link/${linkId}/step`, { stepId: "tg.phone" })).status).toBe(404);
    expect((await call("POST", "/telegram/link/link_00000000000000000000000000000000/step", { stepId: "tg.phone" })).status).toBe(404);
    expect((await call("POST", "/telegram/link/not-a-link/step", { stepId: "tg.phone" })).status).toBe(400);

    const failing = await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.phone", fields: { phone: secretFieldValue } });
    expect(failing.status).toBe(503);
    expect(JSON.stringify(failing.body)).not.toContain(secretFieldValue);

    principal = intruder;
    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.phone" })).status).toBe(403);
    principal = ownerId;

    clock += 10 * 60 * 1000 + 1;
    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.phone" })).body).toEqual({
      linkId, network: "telegram", step: { type: "failed", reason: "expired" },
    });
    expect((await call("POST", `/telegram/link/${linkId}/step`, { stepId: "tg.phone" })).status).toBe(404);
    await expect(store.listBridgeAccounts(ownerId)).resolves.toEqual([]);
  });

  it("never resolves another owner's link session", () => {
    const sessions = new BridgeLinkSessions(() => clock);
    const link = sessions.create(ownerId, "whatsapp", "proc", { type: "display_and_wait", stepId: "s", display: { kind: "qr", data: "x" } });
    expect(sessions.get(intruder, link.linkId)).toBeNull();
    expect(sessions.get(ownerId, link.linkId)).toBe(link);
    for (let index = 0; index < 20; index += 1) sessions.create(ownerId, "whatsapp", `proc${index}`, { type: "failed", reason: "unknown" });
    expect(sessions.size()).toBe(16);
  });

  it("cancels a link attempt at the bridge, idempotently and only for its owner", async () => {
    const qr = { type: "display_and_wait", stepId: "fi.mau.whatsapp.qr", display: { kind: "qr", data: "2@x" } };
    platform.reply("POST /whatsapp/login/start", { status: 200, body: { loginProcessId: "proc_cancel", step: qr } });
    platform.reply("POST /whatsapp/login/cancel", { status: 200, body: { ok: true } });
    const { linkId } = MessagingBridgeLinkProgressSchema.parse((await call("POST", "/whatsapp/link", {})).body);

    principal = intruder;
    expect((await call("POST", `/whatsapp/link/${linkId}/cancel`)).status).toBe(403);
    principal = ownerId;
    expect(await call("POST", `/whatsapp/link/${linkId}/cancel`)).toEqual({ status: 200, body: { ok: true } });
    expect(await call("POST", `/whatsapp/link/${linkId}/cancel`)).toEqual({ status: 200, body: { ok: true } });
    expect(platform.calls.filter((entry) => entry.route === "POST /whatsapp/login/cancel").map((entry) => entry.body)).toEqual([
      { loginProcessId: "proc_cancel" },
    ]);
    expect((await call("POST", `/whatsapp/link/${linkId}/step`, { stepId: qr.stepId })).status).toBe(404);
  });

  it("accepts cookie-sized login values on the step route", async () => {
    const cookie = { type: "user_input", stepId: "li.cookies", fields: [{ id: "cookie", label: "Cookie", kind: "secret", required: true }] };
    platform.reply("POST /linkedin/login/start", { status: 200, body: { loginProcessId: "proc_li", step: cookie } });
    platform.reply("POST /linkedin/login/step", { status: 200, body: { loginProcessId: "proc_li", step: { type: "complete", loginId: "login_li" } } });
    const { linkId } = MessagingBridgeLinkProgressSchema.parse((await call("POST", "/linkedin/link", {})).body);
    const value = "c".repeat(16_000);
    const res = await call("POST", `/linkedin/link/${linkId}/step`, { stepId: "li.cookies", fields: { cookie: value, extra: value, more: value, again: value, last: value } });
    expect(res.body).toMatchObject({ step: { type: "complete" } });
    expect(logs.join("\n")).not.toContain("cccccccc");
  });

  it("creates the owner's homeserver session before the first link starts", async () => {
    platform.reply("POST /whatsapp/login/start", { status: 200, body: { loginProcessId: "proc_first", step: { type: "failed", reason: "rejected" } } });

    expect((await call("POST", "/whatsapp/link", {})).status).toBe(200);
    expect((await call("POST", "/whatsapp/link", {})).status).toBe(200);

    expect(platform.calls.map((entry) => entry.route)).toEqual(["POST /session", "POST /whatsapp/login/start", "POST /whatsapp/login/start"]);
  });

  it("does not start a login when the session cannot be created", async () => {
    platform.reply("POST /session", { status: 503, body: { error: { code: "misconfigured", message: "Messaging is not configured" } } });

    expect((await call("POST", "/whatsapp/link", {})).status).toBe(503);
    expect(platform.calls.map((entry) => entry.route)).toEqual(["POST /session"]);
  });

  it("cancels abandoned logins at the bridge when they expire or are evicted", async () => {
    const qr = { type: "display_and_wait", stepId: "fi.mau.whatsapp.qr", display: { kind: "qr", data: "2@x" } };
    platform.reply("POST /whatsapp/login/start", { status: 200, body: { loginProcessId: "proc_old", step: qr } });
    platform.reply("POST /whatsapp/login/cancel", { status: 200, body: { ok: true } });
    await call("POST", "/whatsapp/link", {});

    clock += 10 * 60 * 1000 + 1;
    service.sweep();
    await vi.waitFor(() => expect(platform.calls.filter((entry) => entry.route === "POST /whatsapp/login/cancel").map((entry) => entry.body))
      .toEqual([{ loginProcessId: "proc_old" }]));

    const sessions = new BridgeLinkSessions(() => clock, (dropped) => evicted.push(dropped.loginProcessId));
    const evicted: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      sessions.create(ownerId, "whatsapp", `proc_${index}`, qr as never);
    }
    expect(evicted).toEqual(["proc_0"]);
    const kept = sessions.create(intruder, "whatsapp", "proc_other", qr as never);
    sessions.delete(kept.linkId);
    expect(evicted).toEqual(["proc_0"]);
  });

  it("bounds the step route to 12 cookie-sized fields", async () => {
    const cookie = { type: "user_input", stepId: "li.cookies", fields: [{ id: "cookie", label: "Cookie", kind: "secret", required: true }] };
    platform.reply("POST /linkedin/login/start", { status: 200, body: { loginProcessId: "proc_li", step: cookie } });
    const { linkId } = MessagingBridgeLinkProgressSchema.parse((await call("POST", "/linkedin/link", {})).body);
    const value = "v".repeat(16_384);

    const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field_${index}`, value]));
    const thirteen = { ...twelve, field_12: "x" };
    expect((await call("POST", `/linkedin/link/${linkId}/step`, { stepId: "li.cookies", fields: thirteen })).status).toBe(400);
    const oversized = { ...twelve, field_0: "v".repeat(16_385) };
    expect((await call("POST", `/linkedin/link/${linkId}/step`, { stepId: "li.cookies", fields: oversized })).status).toBe(400);
    const padded = JSON.stringify({ stepId: "li.cookies", fields: twelve, padding: "p".repeat(64 * 1024) });
    expect((await call("POST", `/linkedin/link/${linkId}/step`, padded)).status).toBe(413);
    expect(logs.join("\n")).not.toContain("vvvvvvvv");
  });

  it("limits link starts to 5 per owner per 10 minutes", async () => {
    platform.reply("POST /whatsapp/login/start", { status: 200, body: { loginProcessId: "proc", step: { type: "failed", reason: "rejected" } } });
    for (let index = 0; index < 5; index += 1) expect((await call("POST", "/whatsapp/link", {})).status).toBe(200);
    expect((await call("POST", "/whatsapp/link", {})).status).toBe(429);
    clock += 10 * 60 * 1000 + 1;
    expect((await call("POST", "/whatsapp/link", {})).status).toBe(200);
  });

  it("unlinks only after the platform logs the account out", async () => {
    const { accountId } = await store.recordLinkedAccount({ ownerId, network: "whatsapp", loginId: "login_wa" });
    platform.reply("POST /whatsapp/logout", { status: 503, body: { error: { code: "bridge_unavailable", message: "down" } } });

    expect((await call("DELETE", `/whatsapp/accounts/${accountId}`)).status).toBe(503);
    await expect(store.listBridgeAccounts(ownerId)).resolves.toHaveLength(1);

    principal = intruder;
    expect((await call("DELETE", `/whatsapp/accounts/${accountId}`)).status).toBe(403);
    principal = ownerId;
    expect((await call("DELETE", `/telegram/accounts/${accountId}`)).status).toBe(404);

    platform.reply("POST /whatsapp/logout", { status: 200, body: { ok: true } });
    expect(await call("DELETE", `/whatsapp/accounts/${accountId}`)).toEqual({ status: 200, body: { ok: true } });
    expect(platform.calls.filter((entry) => entry.route === "POST /whatsapp/logout").map((entry) => entry.body)).toEqual([
      { loginId: "login_wa" }, { loginId: "login_wa" },
    ]);
    await expect(store.listBridgeAccounts(ownerId)).resolves.toEqual([]);
    expect(events.at(-1)?.event).toMatchObject({ type: "messages:changed", scope: "accounts" });
    // Removing it again finds nothing and does not call the platform a third time.
    expect((await call("DELETE", `/whatsapp/accounts/${accountId}`)).status).toBe(404);
    expect(platform.calls.filter((entry) => entry.route === "POST /whatsapp/logout")).toHaveLength(2);
    expect((await call("DELETE", "/whatsapp/accounts/not-an-account")).status).toBe(400);
    const withHeader = await app.request(`${base}/whatsapp/accounts/${accountId}`, { method: "DELETE", headers: { "content-type": "application/json" } });
    expect(withHeader.status).toBe(404);

    const tooBig = await app.request(`${base}/whatsapp/accounts/${accountId}`, { method: "DELETE", body: "x".repeat(4096) });
    expect(tooBig.status).toBe(413);
  });

  it("lists conversations and messages newest first, owner-scoped, and marks the room read", async () => {
    await seedConversation();

    const conversations = MessagingBridgeConversationsResponseSchema.parse((await call("GET", "/conversations?network=whatsapp")).body);
    expect(conversations.items).toEqual([expect.objectContaining({ roomId: room, unreadCount: 1, lastMessagePreview: "hi" })]);
    expect((await call("GET", "/conversations?limit=500")).status).toBe(400);
    expect((await call("GET", "/conversations?network=signal")).status).toBe(400);

    const messages = MessagingBridgeMessagesResponseSchema.parse((await call("GET", `/conversations/${encodeURIComponent(room)}/messages`)).body);
    expect(messages.items.map((item) => item.eventId)).toEqual(["$in1"]);
    expect((await store.listConversations(ownerId, { limit: 10 })).items[0]?.unreadCount).toBe(0);
    expect((await call("GET", `/conversations/${encodeURIComponent(`!other:${bridgeServer}`)}/messages`)).status).toBe(404);

    principal = intruder;
    expect((await call("GET", `/conversations/${encodeURIComponent(room)}/messages`)).status).toBe(403);
    expect((await call("GET", "/conversations")).status).toBe(403);
  });

  it("sends once per clientTxnId even when retried", async () => {
    await seedConversation();
    const path = `/conversations/${encodeURIComponent(room)}/send`;

    const first = await call("POST", path, { body: "on my way", clientTxnId: "txn_abcdef01" });
    const message = MessagingBridgeMessageSchema.parse(first.body);
    expect(message).toMatchObject({ eventId: "$sent1", direction: "outgoing", delivery: "sent", body: "on my way" });
    const retry = await call("POST", path, { body: "on my way", clientTxnId: "txn_abcdef01" });
    expect(retry.body).toEqual(first.body);
    expect(homeserver.sent).toEqual([{ roomId: room, txnId: "txn_abcdef01", body: { msgtype: "m.text", body: "on my way" }, token: "syt_owner_secret_token_1" }]);
    expect((await store.listMessages(ownerId, room, { limit: 10 })).items.filter((item) => item.direction === "outgoing")).toHaveLength(1);
    expect(events.some((entry) => entry.event.scope === "messages" && entry.event.roomId === room)).toBe(true);
  });

  it("keeps a failed send failed, and a retry reuses the same transaction id", async () => {
    await seedConversation();
    const path = `/conversations/${encodeURIComponent(room)}/send`;
    homeserver.onSend(() => json(502, {}));

    const failed = await call("POST", path, { body: "are you there?", clientTxnId: "txn_fail0001" });
    expect(failed.status).toBe(200);
    expect(MessagingBridgeMessageSchema.parse(failed.body)).toMatchObject({ delivery: "failed", body: "are you there?", clientTxnId: "txn_fail0001" });
    expect(failed.body).not.toHaveProperty("eventId");
    expect((await store.listMessages(ownerId, room, { limit: 10 })).items[0]).toMatchObject({ delivery: "failed" });

    homeserver.onSend(null);
    const retried = MessagingBridgeMessageSchema.parse((await call("POST", path, { body: "are you there?", clientTxnId: "txn_fail0001" })).body);
    expect(retried).toMatchObject({ delivery: "sent", eventId: "$sent1", clientTxnId: "txn_fail0001" });
    expect(homeserver.sent.map((entry) => entry.txnId)).toEqual(["txn_fail0001", "txn_fail0001"]);
  });

  it("rejects sends to unknown or foreign rooms and enforces send limits and body limits", async () => {
    await seedConversation();
    expect((await call("POST", `/conversations/${encodeURIComponent(`!nope:${bridgeServer}`)}/send`, { body: "x", clientTxnId: "txn_00000001" })).status).toBe(404);
    expect((await call("POST", `/conversations/${encodeURIComponent(room)}/send`, { body: "   ", clientTxnId: "txn_00000002" })).status).toBe(400);
    expect((await call("POST", `/conversations/${encodeURIComponent(room)}/send`, "{not json")).status).toBe(400);
    const huge = await call("POST", `/conversations/${encodeURIComponent(room)}/send`, { body: "x".repeat(70 * 1024), clientTxnId: "txn_00000003" });
    expect(huge.status).toBe(413);

    principal = intruder;
    expect((await call("POST", `/conversations/${encodeURIComponent(room)}/send`, { body: "x", clientTxnId: "txn_00000004" })).status).toBe(403);
    principal = ownerId;

    const path = `/conversations/${encodeURIComponent(room)}/send`;
    // Two sends were already counted (unknown room, empty body is rejected before the limiter).
    let accepted = 1;
    while (accepted < 30) {
      expect((await call("POST", path, { body: `m${accepted}`, clientTxnId: `txn_limit_${String(accepted).padStart(3, "0")}` })).status).toBe(200);
      accepted += 1;
    }
    expect((await call("POST", path, { body: "one too many", clientTxnId: "txn_limit_999" })).status).toBe(429);
    clock += 60_001;
    expect((await call("POST", path, { body: "later", clientTxnId: "txn_limit_1000" })).status).toBe(200);
    expect(logs.join("\n")).not.toContain("syt_");
  });
});
