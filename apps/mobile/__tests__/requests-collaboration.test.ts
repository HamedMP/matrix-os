jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));

import {
  acceptCollaborationInvitation,
  fetchCollaborationInbox,
  fetchSharedChatMessages,
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
});
