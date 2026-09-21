/**
 * S06 / T030: the shared direct client dials the origin the resource
 * directory returns (never a hardcoded one), exchanges a platform ticket
 * for a home session with Web Crypto proof of possession, signs every
 * request, renews before the session cap, reconnects with a fresh ticket,
 * surfaces safe typed errors, and keeps discovery metadata-only with content
 * hydrated from the home.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { possessionPayload, proofKeyThumbprint, requestSigningPayload, sha256Hex, verifyEd25519 } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { CollaborationDirectError, createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";

const PLATFORM = "https://app.matrix-os.com";
const RELAY = "https://relay.matrix-os.com";
const CLIENT_ORIGIN = "https://app.matrix-os.com";
const scopeId = "10000000-0000-4000-8000-000000000101";
const otherScopeId = "10000000-0000-4000-8000-000000000102";
const actorId = "user_member";
const organizationId = "org_direct_1";
const runtimeId = "vps-11111111-1111-4111-8111-111111111111";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));
void generateKeyPairSync;

type Json = Record<string, unknown>;

interface HomeState {
  generation: number;
  sessions: Map<string, { publicKey: string; scopeId: string; expiresAt: string; renewAfter: string; generation: number }>;
  consumed: Set<string>;
  offline: boolean;
  protocolVersion: number;
  nextSessionTtlMs: number;
  requests: Array<{ method: string; url: string; headers: Headers; body: string }>;
  renewFails: boolean;
}

function fakeWorld() {
  const home: HomeState = {
    generation: 3, sessions: new Map(), consumed: new Set(), offline: false, protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
    nextSessionTtlMs: 300_000, requests: [], renewFails: false,
  };
  const platform = { tickets: [] as Json[], offlineScopes: new Set<string>(), inbox: [] as Json[], shared: [] as Json[] };
  let clock = Date.parse("2026-09-21T10:00:00.000Z");
  const now = () => new Date(clock);
  const advance = (ms: number) => { clock += ms; };
  const signTicket = (ticket: Json) => ({ ticket, keyId: "k1", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) });
  const issue = (body: Json) => {
    const issuedAt = now();
    const ticket = {
      protocolVersion: home.protocolVersion, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""), actorId, organizationId,
      resource: { scopeId: body.scopeId, kind: "chat" }, purpose: body.purpose, runtime: { runtimeId, authorityGeneration: home.generation },
      proofKeyThumbprint: proofKeyThumbprint(body.proofPublicKey as string), maxActions: 1000,
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
    };
    platform.tickets.push(ticket);
    return { signedTicket: signTicket(ticket), endpoint: { origin: RELAY, protocolVersion: home.protocolVersion } };
  };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const sessionFor = (ticket: Json, publicKey: string, previous?: string) => {
    const id = previous ?? randomUUID();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + home.nextSessionTtlMs).toISOString();
    const renewAfter = new Date(issuedAt.getTime() + home.nextSessionTtlMs - 60_000).toISOString();
    const session = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, id, actorId, organizationId, scopeId: (ticket.resource as Json).scopeId as string, runtimeId,
      authorityGeneration: (ticket.runtime as Json).authorityGeneration as number, purpose: "direct_session", proofKeyThumbprint: ticket.proofKeyThumbprint,
      issuedAt: issuedAt.toISOString(), expiresAt, evidenceExpiresAt: new Date(issuedAt.getTime() + 20_000).toISOString(), renewAfter,
    };
    home.sessions.set(id, { publicKey, scopeId: session.scopeId, expiresAt, renewAfter, generation: session.authorityGeneration });
    return session;
  };
  const verifyTicket = (signed: Json): Json | null => {
    const ticket = signed.ticket as Json;
    if (!verifyEd25519(ed25519PublicKeyRaw(platformKey), ticketSigningPayload(ticket), signed.signature as string)) return null;
    if (home.consumed.has(ticket.nonce as string)) return null;
    if (Date.parse(ticket.expiresAt as string) <= clock) return null;
    return ticket;
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.origin === PLATFORM) {
      if (url.pathname === "/api/collaboration/connections" && method === "POST") {
        const parsed = JSON.parse(body) as Json;
        if (platform.offlineScopes.has(parsed.scopeId as string)) return json({ error: "Collaboration unavailable" }, 503);
        return json(issue(parsed), 201);
      }
      if (url.pathname === "/api/collaboration/inbox") return json({ items: platform.inbox });
      if (url.pathname === "/api/collaboration/shared") return json({ items: platform.shared });
      return json({ error: "not found" }, 404);
    }
    if (url.origin !== RELAY) return json({ error: "wrong origin" }, 404);
    home.requests.push({ method, url: url.href, headers, body });
    if (home.offline) return json({ error: "Collaboration unavailable" }, 503);
    if (url.pathname === "/api/collaboration/direct-sessions" && method === "POST") {
      const parsed = JSON.parse(body) as Json;
      if (((parsed.signedTicket as Json).ticket as Json).protocolVersion !== COLLABORATION_DIRECT_PROTOCOL_VERSION) return json({ error: "upgrade_required" }, 426);
      const ticket = verifyTicket(parsed.signedTicket as Json);
      if (!ticket || url.searchParams.get("scope") !== (ticket.resource as Json).scopeId) return json({ error: "Collaboration request denied" }, 401);
      if (parsed.clientOrigin !== CLIENT_ORIGIN) return json({ error: "Collaboration request denied" }, 401);
      if (proofKeyThumbprint(parsed.proofPublicKey as string) !== ticket.proofKeyThumbprint) return json({ error: "denied" }, 401);
      if (!verifyEd25519(parsed.proofPublicKey as string, possessionPayload({ ticketNonce: ticket.nonce as string, purpose: "direct_session" }), parsed.possession as string)) return json({ error: "denied" }, 401);
      home.consumed.add(ticket.nonce as string);
      return json(sessionFor(ticket, parsed.proofPublicKey as string), 201);
    }
    const renew = /^\/api\/collaboration\/direct-sessions\/([^/]+)\/renew$/.exec(url.pathname);
    if (renew && method === "POST") {
      if (home.renewFails) return json({ error: "Collaboration unavailable" }, 503);
      const record = home.sessions.get(renew[1]!);
      const parsed = JSON.parse(body) as Json;
      const ticket = verifyTicket(parsed.signedTicket as Json);
      if (!record || !ticket) return json({ error: "denied" }, 401);
      home.consumed.add(ticket.nonce as string);
      return json(sessionFor(ticket, record.publicKey, renew[1]!));
    }
    // Signed scope request.
    const sessionId = headers.get("x-matrix-collaboration-session");
    const encoded = headers.get("x-matrix-collaboration-request");
    const record = sessionId ? home.sessions.get(sessionId) : undefined;
    if (!record || !encoded) return json({ error: "Collaboration request denied" }, 401);
    if (Date.parse(record.expiresAt) <= clock) { home.sessions.delete(sessionId!); return json({ error: "Collaboration request denied" }, 401); }
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { signature: Json; proof: string };
    const signature = envelope.signature;
    const ok = signature.sessionId === sessionId && signature.method === method && signature.path === url.pathname
      && signature.query === url.search.slice(1) && signature.bodyDigest === sha256Hex(new TextEncoder().encode(body))
      && Math.abs(Date.parse(signature.issuedAt as string) - clock) <= 35_000
      && verifyEd25519(record.publicKey, requestSigningPayload(signature), envelope.proof);
    if (!ok) return json({ error: "Collaboration request denied" }, 401);
    if (record.generation !== home.generation) { home.sessions.delete(sessionId!); return json({ error: "Collaboration request denied" }, 401); }
    if (url.pathname === `/api/collaboration/scopes/${record.scopeId}/chat`) return json({ id: "chat-1", scopeId: record.scopeId, title: "Design review" });
    if (url.pathname === `/api/collaboration/scopes/${record.scopeId}`) return json({ id: record.scopeId, kind: "chat", role: "editor" });
    if (url.pathname.endsWith("/chat/messages") && method === "POST") return json({ accepted: true, echo: JSON.parse(body) });
    if (url.pathname.startsWith("/api/collaboration/invitations/")) return json({ id: url.pathname.split("/")[4], revision: "4", role: "editor", owner: { displayName: "Owner" } });
    return json({ error: "not found" }, 404);
  });
  const sockets: Array<{ url: string; sent: string[]; onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn>; send: (value: string) => void }> = [];
  const webSocketFactory = (url: string) => {
    const socket = {
      url, sent: [] as string[], onopen: null, onmessage: null, onclose: null, onerror: null,
      close: vi.fn(), send: (value: string) => { socket.sent.push(value); },
    };
    sockets.push(socket as never);
    return socket as unknown as WebSocket;
  };
  return { home, platform, fetchImpl, webSocketFactory, sockets, now, advance, verifyTicket };
}

describe("collaboration direct client", () => {
  let world: ReturnType<typeof fakeWorld>;
  beforeEach(() => { world = fakeWorld(); });
  afterEach(() => { vi.useRealTimers(); });

  const client = (extra: Record<string, unknown> = {}) => createCollaborationDirectClient({
    platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl, webSocketFactory: world.webSocketFactory, clientOrigin: CLIENT_ORIGIN, now: world.now,
    getHeaders: async () => ({ Authorization: "Bearer actor-token" }), ...extra,
  });

  it("dials the directory-resolved origin with a one-use ticket and proof of possession, then signs requests", async () => {
    const direct = client();
    const chat = await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    expect(chat).toEqual({ id: "chat-1", scopeId, title: "Design review" });
    const connection = world.fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/api/collaboration/connections"))!;
    expect(String(connection[0]).startsWith(PLATFORM)).toBe(true);
    expect(new Headers(connection[1]?.headers).get("authorization")).toBe("Bearer actor-token");
    const issued = JSON.parse(connection[1]?.body as string) as Json;
    expect(issued.proofPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.purpose).toBe("direct_session");
    const exchange = world.home.requests[0]!;
    expect(exchange.url).toBe(`${RELAY}/api/collaboration/direct-sessions?scope=${scopeId}`);
    expect(exchange.headers.get("authorization")).toBeNull();
    const signed = world.home.requests[1]!;
    expect(signed.headers.get("x-matrix-collaboration-session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(signed.headers.get("authorization")).toBeNull();
    expect(signed.url).not.toContain("ticket");
    expect(direct.describe(scopeId).state).toBe("connected");
    // The same session is reused for the next request: no second ticket.
    await direct.request(scopeId, "POST", `/api/collaboration/scopes/${scopeId}/chat/messages`, { text: "hi" });
    expect(world.platform.tickets).toHaveLength(1);
    const post = world.home.requests.at(-1)!;
    expect(JSON.parse(post.body)).toEqual({ text: "hi" });
  });

  it("routes each scope to its own home session and never to the selected computer", async () => {
    const direct = client();
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    await direct.request(otherScopeId, "GET", `/api/collaboration/scopes/${otherScopeId}`);
    expect(world.platform.tickets.map((ticket) => (ticket.resource as Json).scopeId)).toEqual([scopeId, otherScopeId]);
    expect(world.home.sessions.size).toBe(2);
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${otherScopeId}`)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(direct.request(scopeId, "GET", "/api/private/files")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("obtains a fresh ticket when the endpoint generation changes and retries once", async () => {
    const direct = client();
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    world.home.generation = 4;
    const scope = await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    expect(scope).toEqual({ id: scopeId, kind: "chat", role: "editor" });
    expect(world.platform.tickets).toHaveLength(2);
    expect((world.platform.tickets[1]!.runtime as Json).authorityGeneration).toBe(4);
    expect(direct.describe(scopeId).state).toBe("connected");
    // A denial that persists is not retried again and surfaces as a safe error.
    world.home.generation = 5;
    world.home.offline = false;
    world.platform.offlineScopes.add(scopeId);
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toBeInstanceOf(CollaborationDirectError);
  });

  it("reports an offline home safely and does not fall back to the platform", async () => {
    world.platform.offlineScopes.add(scopeId);
    const direct = client();
    const failure = await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CollaborationDirectError);
    expect((failure as CollaborationDirectError).code).toBe("host_offline");
    expect((failure as Error).message).not.toMatch(/relay|postgres|clerk/i);
    expect(direct.describe(scopeId).state).toBe("offline");
    expect(world.home.requests).toHaveLength(0);
    expect(world.fetchImpl.mock.calls.some(([url]) => String(url).includes(`/api/collaboration/scopes/${scopeId}`))).toBe(false);
  });

  it("renews before the session cap with a fresh ticket and reconnects when renewal fails", async () => {
    const direct = client();
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    const first = world.home.requests[1]!.headers.get("x-matrix-collaboration-session");
    world.advance(245_000);
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    expect(world.platform.tickets).toHaveLength(2);
    expect(world.home.requests.some((request) => request.url.endsWith(`/direct-sessions/${first}/renew?scope=${scopeId}`))).toBe(true);
    expect(world.home.requests.at(-1)!.headers.get("x-matrix-collaboration-session")).toBe(first);
    world.advance(245_000);
    world.home.renewFails = true;
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    const latest = world.home.requests.at(-1)!.headers.get("x-matrix-collaboration-session");
    expect(latest).not.toBe(first);
    expect(world.platform.tickets).toHaveLength(4);
  });

  it("tells old clients to upgrade instead of retrying", async () => {
    world.home.protocolVersion = 3;
    const direct = client();
    const failure = await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`).catch((error: unknown) => error);
    expect((failure as CollaborationDirectError).code).toBe("upgrade_required");
    expect(direct.describe(scopeId).state).toBe("upgrade_required");
    expect(world.home.requests.filter((request) => request.url.includes("direct-sessions"))).toHaveLength(0);
  });

  it("opens event streams with a purpose ticket, proves possession in the first frame and reconnects with a new ticket", async () => {
    vi.useFakeTimers();
    const direct = client();
    const onEvent = vi.fn();
    const states: string[] = [];
    const stop = direct.subscribeEvents(scopeId, { onEvent, onUnavailable: vi.fn(), onConnectionChange: (state) => states.push(state) });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    const socket = world.sockets[0]!;
    const url = new URL(socket.url);
    expect(url.origin).toBe("wss://relay.matrix-os.com");
    expect(url.pathname).toBe(`/ws/collaboration/direct/scopes/${scopeId}/events`);
    const ticket = JSON.parse(Buffer.from(url.searchParams.get("ticket")!, "base64url").toString("utf8")) as Json;
    expect((ticket.ticket as Json).purpose).toBe("events");
    expect(url.searchParams.get("after")).toBe("0");
    socket.onopen?.();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const handshake = JSON.parse(socket.sent[0]!) as Json;
    const sessionId = handshake.sessionId as string;
    const record = world.home.sessions.get(sessionId)!;
    expect(handshake).toMatchObject({ protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "handshake", ticketNonce: (ticket.ticket as Json).nonce });
    expect(verifyEd25519(record.publicKey, possessionPayload({ ticketNonce: (ticket.ticket as Json).nonce as string, purpose: "events", sessionId }), handshake.possession as string)).toBe(true);
    socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "ready", scopeId, resourceId: "chat-1", authorityGeneration: "3", sequence: "7" }) });
    socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "changed", scopeId, resourceId: "chat-1", authorityGeneration: "3", sequence: "8" }) });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(states).toContain("connected");
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    const reconnect = new URL(world.sockets[1]!.url);
    expect(reconnect.searchParams.get("ticket")).not.toBe(url.searchParams.get("ticket"));
    expect(reconnect.searchParams.get("after")).toBe("8");
    expect(world.platform.tickets.filter((issued) => issued.purpose === "events")).toHaveLength(2);
    stop();
    expect(world.sockets[1]!.close).toHaveBeenCalled();
  });

  it("keeps discovery metadata-only on the platform and hydrates content from the home", async () => {
    world.platform.shared = [{ scopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind: "chat", authorityGeneration: 3, status: "accepted" }];
    world.platform.inbox = [{ scopeId: otherScopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind: "chat", authorityGeneration: 3, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }];
    world.platform.offlineScopes.add(otherScopeId);
    const api = createCollaborationDirectApi({ platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl, webSocketFactory: world.webSocketFactory, clientOrigin: CLIENT_ORIGIN, now: world.now });
    const shared = await api.get("/api/collaboration/shared") as { items: Json[] };
    expect(shared.items[0]).toMatchObject({ scopeId, status: "accepted", resource: { scope: { id: scopeId }, chat: { title: "Design review" } } });
    const inbox = await api.get("/api/collaboration/inbox") as { items: Json[] };
    expect(inbox.items[0]).toMatchObject({ scopeId: otherScopeId, status: "invited", home: "offline" });
    expect(inbox.items[0]!.resource).toBeUndefined();
    expect(world.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/api/collaboration/shared")).every(([url]) => String(url).startsWith(PLATFORM))).toBe(true);
    // Invitation routes reach the home of the scope the inbox named.
    world.platform.offlineScopes.delete(otherScopeId);
    const invitation = await api.get("/api/collaboration/invitations/20000000-0000-4000-8000-000000000001") as Json;
    expect(invitation.role).toBe("editor");
    expect(world.home.requests.at(-1)!.url).toBe(`${RELAY}/api/collaboration/invitations/20000000-0000-4000-8000-000000000001`);
  });

  it("stores nothing reusable: keys stay in memory and non-extractable, nothing touches browser storage", async () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
    try {
      const direct = client();
      await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem).not.toHaveBeenCalled();
      const keys = direct.debugKeys(scopeId);
      expect(keys?.privateKey.extractable).toBe(false);
      direct.close();
      expect(direct.describe(scopeId).state).toBe("idle");
      expect(world.home.requests.some((request) => request.method === "DELETE" && request.url.includes("/direct-sessions/"))).toBe(true);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});
