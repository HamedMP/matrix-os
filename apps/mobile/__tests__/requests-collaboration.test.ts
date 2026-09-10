jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));

import {
  acceptCollaborationInvitation,
  collaborationEventsUrl,
  fetchCollaborationEventTicket,
  fetchCollaborationInbox,
  fetchSharedChatMessages,
  fetchSharedAiRequests,
  postSharedAiRequest,
  controlSharedAiRequest,
  decideSharedAiApproval,
  postSharedChatDiscussion,
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
        .mockResolvedValueOnce({ requests: [], approvals: [], defaultSelection })
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
    await postSharedAiRequest("clerk-token", scopeId, "1", "Summarize", defaultSelection,
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
      json: jest.fn().mockResolvedValue({ ticket, expiresAt: "2026-09-07T12:00:30.000Z" }),
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
});
