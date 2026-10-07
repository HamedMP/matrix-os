import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createPlatformAoedeLiveService } from "../../packages/platform/src/aoede/service.js";
import { createAoedeLiveRuntimeRoutes, createAoedeLiveUpgradeHandler } from "../../packages/platform/src/aoede/routes.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createDisabledOrchestrator } from "../../packages/platform/src/orchestrator.js";
import { buildPlatformSpeechRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { registerPlatformWebSocketUpgradeHandler } from "../../packages/platform/src/platform-websocket-upgrade.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const identity = { ownerId: "user_alice", machineId: "machine_alice", runtimeSlot: "primary", runtimeTokenEpoch: 1 };
const policy = { enabled: true, model: "gpt-live-1", voice: "marin", revision: "live-1", microusdPerMinute: 60_000, maxDurationMs: 60_000 } as const;
let db: PlatformDB;
let provider: WebSocketServer;
let peers: WebSocket[];
let service: ReturnType<typeof createPlatformAoedeLiveService>;
let mint: ReturnType<typeof vi.fn>;
let failAttach = false;
let funding: ReturnType<typeof createAiFundedSpeechFundingPort>;
const platformSecret = "platform-secret-aoede-tests-123456789";
let httpServer: Server | undefined;
let clients: WebSocket[];

beforeEach(async () => {
  ({ db } = await createTestPlatformDb());
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
    handle: "alice", runtimeSlot: "primary", status: "running", imageVersion: "v1",
    provisionedAt: new Date().toISOString(), activationState: "authorized" });
  peers = [];
  clients = [];
  failAttach = false;
  provider = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => provider.once("listening", resolve));
  provider.on("connection", (peer) => {
    peers.push(peer);
    peer.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "session.close") {
        peer.send(JSON.stringify({ type: "session.closed", usage: { seconds: 31.25 } }));
      }
    });
  });
  mint = vi.fn(async () => new Response(JSON.stringify({ session: { id: "live_" + randomUUID() },
    transport: { type: "webrtc", sdp: "answer" } }), { status: 201 }));
  service = makeService();
});
afterEach(async () => {
  for (const client of clients) client.terminate();
  await service?.shutdown();
  if (httpServer) { await new Promise<void>((resolve) => httpServer!.close(() => resolve())); httpServer = undefined; }
  for (const peer of peers) peer.terminate();
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await destroyTestPlatformDb(db);
});
function makeService(enabled = true) {
  funding = createAiFundedSpeechFundingPort({ capability: "speech:live", allowedSources: ["promotional"],
    credentialHashSecret: "s".repeat(32), reservationIdFactory: () => "live_" + randomUUID(),
    monthlyAllowance: { monthlyBudgetMicrousd: 1_000_000, monthlyPromotionalCreditMicrousd: 1_000_000 } });
  return createPlatformAoedeLiveService({ db, policy: { ...policy, enabled }, apiKey: "k".repeat(32),
    fingerprintSecret: "f".repeat(32), fetchImpl: mint as typeof fetch,
    finalizationTimeoutMs: 50,
    connect: () => new WebSocket(failAttach ? "ws://127.0.0.1:1" : `ws://127.0.0.1:${(provider.address() as { port: number }).port}`),
    funding });
}
function input(clientRequestId = randomUUID()) { return { clientRequestId, sdp: "offer", instructions: "Be concise", input: [] }; }
async function reservation() { return db.executor.selectFrom("ai_funded_usage_reservations").selectAll().executeTakeFirstOrThrow(); }

it("disabled and exhausted sessions never dispatch a billable mint", async () => {
  await service.shutdown();
  service = makeService(false);
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).not.toHaveBeenCalled();
  await service.shutdown();
  service = makeService();
  // Freeze the wallet using the existing machine restriction boundary.
  await db.executor.insertInto("ai_funded_credit_restrictions").values({ machine_id: identity.machineId,
    owner_id: identity.ownerId, runtime_slot: "primary", frozen: true, debt_microusd: 0,
    updated_at: new Date().toISOString() }).execute();
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).not.toHaveBeenCalled();
});

it("reserves before dispatch, deduplicates invocations, and rejects changed payload", async () => {
  mint.mockImplementationOnce(async () => {
    expect((await reservation()).status).toBe("in_flight");
    return new Response(JSON.stringify({ session: { id: "live_once" }, transport: { type: "webrtc", sdp: "answer" } }), { status: 201 });
  });
  const request = input();
  const result = await service.mint(identity, request);
  await expect(service.mint(identity, request)).rejects.toThrow();
  await expect(service.mint(identity, { ...request, sdp: "different" })).rejects.toThrow();
  expect(mint).toHaveBeenCalledTimes(1);
  await service.close(identity, result.providerSessionId);
});

it("rejects another owner and a rotated epoch on attach and close", async () => {
  const result = await service.mint(identity, input());
  await expect(service.bind({ ...identity, ownerId: "user_bob" }, result.providerSessionId)).rejects.toThrow();
  await expect(service.close({ ...identity, runtimeTokenEpoch: 2 }, result.providerSessionId)).rejects.toThrow();
  expect((await reservation()).status).toBe("in_flight");
});

