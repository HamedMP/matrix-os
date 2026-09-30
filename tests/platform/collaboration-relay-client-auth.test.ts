/**
 * The platform relay names the actor before it forwards a direct-protocol request, so the web and
 * Electron direct clients must present the relay the same platform credentials they present for
 * ticket issuance, and only while the relay is the platform origin. These tests drive the real
 * direct client through the real platform routes, actor resolver and relay to a fake home.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGatewayCors, installHeaderInjection } from "@desktop/main/auth/header-injection";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { createPlatformCollaborationDirectRoutes } from "../../packages/platform/src/collaboration/direct-routes.js";
import { CollaborationRelay, RELAY_RUNTIME_HEADER } from "../../packages/platform/src/collaboration/relay.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { createJourneyUserResolver } from "../../packages/platform/src/journey-routes.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { actorId, CLIENT_ORIGIN, PLATFORM, fakeDirectWorld, runtimeId, scopeId, type Json } from "../helpers/collaboration-direct-world.js";

const SYNC_SECRET = "collaboration-relay-client-auth-sync-secret-0123456789";
const CLERK_SESSION = "clerk-session-token-for-the-member";
const HOME = { runtimeId, origin: "https://203.0.113.10:443" };
/** Request headers a browser sends cross-origin without a preflight (content-type only for these values). */
const SAFELISTED_CONTENT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
const SAFELISTED_RESPONSE_HEADERS = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);

type HeadersReceived = { responseHeaders?: Record<string, string[]>; statusLine?: string };

function relayStack() {
  const world = fakeDirectWorld({ endpointOrigin: PLATFORM });
  const home = { accessEnded: false };
  const homeFetch = vi.fn(async (input: string, init: RequestInit) => {
    const target = new URL(input);
    const body = init.body == null ? undefined : await new Response(init.body as BodyInit).text();
    if (home.accessEnded) {
      // A home that ended access; it also tries to pass itself off as a platform challenge.
      return new Response(JSON.stringify({ error: "Collaboration request denied" }), {
        status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer realm=\"home\"" },
      });
    }
    return world.fetchImpl(`${PLATFORM}${target.pathname}${target.search}`, { method: init.method, headers: init.headers, ...(body ? { body } : {}) });
  });
  const relay = new CollaborationRelay({
    resolveScopeHome: async (id) => (id === scopeId ? HOME : null),
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async (id) => (id === runtimeId ? HOME : null),
    fetchImpl: homeFetch as never,
  });
  const resolveActor = createJourneyUserResolver({
    clerkAuth: createClerkAuth({
      verifyToken: async (token) => {
        if (token !== CLERK_SESSION) throw new Error("invalid session");
        return { sub: actorId };
      },
    }),
    syncJwtSecret: SYNC_SECRET,
  });
  const app = new Hono();
  app.route("/", createPlatformCollaborationRoutes({
    repository: {} as never,
    relay,
    resolveActor,
    authenticateRuntime: async () => null,
    resolveParticipant: async () => null,
    resolveInvitationIdentifier: async () => null,
    allowedOrigins: [PLATFORM],
  }));
  app.route("/", createPlatformCollaborationDirectRoutes({
    endpoints: {} as never,
    controlStream: {} as never,
    relayOrigin: PLATFORM,
    issuer: { issue: async ({ request }: { request: unknown }) => world.issue(request as Json), publicKeys: () => [] } as never,
    resolveActor,
    authenticateRuntime: async () => null,
    resolveRelayHandle: async () => null,
  }));
  return { world, home, homeFetch, app };
}

/** The web shell on the platform origin: the browser attaches the platform cookie only as `credentials` allows. */
function browserFetch(app: Hono, cookie: { value: string | null }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const sameOrigin = url.origin === CLIENT_ORIGIN;
    const credentials = init?.credentials ?? "same-origin";
    if (cookie.value && (credentials === "include" || (credentials === "same-origin" && sameOrigin))) headers.set("cookie", cookie.value);
    if (!sameOrigin || (method !== "GET" && method !== "HEAD")) headers.set("origin", CLIENT_ORIGIN);
    if (url.origin !== PLATFORM) throw new TypeError("Failed to fetch");
    return app.request(`${url.pathname}${url.search}`, { method, headers, ...(init?.body == null ? {} : { body: init.body }) });
  });
}

/**
 * The packaged Electron renderer (file://, origin "null"): the trusted core injects the device credential
 * for the gateway origin and answers CORS for it; Chromium preflights non-safelisted headers and exposes
 * only safelisted or explicitly exposed response headers to the renderer.
 */
