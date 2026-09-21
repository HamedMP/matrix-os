/**
 * S06 / T030: the shared direct client dials the origin the resource
 * directory returns (never a hardcoded one), exchanges a platform ticket
 * for a home session with Web Crypto proof of possession, signs every
 * request, renews before the session cap, reconnects with a fresh ticket,
 * surfaces safe typed errors, and keeps discovery metadata-only with content
 * hydrated from the home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { possessionPayload, verifyEd25519 } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { CollaborationDirectError, createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { CLIENT_ORIGIN, PLATFORM, RELAY, fakeDirectWorld, otherScopeId, scopeId, type Json } from "../helpers/collaboration-direct-world.js";

describe("collaboration direct client", () => {
  let world: ReturnType<typeof fakeDirectWorld>;
  beforeEach(() => { world = fakeDirectWorld(); });
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
    socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "refresh_required", scopeId, resourceId: "chat-1", authorityGeneration: "3", sequence: "8" }) });
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

  it("stops revoked event and terminal streams without obtaining another ticket", async () => {
    vi.useFakeTimers();
    const direct = client();
    const unavailable = vi.fn();
    direct.subscribeEvents(scopeId, { onEvent: vi.fn(), onUnavailable: unavailable });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    const events = world.sockets[0]!;
    events.onmessage?.({ data: JSON.stringify({ version: 1, type: "unavailable", scopeId, resourceId: "chat-1", authorityGeneration: "3", code: "revoked" }) });
    expect(unavailable).toHaveBeenCalledTimes(1);
    events.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.sockets).toHaveLength(1);
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "events")).toHaveLength(1);

    direct.subscribeTerminal(otherScopeId, { onReady: vi.fn(), onOutput: vi.fn(), onState: vi.fn(), onRefreshRequired: vi.fn(), onUnavailable: unavailable, onDisconnected: vi.fn() });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    const terminal = world.sockets[1]!;
    terminal.onmessage?.({ data: JSON.stringify({ version: 1, type: "terminal.unavailable", scopeId: otherScopeId, resourceId: "terminal-1", authorityGeneration: "3", incarnation: "terminal-1", code: "revoked" }) });
    terminal.onmessage?.({ data: JSON.stringify({ version: 1, type: "terminal.output", scopeId: otherScopeId, resourceId: "terminal-1", authorityGeneration: "3", incarnation: "terminal-1", sequence: "1", data: "late" }) });
    terminal.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(world.sockets).toHaveLength(2);
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "terminal")).toHaveLength(1);
  });

  it("fences an exchange completed after sign-out and does not restore its session", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await world.fetchImpl(input, init);
      if (String(input).includes("/api/collaboration/direct-sessions?")) { entered(); await gate; }
      return response;
    }) as typeof fetch;
    const direct = client({ fetchImpl });
    const pending = direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    await reached;
    direct.close();
    release();
    await expect(pending).rejects.toMatchObject({ code: "denied" });
    expect(direct.describe(scopeId).state).toBe("idle");
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toMatchObject({ code: "denied" });
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
      const keys = direct.inspectKeys(scopeId);
      expect(keys?.privateKey.extractable).toBe(false);
      direct.close();
      expect(direct.describe(scopeId).state).toBe("idle");
      await vi.waitFor(() => expect(world.home.requests.some((request) => request.method === "DELETE" && request.url.includes("/direct-sessions/"))).toBe(true));
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});
