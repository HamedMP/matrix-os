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
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { CollaborationDirectError, createCollaborationDirectClient } from "../../packages/ui/src/collaboration/direct-client.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { CLIENT_ORIGIN, PLATFORM, RELAY, actorId, fakeDirectWorld, otherScopeId, runtimeId, scopeId, type Json } from "../helpers/collaboration-direct-world.js";

describe("collaboration direct client", () => {
  let world: ReturnType<typeof fakeDirectWorld>;
  beforeEach(() => { world = fakeDirectWorld(); });
  afterEach(() => { vi.useRealTimers(); });

  const client = (extra: Record<string, unknown> = {}) => createCollaborationDirectClient({
    platformBaseUrl: PLATFORM, fetchImpl: world.fetchImpl, webSocketFactory: world.webSocketFactory, clientOrigin: CLIENT_ORIGIN, now: world.now,
    getHeaders: async () => ({ Authorization: "Bearer actor-token" }), ...extra,
  });

  it("routes session exchange, renewal and close through the real relay's runtime directory", async () => {
    const home = { runtimeId, origin: "https://owner-home.example" };
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => id === scopeId ? home : null,
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async (id) => id === runtimeId ? home : null,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const body = init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init?.body;
        return world.fetchImpl(new URL(url.pathname + url.search, RELAY).href, { ...init, body });
      }) as typeof fetch,
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === PLATFORM) return world.fetchImpl(input, init);
      if (url.origin !== RELAY) return new Response(null, { status: 404 });
      return relay.forward({
        actorId, method: init?.method ?? "GET", path: url.pathname, query: url.search.slice(1),
        headers: new Headers(init?.headers), body: typeof init?.body === "string" ? new TextEncoder().encode(init.body) : null,
      });
    }) as typeof fetch;
    const direct = client({ fetchImpl });
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`))
      .resolves.toMatchObject({ id: "chat-1" });
    world.advance(245_000);
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`))
      .resolves.toMatchObject({ id: "chat-1" });
    const lifecycle = world.home.requests.filter((request) => request.url.includes("/direct-sessions"));
    expect(lifecycle.map((request) => request.method)).toEqual(["POST", "POST"]);
    direct.close(scopeId);
    await vi.waitFor(() => expect(world.home.requests.some((request) => request.method === "DELETE" && request.url.includes("/direct-sessions/"))).toBe(true));
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

  it("evicts old scope records when many resources are visited", async () => {
    const direct = client();
    const ids = Array.from({ length: 129 }, (_, index) => `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
    for (const id of ids) await direct.request(id, "GET", `/api/collaboration/scopes/${id}`);
    expect(direct.inspectKeys(ids[0]!)).toBeNull();
    expect(direct.inspectKeys(ids.at(-1)!)).not.toBeNull();
  });

  const manyScopes = (count: number) => Array.from({ length: count }, (_, index) => `20000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
  const eventHandlers = () => ({ onEvent: vi.fn(), onUnavailable: vi.fn() });
  const ready = (id: string, sequence: string) => ({ data: JSON.stringify({ version: 1, type: "ready", scopeId: id, resourceId: "chat-1", authorityGeneration: "3", sequence }) });
  const terminalProjection = () => ({
    id: "terminal-1", scopeId, incarnation: `terminal-${"a".repeat(32)}`, executionGeneration: "4",
    status: "active" as const, createdBy: { actorId: "user_owner", displayName: "Owner" },
    createdAt: "2026-09-11T11:00:00.000Z",
  });
  const socketFor = (id: string) => world.sockets.find((socket) => socket.url.includes(`/scopes/${id}/`))!;

  it("forgets closed stream scopes so the scope cap never evicts a live stream in their place", async () => {
    vi.useFakeTimers();
    const direct = client();
    const ids = manyScopes(129);
    for (const id of ids.slice(0, 128)) direct.subscribeEvents(id, eventHandlers());
    await vi.waitFor(() => expect(world.sockets).toHaveLength(128));
    direct.close(ids[0]!);
    expect(socketFor(ids[0]!).close).toHaveBeenCalled();
    direct.subscribeEvents(ids[128]!, eventHandlers());
    await vi.waitFor(() => expect(world.sockets).toHaveLength(129));
    for (const id of ids.slice(1)) expect(socketFor(id).close).not.toHaveBeenCalled();
  });

  it("keeps a scope's live streams at the per-scope cap, stopping the oldest as each new one opens", async () => {
    // The cap has to be effective, not decorative: pushing well past it must leave exactly the
    // cap's worth of sockets still running, and each evicted stream must actually be stopped
    // rather than merely selected. Each stream is opened before the next subscribes, so the
    // victims are live sockets rather than connections that never got dialled.
    vi.useFakeTimers();
    const direct = client();
    const perScopeCap = 8;
    const overshoot = 5;
    for (let index = 0; index < perScopeCap + overshoot; index += 1) {
      direct.subscribeEvents(scopeId, eventHandlers());
      await vi.waitFor(() => expect(world.sockets).toHaveLength(index + 1));
    }
    const opened = world.sockets.filter((socket) => socket.url.includes(`/scopes/${scopeId}/`));
    expect(opened).toHaveLength(perScopeCap + overshoot);
    const live = opened.filter((socket) => socket.close.mock.calls.length === 0);
    expect(live).toHaveLength(perScopeCap);
    // The oldest registrations are the ones that went, in order.
    expect(opened.slice(0, overshoot).every((socket) => socket.close.mock.calls.length > 0)).toBe(true);
    expect(opened.slice(overshoot)).toEqual(live);
    // Every survivor is still tracked under its scope: closing the scope stops all of them.
    direct.close(scopeId);
    expect(live.every((socket) => socket.close.mock.calls.length > 0)).toBe(true);
  });

  it("evicts the least recently active stream scope, not the oldest registration, when the scope cap is reached", async () => {
    vi.useFakeTimers();
    const direct = client();
    const ids = manyScopes(129);
    for (const id of ids.slice(0, 128)) direct.subscribeEvents(id, eventHandlers());
    await vi.waitFor(() => expect(world.sockets).toHaveLength(128));
    await vi.advanceTimersByTimeAsync(1_000);
    for (const id of ids.slice(0, 128)) { socketFor(id).onopen?.(); socketFor(id).onmessage?.(ready(id, "1")); }
    await vi.advanceTimersByTimeAsync(1_000);
    socketFor(ids[5]!).onmessage?.(ready(ids[5]!, "2"));
    direct.subscribeEvents(ids[128]!, eventHandlers());
    await vi.waitFor(() => expect(world.sockets).toHaveLength(129));
    expect(socketFor(ids[5]!).close).not.toHaveBeenCalled();
    expect(ids.slice(0, 128).filter((id) => socketFor(id).close.mock.calls.length > 0)).toHaveLength(1);
  });

  it("drops an event stream whose server heartbeats stopped and reconnects with a fresh ticket", async () => {
    vi.useFakeTimers();
    const direct = client();
    const states: string[] = [];
    direct.subscribeEvents(scopeId, { ...eventHandlers(), onConnectionChange: (state) => states.push(state) });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    const socket = world.sockets[0]!;
    socket.onopen?.();
    socket.onmessage?.(ready(scopeId, "4"));
    await vi.advanceTimersByTimeAsync(30_000);
    socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "heartbeat", scopeId, resourceId: "chat-1", authorityGeneration: "3", sequence: "4" }) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    expect(states).toContain("reconnecting");
    expect(new URL(world.sockets[1]!.url).searchParams.get("after")).toBe("4");
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "events")).toHaveLength(2);
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(world.sockets).toHaveLength(2);
  });

  it("drops a terminal stream whose sends stop draining and reconnects with a fresh ticket", async () => {
    vi.useFakeTimers();
    const direct = client();
    const disconnected = vi.fn();
    direct.subscribeTerminal(scopeId, { onReady: vi.fn(), onOutput: vi.fn(), onState: vi.fn(), onRefreshRequired: vi.fn(), onUnavailable: vi.fn(), onDisconnected: disconnected });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    const socket = world.sockets[0]! as typeof world.sockets[number] & { bufferedAmount?: number };
    socket.onopen?.();
    const keepalive = () => socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "terminal.state", scopeId, resourceId: "terminal-1", authorityGeneration: "1", incarnation: `terminal-${"a".repeat(32)}`, sequence: "4", terminal: terminalProjection() }) });
    for (let tick = 0; tick < 6; tick += 1) { await vi.advanceTimersByTimeAsync(20_000); keepalive(); }
    expect(socket.close).not.toHaveBeenCalled();
    // Sends stop draining: the socket is dropped even though the home is still heard on it.
    socket.bufferedAmount = 64;
    for (let tick = 0; tick < 6; tick += 1) { await vi.advanceTimersByTimeAsync(20_000); keepalive(); }
    expect(socket.close).toHaveBeenCalled();
    expect(disconnected).toHaveBeenCalled();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "terminal")).toHaveLength(2);
  });

  it("judges a terminal stream by its own socket: a healthy event stream does not vouch for it", async () => {
    vi.useFakeTimers();
    const direct = client();
    const disconnected = vi.fn();
    direct.subscribeEvents(scopeId, eventHandlers());
    direct.subscribeTerminal(scopeId, { onReady: vi.fn(), onOutput: vi.fn(), onState: vi.fn(), onRefreshRequired: vi.fn(), onUnavailable: vi.fn(), onDisconnected: disconnected });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    const events = world.sockets.find((socket) => socket.url.includes("/events"))!;
    const terminal = world.sockets.find((socket) => socket.url.includes("/terminal"))!;
    events.onopen?.();
    terminal.onopen?.();
    events.onmessage?.(ready(scopeId, "4"));
    // Separate sockets fail separately. The event stream keeps hearing the home while the
    // terminal socket hears nothing, so the terminal must still be dropped and re-dialed.
    for (let tick = 0; tick < 6; tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      events.onmessage?.({ data: JSON.stringify({ version: 1, type: "heartbeat", scopeId, resourceId: "chat-1", authorityGeneration: "3", sequence: "4" }) });
    }
    expect(events.close).not.toHaveBeenCalled();
    expect(terminal.close).toHaveBeenCalled();
    expect(disconnected).toHaveBeenCalled();
    await vi.waitFor(() => expect(world.platform.tickets.filter((ticket) => ticket.purpose === "terminal")).toHaveLength(2));
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "events")).toHaveLength(1);
  });

  it("re-dials a terminal-only scope whose socket goes quiet instead of leaving it disconnected", async () => {
    vi.useFakeTimers();
    const direct = client();
    const disconnected = vi.fn();
    direct.subscribeTerminal(scopeId, { onReady: vi.fn(), onOutput: vi.fn(), onState: vi.fn(), onRefreshRequired: vi.fn(), onUnavailable: vi.fn(), onDisconnected: disconnected });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    const terminal = world.sockets[0]!;
    terminal.onopen?.();
    // No event stream exists to speak for this scope, so nothing but the terminal socket's own
    // frames can prove the home is there. Silence past the window must re-dial, not sit forever.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(terminal.close).toHaveBeenCalled();
    expect(disconnected).toHaveBeenCalled();
    await vi.waitFor(() => expect(world.sockets).toHaveLength(2));
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "terminal")).toHaveLength(2);
  });

  it("keeps an idle terminal stream alive on the home's own keepalive state frames", async () => {
    vi.useFakeTimers();
    const direct = client();
    const disconnected = vi.fn();
    direct.subscribeTerminal(scopeId, { onReady: vi.fn(), onOutput: vi.fn(), onState: vi.fn(), onRefreshRequired: vi.fn(), onUnavailable: vi.fn(), onDisconnected: disconnected });
    await vi.waitFor(() => expect(world.sockets).toHaveLength(1));
    const terminal = world.sockets[0]!;
    terminal.onopen?.();
    // The home gives a silent terminal connection a state frame; nothing is dropped while they arrive.
    for (let tick = 0; tick < 6; tick += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      terminal.onmessage?.({ data: JSON.stringify({ version: 1, type: "terminal.state", scopeId, resourceId: "terminal-1", authorityGeneration: "1", incarnation: `terminal-${"a".repeat(32)}`, sequence: "4", terminal: terminalProjection() }) });
    }
    expect(terminal.close).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    expect(world.platform.tickets.filter((ticket) => ticket.purpose === "terminal")).toHaveLength(1);
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
