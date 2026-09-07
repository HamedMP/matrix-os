const mockGetToken = jest.fn(async () => "clerk-token");
const mockFetchInbox = jest.fn();
const mockFetchShared = jest.fn();
const mockFetchInvitation = jest.fn();
const mockAcceptInvitation = jest.fn();
const mockFetchScope = jest.fn();
const mockFetchChat = jest.fn();
const mockFetchMessages = jest.fn();
const mockPostDiscussion = jest.fn();

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: mockGetToken, userId: "user_editor" }) }));
jest.mock("@/lib/requests/collaboration", () => ({
  fetchCollaborationInbox: (...args: unknown[]) => mockFetchInbox(...args),
  fetchSharedCollaborations: (...args: unknown[]) => mockFetchShared(...args),
  fetchCollaborationInvitation: (...args: unknown[]) => mockFetchInvitation(...args),
  acceptCollaborationInvitation: (...args: unknown[]) => mockAcceptInvitation(...args),
  fetchCollaborationScope: (...args: unknown[]) => mockFetchScope(...args),
  fetchSharedChat: (...args: unknown[]) => mockFetchChat(...args),
  fetchSharedChatMessages: (...args: unknown[]) => mockFetchMessages(...args),
  postSharedChatDiscussion: (...args: unknown[]) => mockPostDiscussion(...args),
  updateSharedChatReadState: jest.fn(async () => undefined),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import SharedScreen from "../app/(drawer)/shared";

const scopeId = "10000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";
const invitation = {
  id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" },
  target: { actorId: "user_editor", displayName: "Ada" }, scopeKind: "chat", role: "editor", status: "pending",
  expiresAt: "2026-09-14T12:00:00.000Z", revision: "1",
};

describe("native shared Chat screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchInbox.mockResolvedValue({ items: [{
      scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
      status: "invited", invitationId, resource: invitation,
    }] });
    mockFetchShared.mockResolvedValue({ items: [] });
    mockFetchInvitation.mockResolvedValue(invitation);
    mockAcceptInvitation.mockResolvedValue({ scopeId, actorId: "user_editor", status: "accepted", revision: "2" });
    mockFetchScope.mockResolvedValue({
      id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: "chat_one", membershipMode: "direct", lifecycle: "shared",
      revision: "1", authEpoch: "1", authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
    });
    mockFetchChat.mockResolvedValue({ id: "chat_one", scopeId, title: "Launch plan", lifecycle: "active", revision: "1", messageCount: "1" });
    mockFetchMessages.mockResolvedValue({ messages: [{
      id: "msg_one", chatId: "chat_one", sequence: "1", role: "user", state: "committed", purpose: "discussion",
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text", text: "Welcome" }],
      createdAt: "2026-09-07T12:00:00.000Z",
    }] });
    mockPostDiscussion.mockResolvedValue({});
  });

  it("accepts an invitation and opens attributed discussion without AI controls", async () => {
    render(<SharedScreen />);
    fireEvent.press(await screen.findByLabelText("Review invitation from Nima"));
    expect(await screen.findByText("Join this shared Chat?")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Accept invitation"));
    expect(await screen.findByText("Launch plan")).toBeTruthy();
    expect(screen.getByText("Nima")).toBeTruthy();
    expect(screen.getByText("Welcome")).toBeTruthy();
    expect(screen.getByText(/AI requests are unavailable/)).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Message everyone"), "Ready");
    fireEvent.press(screen.getByLabelText("Send message"));
    await waitFor(() => expect(mockPostDiscussion).toHaveBeenCalledWith(
      "clerk-token", scopeId, "1", "Ready", expect.any(String),
    ));
  });
});
