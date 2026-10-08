import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createPlatformAoedeLiveService } from "../../packages/platform/src/aoede/service.js";
import { migrateAoedeLiveTerminationV2 } from "../../packages/platform/src/database/migrations/aoede-live-termination-v2.js";
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
function makeService(enabled = true, allowance = 1_000_000) {
  funding = createAiFundedSpeechFundingPort({ capability: "speech:live", allowedSources: ["promotional"],
    credentialHashSecret: "s".repeat(32), reservationIdFactory: () => "live_" + randomUUID(),
    monthlyAllowance: { monthlyBudgetMicrousd: allowance, monthlyPromotionalCreditMicrousd: allowance } });
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

it.each([undefined, {}, { seconds: -1 }, { seconds: "bad" }, { seconds: 1_000_000 }])("trusted close with usage %s releases liveness without fabricating billing", async (usage) => {
  const first = await service.mint(identity, input());
  peers[0].removeAllListeners("message");
  peers[0].send(JSON.stringify({ type: "session.closed", session: { id: first.providerSessionId }, usage }));
  await vi.waitFor(async () => {
    const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
    expect(row.live_terminated_at).toBeTruthy();
    expect(row.live_termination_provider_id).toBe(first.providerSessionId);
    expect(row.live_confirmed).toBe(false);
  });
  expect((await reservation()).finalization_mode).toBe("conservative");
  expect(await service.close(identity, first.providerSessionId)).toEqual({ closed: true, finalization: "unconfirmed" });
  const fresh = await service.mint(identity, input());
  await service.close(identity, fresh.providerSessionId);
});

it("persists closure despite settlement rejection and recovers accounting once without replay", async () => {
  const first = await service.mint(identity, input());
  peers[0].removeAllListeners("message");
  const settle = vi.spyOn(funding, "settle").mockRejectedValueOnce(new Error("injected settlement failure"));
  peers[0].send(JSON.stringify({ type: "session.closed", session: { id: first.providerSessionId }, usage: { seconds: 1 } }));
  await vi.waitFor(async () => {
    const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
    expect(row.live_terminated_at).toBeTruthy();
    expect(row.execution_state).toBe("dispatching");
  });
  expect((await reservation()).status).toBe("in_flight");
  await expect(service.mint(identity, input())).rejects.toThrow();
  const connections = peers.length;
  await Promise.all([service.reconcile(), service.reconcile()]);
  expect((await reservation()).finalization_mode).toBe("conservative");
  expect(settle).toHaveBeenCalledTimes(2);
  const ledger = await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute();
  await service.reconcile();
  await service.close(identity, first.providerSessionId);
  expect(settle).toHaveBeenCalledTimes(2);
  expect(peers).toHaveLength(connections);
  expect(mint).toHaveBeenCalledTimes(1);
  expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual(ledger);
  const fresh = await service.mint(identity, input());
  await service.close(identity, fresh.providerSessionId);
});

it("lost finalization conservatively charges and blocks a fresh invocation", async () => {
  await service.mint(identity, input());
  peers[0].terminate();
  await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("conservative"));
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(mint).toHaveBeenCalledTimes(1);
  expect(Number((await reservation()).actual_microusd)).toBe(Number((await reservation()).reserved_microusd));
});

it.each([undefined, 503, 404, 410])("ambiguous REST failure %s is never refunded or automatically reminted", async (status) => {
  if (status === undefined) mint.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  else mint.mockResolvedValueOnce(new Response(null, { status }));
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
  expect(operation.live_confirmed).toBe(false);
  expect(operation.live_terminated_at).toBeTruthy();
  expect(operation.live_termination_evidence).toBe("session.closed");
  expect(operation.execution_state).toBe("uncertain");
  expect((await reservation()).finalization_mode).toBe("conservative");
  expect(mint).toHaveBeenCalledTimes(1);
  const fresh = await service.mint(identity, input());
  await service.close(identity, fresh.providerSessionId);
});

it.each([-3_600, 3_600])("identity-bound provider expiry offset %s and ambiguous attach never release the fence, and retries back off", async (offset) => {
  const result = await service.mint(identity, input());
  const expiry = Math.floor(Date.now() / 1_000) + offset;
  peers[0].removeAllListeners("message");
  peers[0].send(JSON.stringify({ type: "session.updated", session: { id: "live_wrong", expires_at: expiry } }));
  peers[0].send(JSON.stringify({ type: "session.updated", session: { id: result.providerSessionId, expires_at: expiry } }));
  await vi.waitFor(async () => {
    const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
    expect(row.live_provider_expires_at).toBe(new Date(expiry * 1_000).toISOString());
  });
  peers[0].terminate();
  await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("conservative"));
  const ledger = await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute();
  await db.executor.updateTable("speech_operations").set({ expires_at: new Date(Date.now() - 1_000).toISOString() }).execute();
  failAttach = true;
  await service.reconcile();
  const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
  expect(row.live_terminated_at).toBeNull();
  expect(Date.parse(row.live_reconcile_after!)).toBeGreaterThan(Date.now());
  failAttach = false;
  await service.reconcile();
  expect(peers).toHaveLength(1);
  await expect(service.mint(identity, input())).rejects.toThrow();
  expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual(ledger);
});

