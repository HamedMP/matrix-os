import { randomBytes } from "node:crypto";
import { CollaborationDeleteConditionSchema } from "@matrix-os/contracts/collaboration";
import {
  possessionPayload,
  proofKeyThumbprint,
  requestSigningPayload,
  sha256Hex,
  verifyEd25519,
} from "../../../packages/gateway/src/collaboration/direct-crypto";
import { CollaborationDirectError, createMobileCollaborationDirect } from "@/lib/collaboration-direct";
import {
  PLATFORM,
  SEPARATE_RELAY,
  actorId,
  actorToken,
  createDirectTestWorld,
  invitationId,
  otherScopeId,
  relay,
  scopeId,
  type DirectTestWorld,
} from "./collaboration-direct-test-world";

const { isCollaborationWebSocketCandidate, parseRelayRoute, parseRelaySocketPath } = relay;

const chat = { id: "chat-1", scopeId, title: "Design review" };

function transport(world: DirectTestWorld) {
  return createMobileCollaborationDirect({
    platformUrl: PLATFORM,
    fetchImpl: world.fetchImpl as unknown as typeof fetch,
    now: world.now,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
  });
}

function envelope(headers: Headers) {
  return JSON.parse(Buffer.from(headers.get("x-matrix-collaboration-request")!, "base64url").toString("utf8")) as {
    signature: Record<string, string | number>;
    proof: string;
  };
}

