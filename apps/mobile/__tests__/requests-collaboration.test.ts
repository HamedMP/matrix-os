jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));

import {
  acceptCollaborationInvitation,
  declineCollaborationInvitation,
  collaborationEventsUrl,
  collaborationTerminalUrl,
  controlSharedTerminal,
  fetchCollaborationEventTicket,
  fetchCollaborationInbox,
  fetchCollaborationMembers,
  fetchSessionDiscussion,
  fetchSessionDiscussionUserState,
  fetchSharedTerminal,
  fetchSharedChatMessages,
  fetchSharedAiRequests,
  postSharedAiRequest,
  controlSharedAiRequest,
  decideSharedAiApproval,
  postSharedChatDiscussion,
  postSessionDiscussion,
  inviteCollaborationMember,
  changeCollaborationMemberRole,
  removeCollaborationMember,
  updateSessionDiscussionReadState,
} from "@/lib/requests/collaboration";

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("mobile collaboration requests", () => {
  beforeEach(() => jest.restoreAllMocks());

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

  it("accepts and discusses with conditional actor-scoped requests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn()
        .mockResolvedValueOnce({ scopeId, actorId: "user_editor", status: "accepted", revision: "2" })
        .mockResolvedValueOnce({ id: "msg_two", chatId: "chat_one", sequence: "2", purpose: "discussion", actor: { actorId: "user_editor", displayName: "Ada" }, text: "Ready", createdAt: "2026-09-07T12:01:00.000Z" }),
    } as unknown as Response);
    await acceptCollaborationInvitation("clerk-token", "30000000-0000-4000-8000-000000000001", "1", "20000000-0000-4000-8000-000000000001");
    await postSharedChatDiscussion("clerk-token", scopeId, "1", "Ready", "40000000-0000-4000-8000-000000000001");
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/chat/messages`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({
        clientRequestId: "40000000-0000-4000-8000-000000000001", expectedRevision: "1", text: "Ready",
      }) }),
    );
  });

  it("declines only through the target-scoped invitation route", async () => {
    const invitationId = "30000000-0000-4000-8000-000000000001";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        scopeId,
        actorId: "user_editor",
        status: "revoked",
        scopeRevision: 2,
        memberRevision: 2,
      }),
    } as unknown as Response);

    await declineCollaborationInvitation(
      "clerk-token",
      invitationId,
      "1",
      "40000000-0000-4000-8000-000000000002",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/api/collaboration/invitations/${invitationId}/decline`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientRequestId: "40000000-0000-4000-8000-000000000002",
          expectedRevision: "1",
        }),
      }),
    );
  });

  it("uses the scope-generic discussion layer and actor-private read state", async () => {
    const message = {
      id: "note_one",
      scopeId,
      sequence: "2",
      actor: { actorId: "user_editor", displayName: "Ada" },
      text: "Ready",
      createdAt: "2026-09-07T12:01:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn()
        .mockResolvedValueOnce({ messages: [message], latestSequence: "2" })
        .mockResolvedValueOnce(message)
        .mockResolvedValueOnce({ readThroughSeq: "1" })
        .mockResolvedValueOnce({ readThroughSeq: "2", lastOpenedAt: "2026-09-07T12:02:00.000Z" }),
    } as unknown as Response);

    await fetchSessionDiscussion("clerk-token", scopeId, "0");
    await postSessionDiscussion(
      "clerk-token",
      scopeId,
      "1",
      "Ready",
      "40000000-0000-4000-8000-000000000003",
    );
    await fetchSessionDiscussionUserState("clerk-token", scopeId);
    await updateSessionDiscussionReadState("clerk-token", scopeId, "2");

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/discussion/messages?after=0&limit=100`,
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/discussion/messages`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("Ready") }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/discussion/user-state`,
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/discussion/user-state`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ readThroughSeq: "2" }) }),
    );
  });

  it("uses the existing membership authority for access management", async () => {
    const member = {
      actor: { actorId: "user_editor", displayName: "Ada" },
      role: "editor",
      status: "accepted",
      revision: "1",
      updatedAt: "2026-09-17T12:00:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn()
        .mockResolvedValueOnce({ members: [member] })
        .mockResolvedValueOnce({
          id: "30000000-0000-4000-8000-000000000001", scopeId,
          owner: { actorId: "user_owner", displayName: "Nima" },
          target: member.actor, scopeKind: "chat", role: "editor", status: "pending",
          expiresAt: "2026-09-24T12:00:00.000Z", revision: "2",
        })
        .mockResolvedValue({ scopeId, actorId: "user_editor", role: "viewer", status: "accepted", scopeRevision: 3, memberRevision: 2 }),
    } as unknown as Response);

    await fetchCollaborationMembers("clerk-token", scopeId);
    await inviteCollaborationMember("clerk-token", scopeId, "ada@example.com", "editor", "1", "40000000-0000-4000-8000-000000000004");
    await changeCollaborationMemberRole("clerk-token", scopeId, "user_editor", "viewer", "2", "1", "40000000-0000-4000-8000-000000000005");
    await removeCollaborationMember("clerk-token", scopeId, "user_editor", "3", "2", "40000000-0000-4000-8000-000000000006");

    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/invitations`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("ada@example.com") }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/members/user_editor`,
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"role":"viewer"') }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/members/user_editor`,
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({
        "x-matrix-expected-revision": "3",
        "x-matrix-expected-member-revision": "2",
      }) }),
    );
  });

  it("requests the next bounded page of canonical history", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true, json: jest.fn().mockResolvedValue({ messages: [] }),
    } as unknown as Response);
    await fetchSharedChatMessages("clerk-token", scopeId, "100");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/chat/messages?after=100&limit=100`,
      expect.any(Object),
    );
  });

  it("uses the same scoped M2 queue and control routes", async () => {
    const defaultSelection = { instanceId: "claude_shared", model: "claude-opus-4-6" };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn()
        .mockResolvedValueOnce({
          requests: [], approvals: [],
          capability: { status: "available", effectiveSelection: defaultSelection },
          resourceRevision: "4",
        })
        .mockResolvedValueOnce({
          resourceRevision: "5",
          request: {
            id: "qturn_one", chatId: "chat_one", acceptedSequence: "1",
            actor: { actorId: "user_editor", displayName: "Ada" }, state: "queued", text: "Summarize",
            selection: defaultSelection, acceptedAt: "2026-09-07T12:01:00.000Z", updatedAt: "2026-09-07T12:01:00.000Z",
          },
        })
        .mockResolvedValue({ state: "accepted" }),
    } as unknown as Response);
    await fetchSharedAiRequests("clerk-token", scopeId);
    await postSharedAiRequest("clerk-token", scopeId, "1", "Summarize",
      "40000000-0000-4000-8000-000000000020");
    await controlSharedAiRequest("clerk-token", scopeId, "qturn_one", "cancel", "4",
      "40000000-0000-4000-8000-000000000021");
    await decideSharedAiApproval("clerk-token", scopeId, "approval_one", "run_one", "approve", "5",
      "40000000-0000-4000-8000-000000000022");

    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/chat/requests`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("Summarize") }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/chat/requests/qturn_one/cancel`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/chat/approvals/approval_one/decision`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("obtains a one-use event ticket and builds an exact WebSocket route", async () => {
    const ticket = "t".repeat(43);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ticket, actorId: "user_editor", expiresAt: "2026-09-07T12:00:30.000Z" }),
    } as unknown as Response);
    await expect(fetchCollaborationEventTicket(
      "clerk-token",
      scopeId,
      "40000000-0000-4000-8000-000000000010",
    )).resolves.toMatchObject({ ticket });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/connection-tickets`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(collaborationEventsUrl(scopeId, ticket, "12")).toBe(
      `wss://app.matrix-os.com/ws/collaboration/scopes/${scopeId}/events?ticket=${ticket}&after=12`,
    );
  });

  it("reads and controls a terminal through its scoped M3 routes", async () => {
    const terminal = {
      id: "terminal_release",
      scopeId,
      incarnation: `terminal-${"a".repeat(32)}`,
      executionGeneration: "4",
      status: "active",
      createdBy: { actorId: "user_owner", displayName: "Nima" },
      createdAt: "2026-09-11T12:00:00.000Z",
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(terminal).mockResolvedValueOnce({ terminal, action: "acquired" }),
    } as unknown as Response);

    await expect(fetchSharedTerminal("clerk-token", scopeId)).resolves.toEqual(terminal);
    await expect(controlSharedTerminal("clerk-token", scopeId, {
      type: "acquire",
      clientRequestId: "40000000-0000-4000-8000-000000000030",
      incarnation: terminal.incarnation,
      connectionId: "connection_mobile",
    })).resolves.toMatchObject({ action: "acquired" });

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/terminal`,
      expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/terminal/actions`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("connection_mobile") }),
    );
  });

  it("obtains a terminal ticket and builds the exact scoped terminal socket URL", async () => {
    const ticket = "u".repeat(43);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ticket, actorId: "user_editor", expiresAt: "2026-09-11T12:00:30.000Z" }),
    } as unknown as Response);

    await fetchCollaborationEventTicket(
      "clerk-token",
      scopeId,
      "40000000-0000-4000-8000-000000000031",
      "terminal",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com/api/collaboration/scopes/${scopeId}/connection-tickets`,
      expect.objectContaining({ body: expect.stringContaining('"purpose":"terminal"') }),
    );
    expect(collaborationTerminalUrl(scopeId, ticket)).toBe(
      `wss://app.matrix-os.com/ws/collaboration/scopes/${scopeId}/terminal?ticket=${ticket}`,
    );
  });
});