it("wrong-session close is ignored and concurrent reconciliation cannot duplicate funding", async () => {
  const result = await service.mint(identity, input());
  peers[0].removeAllListeners("message");
  peers[0].send(JSON.stringify({ type: "session.closed", session: { id: "live_wrong" }, usage: { seconds: 1 } }));
  peers[0].send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 2 } }));
  await vi.waitFor(async () => {
    const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
    expect(row.live_usage_seconds).toBe(2);
    expect(row.live_terminated_at).toBeNull();
  });
  peers[0].terminate();
  await vi.waitFor(async () => expect((await reservation()).finalization_mode).toBe("conservative"));
  await db.executor.updateTable("speech_operations").set({ expires_at: new Date(Date.now() - 1_000).toISOString() }).execute();
  const other = makeService();
  try {
    const outcomes = await Promise.allSettled([service.reconcile(), other.reconcile(), service.mint(identity, input())]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("fulfilled");
    expect(outcomes[2].status).toBe("rejected");
    expect(peers).toHaveLength(2);
    const row = await db.executor.selectFrom("speech_operations").selectAll().where("live_provider_id", "=", result.providerSessionId).executeTakeFirstOrThrow();
    expect(row.live_terminated_at).toBeTruthy();
    expect(row.live_confirmed).toBe(false);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().where("kind", "=", "promotional_debit").execute()).toHaveLength(1);
  } finally { await other.shutdown(); }
});

it("late old-session events cannot change replacement accounting or settle twice", async () => {
  const first = await service.mint(identity, input());
  const other = makeService();
  try {
    await other.bind(identity, first.providerSessionId);
    await service.close(identity, first.providerSessionId);
    const old = await db.executor.selectFrom("speech_operations").selectAll().where("live_provider_id", "=", first.providerSessionId).executeTakeFirstOrThrow();
    const fresh = await service.mint(identity, input());
    peers[1].send(JSON.stringify({ type: "session.closed", session: { id: first.providerSessionId }, usage: { seconds: 1 } }));
    await other.close(identity, first.providerSessionId);
    expect(await db.executor.selectFrom("speech_operations").selectAll().where("live_provider_id", "=", first.providerSessionId).executeTakeFirstOrThrow()).toEqual(old);
    const replacement = await db.executor.selectFrom("speech_operations").selectAll().where("live_provider_id", "=", fresh.providerSessionId).executeTakeFirstOrThrow();
    expect(replacement.live_terminated_at).toBeNull();
    expect(replacement.execution_state).toBe("dispatching");
    await service.close(identity, fresh.providerSessionId);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().where("kind", "=", "promotional_debit").execute()).toHaveLength(2);
  } finally { await other.shutdown(); }
});

it("v2 upgrades a retained v1 index and preserves legacy close evidence without backfilling uncertainty", async () => {
  const first = await service.mint(identity, input());
  await service.close(identity, first.providerSessionId);
  const second = await service.mint(identity, input());
  await service.close(identity, second.providerSessionId);
  await service.mint(identity, input());
  peers[2].terminate();
  await vi.waitFor(async () => {
    const row = await db.executor.selectFrom("speech_operations").selectAll().where("live_provider_id", "=", first.providerSessionId).executeTakeFirstOrThrow();
    expect(row.live_terminated_at).toBeTruthy();
    expect(await db.executor.selectFrom("speech_operations").selectAll().where("execution_state", "=", "uncertain").execute()).toHaveLength(1);
  });
  await sql`DROP INDEX speech_live_owner_active`.execute(db.executor);
  await sql`CREATE UNIQUE INDEX speech_live_owner_active ON speech_operations(owner_id)
    WHERE adapter_id = 'aoede-live' AND live_confirmed = FALSE AND execution_state <> 'cancelled'`.execute(db.executor);
  await db.executor.updateTable("speech_operations").set({ live_terminated_at: null, live_termination_evidence: null }).execute();
  await db.transaction((trx) => migrateAoedeLiveTerminationV2(trx.executor));
  const rows = await db.executor.selectFrom("speech_operations").selectAll().execute();
  expect(rows.filter((row) => row.live_termination_evidence === "legacy.session.closed")).toHaveLength(2);
  expect(rows.find((row) => row.execution_state === "uncertain")!.live_terminated_at).toBeNull();
  const index = await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE indexname = 'speech_live_owner_active'`.execute(db.executor);
  expect(index.rows[0].indexdef).toContain("live_terminated_at IS NULL");
  await expect(service.mint(identity, input())).rejects.toThrow();
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
it("actual exhausted funding returns 429 without minting or exposing funding details", async () => {
  await service.shutdown();
  service = makeService(true, 1);
  const response = await platformApp().request("/internal/containers/alice/aoede/session?runtimeSlot=primary", {
    method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(input()),
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: { code: "unavailable", message: "Voice session unavailable" } });
  expect(mint).not.toHaveBeenCalled();
});

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
