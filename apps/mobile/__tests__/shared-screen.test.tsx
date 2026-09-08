const mockGetToken = jest.fn(async () => "clerk-token");
const mockFetchInbox = jest.fn();
const mockFetchShared = jest.fn();
const mockFetchInvitation = jest.fn();
const mockAcceptInvitation = jest.fn();
const mockFetchScope = jest.fn();
const mockFetchChat = jest.fn();
const mockFetchMessages = jest.fn();
const mockPostDiscussion = jest.fn();
const mockFetchEventTicket = jest.fn();

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
  fetchCollaborationEventTicket: (...args: unknown[]) => mockFetchEventTicket(...args),
  collaborationEventsUrl: jest.fn(() => "wss://app.matrix-os.com/ws/collaboration/events?ticket=test"),
  updateSharedChatReadState: jest.fn(async () => undefined),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import SharedScreen from "../app/(drawer)/shared";

const scopeId = "10000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";
const invitation = {
  id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" },
  target: { actorId: "user_editor", displayName: "Ada" }, scopeKind: "chat", role: "editor", status: "pending",
  expiresAt: "2026-09-14T12:00:00.000Z", revision: "1",
};

type TestSocket = WebSocket & {
  onmessage: ((event: { data: string }) => void) | null;
};

const sockets: TestSocket[] = [];
const OriginalWebSocket = global.WebSocket;

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = TestWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = jest.fn();
  close = jest.fn(() => { this.readyState = TestWebSocket.CLOSED; });

  constructor() {
    sockets.push(this as unknown as TestSocket);
  }
}