it("replaying an old invocation cannot close or bill the newer active session", async () => {
  const request = input();
  const first = await service.mint(identity, request);
  await service.close(identity, first.providerSessionId);
  const current = await service.mint(identity, input());
  await expect(service.mint(identity, request)).rejects.toThrow();
  const row = await db.executor.selectFrom("speech_operations").selectAll().where("live_provider_id", "=", current.providerSessionId).executeTakeFirstOrThrow();
  expect(row.execution_state).toBe("dispatching");
  expect(row.live_confirmed).toBe(false);
  expect(mint).toHaveBeenCalledTimes(2);
});

it("replaces cumulative snapshots and settles fractional final seconds exactly once", async () => {
  const result = await service.mint(identity, input());
  peers[0].send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 15 } }));
  peers[0].send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 30 } }));
  await vi.waitFor(async () => {
    const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
    expect(Number(row.live_usage_seconds)).toBe(30);
  });
  await service.close(identity, result.providerSessionId);
  await service.close(identity, result.providerSessionId);
  const row = await reservation();
  expect(row.finalization_mode).toBe("exact");
  expect(Number(row.actual_microusd)).toBe(31_250);
  expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().where("kind", "=", "promotional_debit").execute()).toHaveLength(1);
});

it("lost finalization conservatively charges and blocks a fresh invocation", async () => {
  await service.mint(identity, input());
  peers[0].terminate();
  await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("conservative"));
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).toHaveBeenCalledTimes(1);
  expect(Number((await reservation()).actual_microusd)).toBe(Number((await reservation()).reserved_microusd));
});

it("ambiguous REST failure is never refunded or automatically reminted", async () => {
  mint.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect((await reservation()).finalization_mode).toBe("conservative");
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).toHaveBeenCalledTimes(1);
});

it("provider creation followed by failed attachment is conservatively compensated and blocked", async () => {
  failAttach = true;
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect((await reservation()).finalization_mode).toBe("conservative");
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).toHaveBeenCalledTimes(1);
});

it("a funding start failure releases the reservation without creating a provider session", async () => {
  vi.spyOn(funding, "start").mockRejectedValueOnce(new Error("start failed"));
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect((await reservation()).status).toBe("released");
  expect(mint).not.toHaveBeenCalled();
  expect(Number((await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().executeTakeFirstOrThrow()).reserved_microusd)).toBe(0);
});

it("provider success followed by binding persistence failure closes the billable provider session", async () => {
  await sql`CREATE FUNCTION fail_live_binding() RETURNS trigger AS $$
    BEGIN IF NEW.live_provider_id IS NOT NULL THEN RAISE EXCEPTION 'injected binding failure'; END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql`.execute(db.executor);
  await sql`CREATE TRIGGER fail_live_binding BEFORE UPDATE ON speech_operations FOR EACH ROW EXECUTE FUNCTION fail_live_binding()`.execute(db.executor);
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(peers).toHaveLength(1);
  expect((await reservation()).finalization_mode).toBe("exact");
  expect(Number((await reservation()).actual_microusd)).toBe(31_250);
});

it("aborted runtime response after a successful provider mint closes and accounts for that session", async () => {
  const controller = new AbortController();
  mint.mockImplementationOnce(async () => {
    controller.abort();
    return new Response(JSON.stringify({ session: { id: "live_aborted" }, transport: { type: "webrtc", sdp: "answer" } }), { status: 201 });
  });
  await expect(service.mint(identity, input(), controller.signal)).rejects.toThrow();
  expect(peers).toHaveLength(1);
  expect((await reservation()).finalization_mode).toBe("exact");
});

it("shutdown without provider final usage remains unconfirmed and prevents unsafe remint", async () => {
  await service.mint(identity, input());
  peers[0].removeAllListeners("message");
  await service.shutdown();
  expect((await reservation()).finalization_mode).toBe("conservative");
  expect((await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow()).live_confirmed).toBe(false);
  service = makeService();
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).toHaveBeenCalledTimes(1);
});

it("transcription credentials cannot spend or finalize a Live reservation", async () => {
  await service.mint(identity, input());
  const transcription = createAiFundedSpeechFundingPort({ allowedSources: ["promotional"], credentialHashSecret: "s".repeat(32),
    reservationIdFactory: () => "transcription_unused", monthlyAllowance: { monthlyBudgetMicrousd: 1_000_000, monthlyPromotionalCreditMicrousd: 1_000_000 } });
  const id = (await reservation()).reservation_id;
  await expect(db.transaction((trx) => transcription.settle(trx.executor as never, id, { mode: "exact", actualCostMicrousd: 0 }))).rejects.toThrow();
  expect((await reservation()).status).toBe("in_flight");
});