describe("Native Mobile direct collaboration transport", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it("issues a direct-session ticket from the platform and exchanges it on the scope's home", async () => {
    const world = createDirectTestWorld();
    world.home.responses.set(`GET /api/collaboration/scopes/${scopeId}/chat`, { status: 200, body: chat });

    await expect(transport(world).request(actorToken(), scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`))
      .resolves.toEqual(chat);

    const [ticketRequest, exchange, read] = world.requests;
    expect(ticketRequest).toMatchObject({ origin: PLATFORM, method: "POST", path: "/api/collaboration/connections" });
    expect(ticketRequest!.headers.get("authorization")).toBe(`Bearer ${actorToken()}`);
    expect(JSON.parse(ticketRequest!.body)).toMatchObject({ scopeId, purpose: "direct_session" });
    expect(exchange).toMatchObject({ method: "POST", path: "/api/collaboration/direct-sessions", query: `scope=${scopeId}` });
    expect(read).toMatchObject({ method: "GET", path: `/api/collaboration/scopes/${scopeId}/chat` });
    expect(world.home.accepted).toHaveLength(1);
    expect(world.home.accepted[0]!.session.actorId).toBe(actorId);
  });

  it("signs every scope request so the home verifies method, path, query, body and key", async () => {
    const world = createDirectTestWorld();
    const path = `/api/collaboration/scopes/${scopeId}/chat/messages`;
    world.home.responses.set(`POST ${path}`, { status: 200, body: { id: "msg_1" } });
    world.home.responses.set(`GET ${path}`, { status: 200, body: { messages: [] } });
    const direct = transport(world);

    await direct.request(actorToken(), scopeId, "POST", path, { text: "Ready" });
    await direct.request(actorToken(), scopeId, "GET", `${path}?after=12&limit=100`);

    const [post, get] = world.requests.filter((request) => request.path === path);
    const session = world.home.accepted[0]!.session;
    for (const request of [post!, get!]) {
      const { signature, proof } = envelope(request.headers);
      expect(request.headers.get("x-matrix-collaboration-session")).toBe(session.id);
      expect(signature).toMatchObject({ method: request.method, path, query: request.query, sessionId: session.id });
      expect(signature.bodyDigest).toBe(sha256Hex(new TextEncoder().encode(request.body)));
      expect(verifyEd25519(session.publicKey, requestSigningPayload(signature), proof)).toBe(true);
    }
    expect(get!.query).toBe("after=12&limit=100");
    expect(world.home.accepted).toHaveLength(2);
  });

  it("binds DELETE revision conditions into the signature exactly as the home digests them", async () => {
    const world = createDirectTestWorld();
    const path = `/api/collaboration/scopes/${scopeId}/members/user_editor`;
    world.home.responses.set(`DELETE ${path}`, { status: 200, body: { status: "revoked" } });
    const conditions = {
      clientRequestId: "40000000-0000-4000-8000-000000000006",
      expectedRevision: "3",
      expectedMemberRevision: "2",
    };

    await transport(world).request(actorToken(), scopeId, "DELETE", path, undefined, conditions);

    const request = world.requests.find((candidate) => candidate.method === "DELETE")!;
    expect(request.body).toBe("");
    expect(request.headers.get("x-matrix-client-request-id")).toBe(conditions.clientRequestId);
    expect(request.headers.get("x-matrix-expected-revision")).toBe("3");
    expect(request.headers.get("x-matrix-expected-member-revision")).toBe("2");
    expect(world.home.accepted[0]!.conditionalHeadersDigest).toBe(
      sha256Hex(new TextEncoder().encode(JSON.stringify(CollaborationDeleteConditionSchema.parse(conditions)))),
    );
  });

  it("only sends requests the platform relays and never the retired V1 routes", async () => {
    const world = createDirectTestWorld();
    const scope = `/api/collaboration/scopes/${scopeId}`;
    world.home.responses.set(`GET ${scope}`, { status: 200, body: { id: scopeId } });
    world.home.responses.set(`PATCH ${scope}/user-state`, { status: 200, body: { readThroughSeq: "2" } });
    world.home.responses.set(`POST /api/collaboration/invitations/${invitationId}/accept`, { status: 200, body: { status: "accepted" } });
    const direct = transport(world);

    await direct.request(actorToken(), scopeId, "GET", scope);
    await direct.request(actorToken(), scopeId, "PATCH", `${scope}/user-state`, { readThroughSeq: "2" });
    await direct.request(actorToken(), scopeId, "POST", `/api/collaboration/invitations/${invitationId}/accept`, { expectedRevision: "1" });
    await direct.stream(actorToken(), scopeId, "events", "0");

    for (const request of world.requests) {
      expect(`${request.path}?${request.query}`).not.toMatch(/connection-tickets|\/ws\/collaboration\/scopes\//);
      if (request.path === "/api/collaboration/connections") continue;
      const route = parseRelayRoute(request.method, request.path);
      expect(route).not.toBeNull();
      expect(route!.kind === "session" || Boolean(request.headers.get("x-matrix-collaboration-session"))).toBe(true);
    }
    expect(world.home.accepted.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${scope}`,
      `PATCH ${scope}/user-state`,
      `POST /api/collaboration/invitations/${invitationId}/accept`,
    ]);
  });

  it("builds direct event and terminal sockets the platform relays and the home admits", async () => {
    const world = createDirectTestWorld();
    world.platform.scopeKinds.set(scopeId, "terminal");
    const direct = transport(world);

    for (const [purpose, after] of [["events", "12"], ["terminal", "0"]] as const) {
      const stream = await direct.stream(actorToken(), scopeId, purpose, after);
      const url = new URL(stream.url);
      expect(url.protocol).toBe("wss:");
      expect(url.origin.replace(/^wss:/, "https:")).toBe(PLATFORM);
      const rawPath = `${url.pathname}${url.search}`;
      expect(isCollaborationWebSocketCandidate(rawPath)).toBe(true);
      expect(parseRelaySocketPath(rawPath)).toMatchObject({ scopeId, purpose });
      expect(url.searchParams.get("after")).toBe(after);

      const signedTicket = JSON.parse(Buffer.from(url.searchParams.get("ticket")!, "base64url").toString("utf8")) as {
        ticket: { nonce: string; purpose: string; proofKeyThumbprint: string };
      };
      expect(world.verifyTicket(signedTicket as never)).not.toBeNull();
      expect(signedTicket.ticket.purpose).toBe(purpose);

      const session = [...world.home.sessions.values()][0]!;
      expect(signedTicket.ticket.proofKeyThumbprint).toBe(proofKeyThumbprint(session.publicKey));
      const handshake = JSON.parse(stream.handshake) as { protocolVersion: number; type: string; sessionId: string; ticketNonce: string; possession: string };
      expect(handshake).toMatchObject({ protocolVersion: 2, type: "handshake", sessionId: session.id, ticketNonce: signedTicket.ticket.nonce });
      expect(verifyEd25519(session.publicKey, possessionPayload({
        ticketNonce: signedTicket.ticket.nonce, purpose, sessionId: session.id,
      }), handshake.possession)).toBe(true);
      // The platform authenticates the socket upgrade from the actor bearer.
      expect(stream.headers).toEqual({ Authorization: `Bearer ${actorToken()}` });
    }
    expect(world.home.sessions.size).toBe(1);
  });

  it("sends the actor bearer only to the platform origin, never to a separate home origin", async () => {
    const world = createDirectTestWorld({ relayOrigin: SEPARATE_RELAY });
    world.home.responses.set(`GET /api/collaboration/scopes/${scopeId}/chat`, { status: 200, body: chat });
    const direct = transport(world);

    await direct.request(actorToken(), scopeId, "GET", `/api/collaboration/scopes/${scopeId}/chat`);
    const stream = await direct.stream(actorToken(), scopeId, "events", "0");

    for (const request of world.requests) {
      if (request.origin === PLATFORM) {
        expect(request.path).toBe("/api/collaboration/connections");
        expect(request.headers.get("x-matrix-collaboration-session")).toBeNull();
      } else {
        expect(request.origin).toBe(SEPARATE_RELAY);
        expect(request.headers.get("authorization")).toBeNull();
      }
    }
    expect(new URL(stream.url).host).toBe("relay.matrix-os.com");
    expect(stream.headers).toEqual({});
  });

  it("reuses a live session, renews it before expiry, and retries once with a fresh session after a 401", async () => {
    const world = createDirectTestWorld();
    const path = `/api/collaboration/scopes/${scopeId}/chat`;
    world.home.responses.set(`GET ${path}`, { status: 200, body: chat });
    const direct = transport(world);

    await direct.request(actorToken(), scopeId, "GET", path);
    await direct.request(actorToken(), scopeId, "GET", path);
    expect(world.platform.tickets).toHaveLength(1);

    world.advance(241_000);
    await direct.request(actorToken(), scopeId, "GET", path);
    expect(world.requests.some((request) => /\/direct-sessions\/[^/]+\/renew$/.test(request.path))).toBe(true);
    expect(world.home.sessions.size).toBe(1);

    world.home.generation = 4;
    await direct.request(actorToken(), scopeId, "GET", path);
    expect(world.home.sessions.size).toBe(1);
    expect(world.home.accepted).toHaveLength(4);
    expect(world.home.accepted[3]!.session.generation).toBe(4);
  });

  it("never reuses one account's session for another account", async () => {
    const world = createDirectTestWorld();
    const path = `/api/collaboration/scopes/${scopeId}/chat`;
    world.home.responses.set(`GET ${path}`, { status: 200, body: chat });
    const direct = transport(world);

    await direct.request(actorToken("user_first"), scopeId, "GET", path);
    await direct.request(actorToken("user_second"), scopeId, "GET", path);

    expect(world.home.accepted.map((request) => request.session.actorId)).toEqual(["user_first", "user_second"]);
    expect(world.home.accepted[0]!.session.id).not.toBe(world.home.accepted[1]!.session.id);
  });

  it("refuses a ticket issued to a different actor than the signed-in account", async () => {
    const world = createDirectTestWorld();
    world.platform.ticketActorOverride = "user_someone_else";

    await expect(transport(world).request(actorToken(), scopeId, "GET", `/api/collaboration/scopes/${scopeId}`))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(world.requests.every((request) => request.path !== "/api/collaboration/direct-sessions")).toBe(true);
  });

  it("maps offline homes, protocol upgrades and missing resources to generic typed errors", async () => {
    const world = createDirectTestWorld();
    const direct = transport(world);

    world.platform.offlineScopes.add(scopeId);
    await expect(direct.request(actorToken(), scopeId, "GET", `/api/collaboration/scopes/${scopeId}`))
      .rejects.toMatchObject({ code: "host_offline" });

    world.platform.offlineScopes.clear();
    await expect(direct.request(actorToken(), scopeId, "GET", `/api/collaboration/scopes/${scopeId}/terminal`))
      .rejects.toMatchObject({ code: "not_found" });

    world.home.protocolVersion = 3;
    await expect(direct.request(actorToken(), otherScopeId, "GET", `/api/collaboration/scopes/${otherScopeId}`))
      .rejects.toMatchObject({ code: "upgrade_required" });

    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain("Bearer");
    expect(logged).not.toContain(scopeId);
  });

  it("rejects paths outside the addressed scope before any network call", async () => {
    const world = createDirectTestWorld();
    const direct = transport(world);

    for (const path of [
      `/api/collaboration/scopes/${otherScopeId}/chat`,
      "/api/collaboration/inbox",
      `/api/collaboration/scopes/${scopeId}/../${otherScopeId}`,
      `https://evil.example/api/collaboration/scopes/${scopeId}`,
    ]) {
      await expect(direct.request(actorToken(), scopeId, "GET", path)).rejects.toBeInstanceOf(CollaborationDirectError);
    }
    await expect(direct.request(actorToken(), "not-a-scope", "GET", "/api/collaboration/scopes/not-a-scope"))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(direct.request("", scopeId, "GET", `/api/collaboration/scopes/${scopeId}`))
      .rejects.toMatchObject({ code: "denied" });
    expect(world.requests).toHaveLength(0);
  });

  it("drops every cached session on close", async () => {
    const world = createDirectTestWorld();
    const path = `/api/collaboration/scopes/${scopeId}/chat`;
    world.home.responses.set(`GET ${path}`, { status: 200, body: chat });
    const direct = transport(world);

    await direct.request(actorToken(), scopeId, "GET", path);
    direct.close();
    await direct.request(actorToken(), scopeId, "GET", path);

    expect(world.platform.tickets).toHaveLength(2);
    expect(world.home.accepted[0]!.session.id).not.toBe(world.home.accepted[1]!.session.id);
  });
});