describe("native shared Chat screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sockets.length = 0;
    global.WebSocket = TestWebSocket as unknown as typeof WebSocket;
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
    mockFetchEventTicket.mockResolvedValue({ ticket: "t".repeat(43), expiresAt: "2026-09-07T12:00:30.000Z" });
  });

  afterAll(() => {
    global.WebSocket = OriginalWebSocket;
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

  it("discards an old Chat history page after opening another shared Chat", async () => {
    const secondScopeId = "10000000-0000-4000-8000-000000000002";
    const scopeFor = (id: string, chatId: string) => ({
      id, ownerId: "user_owner", kind: "chat", resourceId: chatId, membershipMode: "direct", lifecycle: "shared",
      revision: "1", authEpoch: "1", authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
    });
    const chatFor = (id: string, scope: string, title: string, messageCount = "1") => ({
      id, scopeId: scope, title, lifecycle: "active", revision: "1", messageCount,
    });
    const messageFor = (id: string, chatId: string, sequence: string, text: string) => ({
      id, chatId, sequence, role: "user", state: "committed", purpose: "discussion",
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text", text }],
      createdAt: "2026-09-07T12:00:00.000Z",
    });
    mockFetchInbox.mockResolvedValue({ items: [] });
    mockFetchShared.mockResolvedValue({ items: [
      { scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
        status: "accepted", resource: { scope: scopeFor(scopeId, "chat_a"), chat: chatFor("chat_a", scopeId, "Chat A", "2") } },
      { scopeId: secondScopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
        status: "accepted", resource: { scope: scopeFor(secondScopeId, "chat_b"), chat: chatFor("chat_b", secondScopeId, "Chat B") } },
    ] });
    mockFetchScope.mockImplementation(async (_token: string, selectedScopeId: string) => selectedScopeId === scopeId
      ? scopeFor(scopeId, "chat_a") : scopeFor(secondScopeId, "chat_b"));
    mockFetchChat.mockImplementation(async (_token: string, selectedScopeId: string) => selectedScopeId === scopeId
      ? chatFor("chat_a", scopeId, "Chat A", "2") : chatFor("chat_b", secondScopeId, "Chat B"));
    let resolveOldPage!: (value: unknown) => void;
    mockFetchMessages.mockImplementation(async (_token: string, selectedScopeId: string, after?: string) => {
      if (selectedScopeId === scopeId && after === "1") {
        return new Promise<unknown>((resolve) => { resolveOldPage = resolve; });
      }
      return { messages: selectedScopeId === scopeId
        ? [messageFor("msg_a1", "chat_a", "1", "A first")]
        : [messageFor("msg_b1", "chat_b", "1", "B current")] };
    });

    render(<SharedScreen />);
    fireEvent.press(await screen.findByLabelText("Open Chat A"));
    fireEvent.press(await screen.findByLabelText("Load more messages"));
    await waitFor(() => expect(resolveOldPage).toBeDefined());
    fireEvent.press(screen.getByLabelText("Back to Shared with me"));
    fireEvent.press(await screen.findByLabelText("Open Chat B"));
    expect(await screen.findByText("B current")).toBeTruthy();
    resolveOldPage({ messages: [messageFor("msg_a2", "chat_a", "2", "A stale")] });
    await waitFor(() => expect(screen.queryByText("A stale")).toBeNull());
    expect(screen.getByText("B current")).toBeTruthy();
  });

  it("loads another discovery page without replacing the first page", async () => {
    const secondInvitation = {
      ...invitation,
      id: "30000000-0000-4000-8000-000000000002",
      scopeId: "10000000-0000-4000-8000-000000000002",
      owner: { actorId: "user_owner_two", displayName: "Grace" },
    };
    mockFetchInbox
      .mockResolvedValueOnce({ items: [
        {
          scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
          status: "invited", invitationId, resource: invitation,
        },
      ], nextCursor: "opaque-next-page" })
      .mockResolvedValueOnce({ items: [
        {
          scopeId: secondInvitation.scopeId, runtimeId: "runtime_owner", ownerId: "user_owner_two", kind: "chat", authorityGeneration: 1,
          status: "invited", invitationId: secondInvitation.id, resource: secondInvitation,
        },
      ] });

    render(<SharedScreen />);
    expect(await screen.findByText("Nima invited you")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Load more shared items"));
    expect(await screen.findByText("Grace invited you")).toBeTruthy();
    expect(screen.getByText("Nima invited you")).toBeTruthy();
    expect(mockFetchInbox).toHaveBeenLastCalledWith("clerk-token", "opaque-next-page");
  });

  it("does not let a pending history page overwrite a newer realtime refresh", async () => {
    const message = (sequence: number) => ({
      id: `msg_${sequence}`, chatId: "chat_one", sequence: String(sequence), role: "user", state: "committed", purpose: "discussion",
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text", text: `Message ${sequence}` }],
      createdAt: "2026-09-07T12:00:00.000Z",
    });
    mockFetchInbox.mockResolvedValue({ items: [] });
    mockFetchShared.mockResolvedValue({ items: [{
      scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
      status: "accepted", resource: { scope: await mockFetchScope(), chat: await mockFetchChat() },
    }] });
    let resolveOldPage!: (value: unknown) => void;
    let historyCall = 0;
    mockFetchMessages.mockImplementation(async (_token: string, _scopeId: string, after?: string) => {
      historyCall += 1;
      if (historyCall === 1) return { messages: [message(1)] };
      if (after === "1" && historyCall === 2) {
        return new Promise<unknown>((resolve) => { resolveOldPage = resolve; });
      }
      return { messages: [message(2), message(3)] };
    });
    mockFetchChat.mockResolvedValue({
      id: "chat_one", scopeId, title: "Launch plan", lifecycle: "active", revision: "2", messageCount: "3",
    });

    render(<SharedScreen />);
    fireEvent.press(await screen.findByLabelText("Open Launch plan"));
    fireEvent.press(await screen.findByLabelText("Load more messages"));
    await waitFor(() => expect(resolveOldPage).toBeDefined());
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => sockets[0]!.onmessage?.({ data: JSON.stringify({
      version: 1, type: "refresh_required", scopeId, resourceId: "chat_one", authorityGeneration: "1", sequence: "2",
    }) }));
    expect(await screen.findByText("Message 3")).toBeTruthy();
    await act(async () => resolveOldPage({ messages: [message(2)] }));
    expect(screen.getByText("Message 3")).toBeTruthy();
  });

  it("does not let the initial Chat load overwrite a newer realtime refresh", async () => {
    const scopeRecord = {
      id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: "chat_one", membershipMode: "direct", lifecycle: "shared",
      revision: "2", authEpoch: "1", authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
    };
    const initialChat = {
      id: "chat_one", scopeId, title: "Old title", lifecycle: "active", revision: "1", messageCount: "1",
    };
    const currentChat = { ...initialChat, title: "Current title", revision: "2" };
    const message = (id: string, text: string) => ({
      id, chatId: "chat_one", sequence: "1", role: "user", state: "committed", purpose: "discussion",
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text", text }],
      createdAt: "2026-09-07T12:00:00.000Z",
    });
    mockFetchInbox.mockResolvedValue({ items: [] });
    mockFetchShared.mockResolvedValue({ items: [{
      scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
      status: "accepted", resource: { scope: scopeRecord, chat: initialChat },
    }] });
    let resolveInitialScope!: (value: unknown) => void;
    let resolveInitialChat!: (value: unknown) => void;
    let resolveInitialHistory!: (value: unknown) => void;
    mockFetchScope
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitialScope = resolve; }))
      .mockResolvedValue(scopeRecord);
    mockFetchChat
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitialChat = resolve; }))
      .mockResolvedValue(currentChat);
    mockFetchMessages
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitialHistory = resolve; }))
      .mockResolvedValue({ messages: [message("msg_current", "Current message")] });

    render(<SharedScreen />);
    fireEvent.press(await screen.findByLabelText("Open Old title"));
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => sockets[0]!.onmessage?.({ data: JSON.stringify({
      version: 1, type: "refresh_required", scopeId, resourceId: "chat_one", authorityGeneration: "1", sequence: "2",
    }) }));
    expect(await screen.findByText("Current message")).toBeTruthy();
    await act(async () => {
      resolveInitialScope({ ...scopeRecord, revision: "1" });
      resolveInitialChat(initialChat);
      resolveInitialHistory({ messages: [message("msg_old", "Old message")] });
    });
    await waitFor(() => expect(screen.queryByText("Old message")).toBeNull());
    expect(screen.getByText("Current message")).toBeTruthy();
    expect(screen.getByText("Current title")).toBeTruthy();
  });

  it("does not show an error from a realtime refresh superseded by leaving the Chat", async () => {
    mockFetchInbox.mockResolvedValue({ items: [] });
    mockFetchShared.mockResolvedValue({ items: [{
      scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1,
      status: "accepted", resource: { scope: await mockFetchScope(), chat: await mockFetchChat() },
    }] });
    render(<SharedScreen />);
    fireEvent.press(await screen.findByLabelText("Open Launch plan"));
    await waitFor(() => expect(sockets).toHaveLength(1));
    let rejectRefresh!: (reason: Error) => void;
    mockFetchScope.mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    await act(async () => sockets[0]!.onmessage?.({ data: JSON.stringify({
      version: 1, type: "refresh_required", scopeId, resourceId: "chat_one", authorityGeneration: "1", sequence: "2",
    }) }));
    await waitFor(() => expect(rejectRefresh).toBeDefined());
    fireEvent.press(screen.getByLabelText("Back to Shared with me"));
    await act(async () => rejectRefresh(new Error("old Chat failed")));
    await waitFor(() => expect(screen.queryByText("This shared Chat could not be refreshed. Try again.")).toBeNull());
    expect(await screen.findByText("Shared with me")).toBeTruthy();
  });
});
