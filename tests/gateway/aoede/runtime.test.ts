import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Pool } from "pg";
import { PostgresDialect, sql } from "kysely";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { createAoedeRuntime } from "../../../packages/gateway/src/aoede/runtime.js";
import { createAppDb } from "../../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../../packages/gateway/src/app-db-registry.js";
import { registerNativeAppStorage } from "../../../packages/gateway/src/native-app-storage.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatEventStream } from "../../../packages/gateway/src/chat/event-stream.js";
import { registerMainWebSocketRoutes } from "../../../packages/gateway/src/server/main-ws-routes.js";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../../packages/gateway/src/request-principal.js";

it("disabled composition authenticates before returning unavailable on the real HTTP listener", async () => {
  const app = new Hono(); app.use("*", authMiddleware("owner-token"));
  const runtime = await createAoedeRuntime({ env: {}, homePath: tmpdir(), database: null, registry: null, chat: null,
    getPrincipal: c => requireRequestPrincipal(c, { configuredUserId: "owner", isTrustedSingleUserGateway: true }),
    clients: new Set(), clientOwnerIds: new WeakMap(), clientConnectionIds: new WeakMap(),
    broadcastToOwner: () => {}, notifyDataChange: () => {} });
  app.route("/api/aoede", runtime.routes);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const url = `http://127.0.0.1:${address.port}/api/aoede/session`;
  try {
    expect((await fetch(url, { method: "POST", signal: AbortSignal.timeout(2000) })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer owner-token" }, signal: AbortSignal.timeout(2000) })).status).toBe(503);
  } finally { await runtime.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("real SQL and main socket admit only authenticated mint and fence UI acknowledgements to the invoking connection", async () => {
  const url = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_TEST_POSTGRES_URL required: disposable database creation must be authorized");
  const admin = new Pool({ connectionString: url }); const name = `aoede_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const isolated = new URL(url); isolated.pathname = `/${name}`;
  const storage = createAppDb(isolated.toString());
  const repository = new ChatRepository(new PostgresDialect({ pool: new Pool({ connectionString: isolated.toString() }) }));
  const homePath = await mkdtemp(join(tmpdir(), "aoede-runtime-"));
  const provider = createServer(); const sidebands = new WebSocketServer({ server: provider });
  let minted = 0; const spoken: string[] = [];
  provider.on("request", async (req, res) => {
    for await (const _chunk of req) { /* consume bounded fixture requests */ }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { minted++; res.end(JSON.stringify({ providerSessionId: "live_test", sdp: "answer" })); }
    else { for (const peer of sidebands.clients) peer.send(JSON.stringify({ type: "session.closed", session: { id: "live_test" } })); res.end("{}"); }
  });
  sidebands.on("connection", peer => peer.on("message", raw => {
    const frame = JSON.parse(raw.toString()); spoken.push(frame.content);
    peer.send(JSON.stringify({ type: frame.type.replace(/append$/, "appended"), client_event_id: frame.event_id }));
  }));
  provider.listen(0, "127.0.0.1"); await once(provider, "listening"); const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider port");
  const app = new Hono(); const clients = new Set<WSContext>(); const owners = new WeakMap<WSContext, string>(); const ids = new WeakMap<WSContext, string>();
  const env = { MATRIX_PLATFORM_SPEECH_ENABLED: "true", MATRIX_PLATFORM_SPEECH_ORIGIN: `http://127.0.0.1:${address.port}`,
    MATRIX_HANDLE: "test", MATRIX_CLERK_USER_ID: "owner", MATRIX_MACHINE_ID: "machine", MATRIX_RUNTIME_SLOT: "main", MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "a".repeat(64) };
  const oldOwner = process.env.MATRIX_USER_ID; process.env.MATRIX_USER_ID = "owner";
  app.use("*", authMiddleware("owner-token"));
  const catalog = { getCatalog: async () => ({ revision: "empty", drivers: [], instances: [] }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([]) });
  const stream = createCanonicalChatEventStream({ repository });
  let runtime: Awaited<ReturnType<typeof createAoedeRuntime>> | undefined;
  let server: ReturnType<typeof serve> | undefined; const sockets: WebSocket[] = [];
  try {
    await storage.db.bootstrap(); await repository.bootstrap();
    const registry = createAppRegistry(storage.db, storage.kysely); await registerNativeAppStorage(registry);
    runtime = await createAoedeRuntime({ env, homePath, database: storage.kysely, registry,
      chat: { repository, orchestrator, eventStream: stream, catalog }, getPrincipal: requireRequestPrincipal,
      clients, clientOwnerIds: owners, clientConnectionIds: ids,
      broadcastToOwner: (owner, frame) => { for (const peer of clients) if (owners.get(peer) === owner) peer.send(JSON.stringify(frame)); }, notifyDataChange: () => {} });
    app.route("/api/aoede", runtime.routes); const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    registerMainWebSocketRoutes({ app, upgradeWebSocket, clients, clientOwnerIds: owners, clientConnectionIds: ids,
      onAoedeClientMessage: runtime.onClientMessage, syncReport: undefined, isSyncReportSent: () => true, markSyncReportSent: () => {},
      syncPeerRegistry: null, conversationRuns: null as never, conversationLifecycle: null as never, conversationContextResolver: null as never,
      reconnectableAbortControllers: new Map(), conversations: null as never, dispatcher: null as never,
      approvalPolicy: { timeout: 1000 } as never, captureGatewayProductEvent: () => {}, evictOldestMainWsClientIfNeeded: () => {},
      finalizeWithSummary: async () => {}, logUnexpectedJsonParseFailure: (_context, error) => { throw error; } });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }); injectWebSocket(server); await once(server, "listening");
    const gatewayAddress = server.address(); if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Missing gateway port");
    const base = `http://127.0.0.1:${gatewayAddress.port}`;
    const start = (token?: string, body = { clientRequestId: randomUUID(), sdp: "offer" }) => fetch(`${base}/api/aoede/session`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    expect((await start()).status).toBe(401); expect((await start("wrong")).status).toBe(401); expect(minted).toBe(0);
    expect((await start("owner-token", { clientRequestId: randomUUID(), sdp: "x".repeat(65536) })).status).toBe(413); expect(minted).toBe(0);
    const response = await start("owner-token"); expect(response.status).toBe(200); const { sessionId } = await response.json();
    expect(await storage.kysely.selectFrom("aoede_sessions").select("owner_id").where("id", "=", sessionId).executeTakeFirst()).toEqual({ owner_id: "owner" });
    const received: any[][] = [[], []];
    for (let i = 0; i < 2; i++) {
      const socket = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { authorization: "Bearer owner-token" } });
      socket.on("message", raw => received[i].push(JSON.parse(raw.toString()))); sockets.push(socket); await once(socket, "open");
    }
    sockets[0].send(JSON.stringify({ type: "aoede:ready", sessionId }));
    await expect.poll(() => received[0].some(f => f.type === "aoede:state" && f.state === "active")).toBe(true);
    const emit = (frame: unknown) => { for (const peer of sidebands.clients) peer.send(JSON.stringify(frame)); };
    emit({ type: "session.input_transcript.delta", event_id: "input1", delta: "open notes", start_ms: 0, end_ms: 10 });
    emit({ type: "session.delegation.created", offset_ms: 10, delegation: { id: "del_open", target: "client", type: "delegation" } });
    await expect.poll(() => received[0].find(f => f.type === "aoede:ui" && f.phase === "resolve")).toBeTruthy();
    const resolve = received[0].find(f => f.type === "aoede:ui");
    const result = { type: "aoede:ui_result", sessionId, correlationId: resolve.correlationId, phase: "resolve", status: "ok", slug: "notes" };
    sockets[1].send(JSON.stringify(result)); sockets[1].send(JSON.stringify({ type: "aoede:ready", sessionId }));
    sockets[0].send(JSON.stringify({ ...result, sessionId: randomUUID() }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received[0].filter(f => f.type === "aoede:ui")).toHaveLength(1); expect(received[1]).toEqual([]);
    sockets[0].send(JSON.stringify(result));
    await expect.poll(() => received[0].find(f => f.type === "aoede:ui" && f.phase === "execute")).toBeTruthy();
    const execute = received[0].find(f => f.type === "aoede:ui" && f.phase === "execute");
    sockets[0].send(JSON.stringify({ ...result, phase: "execute", correlationId: execute.correlationId }));
    await expect.poll(() => spoken.some(text => /opened/i.test(text))).toBe(true);
    await runtime.shutdown(); runtime = undefined;
    expect((await sql`SELECT 1 AS alive`.execute(storage.kysely)).rows).toEqual([{ alive: 1 }]);
  } finally {
    await runtime?.shutdown(); for (const socket of sockets) socket.terminate();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    for (const peer of sidebands.clients) peer.terminate(); await new Promise<void>(resolve => sidebands.close(() => provider.close(() => resolve())));
    stream.shutdown(); await orchestrator.close(); await repository.kysely.destroy(); await storage.db.destroy();
    await admin.query(`DROP DATABASE "${name}"`); await admin.end(); await rm(homePath, { recursive: true, force: true });
    if (oldOwner === undefined) delete process.env.MATRIX_USER_ID; else process.env.MATRIX_USER_ID = oldOwner;
  }
}, 15000);