function electronRendererFetch(app: Hono, token: () => string | null) {
  let beforeSend: ((details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void) | undefined;
  let headersReceived: ((details: { url: string; method: string; responseHeaders?: Record<string, string[]> }, callback: (response: HeadersReceived) => void) => void) | undefined;
  const session = {
    webRequest: {
      onBeforeSendHeaders: (listener: typeof beforeSend) => { beforeSend = listener; },
      onHeadersReceived: (listener: typeof headersReceived) => { headersReceived = listener; },
    },
  };
  installHeaderInjection(session as never, token, () => PLATFORM, "null");
  installGatewayCors(session as never, () => PLATFORM, "null");
  const received = (url: string, method: string, responseHeaders: Record<string, string[]>) =>
    new Promise<HeadersReceived>((resolve) => headersReceived!({ url, method, responseHeaders }, resolve));
  const header = (result: HeadersReceived, name: string) =>
    Object.entries(result.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]?.join(", ") ?? "";
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const requestHeaders: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { requestHeaders[name] = value; });
    const unsafe = Object.entries(requestHeaders)
      .filter(([name, value]) => !(name === "accept" || (name === "content-type" && SAFELISTED_CONTENT_TYPES.has(value))))
      .map(([name]) => name);
    if (unsafe.length > 0 || !["GET", "HEAD", "POST"].includes(method)) {
      const preflight = await received(url.href, "OPTIONS", {});
      const allowedHeaders = header(preflight, "access-control-allow-headers").toLowerCase().split(/,\s*/);
      const allowedMethods = header(preflight, "access-control-allow-methods").split(/,\s*/);
      if (preflight.statusLine !== "HTTP/1.1 200 OK" || header(preflight, "access-control-allow-origin") !== "null"
        || !unsafe.every((name) => allowedHeaders.includes(name)) || !allowedMethods.includes(method)) {
        throw new TypeError("Failed to fetch");
      }
    }
    const sent = await new Promise<Record<string, string>>((resolve) => beforeSend!({ url: url.href, requestHeaders: { ...requestHeaders } }, (response) => resolve(response.requestHeaders)));
    const headers = new Headers(sent);
    headers.set("origin", "null");
    const response = await app.request(`${url.pathname}${url.search}`, { method, headers, ...(init?.body == null ? {} : { body: init.body }) });
    const raw: Record<string, string[]> = {};
    response.headers.forEach((value, name) => { raw[name] = [value]; });
    const cors = await received(url.href, method, raw);
    if (header(cors, "access-control-allow-origin") !== "null") throw new TypeError("Failed to fetch");
    const exposed = header(cors, "access-control-expose-headers").toLowerCase().split(/,\s*/);
    const visible = new Headers();
    response.headers.forEach((value, name) => { if (SAFELISTED_RESPONSE_HEADERS.has(name) || exposed.includes(name)) visible.set(name, value); });
    return new Response(response.body, { status: response.status, headers: visible });
  });
}

