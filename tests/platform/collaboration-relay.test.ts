/**
 * S05 / T103: the platform relay forwards direct-protocol bytes to the
 * directory-resolved home without deciding, parsing, signing or logging
 * anything about them. The home rejects forged and expired tickets itself,
 * and platform policy storage is not on the path of an in-flight request.
 */
import { describe, expect, it, vi } from "vitest";
import { CollaborationRelay, parseRelayRoute, parseRelaySocketPath, RELAY_RUNTIME_HEADER, type RelayMetadata } from "../../packages/platform/src/collaboration/relay.js";
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

  it("relays exact owner catalog resolution to the named runtime", () => {
    expect(parseRelayRoute("POST", "/api/collaboration/runtimes/runtime_owner/catalog/resolve"))
      .toEqual({ kind: "runtime", identifier: "runtime_owner" });
    expect(parseRelayRoute("GET", "/api/collaboration/runtimes/runtime_owner/catalog/resolve")).toBeNull();
    expect(parseRelayRoute("POST", "/api/collaboration/runtimes/runtime_owner/catalog/resolve/extra")).toBeNull();
    const encoded = "vps%3A11111111-1111-4111-8111-111111111111";
    expect(parseRelayRoute("POST", `/api/collaboration/runtimes/${encoded}/catalog/resolve`))
      .toEqual({ kind: "runtime", identifier: "vps:11111111-1111-4111-8111-111111111111" });
    expect(parseRelayRoute("POST", `/api/collaboration/runtimes/${encoded}/scopes/preflight`))
      .toEqual({ kind: "runtime", identifier: "vps:11111111-1111-4111-8111-111111111111" });
    expect(parseRelayRoute("POST", `/api/collaboration/runtimes/${encoded}/scopes`))
      .toEqual({ kind: "runtime", identifier: "vps:11111111-1111-4111-8111-111111111111" });
    expect(parseRelayRoute("POST", "/api/collaboration/runtimes/vps%2Fother/catalog/resolve")).toBeNull();
    expect(parseRelayRoute("POST", "/api/collaboration/owner-runtime/sessions")).toEqual({ kind: "session" });
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
