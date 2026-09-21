import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { possessionPayload, verifyEd25519 } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createCliCollaborationTransport } from "../../packages/sync-client/src/cli/collaboration-direct-transport.js";
import { collaborationRequest } from "../../packages/sync-client/src/cli/commands/collaboration.js";
import { CLIENT_ORIGIN, PLATFORM, RELAY, fakeDirectWorld, scopeId } from "../helpers/collaboration-direct-world.js";

describe("525 CLI direct transport compatibility", () => {
  let world: ReturnType<typeof fakeDirectWorld>;
  beforeEach(() => { world = fakeDirectWorld(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const transport = () => createCliCollaborationTransport({
    platformUrl: PLATFORM, token: "actor-token", fetchImpl: world.fetchImpl, now: world.now,
    clientOrigin: CLIENT_ORIGIN,
  });

  it("exchanges a v2 ticket at the directory origin and signs home content without an owner bearer", async () => {
    const direct = transport();
    expect(await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`))
      .toEqual({ id: "chat-1", scopeId, title: "Design review" });
    expect(world.platform.tickets).toHaveLength(1);
    expect(world.platform.tickets[0]).toMatchObject({ resource: { scopeId }, purpose: "direct_session" });
    expect(world.home.requests[0]?.url).toBe(`${RELAY}/api/collaboration/direct-sessions?scope=${scopeId}`);
    expect(world.home.requests[0]?.headers.get("authorization")).toBeNull();
    expect(world.home.requests[1]?.headers.get("authorization")).toBeNull();
    expect(world.home.requests[1]?.headers.get("x-matrix-collaboration-session")).toMatch(/^[0-9a-f-]{36}$/);
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    expect(world.platform.tickets).toHaveLength(1);
  });

  it("renews before expiry and never sends a content request to the platform on home denial", async () => {
    const direct = transport();
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    world.advance(245_000);
    await direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`);
    expect(world.platform.tickets).toHaveLength(2);
    expect(world.home.requests.some((request) => request.url.includes("/renew?scope="))).toBe(true);
    world.platform.offlineScopes.add(scopeId);
    world.home.generation = 4;
    await expect(direct.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`)).rejects.toThrow();
    expect(world.fetchImpl.mock.calls.some(([url]) => String(url).includes(`/api/collaboration/scopes/${scopeId}`)
      && String(url).startsWith(PLATFORM))).toBe(false);
  });

  it("issues a terminal-purpose ticket and signs the first direct WebSocket handshake", async () => {
    const direct = transport();
    const connection = await direct.terminal(scopeId);
    const url = new URL(connection.url);
    expect(url.origin).toBe("wss://relay.matrix-os.com");
    expect(url.pathname).toBe(`/ws/collaboration/direct/scopes/${scopeId}/terminal`);
    const signedTicket = JSON.parse(Buffer.from(url.searchParams.get("ticket")!, "base64url").toString("utf8")) as {
      ticket: { nonce: string; purpose: string; actorId: string };
    };
    expect(signedTicket.ticket.purpose).toBe("terminal");
    const handshake = JSON.parse(connection.handshake) as {
      type: string; sessionId: string; ticketNonce: string; possession: string;
    };
    expect(handshake).toMatchObject({ type: "handshake", ticketNonce: signedTicket.ticket.nonce });
    const homeSession = world.home.sessions.get(handshake.sessionId)!;
    expect(verifyEd25519(homeSession.publicKey, possessionPayload({
      ticketNonce: signedTicket.ticket.nonce, purpose: "terminal", sessionId: handshake.sessionId,
    }), handshake.possession)).toBe(true);
    expect(connection.actorId).toBe(signedTicket.ticket.actorId);
  });

  it("wires the unmodified 525 Chat command request through the real Node adapter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(world.now());
    vi.spyOn(globalThis, "fetch").mockImplementation(world.fetchImpl as typeof fetch);
    expect(await collaborationRequest({ platformUrl: PLATFORM, token: "actor-token", method: "GET",
      path: `/api/collaboration/scopes/${scopeId}/chat` }))
      .toEqual({ id: "chat-1", scopeId, title: "Design review" });
    expect(world.platform.tickets).toHaveLength(1);
    expect(world.home.requests.at(-1)?.headers.get("authorization")).toBeNull();
  });

  it("resolves one invitation pointer before reading the invitation on the owner home", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(world.now());
    const invitationId = "30000000-0000-4000-8000-000000000001";
    const location = `/api/collaboration/invitations/${invitationId}/location`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (new URL(String(input)).pathname === location) return Promise.resolve(Response.json({ scopeId }));
      return world.fetchImpl(input, init);
    });
    const invitation = await collaborationRequest({ platformUrl: PLATFORM, token: "actor-invite", method: "GET",
      path: `/api/collaboration/invitations/${invitationId}` });
    expect(invitation).toMatchObject({ id: invitationId });
    expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === location)).toHaveLength(1);
    expect(world.home.requests.at(-1)?.url).toBe(`${RELAY}/api/collaboration/invitations/${invitationId}`);
  });
});
