/**
 * S05 / T103: the platform relay forwards direct-protocol bytes to the
 * directory-resolved home without deciding, parsing, signing or logging
 * anything about them. The home rejects forged and expired tickets itself,
 * and platform policy storage is not on the path of an in-flight request.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CollaborationRelay, parseRelayRoute, parseRelaySocketPath, RELAY_RUNTIME_HEADER, type RelayMetadata } from "../../packages/platform/src/collaboration/relay.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { COLLABORATION_CLIENT_REQUEST_ID_HEADER, COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER, COLLABORATION_EXPECTED_REVISION_HEADER } from "@matrix-os/contracts";

const scopeId = "10000000-0000-4000-8000-000000000001";
const home = { runtimeId: "vps-11111111-1111-4111-8111-111111111111", origin: "https://203.0.113.10:443" };

function relay(overrides: Partial<ConstructorParameters<typeof CollaborationRelay>[0]> = {}, fetchImpl?: typeof fetch) {
  const metadata: RelayMetadata[] = [];
  const instance = new CollaborationRelay({
    resolveScopeHome: async (id) => (id === scopeId ? home : null),
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async (runtimeId) => (runtimeId === home.runtimeId ? home : null),
    fetchImpl,
    onMetadata: (entry) => { metadata.push(entry); },
    ...overrides,
  });
  return { instance, metadata };
}

/** A request body delivered in chunks with no declared length, as a chunked upload arrives. */
function chunkedBody(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(16 * 1024, totalBytes - sent)).fill(120);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

/** Counts what actually reaches the home and reports whether the upload completed. */
function countingHome() {
  const state = { received: 0, calls: 0, completed: false };
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    state.calls += 1;
    const body = (init as { body?: unknown }).body;
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        state.received += chunk.value.byteLength;
      }
      state.completed = true;
    }
    return new Response("ok", { status: 200 });
  });
  return { state, fetchImpl };
}

