import type { ReactNode } from "react";
import type { CanonicalChatDetailResponse, CanonicalChatModelSelection } from "@matrix-os/contracts";

// These tests run the real send mutation against a real QueryClient; only the
// network requests, auth, and the chat session's bind are replaced.
const mockFetchActiveComputer = jest.fn();
const mockCreateChat = jest.fn();
const mockAdmitChatTurn = jest.fn();
const mockBindDraftChatId = jest.fn();
let mockRequestIdCount = 0;

// The contracts barrel pulls in ESM-only micromark, which Jest cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: async () => "clerk-token", userId: "user_1" }),
}));

jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ bindDraftChatId: mockBindDraftChatId }),
}));

jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.example.test" }));

jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  createChat: (...args: unknown[]) => mockCreateChat(...args),
  admitChatTurn: (...args: unknown[]) => mockAdmitChatTurn(...args),
  canonicalChatTitle: (text: string) => text,
  canonicalChatRequestId: () => `req_${++mockRequestIdCount}`,
  mobileQueryKeys: {
    canonicalChats: (userId: string, computerKey: string) => ["chats", userId, computerKey],
    canonicalChatDetail: (userId: string, computerKey: string, chatId: string) => [
      "chats", "detail", userId, computerKey, chatId,
    ],
  },
}));

import React from "react";
import * as Haptics from "expo-haptics";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import { disposeTestQueryClient } from "./query-test-cleanup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useChatComposer } from "../lib/use-chat-composer";

const selection = { instanceId: "instance_test", model: "test" } as CanonicalChatModelSelection;
const turnModes = { interactionMode: "default", permissionMode: "supervised" };

type ComposerProps = Parameters<typeof useChatComposer>[0];

const newChat: ComposerProps = {
  scope: "user_1:amin:primary", activeChatId: null, detail: null, selection, turnModes, projectId: null,
};

function detailFor(chatId: string, messageIds: string[], turns: { clientRequestId: string; inputMessageId: string }[] = []) {
  return {
    record: { chat: { id: chatId, revision: 7 } },
    runs: [],
    activities: [],
    turns: turns.map((turn) => ({ id: `cturn_${turn.inputMessageId}`, chatId, ...turn })),
    messages: messageIds.map((id, index) => ({
      id, chatId, role: "user", state: "committed", seq: index + 1,
      parts: [{ type: "text", text: "Ship it" }], createdAt: "2026-09-09T00:00:00.000Z",
    })),
  } as unknown as CanonicalChatDetailResponse;
}

function admissionFor(chatId: string, messageId: string) {
  return { record: { chat: { id: chatId, revision: 2 } }, message: { id: messageId }, admission: "accepted" };
}

