import { describe, expect, it, vi } from "vitest";
import {
  RelayAccountClassifier,
  loadRelayAccountLimits,
  ownsActiveRelayComputer,
} from "../../packages/platform/src/collaboration/relay-usage";
import { CollaborationRelay, RelayAccountLimitError } from "../../packages/platform/src/collaboration/relay";
import type { RelayUsageMeter } from "../../packages/platform/src/collaboration/relay-usage";
import { createPlatformCollaborationDirectRoutes } from "../../packages/platform/src/collaboration/direct-routes";
import type { CollaborationTicketIssuer } from "../../packages/platform/src/collaboration/ticket-issuer";
import type { CollaborationRuntimeEndpointRegistry } from "../../packages/platform/src/collaboration/runtime-endpoints";
import type { CollaborationControlStream } from "../../packages/platform/src/collaboration/control-stream";
import { insertUserMachine } from "../../packages/platform/src/db";
import { setupProxyRoutingTest, cleanupProxyRoutingTest } from "./proxy-routing-test-utils";

const scopeId = "10000000-0000-4000-8000-000000000001";
function relay(classifier: RelayAccountClassifier, usage?: Pick<RelayUsageMeter, "canAdmit" | "record">, fetchImpl?: typeof fetch) {
  return new CollaborationRelay({
    resolveScopeHome: async () => ({ runtimeId: "vps:11111111-1111-4111-8111-111111111111", origin: "https://owner.test" }),
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async () => null,
    accountClassifier: classifier,
    accountLimits: loadRelayAccountLimits({}),
    ...(usage ? { accountUsage: usage } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

describe("machine-free relay policy", () => {
  it("counts an owned active machine but never preview access or a failed machine", async () => {
    const db = await setupProxyRoutingTest();
    try {
      await insertUserMachine(db, {
        machineId: "11111111-1111-4111-8111-111111111111", clerkUserId: "user_owner", handle: "owner-handle",
        runtimeSlot: "primary", status: "running", hetznerServerId: 100, publicIPv4: "203.0.113.10",
        imageVersion: "dev", serverType: "cpx22", provisionedAt: "2026-09-28T00:00:00.000Z",
        accessClerkUserIds: ["user_preview_member"],
      });
      expect(await ownsActiveRelayComputer(db, "user_owner")).toBe(true);
      expect(await ownsActiveRelayComputer(db, "user_preview_member")).toBe(false);
      await db.executor.updateTable("user_machines").set({ status: "failed" }).where("clerk_user_id", "=", "user_owner").execute();
      expect(await ownsActiveRelayComputer(db, "user_owner")).toBe(false);
    } finally { await cleanupProxyRoutingTest(db); }
  });
  it("classifies only owned, active computers and caches for at most 60 seconds", async () => {
    let now = 0;
    const ownsActiveComputer = vi.fn(async (_actorId: string) => true);
    const classifier = new RelayAccountClassifier({ ownsActiveComputer, now: () => now });
    expect(await classifier.isMachineFree("user_owner")).toBe(false);
    expect(await classifier.isMachineFree("user_owner")).toBe(false);
    expect(ownsActiveComputer).toHaveBeenCalledTimes(1);
    now = 60_001;
    ownsActiveComputer.mockResolvedValueOnce(false);
    expect(await classifier.isMachineFree("user_owner")).toBe(true);
    classifier.close();
  });

  it("treats a failed machine lookup as machine-free and caps the cache", async () => {
    const ownsActiveComputer = vi.fn(async () => { throw new Error("database offline"); });
    const classifier = new RelayAccountClassifier({ ownsActiveComputer, maxEntries: 2 });
    expect(await classifier.isMachineFree("user_a")).toBe(true);
    expect(await classifier.isMachineFree("user_b")).toBe(true);
    expect(await classifier.isMachineFree("user_c")).toBe(true);
    expect(classifier.cacheSize()).toBe(2);
    classifier.close();
  });

  it("accepts bounded overrides and refuses invalid startup configuration", () => {
    expect(loadRelayAccountLimits({})).toMatchObject({ sockets: 8, dailyBytes: 1024 ** 3 });
    expect(loadRelayAccountLimits({ MATRIX_COLLABORATION_RELAY_MACHINE_FREE_SOCKETS: "12", MATRIX_COLLABORATION_RELAY_MACHINE_FREE_DAILY_BYTES: "2097152" }))
      .toMatchObject({ sockets: 12, dailyBytes: 2 * 1024 ** 2 });
    for (const sockets of ["0", "33", "1.5", "eight", ""]) {
      expect(() => loadRelayAccountLimits({ MATRIX_COLLABORATION_RELAY_MACHINE_FREE_SOCKETS: sockets })).toThrow();
    }
    for (const dailyBytes of ["0", "1048575", String(17 * 1024 ** 3), "1.5", "many"]) {
      expect(() => loadRelayAccountLimits({ MATRIX_COLLABORATION_RELAY_MACHINE_FREE_DAILY_BYTES: dailyBytes })).toThrow();
    }
  });

  it("allows eight machine-free sockets, refuses the ninth and releases its count on close", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => false });
    const instance = relay(classifier);
    const open = () => instance.prepareSocket({
      actorId: "user_without_computer", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=opaque`,
      incomingHeaders: {}, externalHost: "app.matrix-os.com",
    });
    const sockets = await Promise.all(Array.from({ length: 8 }, () => open()));
    expect(sockets.every(Boolean)).toBe(true);
    await expect(open()).rejects.toBeInstanceOf(RelayAccountLimitError);
    sockets[0]!.release();
    expect(await open()).not.toBeNull();
    instance.close();
    classifier.close();
  });

  it("preserves the existing socket cap for an account that owns a computer", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => true });
    const instance = relay(classifier);
    const open = () => instance.prepareSocket({
      actorId: "user_owner", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=opaque`,
      incomingHeaders: {}, externalHost: "app.matrix-os.com",
    });
    const sockets = await Promise.all(Array.from({ length: 9 }, () => open()));
    expect(sockets.every(Boolean)).toBe(true);
    instance.close();
    classifier.close();
  });

  it("returns 429 relay_limit before forwarding HTTP bytes when a machine-free account is over quota", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => false });
    const usage = { canAdmit: vi.fn(async () => false), record: vi.fn(() => false) };
    const fetchImpl = vi.fn(async () => new Response("home data")) as unknown as typeof fetch;
    const instance = relay(classifier, usage, fetchImpl);
    const response = await instance.forward({ actorId: "user_without_computer", method: "GET", path: `/api/collaboration/scopes/${scopeId}`,
      query: "", headers: new Headers(), body: null });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "relay_limit", retryAfterSeconds: expect.any(Number) });
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    instance.close(); classifier.close();
  });

  it("meters concurrent HTTP response chunks and stops a stream at the daily bound", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => false });
    let used = 0;
    const usage = {
      canAdmit: vi.fn(async () => used < 100),
      record: vi.fn((_actor: string, _free: boolean, delta: { bytes?: number }, _limit?: number, ratio = 1.1) => {
        used += delta.bytes ?? 0;
        return used > 100 * ratio;
      }),
    };
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(60)); controller.close(); },
    }))) as unknown as typeof fetch;
    const instance = relay(classifier, usage, fetchImpl);
    const input = { actorId: "user_without_computer", method: "GET", path: `/api/collaboration/scopes/${scopeId}`,
      query: "", headers: new Headers(), body: null };
    const [first, second] = await Promise.all([instance.forward(input), instance.forward(input)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.arrayBuffer()).byteLength).toBe(60);
    await expect(second.arrayBuffer()).rejects.toThrow();
    expect(used).toBe(120);
    expect(usage.record.mock.calls.some((call) => call[4] === 1)).toBe(true);
    instance.close(); classifier.close();
  });

  it("stops an upload before forwarding bytes past the account bound", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => false });
    let used = 0;
    const usage = {
      canAdmit: vi.fn(async () => true),
      record: vi.fn((_actor: string, _free: boolean, delta: { bytes?: number }, _limit?: number, ratio = 1.1) => {
        used += delta.bytes ?? 0;
        return used > 100 * ratio;
      }),
    };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      await new Response(init.body as ReadableStream<Uint8Array>).arrayBuffer();
      return new Response("ok");
    }) as unknown as typeof fetch;
    const instance = relay(classifier, usage, fetchImpl);
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(60)); controller.enqueue(new Uint8Array(60)); controller.close(); },
    });
    const response = await instance.forward({ actorId: "user_without_computer", method: "POST", path: `/api/collaboration/scopes/${scopeId}`,
      query: "", headers: new Headers(), body: source });
    expect(response.status).toBe(429);
    expect(used).toBe(120);
    expect(fetchImpl).toHaveBeenCalledOnce();
    instance.close(); classifier.close();
  });

  it("refuses a new socket at the daily limit without reserving a connection", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => false });
    const usage = { canAdmit: vi.fn(async () => false), record: vi.fn(() => false) };
    const instance = relay(classifier, usage);
    await expect(instance.prepareSocket({ actorId: "user_without_computer", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=opaque`,
      incomingHeaders: {}, externalHost: "app.matrix-os.com" })).rejects.toBeInstanceOf(RelayAccountLimitError);
    expect(instance.connectionCounts().actors).toBe(0);
    instance.close(); classifier.close();
  });

  it("drains an open socket when metered bytes cross the 110 percent hard stop", async () => {
    const classifier = new RelayAccountClassifier({ ownsActiveComputer: async () => false });
    const usage = { canAdmit: vi.fn(async () => true), record: vi.fn((_actor: string, _machineFree: boolean, delta: { bytes?: number }) => (delta.bytes ?? 0) > 0) };
    const instance = relay(classifier, usage);
    const prepared = await instance.prepareSocket({ actorId: "user_without_computer", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=opaque`,
      incomingHeaders: {}, externalHost: "app.matrix-os.com" });
    const close = vi.fn();
    prepared!.onEvict(close);
    prepared!.record(10);
    prepared!.record(10);
    expect(close).toHaveBeenCalledOnce();
    expect(usage.record).toHaveBeenCalledTimes(2);
    expect(instance.connectionCounts().actors).toBe(0);
    instance.close(); classifier.close();
  });

  it("returns 429 before issuing a connection ticket at the daily limit", async () => {
    const issue = vi.fn(async () => ({ ticket: "opaque" }));
    const app = createPlatformCollaborationDirectRoutes({
      endpoints: {} as CollaborationRuntimeEndpointRegistry,
      controlStream: {} as CollaborationControlStream,
      issuer: { issue } as unknown as CollaborationTicketIssuer,
      relayOrigin: "https://app.matrix-os.com",
      resolveActor: async () => "user_without_computer",
      authenticateRuntime: async () => null,
      resolveRelayHandle: async () => null,
      admitAccount: async () => false,
    });
    const response = await app.request("/api/collaboration/connections", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "relay_limit", retryAfterSeconds: expect.any(Number) });
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(issue).not.toHaveBeenCalled();
  });
});