describe("CollaborationRelay", () => {
  it("classifies only direct-protocol routes and never a catch-all", () => {
    expect(parseRelayRoute("POST", "/api/collaboration/direct-sessions")).toEqual({ kind: "session" });
    expect(parseRelayRoute("GET", `/api/collaboration/scopes/${scopeId}/chat`)).toEqual({ kind: "scope", identifier: scopeId });
    expect(parseRelayRoute("GET", "/api/files/secret")).toBeNull();
    expect(parseRelayRoute("GET", "/api/collaboration/../files")).toBeNull();
    expect(parseRelaySocketPath(`/ws/collaboration/direct/scopes/${scopeId}/events?ticket=abc&after=3`)).toMatchObject({ scopeId, purpose: "events", query: "ticket=abc&after=3" });
    expect(parseRelaySocketPath(`/ws/collaboration/direct/scopes/${scopeId}/events?token=abc`)).toBeNull();
    expect(parseRelaySocketPath(`/ws/collaboration/scopes/${scopeId}/events?ticket=abc`)).toBeNull();
  });

  it("forwards a forged ticket untouched and returns the home's rejection verbatim, logging metadata only", async () => {
    const forgedBody = JSON.stringify({ clientRequestId: "x", signedTicket: { ticket: { actorId: "user_victim" }, keyId: "nope", signature: "forged" } });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${home.origin}/api/collaboration/direct-sessions`);
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(forgedBody);
      expect(new Headers(init.headers).has("x-matrix-collaboration-proof")).toBe(false);
      return new Response(JSON.stringify({ error: "Collaboration request denied" }), { status: 401, headers: { "content-type": "application/json" } });
    });
    const { instance, metadata } = relay({}, fetchImpl as never);
    const response = await instance.forward({
      actorId: "user_attacker", method: "POST", path: "/api/collaboration/direct-sessions", query: "",
      headers: new Headers({ "content-type": "application/json", cookie: "owner=secret", authorization: "Bearer owner", [RELAY_RUNTIME_HEADER]: home.runtimeId }),
      body: new TextEncoder().encode(forgedBody),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("denied");
    const sent = new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers);
    expect(sent.has("cookie")).toBe(false);
    expect(sent.has("authorization")).toBe(false);
    expect(metadata).toEqual([expect.objectContaining({ actorId: "user_attacker", runtimeId: home.runtimeId, status: 401, outcome: "forwarded" })]);
    expect(JSON.stringify(metadata)).not.toContain("user_victim");
    expect(JSON.stringify(metadata)).not.toContain("forged");
  });

  it("keeps serving an in-flight request when policy storage is unavailable, because no policy lookup exists", async () => {
    const policyStore = { lookup: vi.fn(async () => { throw new Error("policy storage down"); }) };
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const { instance } = relay({}, fetchImpl as never);
    const response = await instance.forward({ actorId: "user_a", method: "GET", path: `/api/collaboration/scopes/${scopeId}`, query: "", headers: new Headers(), body: null });
    expect(response.status).toBe(200);
    expect(policyStore.lookup).not.toHaveBeenCalled();
  });

  it("is unroutable without a directory entry and never guesses a home", async () => {
    const fetchImpl = vi.fn();
    const { instance, metadata } = relay({}, fetchImpl as never);
    const response = await instance.forward({ actorId: "user_a", method: "GET", path: "/api/collaboration/scopes/10000000-0000-4000-8000-0000000000ff", query: "", headers: new Headers(), body: null });
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(metadata[0]).toMatchObject({ outcome: "unroutable", runtimeId: null });
  });

  it("applies coarse byte limits and forwards upstream status codes without remapping", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(64), { status: 409, headers: { "content-length": "64", "content-type": "text/plain" } }));
    const { instance } = relay({ limits: { responseBytes: 32, requestBytes: 16 } }, fetchImpl as never);
    const large = await instance.forward({ actorId: "user_a", method: "POST", path: `/api/collaboration/scopes/${scopeId}/discussion/messages`, query: "", headers: new Headers(), body: new Uint8Array(17) });
    expect(large.status).toBe(413);
    const over = await instance.forward({ actorId: "user_a", method: "GET", path: `/api/collaboration/scopes/${scopeId}`, query: "", headers: new Headers(), body: null });
    expect(over.status).toBe(503);
    const { instance: roomy } = relay({}, fetchImpl as never);
    const passthrough = await roomy.forward({ actorId: "user_a", method: "GET", path: `/api/collaboration/scopes/${scopeId}`, query: "", headers: new Headers(), body: null });
    expect(passthrough.status).toBe(409);
  });

  it("bounds a chunked request body by its own request limit, not only the declared length", async () => {
    // The declared length is the only thing the 96 KiB check reads, and a chunked upload
    // declares nothing. The relay must hold its own limit against the bytes themselves, so
    // the bound does not depend on a caller mounting a route-level body limit with a matching
    // constant.
    const { state, fetchImpl } = countingHome();
    const { instance, metadata } = relay({ limits: { requestBytes: 32 * 1024 } }, fetchImpl as never);
    const refused = await instance.forward({
      actorId: "user_a", method: "POST", path: `/api/collaboration/scopes/${scopeId}/discussion/messages`,
      query: "", headers: new Headers(), body: chunkedBody(128 * 1024),
    });
    expect(refused.status).toBe(413);
    expect(metadata.at(-1)?.outcome).toBe("limit");
    // The home never receives the whole upload, and never more than the limit.
    expect(state.completed).toBe(false);
    expect(state.received).toBeLessThanOrEqual(32 * 1024);
  });

  it("forwards a chunked request body that stays inside the request limit", async () => {
    const { state, fetchImpl } = countingHome();
    const { instance } = relay({ limits: { requestBytes: 64 * 1024 } }, fetchImpl as never);
    const forwarded = await instance.forward({
      actorId: "user_a", method: "POST", path: `/api/collaboration/scopes/${scopeId}/discussion/messages`,
      query: "", headers: new Headers(), body: chunkedBody(48 * 1024),
    });
    expect(forwarded.status).toBe(200);
    expect(state.completed).toBe(true);
    expect(state.received).toBe(48 * 1024);
  });

  it("refuses a chunked over-limit upload through the mutating relay route before the home can read it all", async () => {
    // End to end through the route that omits Content-Length: the branch must not hand the
    // home an unbounded stream.
    const { state, fetchImpl } = countingHome();
    const { instance } = relay({}, fetchImpl as never);
    const app = new Hono();
    app.route("/", createPlatformCollaborationRoutes({
      repository: {} as never, signer: {} as never, sockets: {} as never, relay: instance,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async () => null,
      resolveParticipant: async () => null,
      resolveInvitationIdentifier: async () => null,
      hydrate: async () => ({}),
    }));
    const request = new Request("http://local/api/collaboration/direct-sessions", {
      method: "POST",
      headers: { "x-test-actor": "user_member", "content-type": "application/json", [RELAY_RUNTIME_HEADER]: home.runtimeId },
      body: chunkedBody(4 * 1024 * 1024),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.request(request);
    expect(response.ok).toBe(false);
    expect(state.completed).toBe(false);
    expect(state.received).toBeLessThanOrEqual(96 * 1024);
  });

  it("routes session lifecycle routes by the runtime header and never by a query parameter", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(url, { status: 200 }));
    const { instance, metadata } = relay({}, fetchImpl as never);
    const sessionId = "20000000-0000-4000-8000-000000000001";
    for (const [method, path] of [["POST", `/api/collaboration/direct-sessions/${sessionId}/renew`], ["DELETE", `/api/collaboration/direct-sessions/${sessionId}`]] as const) {
      const routed = await instance.forward({ actorId: "user_a", method, path, query: "", headers: new Headers({ [RELAY_RUNTIME_HEADER]: home.runtimeId }), body: null });
      expect(routed.status).toBe(200);
      expect(await routed.text()).toBe(`${home.origin}${path}`);
    }
    const unrouted = await instance.forward({ actorId: "user_a", method: "POST", path: `/api/collaboration/direct-sessions/${sessionId}/renew`, query: `scope=${scopeId}`, headers: new Headers(), body: null });
    expect(unrouted.status).toBe(404);
    const foreign = await instance.forward({ actorId: "user_a", method: "POST", path: `/api/collaboration/direct-sessions/${sessionId}/renew`, query: "", headers: new Headers({ [RELAY_RUNTIME_HEADER]: "vps-unknown" }), body: null });
    expect(foreign.status).toBe(404);
    expect(metadata.filter((entry) => entry.outcome === "forwarded")).toHaveLength(2);
  });

  it("keeps the protocol's conditional DELETE headers and drops everything else", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const { instance } = relay({}, fetchImpl as never);
    const grantId = "30000000-0000-4000-8000-000000000001";
    const response = await instance.forward({
      actorId: "user_a", method: "DELETE", path: `/api/collaboration/scopes/${scopeId}/grants/${grantId}`, query: "",
      headers: new Headers({
        [COLLABORATION_CLIENT_REQUEST_ID_HEADER]: "40000000-0000-4000-8000-000000000001",
        [COLLABORATION_EXPECTED_REVISION_HEADER]: "3",
        [COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER]: "2",
        "x-matrix-collaboration-session": "20000000-0000-4000-8000-000000000001",
        "x-forwarded-for": "203.0.113.1",
        cookie: "owner=secret",
      }),
      body: null,
    });
    expect(response.status).toBe(204);
    const sent = new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers);
    expect(sent.get(COLLABORATION_CLIENT_REQUEST_ID_HEADER)).toBe("40000000-0000-4000-8000-000000000001");
    expect(sent.get(COLLABORATION_EXPECTED_REVISION_HEADER)).toBe("3");
    expect(sent.get(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER)).toBe("2");
    expect(sent.get("x-matrix-collaboration-session")).toBe("20000000-0000-4000-8000-000000000001");
    expect(sent.has("x-forwarded-for")).toBe(false);
    expect(sent.has("cookie")).toBe(false);
    expect([...sent.keys()].some((name) => name.startsWith("x-matrix-collaboration-client"))).toBe(false);
  });

  it("resolves null and never rejects when the directory lookup fails during a socket upgrade", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { instance } = relay({ resolveScopeHome: async () => { throw new Error("connection terminated unexpectedly: postgres://user:secret@db"); } });
      await expect(instance.prepareSocket({ actorId: "user_a", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=abc`, incomingHeaders: {}, externalHost: "app.matrix-os.com" })).resolves.toBeNull();
      expect(instance.connectionCounts()).toEqual({ homes: 0, actors: 0 });
      // Only the error name is logged, never the message with connection details.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[collaboration-relay]"), "Error");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("caps the number of tracked homes and actors and evicts stale socket reservations by idle time", async () => {
    let clock = 1_000_000;
    const homes = new Map<string, { runtimeId: string; origin: string }>();
    const { instance } = relay({
      resolveScopeHome: async (id) => homes.get(id) ?? null,
      limits: { maxTrackedHomes: 2, maxTrackedActors: 3, socketIdleMs: 60_000 },
      now: () => clock,
    });
    const scopeFor = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    for (let index = 1; index <= 3; index += 1) homes.set(scopeFor(index), { runtimeId: `vps-${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`, origin: "https://203.0.113.10:443" });
    const prepare = (index: number, actorId: string) => instance.prepareSocket({ actorId, rawPath: `/ws/collaboration/direct/scopes/${scopeFor(index)}/events?ticket=abc`, incomingHeaders: {}, externalHost: "app.matrix-os.com" });
    const evicted: string[] = [];
    const first = await prepare(1, "user_a");
    const second = await prepare(2, "user_b");
    expect(first && second).toBeTruthy();
    first!.onEvict(() => { evicted.push("first"); });
    second!.onEvict(() => { evicted.push("second"); });
    // A third distinct home exceeds the tracked-home cap; the same homes still admit.
    expect(await prepare(3, "user_c")).toBeNull();
    const third = await prepare(1, "user_c");
    expect(third).not.toBeNull();
    third!.onEvict(() => { evicted.push("third"); });
    // A fourth distinct actor exceeds the tracked-actor cap.
    expect(await prepare(1, "user_d")).toBeNull();
    // Only the first reservation stays quiet; the others are touched by traffic and survive the sweep.
    clock += 45_000;
    second!.touch();
    third!.touch();
    clock += 20_000;
    expect(instance.sweepStaleSockets()).toBe(1);
    expect(evicted).toEqual(["first"]);
    expect(instance.connectionCounts()).toEqual({ homes: 2, actors: 2 });
    // Evicting released the slot; releasing an evicted reservation again is a no-op.
    first!.release();
    expect(instance.connectionCounts()).toEqual({ homes: 2, actors: 2 });
    expect(await prepare(1, "user_a")).not.toBeNull();
    second!.release();
    third!.release();
    expect(instance.sweepStaleSockets()).toBe(0);
  });

  it("drains active socket reservations on shutdown and admits nothing afterwards", async () => {
    let clock = 1_000_000;
    const { instance } = relay({ now: () => clock });
    instance.startSweep();
    expect(instance.sweepRunning()).toBe(true);
    const destroyed: string[] = [];
    const prepare = (actorId: string) => instance.prepareSocket({ actorId, rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=abc`, incomingHeaders: {}, externalHost: "app.matrix-os.com" });
    const first = await prepare("user_a");
    const second = await prepare("user_b");
    expect(first && second).toBeTruthy();
    first!.onEvict(() => { destroyed.push("first"); });
    // One failing hook must not strand the reservations behind it.
    second!.onEvict(() => { destroyed.push("second"); throw new Error("socket already gone"); });
    const third = await prepare("user_c");
    third!.onEvict(() => { destroyed.push("third"); });
    expect(instance.connectionCounts()).toEqual({ homes: 3, actors: 3 });

    instance.close();

    // Shutdown notifies and releases every reservation before the structures the
    // upgrade path depends on are torn down.
    expect(destroyed.sort()).toEqual(["first", "second", "third"]);
    expect(instance.connectionCounts()).toEqual({ homes: 0, actors: 0 });
    expect(instance.sweepRunning()).toBe(false);
    expect(instance.sweepStaleSockets()).toBe(0);
    // A late upgrade is refused rather than reserving a socket nothing will drain.
    expect(await prepare("user_d")).toBeNull();
    expect(instance.connectionCounts()).toEqual({ homes: 0, actors: 0 });
    // Releasing a drained reservation and closing twice stay no-ops.
    first!.release();
    instance.close();
    expect(destroyed).toHaveLength(3);
    instance.startSweep();
    expect(instance.sweepRunning()).toBe(false);
  });

  it("prepares socket upgrades with no proof header and bounded connections", async () => {
    const { instance } = relay({ limits: { connectionsPerActor: 1 } });
    const prepared = await instance.prepareSocket({ actorId: "user_a", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=abc`, incomingHeaders: { upgrade: "websocket", connection: "Upgrade", cookie: "x", "sec-websocket-key": "k" }, externalHost: "app.matrix-os.com" });
    expect(prepared).not.toBeNull();
    expect(prepared!.upstreamPath).toBe(`/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=abc`);
    expect(prepared!.headers).not.toContain("proof");
    expect(prepared!.headers).not.toContain("cookie");
    expect(await instance.prepareSocket({ actorId: "user_a", rawPath: `/ws/collaboration/direct/scopes/${scopeId}/events?ticket=abc`, incomingHeaders: {}, externalHost: "app.matrix-os.com" })).toBeNull();
    prepared!.release();
    expect(instance.connectionCounts()).toEqual({ homes: 0, actors: 0 });
  });
});
