jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
const mockSecureRandom = jest.fn((bytes: Uint8Array) => {
  (jest.requireActual("node:crypto") as typeof import("node:crypto")).randomFillSync(bytes);
  return bytes;
});
jest.mock("expo-crypto", () => ({
  getRandomValues: (bytes: Uint8Array) => mockSecureRandom(bytes),
  // Falls back to Math.random under remote debugging, so the transport must never use it.
  getRandomBytes: () => { throw new Error("getRandomBytes must not be used for collaboration keys"); },
}));

import {
  acceptCollaborationInvitation,
  changeCollaborationMemberRole,
  closeCollaborationSessions,
  controlSharedAiRequest,
  controlSharedTerminal,
  decideSharedAiApproval,
  declineCollaborationInvitation,
  fetchCollaborationInbox,
  fetchCollaborationInvitation,
  fetchCollaborationMembers,
  fetchCollaborationScope,
  fetchSessionDiscussion,
  fetchSessionDiscussionUserState,
  fetchSharedAiRequests,
  fetchSharedChat,
  fetchSharedChatMessages,
  fetchSharedTerminal,
  hydrateCollaborationDiscovery,
  inviteCollaborationMember,
  openCollaborationStream,
  postSessionDiscussion,
  postSharedAiRequest,
  postSharedChatDiscussion,
  removeCollaborationMember,
  revokeCollaborationInvitation,
  updateSessionDiscussionReadState,
  updateSharedChatReadState,
} from "@/lib/requests/collaboration";
import {
  PLATFORM,
  actorToken,
  createDirectTestWorld,
  relay,
  type DirectTestWorld,
} from "./collaboration-direct-test-world";
import { possessionPayload, verifyEd25519 } from "../../../packages/gateway/src/collaboration/direct-crypto";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalScopeId = "10000000-0000-4000-8000-000000000002";
const invitationId = "30000000-0000-4000-8000-000000000001";
const token = actorToken("user_editor");
const participant = { actorId: "user_editor", displayName: "Ada" };
const owner = { actorId: "user_owner", displayName: "Nima" };
const invitation = {
  id: invitationId, scopeId, owner, target: participant, scopeKind: "chat", role: "editor", status: "pending",
  expiresAt: "2026-09-24T12:00:00.000Z", revision: "1",
};
const scope = (id: string, kind: "chat" | "terminal") => ({
  id, ownerId: "user_owner", kind, resourceId: kind === "chat" ? "chat_one" : "terminal_release", membershipMode: "direct",
  lifecycle: "shared", revision: "1", authEpoch: "1", authorityGeneration: "1", role: "editor",
  capabilities: { read: true, discuss: true, manageMembers: false, requestAi: true },
});
const chat = { id: "chat_one", scopeId, title: "Launch plan", lifecycle: "active", revision: "1", messageCount: "1" };
const terminal = {
  id: "terminal_release", scopeId: terminalScopeId, incarnation: `terminal-${"a".repeat(32)}`, executionGeneration: "4",
  status: "active", createdBy: owner, createdAt: "2026-09-11T12:00:00.000Z",
};
const directory = (id: string, kind: string, status: "invited" | "accepted") => ({
  scopeId: id, runtimeId: "runtime_owner", ownerId: "user_owner", kind, authorityGeneration: 1, status,
  ...(status === "invited" ? { invitationId } : {}),
});

function respond(world: DirectTestWorld, method: string, path: string, body: unknown, status = 200) {
  world.home.responses.set(`${method} ${path}`, { status, body });
}

/** Every request after the ticket issue must be one the platform relays to the home, never a retired V1 route. */
function expectOnlyRelayedDirectTraffic(world: DirectTestWorld) {
  for (const request of world.requests) {
    expect(`${request.path}?${request.query}`).not.toMatch(/connection-tickets/);
    if (request.path === "/api/collaboration/connections") continue;
    const route = relay.parseRelayRoute(request.method, request.path);
    expect(route).not.toBeNull();
    expect(route!.kind === "session" || Boolean(request.headers.get("x-matrix-collaboration-session"))).toBe(true);
  }
}

