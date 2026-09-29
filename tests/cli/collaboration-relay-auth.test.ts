/**
 * The platform relay names the actor before it forwards a direct-protocol request, so the CLI
 * must present the relay the bearer it already presents for ticket issuance, and only while the
 * relay is the platform origin. These tests drive the real CLI transport and command through the
 * real platform routes, actor resolver (platform sync JWTs) and relay to a fake home.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformCollaborationDirectRoutes } from "../../packages/platform/src/collaboration/direct-routes.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { createJourneyUserResolver } from "../../packages/platform/src/journey-routes.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { createCliCollaborationTransport } from "../../packages/sync-client/src/cli/collaboration-direct-transport.js";
import { collaborationRequest, watchCollaborationTerminal } from "../../packages/sync-client/src/cli/commands/collaboration.js";
import { PLATFORM, RELAY, actorId, fakeDirectWorld, runtimeId, scopeId } from "../helpers/collaboration-direct-world.js";

const SYNC_SECRET = "cli-collaboration-relay-auth-sync-secret-0123456789";
const HOME = { runtimeId, origin: "https://203.0.113.10:443" };

async function token(secret = SYNC_SECRET): Promise<string> {
  return (await issueSyncJwt({ secret, clerkUserId: actorId, handle: "member", gatewayUrl: PLATFORM })).token;
}

/** The real platform collaboration routes with the relay on the platform origin, as in production. */
function platformStack() {
  const world = fakeDirectWorld();
  const access = { revoked: false };
  const relay = new CollaborationRelay({
    resolveScopeHome: async (id) => (id === scopeId ? HOME : null),
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async (id) => (id === runtimeId ? HOME : null),
    // The relay dials the home's own address; the fake home answers there.
    fetchImpl: (async (input: string, init: RequestInit) => {
      const target = new URL(input);
      const body = init.body == null ? undefined : await new Response(init.body as BodyInit).text();
      return world.fetchImpl(`${RELAY}${target.pathname}${target.search}`, { method: init.method, headers: init.headers, ...(body ? { body } : {}) });
    }) as typeof fetch,
  });
  const verified = createJourneyUserResolver({ syncJwtSecret: SYNC_SECRET });
  const resolveActor = async (c: Parameters<typeof verified>[0]) => (access.revoked ? null : verified(c));
  const app = new Hono();
  app.route("/", createPlatformCollaborationRoutes({
    repository: {} as never, relay, resolveActor,
    authenticateRuntime: async () => null, resolveParticipant: async () => null, resolveInvitationIdentifier: async () => null,
  }));
  app.route("/", createPlatformCollaborationDirectRoutes({
    endpoints: {} as never, controlStream: {} as never, relayOrigin: PLATFORM, resolveActor,
    authenticateRuntime: async () => null, resolveRelayHandle: async () => null,
    issuer: {
      publicKeys: () => [],
      // The fake platform signs the ticket; production names the platform relay as the endpoint.
      issue: async ({ request }: { request: unknown }) => {
        const issued = await world.fetchImpl(`${PLATFORM}/api/collaboration/connections`, { method: "POST", body: JSON.stringify(request) });
        const body = await issued.json() as { endpoint: { origin: string } };
        return { ...body, endpoint: { ...body.endpoint, origin: PLATFORM } };
      },
    } as never,
  }));
  const sent: Array<{ url: string; headers: Headers }> = [];
  /** Node's fetch as the CLI sees it: only the platform origin is reachable here. */
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url: url.href, headers: new Headers(init?.headers) });
    if (url.origin !== PLATFORM) throw new TypeError("fetch failed");
    return app.request(`${url.pathname}${url.search}`, init);
  });
  return { world, access, fetchImpl, sent };
}