describe("chat composer send lifecycle", () => {
  let queryClient: QueryClient;
  let invalidateQueries: jest.SpyInstance;

  function renderComposer(initialProps: Partial<ComposerProps> = {}) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook((props: ComposerProps) => useChatComposer(props), {
      wrapper,
      initialProps: { ...newChat, ...initialProps },
    });
  }

  function sendText(composer: ReturnType<typeof renderComposer>, text: string) {
    act(() => { composer.result.current.setDraft(text); });
    act(() => { composer.result.current.send(); });
  }

  beforeEach(() => {
    mockRequestIdCount = 0;
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
    invalidateQueries = jest.spyOn(queryClient, "invalidateQueries");
    mockFetchActiveComputer.mockResolvedValue({ handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" });
    mockCreateChat.mockResolvedValue({ chat: { id: "chat_new", revision: 1 } });
  });

  afterEach(async () => {
    cleanup();
    await disposeTestQueryClient(queryClient);
    jest.clearAllMocks();
  });

  it("carries the message from a draft into its new chat and hands over to the admitted message", async () => {
    let admit: (admission: unknown) => void = () => {};
    mockAdmitChatTurn.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
    const composer = renderComposer();

    sendText(composer, "Ship it");
    expect(composer.result.current.draft).toBe("");
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Ship it", chatId: null }]);

    // The chat is created, but the draft is not bound to it until the turn is admitted.
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
    expect(mockCreateChat.mock.calls[0][2]).toMatchObject({ clientRequestId: "req_1", title: "Ship it" });
    const [, gatewayUrl, admittedChatId, turnRequest] = mockAdmitChatTurn.mock.calls[0];
    expect(gatewayUrl).toBe("https://app.example.test/vm/amin");
    expect(admittedChatId).toBe("chat_new");
    expect(turnRequest).toMatchObject({
      clientRequestId: "req_2",
      baseRevision: 1,
      parts: [{ type: "text", text: "Ship it" }],
    });
    expect(mockBindDraftChatId).not.toHaveBeenCalled();
    expect(composer.result.current.isSending).toBe(true);

    await act(async () => { admit(admissionFor("chat_new", "msg_new")); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));
    expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_new");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["chats", "user_1", "amin:primary"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["chats", "detail", "user_1", "amin:primary", "chat_new"],
    });

    // The session now shows the new chat; its detail has not loaded yet.
    composer.rerender({ ...newChat, activeChatId: "chat_new" });
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Ship it", chatId: "chat_new" }]);

    // The detail arrives with the admitted turn and its message.
    composer.rerender({
      ...newChat,
      activeChatId: "chat_new",
      detail: detailFor("chat_new", ["msg_new"], [{ clientRequestId: "req_2", inputMessageId: "msg_new" }]),
    });
    expect(composer.result.current.optimisticMessages).toEqual([]);
    expect(composer.result.current.draft).toBe("");
  });

  it("hands over by the admitted message id when the detail does not carry the turn", async () => {
    mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_existing", "msg_mine"));
    const composer = renderComposer({ activeChatId: "chat_existing", detail: detailFor("chat_existing", ["msg_old"]) });

    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    // An existing chat is sent to as is, at its current revision.
    expect(mockCreateChat).not.toHaveBeenCalled();
    expect(mockBindDraftChatId).not.toHaveBeenCalled();
    expect(mockAdmitChatTurn.mock.calls[0][2]).toBe("chat_existing");
    expect(mockAdmitChatTurn.mock.calls[0][3]).toMatchObject({ baseRevision: 7 });
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Ship it" }]);

    composer.rerender({
      ...newChat,
      activeChatId: "chat_existing",
      detail: detailFor("chat_existing", ["msg_old", "msg_mine"]),
    });
    expect(composer.result.current.optimisticMessages).toEqual([]);
  });

  it("keeps a message whose admission failed in the chat as not sent, and sends it again with the same keys", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const composer = renderComposer();

    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));
    expect(composer.result.current.optimisticMessages).toMatchObject([
      { id: "optimistic-req_2", text: "Ship it", failed: true, retryBlocked: false },
    ]);
    expect(composer.result.current.draft).toBe("");
    expect(mockBindDraftChatId).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);

    let admit: (admission: unknown) => void = () => {};
    mockAdmitChatTurn.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
    act(() => { composer.result.current.retrySend("optimistic-req_2"); });

    // On its way again, and nothing else can be retried meanwhile.
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Ship it" }]);
    expect(composer.result.current.optimisticMessages[0]?.failed).toBeFalsy();
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
    await act(async () => { admit(admissionFor("chat_new", "msg_new")); });
    await waitFor(() => expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_new"));

    expect(mockCreateChat.mock.calls.map((call) => call[2].clientRequestId)).toEqual(["req_1", "req_1"]);
    expect(mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId)).toEqual(["req_2", "req_2"]);
    expect(composer.result.current.draft).toBe("");
  });

  it("keeps a failed message in an existing chat, leaves what is typed alone, and reads the chat again", async () => {
    let fail: (error: Error) => void = () => {};
    mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const inChat = { activeChatId: "chat_existing", detail: detailFor("chat_existing", ["msg_old"]) };
    const composer = renderComposer(inChat);

    sendText(composer, "Ship it");
    act(() => { composer.result.current.setDraft("and tag it"); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
    await act(async () => { fail(new Error("Turn rejected")); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Ship it", failed: true }]);
    expect(composer.result.current.draft).toBe("and tag it");
    // The answer may only have been lost; the chat's copy then takes over.
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["chats", "detail", "user_1", "amin:primary", "chat_existing"],
    });
    composer.rerender({
      ...newChat,
      ...inChat,
      detail: detailFor("chat_existing", ["msg_old", "msg_mine"], [{ clientRequestId: "req_2", inputMessageId: "msg_mine" }]),
    });
    expect(composer.result.current.optimisticMessages).toEqual([]);
  });

  it("takes a message that was not sent back into the composer ahead of what was typed, and sends it unchanged as the same send", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const composer = renderComposer({ activeChatId: "chat_existing", detail: detailFor("chat_existing", []) });

    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.optimisticMessages).toMatchObject([{ failed: true }]));
    act(() => { composer.result.current.setDraft("today"); });

    act(() => { composer.result.current.editUnsent("optimistic-req_2"); });
    expect(composer.result.current.optimisticMessages).toEqual([]);
    expect(composer.result.current.draft).toBe("Ship it today");

    // Sent again as it was, it is still the same send.
    mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_existing", "msg_mine"));
    sendText(composer, "Ship it");
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
    expect(mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId)).toEqual(["req_2", "req_2"]);
  });

  it("does not send a message that was not sent again while another send is on its way, or while sending is held back", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const inChat = { activeChatId: "chat_existing", detail: detailFor("chat_existing", []) };
    const composer = renderComposer(inChat);
    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.optimisticMessages).toMatchObject([{ failed: true }]));

    mockAdmitChatTurn.mockReturnValue(new Promise(() => {}));
    sendText(composer, "Something else");
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
    expect(composer.result.current.optimisticMessages).toMatchObject([
      { text: "Ship it", failed: true, retryBlocked: true },
      { text: "Something else" },
    ]);
    act(() => { composer.result.current.retrySend("optimistic-req_2"); });
    expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2);

    const held = renderComposer({ ...inChat, disabled: true });
    expect(held.result.current.optimisticMessages).toEqual([]);
  });

  it("keeps a new chat's message that was not sent tied to its own chat when the next message there creates another", async () => {
    // Each creation key names its own chat, as on the computer.
    mockCreateChat.mockImplementation(async (_token: string, _gateway: string, input: { clientRequestId: string }) => (
      { chat: { id: input.clientRequestId === "req_1" ? "chat_first" : "chat_new", revision: 1 } }
    ));
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const composer = renderComposer();
    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.optimisticMessages).toMatchObject([{ failed: true }]));

    mockAdmitChatTurn.mockResolvedValueOnce(admissionFor("chat_new", "msg_other"));
    sendText(composer, "Never mind");
    await waitFor(() => expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_new"));
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    // The first message may have been admitted in its own chat, so it is not
    // sent again in the one the second message created.
    composer.rerender({ ...newChat, activeChatId: "chat_new" });
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Never mind", chatId: "chat_new" }]);
    expect(composer.result.current.optimisticMessages.some((message) => message.failed)).toBe(false);

    // It comes back in the next new chat, and sent from there it reaches its own chat.
    composer.rerender(newChat);
    expect(composer.result.current.draft).toBe("Ship it");
    mockAdmitChatTurn.mockResolvedValueOnce(admissionFor("chat_first", "msg_first"));
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(3));
    expect(mockCreateChat.mock.calls[2][2]).toMatchObject({ clientRequestId: "req_1" });
    expect(mockAdmitChatTurn.mock.calls[2][2]).toBe("chat_first");
    expect(mockAdmitChatTurn.mock.calls[2][3]).toMatchObject({ clientRequestId: "req_2" });
  });

  it("puts a new chat's message that was not sent back into the next new chat's composer once the user moves on", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const composer = renderComposer();
    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.optimisticMessages).toMatchObject([{ failed: true }]));

    composer.rerender({ ...newChat, activeChatId: "chat_b", detail: detailFor("chat_b", []) });
    expect(composer.result.current.optimisticMessages).toEqual([]);
    expect(composer.result.current.draft).toBe("");

    composer.rerender(newChat);
    expect(composer.result.current.optimisticMessages).toEqual([]);
    expect(composer.result.current.draft).toBe("Ship it");
  });

  it("puts the oldest message that was not sent back into its composer beyond the limit, so none is lost", async () => {
    mockAdmitChatTurn.mockRejectedValue(new Error("Turn rejected"));
    const composer = renderComposer({ activeChatId: "chat_existing", detail: detailFor("chat_existing", []) });

    for (let index = 0; index < 9; index += 1) {
      sendText(composer, `Message ${index}`);
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
    }

    const unsent = composer.result.current.optimisticMessages;
    expect(unsent).toHaveLength(8);
    expect(unsent.every((message) => message.failed)).toBe(true);
    expect(unsent[0]).toMatchObject({ text: "Message 1" });
    expect(composer.result.current.draft).toBe("Message 0");
  });

  it("keeps a chat's pending message when another chat sends before it is delivered", async () => {
    mockAdmitChatTurn.mockResolvedValueOnce(admissionFor("chat_a", "msg_a"));
    const inA = { ...newChat, activeChatId: "chat_a", detail: detailFor("chat_a", []) };
    const inB = { ...newChat, activeChatId: "chat_b", detail: detailFor("chat_b", []) };
    const composer = renderComposer(inA);

    sendText(composer, "For A");
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    // Admitted, but chat A's detail has not caught up when the user moves on.
    mockAdmitChatTurn.mockResolvedValueOnce(admissionFor("chat_b", "msg_b"));
    composer.rerender(inB);
    expect(composer.result.current.optimisticMessages).toEqual([]);
    sendText(composer, "For B");
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "For B" }]);

    composer.rerender(inA);
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "For A" }]);

    composer.rerender({ ...inA, detail: detailFor("chat_a", ["msg_a"]) });
    expect(composer.result.current.optimisticMessages).toEqual([]);
  });

  it("moves text typed during a new chat's first send into the chat created for it", async () => {
    let admit: (admission: unknown) => void = () => {};
    mockAdmitChatTurn.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
    const composer = renderComposer();

    sendText(composer, "Ship it");
    act(() => { composer.result.current.setDraft("and tag it"); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
    await act(async () => { admit(admissionFor("chat_new", "msg_new")); });
    await waitFor(() => expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_new"));

    composer.rerender({ ...newChat, activeChatId: "chat_new" });
    expect(composer.result.current.draft).toBe("and tag it");

    // The next new chat starts with an empty composer.
    composer.rerender(newChat);
    expect(composer.result.current.draft).toBe("");
  });

  describe("a new chat started after an earlier new chat's send", () => {
    const inAnotherChat = { ...newChat, activeChatId: "chat_b", detail: detailFor("chat_b", []) };

    it("keeps its draft when the earlier send completes", async () => {
      let admit: (admission: unknown) => void = () => {};
      mockAdmitChatTurn.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
      const composer = renderComposer();
      sendText(composer, "Ship it");

      // The user opens another chat, then starts a different new chat.
      composer.rerender(inAnotherChat);
      composer.rerender(newChat);
      expect(composer.result.current.optimisticMessages).toEqual([]);
      act(() => { composer.result.current.setDraft("later"); });

      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      await act(async () => { admit(admissionFor("chat_new", "msg_new")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
      expect(composer.result.current.draft).toBe("later");

      // The created chat shows the sent message and has no draft of its own.
      composer.rerender({ ...newChat, activeChatId: "chat_new" });
      expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "Ship it" }]);
      expect(composer.result.current.draft).toBe("");
    });

    it("is not given the earlier send's text when that send fails, until its composer is free", async () => {
      let fail: (error: Error) => void = () => {};
      mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
      const composer = renderComposer();
      sendText(composer, "Ship it");

      composer.rerender(inAnotherChat);
      composer.rerender(newChat);
      act(() => { composer.result.current.setDraft("later"); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      await act(async () => { fail(new Error("Turn rejected")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
      expect(composer.result.current.draft).toBe("later");

      // Once the later draft is out of the composer, the unsent text comes back.
      act(() => { composer.result.current.setDraft(""); });
      expect(composer.result.current.draft).toBe("Ship it");

      // And it is still a retry of the same send.
      mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_new", "msg_new"));
      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
      expect(mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId)).toEqual(["req_2", "req_2"]);
    });

    it("does not bring the earlier send's text back once it has been retried successfully", async () => {
      let fail: (error: Error) => void = () => {};
      mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
      const composer = renderComposer();
      sendText(composer, "Ship it");

      composer.rerender(inAnotherChat);
      composer.rerender(newChat);
      act(() => { composer.result.current.setDraft("later"); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      await act(async () => { fail(new Error("Turn rejected")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));

      // While the failed text is still held, the user types it again and sends it.
      mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_new", "msg_new"));
      sendText(composer, "Ship it");
      await waitFor(() => expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_new"));
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
      expect(mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId)).toEqual(["req_2", "req_2"]);

      // It was sent, so the next new chat starts empty.
      composer.rerender({ ...newChat, activeChatId: "chat_new" });
      composer.rerender(newChat);
      expect(composer.result.current.draft).toBe("");
    });

    it("takes the earlier send's text straight away when nothing has been typed in it", async () => {
      let fail: (error: Error) => void = () => {};
      mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
      const composer = renderComposer();
      sendText(composer, "Ship it");

      composer.rerender(inAnotherChat);
      composer.rerender(newChat);
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      await act(async () => { fail(new Error("Turn rejected")); });
      await waitFor(() => expect(composer.result.current.draft).toBe("Ship it"));
    });
  });

  describe("switching to another computer", () => {
    const onOtherComputer = { ...newChat, scope: "user_1:amin:secondary" };

    it("starts clean and ignores a send made on the previous computer", async () => {
      let fail: (error: Error) => void = () => {};
      mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
      const composer = renderComposer();
      sendText(composer, "Ship it");
      act(() => { composer.result.current.setDraft("and tag it"); });

      composer.rerender(onOtherComputer);
      expect(composer.result.current.draft).toBe("");
      expect(composer.result.current.optimisticMessages).toEqual([]);

      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      await act(async () => { fail(new Error("Turn rejected")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
      expect(composer.result.current.draft).toBe("");

      // The same text sent here is a new send, not a retry of the other computer's.
      mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_new", "msg_new"));
      sendText(composer, "Ship it");
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
      const [first, second] = mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId);
      expect(second).not.toBe(first);
    });

    it("keeps a draft typed before the computer was known", () => {
      const composer = renderComposer({ scope: null });
      act(() => { composer.result.current.setDraft("typed early"); });

      composer.rerender(newChat);
      expect(composer.result.current.draft).toBe("typed early");
    });
  });

  it("does not reuse a failed new chat's keys once a different project is selected", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const composer = renderComposer({ projectId: "proj_old" });

    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.optimisticMessages).toMatchObject([{ failed: true }]));

    // The message was written for the old project's new chat; in the new
    // project's it is not shown, and its text comes back to the composer.
    mockCreateChat.mockResolvedValue({ chat: { id: "chat_in_new_project", revision: 1 } });
    mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_in_new_project", "msg_new"));
    composer.rerender({ ...newChat, projectId: "proj_new" });
    expect(composer.result.current.optimisticMessages).toEqual([]);
    expect(composer.result.current.draft).toBe("Ship it");

    // Reusing the creation key would bring back the chat made in the old project.
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_in_new_project"));

    const [first, second] = mockCreateChat.mock.calls.map((call) => call[2]);
    expect(first).toMatchObject({ projectId: "proj_old" });
    expect(second).toMatchObject({ projectId: "proj_new" });
    expect(second.clientRequestId).not.toBe(first.clientRequestId);
    const [firstTurn, secondTurn] = mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId);
    expect(secondTurn).not.toBe(firstTurn);
  });

  it("treats repeated text as a new message once another send in the chat has succeeded", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Turn rejected"));
    const props = { activeChatId: "chat_existing", detail: detailFor("chat_existing", []) };
    const composer = renderComposer(props);

    sendText(composer, "Ship it");
    await waitFor(() => expect(composer.result.current.optimisticMessages).toMatchObject([{ failed: true }]));
    act(() => { composer.result.current.editUnsent("optimistic-req_2"); });
    expect(composer.result.current.draft).toBe("Ship it");

    // The user sends something else instead, which succeeds.
    mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_existing", "msg_other"));
    sendText(composer, "Never mind");
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    sendText(composer, "Ship it");
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(3));
    const requestIds = mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId);
    expect(new Set(requestIds).size).toBe(3);
  });
});
