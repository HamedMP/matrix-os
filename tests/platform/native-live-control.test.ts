import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { buildPlatformSpeechRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createNativeLiveControl } from "../../packages/platform/src/native-live/control.js";
import { registerPlatformWebSocketUpgradeHandler } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { createApp } from "../../packages/platform/src/main.js";
import { stubOrchestrator } from "./proxy-routing-test-utils.js";

const env = { MATRIX_PLATFORM_LIVE_ENABLED: "true", MATRIX_PLATFORM_LIVE_POLICY_REVISION: "live-1", MATRIX_PLATFORM_LIVE_ALLOWED_HANDLES: "alice", GEMINI_API_KEY: "platform-only-test-key" };
const secret = "platform-secret";
const bearer = buildPlatformSpeechRuntimeVerificationToken({ handle: "alice", machineId: "machine_alice", runtimeSlot: "alice-test" }, secret);
const cleanups: Array<() => Promise<void>> = [];
let db: PlatformDB;
beforeEach(async () => {
  ({ db } = await createTestPlatformDb());
  await insertUserMachine(db, { machineId: "machine_alice", clerkUserId: "user_alice", handle: "alice", runtimeSlot: "alice-test",
    status: "running", imageVersion: "v1", activationState: "authorized", provisionedAt: new Date().toISOString() });
});
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await destroyTestPlatformDb(db); });
describe("platform paid Live boundary", () => {
  it("leaves unrelated WebSockets to their existing handler even during shutdown", async () => {
    const control = createNativeLiveControl({ db, env, platformSecret: secret, entitled: async () => true });
    await control.shutdown();
    const end = vi.fn();
    expect(await control.handleUpgrade({ url: "/ws/chats/chat_one" } as IncomingMessage, { end } as unknown as Socket, Buffer.alloc(0))).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });
  it("requires the exact current machine/runtime credential and exposes no provider secret", async () => {
    const control = createNativeLiveControl({ db, env, platformSecret: secret, entitled: async () => true });
    cleanups.push(() => control.shutdown());
    const request = (token: string, slot = "alice-test") => control.routes.request(`/internal/containers/alice/native-live/capabilities?runtimeSlot=${slot}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await request("bad")).status).toBe(401);
    expect((await request(bearer, "primary")).status).toBe(401);
    const response = await request(bearer);
    expect(await response.json()).toEqual({ available: true, ownerId: "user_alice", maximumSessionMs: 1_800_000 });
    await db.executor.updateTable("user_machines").set({ runtime_token_epoch: 2 }).where("handle", "=", "alice").execute();
    expect((await request(bearer)).status).toBe(401);
  });
  it("reaches the authenticated Live route through the real platform app before tenant routing", async () => {
    const control = createNativeLiveControl({ db, env, platformSecret: secret, entitled: async () => true });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret, internalNativeLiveRuntimeRoutes: control.routes });
    cleanups.push(async () => { await control.shutdown(); await app.shutdownPostHog(); });
    const response = await app.request("https://app.matrix-os.com/internal/containers/alice/native-live/capabilities?runtimeSlot=alice-test", { headers: { authorization: `Bearer ${bearer}`, host: "app.matrix-os.com" } });
    expect(response.status).toBe(200);
    expect((await response.json()).ownerId).toBe("user_alice");
  });
  it("fails closed without platform policy, credential, or entitlement", async () => {
    for (const config of [{ env: {} }, { env, entitled: async () => false }, { env: { ...env, GEMINI_API_KEY: "" } }]) {
      const control = createNativeLiveControl({ db, platformSecret: secret, entitled: async () => true, ...config });
      cleanups.push(() => control.shutdown());
      const response = await control.routes.request("/internal/containers/alice/native-live/capabilities?runtimeSlot=alice-test", { headers: { authorization: `Bearer ${bearer}` } });
      expect((await response.json()).available).toBe(false);
    }
  });
  async function sockets(entitled: () => Promise<boolean> = async () => true) {
    const providerHttp = createServer();
    const provider = new WebSocketServer({ server: providerHttp });
    cleanups.push(() => new Promise<void>(r => { provider.clients.forEach(c => c.terminate()); provider.close(() => providerHttp.close(() => r())); }));
    await new Promise<void>(r => providerHttp.listen(0, "127.0.0.1", r));
    const control = createNativeLiveControl({ db, env, platformSecret: secret, entitled,
      providerUrl: `ws://127.0.0.1:${(providerHttp.address() as AddressInfo).port}` });
    const proxy = createServer();
    const decision = { status: "active" as const, runtimeProxyAllowed: true, ownerDataPreserved: true as const, ownerDataExportable: true as const, remediation: null };
    registerPlatformWebSocketUpgradeHandler({ server: proxy, app: { capturePlatformEvent: vi.fn() }, db, env, platformSecret: secret,
      platformJwtSecret: "synthetic-platform-jwt", legacyContainerRoutingEnabled: false, codeServerPort: 3100,
      getRuntimeEntitlementDecision: () => decision, getRuntimeEntitlementDecisionForUser: async () => decision, nativeLiveControl: control });
    cleanups.push(async () => { await control.shutdown(); await new Promise<void>(r => proxy.close(() => r())); });
    await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
    const url = `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/internal/containers/alice/native-live?runtimeSlot=alice-test`;
    const connect = () => new WebSocket(url, { headers: { authorization: `Bearer ${bearer}` } });
    return { control, provider, connect };
  }
  it("relays real socket frames with constrained setup and keeps native async responses flowing", async () => {
    const { provider, connect, control } = await sockets();
    const received = new Promise<any>(r => provider.on("connection", socket => socket.on("message", data => {
      r(JSON.parse(data.toString())); socket.send(JSON.stringify({ setupComplete: {} }));
    })));
    const client = connect();
    await new Promise<void>(r => client.on("open", r));
    const response = new Promise<string>(r => client.on("message", data => r(data.toString())));
    client.send(JSON.stringify({ setup: { model: "models/unapproved", systemInstruction: { parts: [{ text: "Hello" }] }, tools: [] } }));
    expect((await received).setup.model).toBe("models/gemini-3.8-live");
    expect(JSON.parse(await response)).toEqual({ setupComplete: {} });
    await control.shutdown();
    expect((await db.executor.selectFrom("native_live_sessions").select("status").execute())[0]?.status).toBe("closed");
  });
  it("refuses a second owner session before connecting to the provider", async () => {
    const { connect } = await sockets();
    const first = connect(); await new Promise<void>(r => first.on("open", r));
    const second = connect();
    expect(await new Promise<number>(r => { second.on("unexpected-response", (_req, res) => { r(res.statusCode!); second.terminate(); }); second.on("error", () => {}); })).toBe(503);
  });
  it("drains and conservatively records an over-budget provider session", async () => {
    const { provider, connect } = await sockets();
    provider.on("connection", socket => socket.on("message", () => socket.send(JSON.stringify({ usageMetadata: { promptTokenCount: 1_000_000, responseTokenCount: 0 } }))));
    const client = connect(); await new Promise<void>(r => client.on("open", r));
    const closed = new Promise<void>(r => client.on("close", () => r()));
    client.send(JSON.stringify({ setup: { tools: [] } })); await closed;
    const row = await db.executor.selectFrom("native_live_sessions").selectAll().executeTakeFirstOrThrow();
    expect(row.accounted_microusd).toBe(3_000_000); expect(row.platform_absorbed_overrun_microusd).toBe(1_000_000);
  });
  it("waits for in-progress authorization before shutdown can release the database", async () => {
    let resolve!: (value: boolean) => void;
    const entitlement = vi.fn(() => new Promise<boolean>(r => { resolve = r; }));
    const { connect, control } = await sockets(entitlement);
    const client = connect(); client.on("error", () => {});
    await vi.waitFor(() => expect(entitlement).toHaveBeenCalled());
    let drained = false;
    const shutdown = control.shutdown().then(() => { drained = true; });
    try { await new Promise(r => setTimeout(r, 10)); expect(drained).toBe(false); }
    finally { resolve(true); await shutdown; client.terminate(); }
  });
  it("records all accepted usage events even when the first event closes the socket", async () => {
    const { provider, connect, control } = await sockets();
    provider.on("connection", socket => socket.on("message", () => {
      for (let i = 0; i < 3; i++) socket.send(JSON.stringify({ usageMetadata: { promptTokenCount: 1_000_000, responseTokenCount: 0 } }));
    }));
    const client = connect(); await new Promise<void>(r => client.on("open", r));
    const closed = new Promise<void>(r => client.on("close", () => r()));
    client.send(JSON.stringify({ setup: { tools: [] } })); await closed; await control.shutdown();
    const row = await db.executor.selectFrom("native_live_sessions").selectAll().executeTakeFirstOrThrow();
    expect(row.usage_events).toBe(3);
    expect(row.accounted_microusd).toBe(9_000_000);
    expect(row.platform_absorbed_overrun_microusd).toBe(7_000_000);
  });
  it("records provider usage before closing a client with excessive backpressure", async () => {
    const { provider, connect, control } = await sockets();
    provider.on("connection", socket => socket.on("message", () => {
      vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(256 * 1024 + 1);
      socket.send(JSON.stringify({ usageMetadata: { promptTokenCount: 1_000_000, responseTokenCount: 0 } }));
    }));
    const client = connect(); await new Promise<void>(r => client.on("open", r));
    const closed = new Promise<void>(r => client.on("close", () => r()));
    client.send(JSON.stringify({ setup: { tools: [] } })); await closed; await control.shutdown();
    const row = await db.executor.selectFrom("native_live_sessions").selectAll().executeTakeFirstOrThrow();
    expect(row.accounted_microusd).toBe(3_000_000);
    expect(row.platform_absorbed_overrun_microusd).toBe(1_000_000);
  });
});