describe("CLI direct transport at the platform relay", () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("authenticates session exchange and signed requests at the relay with the CLI's bearer", async () => {
    const { world, fetchImpl, sent } = platformStack();
    const bearer = await token();
    const direct = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl, now: world.now });

    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`))
      .resolves.toEqual({ id: "chat-1", scopeId, title: "Design review" });
    await expect(direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/chat/messages`, { text: "hello" }))
      .resolves.toMatchObject({ accepted: true });
    // Ticket, session exchange and both signed requests went to the platform, each with the bearer.
    expect(sent.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/collaboration/connections", "/api/collaboration/direct-sessions",
      `/api/collaboration/scopes/${scopeId}/chat`, `/api/collaboration/scopes/${scopeId}/chat/messages`,
    ]);
    for (const request of sent) expect(request.headers.get("authorization")).toBe(`Bearer ${bearer}`);
    // The relay stripped it before the home saw any request.
    expect(world.home.requests).toHaveLength(3);
    for (const request of world.home.requests) expect(request.headers.has("authorization")).toBe(false);
  });

  it("tells the user to run `matrix login` when the platform refuses the CLI's credential", async () => {
    const { world, fetchImpl } = platformStack();
    const forged = await token("a-different-secret-that-the-platform-never-issued-with");
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl as typeof fetch);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(world.now());
    const failure = await collaborationRequest({
      platformUrl: PLATFORM, token: forged, method: "GET", path: `/api/collaboration/scopes/${scopeId}/chat`,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "auth_rejected" });
    expect((failure as Error).message).toContain("matrix login");
    expect(world.home.requests).toHaveLength(0);
  });

  it("tells the user to run `matrix login` when the relay stops recognizing a signed-in CLI", async () => {
    const { world, access, fetchImpl } = platformStack();
    const bearer = await token();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl as typeof fetch);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(world.now());
    const path = `/api/collaboration/scopes/${scopeId}/chat`;
    await collaborationRequest({ platformUrl: PLATFORM, token: bearer, method: "GET", path });
    const homeRequests = world.home.requests.length;
    access.revoked = true;
    const failure = await collaborationRequest({ platformUrl: PLATFORM, token: bearer, method: "GET", path }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "auth_rejected" });
    expect((failure as Error).message).toContain("matrix login");
    expect(world.home.requests).toHaveLength(homeRequests);
  });

  it("stops on the relay's own sign-in challenge without re-ticketing, and never takes one from another origin", async () => {
    const bearer = await token();
    const challenge = () => new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="matrix-os"' },
    });
    // The relay on the platform origin answers a signed request with its challenge.
    const relayed = fakeDirectWorld();
    let challengeSigned = false;
    const onPlatform = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/api/collaboration/connections") {
        const response = await relayed.fetchImpl(input, init);
        const body = await response.json() as { endpoint: { origin: string } };
        return Response.json({ ...body, endpoint: { ...body.endpoint, origin: PLATFORM } }, { status: response.status });
      }
      if (challengeSigned && url.pathname.startsWith("/api/collaboration/scopes/")) return challenge();
      return relayed.fetchImpl(`${RELAY}${url.pathname}${url.search}`, init);
    });
    const direct = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl: onPlatform, now: relayed.now });
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    challengeSigned = true;
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`)).rejects.toMatchObject({ code: "auth_rejected" });
    expect(relayed.platform.tickets).toHaveLength(1);

    // A home on another origin cannot pass itself off as the platform: its 401 is a session end, retried once.
    const remote = fakeDirectWorld();
    const offPlatform = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.origin === RELAY && url.pathname.startsWith("/api/collaboration/scopes/")) return challenge();
      return remote.fetchImpl(input, init);
    });
    const other = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl: offPlatform, now: remote.now });
    const failure = await other.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`).catch((error: unknown) => error);
    expect(failure).not.toMatchObject({ code: "auth_rejected" });
    expect(remote.platform.tickets).toHaveLength(2);
  });

  it("never writes the bearer to any log or error, on success or failure", async () => {
    const { world, access, fetchImpl } = platformStack();
    const bearer = await token();
    const direct = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl, now: world.now });
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    // A failed renewal is logged, then recovered with a fresh session.
    world.home.renewFails = true;
    world.advance(245_000);
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    world.advance(245_000);
    access.revoked = true;
    const failures = await Promise.all([
      direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`).catch((error: unknown) => error),
      direct.terminal(scopeId).catch((error: unknown) => error),
    ]);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(JSON.stringify({ message: (failure as Error).message, stack: (failure as Error).stack })).not.toContain(bearer);
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(bearer);
  });

  it("presents the bearer on the relayed terminal upgrade, and to no other origin", async () => {
    const { world, fetchImpl } = platformStack();
    const bearer = await token();
    const direct = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl, now: world.now });
    const connection = await direct.terminal(scopeId);
    expect(new URL(connection.url).origin).toBe("wss://app.matrix-os.com");
    expect(connection.headers).toEqual({ authorization: `Bearer ${bearer}` });

    const opened: Array<{ url: string; options: unknown }> = [];
    class Socket {
      constructor(url: string, options?: unknown) { opened.push({ url, options }); }
      on() { return this; }
      send() { /* no frames in this test */ }
      close() { /* no frames in this test */ }
    }
    void watchCollaborationTerminal({
      platformUrl: PLATFORM, token: bearer, scopeId, transport: { request: vi.fn(), terminal: async () => connection } as never,
      WebSocketImpl: Socket as never, writeOutput: vi.fn(), writeState: vi.fn(),
    });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]!.options).toEqual({ headers: { authorization: `Bearer ${bearer}` } });

    // A home served from any other origin -- here the separate relay the fake platform names -- gets nothing.
    const elsewhere = fakeDirectWorld();
    const direct2 = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl: elsewhere.fetchImpl, now: elsewhere.now });
    const remote = await direct2.terminal(scopeId);
    expect(new URL(remote.url).origin).toBe("wss://relay.matrix-os.com");
    expect(remote.headers).toEqual({});
  });

  it.each([
    ["a separate relay host", RELAY],
    ["the platform host on another port", "https://app.matrix-os.com:8443"],
    ["a look-alike host", "https://app.matrix-os.com.attacker.example"],
  ])("never sends the bearer to %s", async (_label, endpoint) => {
    const world = fakeDirectWorld();
    const bearer = await token();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.origin === PLATFORM) {
        const response = await world.fetchImpl(input, init);
        const body = await response.json() as { endpoint: { origin: string } };
        return Response.json({ ...body, endpoint: { ...body.endpoint, origin: endpoint } }, { status: response.status });
      }
      return world.fetchImpl(`${RELAY}${url.pathname}${url.search}`, init);
    });
    const direct = createCliCollaborationTransport({ platformUrl: PLATFORM, token: bearer, fetchImpl, now: world.now });
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    const offPlatform = fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).origin !== PLATFORM);
    expect(offPlatform.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of offPlatform) expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect((await direct.terminal(scopeId)).headers).toEqual({});
  });
});