describe("mobile collaboration requests", () => {
  let world: DirectTestWorld;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    closeCollaborationSessions();
    world = createDirectTestWorld({ startAt: Date.now() });
    jest.spyOn(global, "fetch").mockImplementation(world.fetchImpl as unknown as typeof fetch);
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("loads the actor's platform inbox without selecting an owner computer", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ items: [] }),
    } as unknown as Response);
    await expect(fetchCollaborationInbox("clerk-token")).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/api/collaboration/inbox", expect.objectContaining({
      headers: { Authorization: "Bearer clerk-token" }, signal: expect.any(AbortSignal),
    }));
  });

  it("requests an opaque next discovery page without interpreting the cursor", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ items: [] }),
    } as unknown as Response);
    await fetchCollaborationInbox("clerk-token", "opaque/+ cursor");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/collaboration/inbox?limit=50&cursor=opaque%2F%2B+cursor",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("hydrates metadata-only discovery from each item's home and marks unreachable homes", async () => {
    const offlineScopeId = "10000000-0000-4000-8000-000000000003";
    const deniedScopeId = "10000000-0000-4000-8000-000000000004";
    const fileScopeId = "10000000-0000-4000-8000-000000000005";
    world.platform.scopeKinds.set(terminalScopeId, "terminal");
    world.platform.offlineScopes.add(offlineScopeId);
    respond(world, "GET", `/api/collaboration/invitations/${invitationId}`, invitation);
    respond(world, "GET", `/api/collaboration/scopes/${terminalScopeId}`, scope(terminalScopeId, "terminal"));
    respond(world, "GET", `/api/collaboration/scopes/${terminalScopeId}/terminal`, terminal);
    respond(world, "GET", `/api/collaboration/scopes/${deniedScopeId}`, { error: "Forbidden" }, 403);
    const pending = {
      scopeId: "10000000-0000-4000-8000-000000000006", runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat",
      authorityGeneration: 1, status: "organization_pending", organizationId: "org_direct_1", grantId: "50000000-0000-4000-8000-000000000001",
    } as const;

    const items = await hydrateCollaborationDiscovery(token, [
      directory(scopeId, "chat", "invited"),
      directory(terminalScopeId, "terminal", "accepted"),
      directory(offlineScopeId, "chat", "accepted"),
      directory(deniedScopeId, "chat", "accepted"),
      directory(fileScopeId, "file", "accepted"),
      pending,
    ] as never);

    expect(items[0]).toMatchObject({ status: "invited", resource: { id: invitationId, owner } });
    expect(items[1]).toMatchObject({ status: "accepted", resource: { scope: { id: terminalScopeId }, terminal: { id: "terminal_release" } } });
    expect(items[2]).toMatchObject({ status: "accepted", home: "offline" });
    expect(items[2]).not.toHaveProperty("resource");
    expect(items[3]).toMatchObject({ status: "accepted", home: "denied" });
    expect(items[4]).toEqual(directory(fileScopeId, "file", "accepted"));
    expect(items[5]).toEqual(pending);
    expectOnlyRelayedDirectTraffic(world);
  });

  it("accepts and declines invitations on the invitation's scope session", async () => {
    respond(world, "GET", `/api/collaboration/invitations/${invitationId}`, invitation);
    respond(world, "POST", `/api/collaboration/invitations/${invitationId}/accept`,
      { scopeId, actorId: "user_editor", status: "accepted", revision: "2" });
    respond(world, "POST", `/api/collaboration/invitations/${invitationId}/decline`,
      { scopeId, actorId: "user_editor", status: "revoked", scopeRevision: 2, memberRevision: 2 });

    await expect(fetchCollaborationInvitation(token, scopeId, invitationId)).resolves.toMatchObject({ id: invitationId });
    await expect(acceptCollaborationInvitation(token, scopeId, invitationId, "1", "20000000-0000-4000-8000-000000000001"))
      .resolves.toMatchObject({ status: "accepted" });
    await expect(declineCollaborationInvitation(token, scopeId, invitationId, "1", "40000000-0000-4000-8000-000000000002"))
      .resolves.toMatchObject({ status: "revoked" });

    expect(world.home.accepted.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "GET", path: `/api/collaboration/invitations/${invitationId}`, body: "" },
      { method: "POST", path: `/api/collaboration/invitations/${invitationId}/accept`,
        body: JSON.stringify({ clientRequestId: "20000000-0000-4000-8000-000000000001", expectedRevision: "1" }) },
      { method: "POST", path: `/api/collaboration/invitations/${invitationId}/decline`,
        body: JSON.stringify({ clientRequestId: "40000000-0000-4000-8000-000000000002", expectedRevision: "1" }) },
    ]);
    expect(new Set(world.home.accepted.map((request) => request.session.scopeId))).toEqual(new Set([scopeId]));
    expectOnlyRelayedDirectTraffic(world);
  });

  it("reads and discusses a shared Chat through signed home requests", async () => {
    const message = { id: "note_one", scopeId, sequence: "2", actor: participant, text: "Ready", createdAt: "2026-09-07T12:01:00.000Z" };
    const base = `/api/collaboration/scopes/${scopeId}`;
    respond(world, "GET", base, scope(scopeId, "chat"));
    respond(world, "GET", `${base}/chat`, chat);
    respond(world, "GET", `${base}/chat/messages`, { messages: [] });
    respond(world, "POST", `${base}/chat/messages`, {
      id: "msg_two", chatId: "chat_one", sequence: "2", purpose: "discussion", actor: participant, text: "Ready", createdAt: "2026-09-07T12:01:00.000Z",
    });
    respond(world, "PATCH", `${base}/user-state`, { readThroughSeq: "2", pinned: false, muted: false });
    respond(world, "GET", `${base}/discussion/messages`, { messages: [message], latestSequence: "2" });
    respond(world, "POST", `${base}/discussion/messages`, message);
    respond(world, "GET", `${base}/discussion/user-state`, { readThroughSeq: "1" });
    respond(world, "PATCH", `${base}/discussion/user-state`, { readThroughSeq: "2", lastOpenedAt: "2026-09-07T12:02:00.000Z" });

    await fetchCollaborationScope(token, scopeId);
    await fetchSharedChat(token, scopeId);
    await fetchSharedChatMessages(token, scopeId, "100");
    await postSharedChatDiscussion(token, scopeId, "1", "Ready", "40000000-0000-4000-8000-000000000001");
    await updateSharedChatReadState(token, scopeId, "2");
    await fetchSessionDiscussion(token, scopeId, "0");
    await postSessionDiscussion(token, scopeId, "1", "Ready", "40000000-0000-4000-8000-000000000003");
    await fetchSessionDiscussionUserState(token, scopeId);
    await updateSessionDiscussionReadState(token, scopeId, "2");

    expect(world.home.accepted.map(({ method, path, query }) => `${method} ${path}${query ? `?${query}` : ""}`)).toEqual([
      `GET ${base}`,
      `GET ${base}/chat`,
      `GET ${base}/chat/messages?after=100&limit=100`,
      `POST ${base}/chat/messages`,
      `PATCH ${base}/user-state`,
      `GET ${base}/discussion/messages?after=0&limit=100`,
      `POST ${base}/discussion/messages`,
      `GET ${base}/discussion/user-state`,
      `PATCH ${base}/discussion/user-state`,
    ]);
    expect(world.platform.tickets).toHaveLength(1);
    expectOnlyRelayedDirectTraffic(world);
  });

  it("manages membership with conditional DELETEs the home verifies", async () => {
    const base = `/api/collaboration/scopes/${scopeId}`;
    const member = { actor: participant, role: "editor", status: "accepted", revision: "1", updatedAt: "2026-09-17T12:00:00.000Z" };
    const mutation = { scopeId, actorId: "user_editor", role: "viewer", status: "accepted", scopeRevision: 3, memberRevision: 2 };
    respond(world, "GET", `${base}/members`, { members: [member] });
    respond(world, "POST", `${base}/invitations`, { ...invitation, revision: "2" });
    respond(world, "PATCH", `${base}/members/user_editor`, mutation);
    respond(world, "DELETE", `${base}/members/user_editor`, mutation);
    respond(world, "DELETE", `${base}/invitations/${invitationId}`, { ...mutation, status: "revoked" });

    await fetchCollaborationMembers(token, scopeId);
    await inviteCollaborationMember(token, scopeId, "ada@example.com", "editor", "1", "40000000-0000-4000-8000-000000000004");
    await changeCollaborationMemberRole(token, scopeId, "user_editor", "viewer", "2", "1", "40000000-0000-4000-8000-000000000005");
    await removeCollaborationMember(token, scopeId, "user_editor", "3", "2", "40000000-0000-4000-8000-000000000006");
    await revokeCollaborationInvitation(token, scopeId, invitationId, "3", "2", "40000000-0000-4000-8000-000000000007");

    const deletes = world.requests.filter((request) => request.method === "DELETE");
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.headers.get("x-matrix-expected-revision")).toBe("3");
    expect(deletes[0]!.headers.get("x-matrix-expected-member-revision")).toBe("2");
    expect(deletes[1]!.headers.get("x-matrix-client-request-id")).toBe("40000000-0000-4000-8000-000000000007");
    expect(world.home.accepted.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${base}/members`,
      `POST ${base}/invitations`,
      `PATCH ${base}/members/user_editor`,
      `DELETE ${base}/members/user_editor`,
      `DELETE ${base}/invitations/${invitationId}`,
    ]);
    expectOnlyRelayedDirectTraffic(world);
  });

  it("uses the same scoped queue and approval routes for shared AI", async () => {
    const base = `/api/collaboration/scopes/${scopeId}`;
    const selection = { instanceId: "claude_shared", model: "claude-opus-4-6" };
    respond(world, "GET", `${base}/chat/requests`, {
      requests: [], approvals: [], capability: { status: "available", effectiveSelection: selection }, resourceRevision: "4",
    });
    respond(world, "POST", `${base}/chat/requests`, {
      resourceRevision: "5",
      request: {
        id: "qturn_one", chatId: "chat_one", acceptedSequence: "1", actor: participant, state: "queued", text: "Summarize",
        selection, acceptedAt: "2026-09-07T12:01:00.000Z", updatedAt: "2026-09-07T12:01:00.000Z",
      },
    });
    respond(world, "POST", `${base}/chat/requests/qturn_one/cancel`, { state: "accepted" });
    respond(world, "POST", `${base}/chat/approvals/approval_one/decision`, { state: "accepted" });

    await fetchSharedAiRequests(token, scopeId);
    await postSharedAiRequest(token, scopeId, "1", "Summarize", "40000000-0000-4000-8000-000000000020");
    await controlSharedAiRequest(token, scopeId, "qturn_one", "cancel", "4", "40000000-0000-4000-8000-000000000021");
    await decideSharedAiApproval(token, scopeId, "approval_one", "run_one", "approve", "5", "40000000-0000-4000-8000-000000000022");

    expect(world.home.accepted.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${base}/chat/requests`,
      `POST ${base}/chat/requests`,
      `POST ${base}/chat/requests/qturn_one/cancel`,
      `POST ${base}/chat/approvals/approval_one/decision`,
    ]);
    expectOnlyRelayedDirectTraffic(world);
  });

  it("reads and controls a shared terminal through its scope session", async () => {
    const base = `/api/collaboration/scopes/${terminalScopeId}`;
    world.platform.scopeKinds.set(terminalScopeId, "terminal");
    respond(world, "GET", `${base}/terminal`, terminal);
    respond(world, "POST", `${base}/terminal/actions`, { terminal, action: "acquired" });

    await expect(fetchSharedTerminal(token, terminalScopeId)).resolves.toEqual(terminal);
    await expect(controlSharedTerminal(token, terminalScopeId, {
      type: "acquire",
      clientRequestId: "40000000-0000-4000-8000-000000000030",
      incarnation: terminal.incarnation,
      connectionId: "connection_mobile",
    })).resolves.toMatchObject({ action: "acquired" });

    expect(world.home.accepted[1]!.body).toContain("connection_mobile");
    expectOnlyRelayedDirectTraffic(world);
  });

  it("opens direct event and terminal streams with a first-frame possession proof", async () => {
    world.platform.scopeKinds.set(terminalScopeId, "terminal");

    for (const [id, purpose, after] of [[scopeId, "events", "12"], [terminalScopeId, "terminal", "0"]] as const) {
      const stream = await openCollaborationStream(token, id, purpose, after);
      const url = new URL(stream.url);
      expect(url.origin).toBe(PLATFORM.replace(/^https:/, "wss:"));
      expect(relay.parseRelaySocketPath(`${url.pathname}${url.search}`)).toMatchObject({ scopeId: id, purpose });
      expect(url.searchParams.get("after")).toBe(after);
      expect(stream.headers).toEqual({ Authorization: `Bearer ${token}` });
      const handshake = JSON.parse(stream.handshake) as { sessionId: string; ticketNonce: string; possession: string };
      const session = world.home.sessions.get(handshake.sessionId)!;
      expect(session.scopeId).toBe(id);
      expect(verifyEd25519(session.publicKey, possessionPayload({
        ticketNonce: handshake.ticketNonce, purpose, sessionId: session.id,
      }), handshake.possession)).toBe(true);
    }
    expectOnlyRelayedDirectTraffic(world);
  });

  it("draws proof keys and nonces only from the native CSPRNG", async () => {
    respond(world, "GET", `/api/collaboration/scopes/${scopeId}/chat`, chat);
    mockSecureRandom.mockClear();

    await fetchSharedChat(token, scopeId);

    // Proof key seed, ticket and session request ids, and the request-signature nonce.
    expect(mockSecureRandom.mock.calls.map(([bytes]) => bytes.byteLength).sort((a, b) => a - b)).toEqual([16, 16, 32, 32]);
  });

  it("returns only a generic error when the home refuses a scoped request", async () => {
    respond(world, "GET", `/api/collaboration/scopes/${scopeId}/chat`, { error: "Forbidden" }, 403);

    await expect(fetchSharedChat(token, scopeId)).rejects.toThrow("Collaboration unavailable. Try again.");
    await expect(openCollaborationStream("", scopeId, "events")).rejects.toThrow("Collaboration unavailable. Try again.");
    expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain("Bearer");
  });
});