describe("platform relay actor authentication for direct clients", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  function expectNoPlatformCredentialsAtHome(world: ReturnType<typeof fakeDirectWorld>) {
    expect(world.home.requests.length).toBeGreaterThan(0);
    for (const request of world.home.requests) {
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("origin")).toBe(false);
    }
  }

  it("exchanges a web session and relays signed requests for the cookie-authenticated actor", async () => {
    const { world, app } = relayStack();
    const cookie = { value: `__session=${CLERK_SESSION}` };
    const direct = createCollaborationDirectClient({ platformBaseUrl: PLATFORM, fetchImpl: browserFetch(app, cookie), clientOrigin: CLIENT_ORIGIN, now: world.now });

    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).resolves.toMatchObject({ id: scopeId });
    await expect(direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/chat/messages`, { text: "hello" }))
      .resolves.toMatchObject({ accepted: true });
    expect(direct.describe(scopeId)).toMatchObject({ state: "connected", origin: PLATFORM });
    // Session exchange plus both signed requests reached the home, none carrying a platform credential.
    expect(world.home.requests).toHaveLength(3);
    expectNoPlatformCredentialsAtHome(world);
  });

  it("authenticates Electron relay requests with the trusted-core credential it uses for tickets", async () => {
    const { world, app } = relayStack();
    const { token } = await issueSyncJwt({ secret: SYNC_SECRET, clerkUserId: actorId, handle: "member", gatewayUrl: PLATFORM });
    const renderer = electronRendererFetch(app, () => token);
    const direct = createCollaborationDirectClient({ platformBaseUrl: PLATFORM, fetchImpl: renderer, clientOrigin: new URL(PLATFORM).origin, now: world.now });

    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).resolves.toMatchObject({ id: scopeId });
    await expect(direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/chat/messages`, { text: "hello" }))
      .resolves.toMatchObject({ accepted: true });
    expect(direct.describe(scopeId).state).toBe("connected");
    expectNoPlatformCredentialsAtHome(world);
  });

  it("rejects a cookie-authenticated relay mutation from a disallowed or missing origin before any home sees it", async () => {
    const { app, homeFetch } = relayStack();
    const send = (origin?: string) => app.request(`/api/collaboration/direct-sessions?scope=${scopeId}`, {
      method: "POST",
      headers: {
        cookie: `__session=${CLERK_SESSION}`, "content-type": "application/json", [RELAY_RUNTIME_HEADER]: runtimeId,
        ...(origin ? { origin } : {}),
      },
      body: "{}",
    });

    expect((await send("https://attacker.example")).status).toBe(403);
    expect((await send("null")).status).toBe(403);
    expect((await send()).status).toBe(403);
    expect(homeFetch).not.toHaveBeenCalled();
    // The configured origin passes the check and the request is relayed (the home rejects the empty body itself).
    await send(PLATFORM);
    expect(homeFetch).toHaveBeenCalledTimes(1);
  });

  it("reports reauthentication, not ended access, when the platform session lapses at the relay", async () => {
    const { world, app } = relayStack();
    const cookie: { value: string | null } = { value: `__session=${CLERK_SESSION}` };
    const direct = createCollaborationDirectClient({ platformBaseUrl: PLATFORM, fetchImpl: browserFetch(app, cookie), clientOrigin: CLIENT_ORIGIN, now: world.now });
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    const homeRequests = world.home.requests.length;

    cookie.value = null;
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(direct.describe(scopeId).state).toBe("unauthenticated");
    expect(world.home.requests).toHaveLength(homeRequests);

    // Signing back in resumes on the same home session.
    cookie.value = `__session=${CLERK_SESSION}`;
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).resolves.toMatchObject({ id: scopeId });
    expect(direct.describe(scopeId).state).toBe("connected");
    expect(world.home.sessions.size).toBe(1);
  });

  it("lets the Electron renderer read the relay's sign-in challenge when its device credential lapses", async () => {
    const { world, app } = relayStack();
    const { token } = await issueSyncJwt({ secret: SYNC_SECRET, clerkUserId: actorId, handle: "member", gatewayUrl: PLATFORM });
    const credential: { value: string | null } = { value: token };
    const direct = createCollaborationDirectClient({
      platformBaseUrl: PLATFORM, fetchImpl: electronRendererFetch(app, () => credential.value), clientOrigin: new URL(PLATFORM).origin, now: world.now,
    });
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    const tickets = world.platform.tickets.length;

    credential.value = "a-revoked-device-credential-that-no-longer-verifies";
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(direct.describe(scopeId).state).toBe("unauthenticated");
    // The challenge was readable, so the client neither re-ticketed nor dropped its home session.
    expect(world.platform.tickets).toHaveLength(tickets);
    credential.value = token;
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).resolves.toMatchObject({ id: scopeId });
    expect(world.home.sessions.size).toBe(1);
  });

  it("reports reauthentication when the platform refuses the ticket for a signed-out actor", async () => {
    const { world, app } = relayStack();
    const direct = createCollaborationDirectClient({ platformBaseUrl: PLATFORM, fetchImpl: browserFetch(app, { value: null }), clientOrigin: CLIENT_ORIGIN, now: world.now });
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(direct.describe(scopeId).state).toBe("unauthenticated");
    expect(world.platform.tickets).toHaveLength(0);
  });

  it("keeps a home's own rejection as ended access even when the home imitates a platform challenge", async () => {
    const { world, home, app } = relayStack();
    const direct = createCollaborationDirectClient({
      platformBaseUrl: PLATFORM, fetchImpl: browserFetch(app, { value: `__session=${CLERK_SESSION}` }), clientOrigin: CLIENT_ORIGIN, now: world.now,
    });
    home.accessEnded = true;
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toMatchObject({ code: "denied" });
    expect(direct.describe(scopeId).state).toBe("denied");
  });
});