it("restart reconciliation closes an orphan without replay or remint and preserves conservative accounting", async () => {
  await service.mint(identity, input());
  peers[0].terminate();
  await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("conservative"));
  await service.shutdown();
  await db.executor.updateTable("speech_operations").set({ expires_at: new Date(Date.now() - 1_000).toISOString() }).execute();
  service = makeService();
  await service.reconcile();
  const operation = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
  expect(operation.live_confirmed).toBe(true);
  expect(operation.execution_state).toBe("uncertain");
  expect((await reservation()).finalization_mode).toBe("conservative");
  expect(mint).toHaveBeenCalledTimes(1);
  const fresh = await service.mint(identity, input());
  await service.close(identity, fresh.providerSessionId);
});

it("enforces one runtime controller across platform processes and never reflects audio", async () => {
  const result = await service.mint(identity, input());
  const other = makeService();
  try {
    const binding = await other.bind(identity, result.providerSessionId);
    const seen: string[] = [];
    binding.subscribe((event) => seen.push(event));
    await expect(service.bind(identity, result.providerSessionId)).rejects.toThrow();
    const event = { type: "session.delegation.created", delegation: { id: "del_one", target: "client", type: "delegation" } };
    peers[1].send(JSON.stringify({ type: "session.input_audio.append", audio: "private audio" }));
    peers[1].send(JSON.stringify(event));
    await vi.waitFor(() => expect(seen).toEqual([JSON.stringify(event)]));
    binding.release();
    await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("exact"));
  } finally { await other.shutdown(); }
});

function token(handle = "alice", machineId = identity.machineId, epoch = 1) {
  return buildPlatformSpeechRuntimeVerificationToken({ handle, machineId, runtimeSlot: "primary" }, platformSecret, epoch);
}
function platformApp() {
  return createApp({ db, platformSecret, orchestrator: createDisabledOrchestrator({ db, image: "test" }),
    internalAoedeLiveRuntimeRoutes: createAoedeLiveRuntimeRoutes({ db, platformSecret, service }) });
}
it("real platform dispatcher requires current machine/slot/epoch credentials and no-store on mint and close", async () => {
  const app = platformApp();
  const path = "/internal/containers/alice/aoede/session?runtimeSlot=primary";
  for (const bearer of [buildPlatformVerificationToken("alice", platformSecret), token("alice", identity.machineId, 2)]) {
    const response = await app.request(path, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(input()) });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(mint).not.toHaveBeenCalled();
  const response = await app.request(path, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(input()) });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const result = await response.json() as { providerSessionId: string };
  const closed = await app.request(`/internal/containers/alice/aoede/sessions/${result.providerSessionId}?runtimeSlot=primary`,
    { method: "DELETE", headers: { authorization: `Bearer ${token()}` } });
  expect(closed.status).toBe(200);
  expect(closed.headers.get("cache-control")).toContain("no-store");
  expect((await reservation()).finalization_mode).toBe("exact");
});

it("body limits both mint and DELETE before provider dispatch", async () => {
  const app = platformApp();
  for (const [method, path] of [["POST", "session"], ["DELETE", "sessions/live_fake"]]) {
    const response = await app.request(`/internal/containers/alice/aoede/${path}?runtimeSlot=primary`, {
      method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: "x".repeat(70_000) });
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(mint).not.toHaveBeenCalled();
});

it("real upgrade dispatcher rejects another owner then forwards authorized control and final usage", async () => {
  const result = await service.mint(identity, input());
  await insertUserMachine(db, { machineId: "machine_bob", clerkUserId: "user_bob", handle: "bob", runtimeSlot: "primary",
    status: "running", imageVersion: "v1", provisionedAt: new Date().toISOString(), activationState: "authorized" });
  httpServer = createServer();
  registerPlatformWebSocketUpgradeHandler({ server: httpServer, db, app: { capturePlatformEvent() {} }, env: {},
    platformSecret, platformJwtSecret: platformSecret, legacyContainerRoutingEnabled: false, codeServerPort: 8080,
    getRuntimeEntitlementDecision: () => ({ runtimeProxyAllowed: false }) as never,
    getRuntimeEntitlementDecisionForUser: async () => ({ runtimeProxyAllowed: false }) as never,
    aoedeLiveUpgrade: createAoedeLiveUpgradeHandler({ db, platformSecret, service }) });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as { port: number }).port;
  const refused = new WebSocket(`ws://127.0.0.1:${port}/internal/containers/bob/aoede/sessions/${result.providerSessionId}/attach?runtimeSlot=primary`,
    { headers: { authorization: `Bearer ${token("bob", "machine_bob")}` } });
  clients.push(refused);
  refused.on("error", () => undefined);
  expect(await new Promise<number>((resolve) => refused.on("unexpected-response", (_req, response) => { response.resume(); refused.terminate(); resolve(response.statusCode!); }))).toBe(404);
  const client = new WebSocket(`ws://127.0.0.1:${port}/internal/containers/alice/aoede/sessions/${result.providerSessionId}/attach?runtimeSlot=primary`,
    { headers: { authorization: `Bearer ${token()}` } });
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  const received = new Promise<string>((resolve) => client.once("message", (data) => resolve(data.toString())));
  client.send(JSON.stringify({ type: "session.close" }));
  expect(JSON.parse(await received).usage.seconds).toBe(31.25);
  await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("exact"));
});
