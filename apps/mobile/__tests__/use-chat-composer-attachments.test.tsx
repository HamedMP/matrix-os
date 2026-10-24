import type { ReactNode } from "react";
import type { CanonicalChatDetailResponse, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MAX_MESSAGE_ATTACHMENTS, type ComposerAttachment } from "../lib/chat-attachments";
import { useChatComposer } from "../lib/use-chat-composer";

import { disposeTestQueryClient } from "./query-test-cleanup";
import { catalogOf, engineInstance } from "./model-test-catalog";

// These tests run the real send mutation against a real QueryClient; only the
// network requests, auth, and the chat session's bind are replaced.
const mockFetchActiveComputer = jest.fn();
const mockCreateChat = jest.fn();
const mockAdmitChatTurn = jest.fn();
const mockUploadChatAttachment = jest.fn();
const mockRemoveChatAttachment = jest.fn();
const mockBindDraftChatId = jest.fn();
const mockGetToken = jest.fn();
let mockRequestIdCount = 0;

// The contracts barrel pulls in ESM-only micromark, which Jest cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: () => mockGetToken(), userId: "user_1" }),
}));

jest.mock("@/lib/canonical-chat-session-context", () => ({
  useCanonicalChatSession: () => ({ bindDraftChatId: mockBindDraftChatId }),
}));

jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.example.test" }));

jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  createChat: (...args: unknown[]) => mockCreateChat(...args),
  admitChatTurn: (...args: unknown[]) => mockAdmitChatTurn(...args),
  uploadChatAttachment: (...args: unknown[]) => mockUploadChatAttachment(...args),
  removeChatAttachment: (...args: unknown[]) => mockRemoveChatAttachment(...args),
  canonicalChatTitle: (text: string) => text,
  canonicalChatRequestId: () => `req_${++mockRequestIdCount}`,
  mobileQueryKeys: {
    canonicalChats: (userId: string, computerKey: string) => ["chats", userId, computerKey],
    canonicalChatDetail: (userId: string, computerKey: string, chatId: string) => [
      "chats", "detail", userId, computerKey, chatId,
    ],
  },
}));

const selection = { instanceId: "instance_test", model: "test" } as CanonicalChatModelSelection;
const turnModes = { interactionMode: "default", permissionMode: "supervised" };
const gatewayUrl = "https://app.example.test/vm/amin";

type ComposerProps = Parameters<typeof useChatComposer>[0];

const newChat: ComposerProps = {
  scope: "user_1:amin:primary", activeChatId: null, detail: null, selection, turnModes, projectId: null,
  catalog: catalogOf(engineInstance(selection.instanceId, "codex", "Test", [[selection.model, "Test"]])),
};

/** A well-formed attachment id for a test attachment, from its short name. */
function idOf(name: string): string {
  const hex = Array.from(name, (letter) => letter.charCodeAt(0).toString(16)).join("");
  return `att_${hex.padEnd(32, "0").slice(0, 32)}`;
}

function photo(name: string): ComposerAttachment {
  return {
    id: idOf(name),
    uri: `file:///cache/${name}.jpg`,
    name: `${name}.jpg`,
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 2_048,
  };
}

function placeOf(name: string): string {
  return `temporary/desktop-chat/${idOf(name)}-${name}.jpg`;
}

function partFor(name: string) {
  return {
    type: "attachment_reference",
    attachmentId: `mobile_upload_${idOf(name)}`,
    kind: "image",
    label: `${name}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 2_048,
    ownerReference: placeOf(name),
  };
}

function detailFor(chatId: string) {
  return {
    record: { chat: { id: chatId, revision: 7 } }, runs: [], activities: [], turns: [], messages: [],
  } as unknown as CanonicalChatDetailResponse;
}

function admissionFor(chatId: string, messageId: string) {
  return { record: { chat: { id: chatId, revision: 2 } }, message: { id: messageId }, admission: "accepted" };
}

describe("chat composer attachments", () => {
  let queryClient: QueryClient;
  let warn: jest.SpyInstance;

  function renderComposer(initialProps: Partial<ComposerProps> = {}) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook((props: ComposerProps) => useChatComposer(props), {
      wrapper,
      initialProps: { ...newChat, ...initialProps },
    });
  }

  function attach(composer: ReturnType<typeof renderComposer>, ...names: string[]) {
    act(() => { composer.result.current.addAttachments(names.map(photo)); });
  }

  function waiting(composer: ReturnType<typeof renderComposer>) {
    return composer.result.current.attachments.map((attachment) => attachment.name);
  }

  /** The attachments of the chat's messages that were not sent, by message. */
  function unsent(composer: ReturnType<typeof renderComposer>) {
    return composer.result.current.optimisticMessages
      .filter((message) => message.failed)
      .map((message) => (message.attachments ?? []).map((attachment) => attachment.name));
  }

  // The first send's keys are req_1 (the chat) and req_2 (the turn).
  const FIRST_SEND = "optimistic-req_2";

  beforeEach(() => {
    mockRequestIdCount = 0;
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockGetToken.mockResolvedValue("clerk-token");
    mockFetchActiveComputer.mockResolvedValue({ handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" });
    mockCreateChat.mockResolvedValue({ chat: { id: "chat_new", revision: 1 } });
    mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_new", "msg_new"));
    mockUploadChatAttachment.mockImplementation(async (_token: string, _gateway: string, attachment: ComposerAttachment) => (
      { path: `temporary/desktop-chat/${attachment.id}-${attachment.name}`, created: true }
    ));
    mockRemoveChatAttachment.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    cleanup();
    await disposeTestQueryClient(queryClient);
    warn.mockRestore();
    jest.clearAllMocks();
  });

  it("holds what is added, each once, and lets go of what is removed", () => {
    const composer = renderComposer();

    attach(composer, "a", "b");
    attach(composer, "b", "c");
    expect(waiting(composer)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);

    act(() => { composer.result.current.removeAttachment(photo("b").id); });
    expect(waiting(composer)).toEqual(["a.jpg", "c.jpg"]);
  });

  it("holds no more than a message carries", () => {
    const composer = renderComposer();

    attach(composer, ...Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 2 }, (_, index) => `p${index}`));

    expect(waiting(composer)).toHaveLength(MAX_MESSAGE_ATTACHMENTS);
  });

  it("keeps each chat's attachments apart, like its draft", () => {
    const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
    attach(composer, "for-a");

    composer.rerender({ ...newChat, activeChatId: "chat_b", detail: detailFor("chat_b") });
    expect(waiting(composer)).toEqual([]);
    attach(composer, "for-b");

    composer.rerender({ ...newChat, activeChatId: "chat_a", detail: detailFor("chat_a") });
    expect(waiting(composer)).toEqual(["for-a.jpg"]);
  });

  it("does not carry attachments over to another account or computer", () => {
    const composer = renderComposer();
    attach(composer, "mine");

    composer.rerender({ ...newChat, scope: "user_2:eve:primary" });

    expect(waiting(composer)).toEqual([]);
    expect(composer.result.current.sentAttachments).toEqual({});
  });

  it("uploads the attachments, then sends a message that names them after its text", async () => {
    const composer = renderComposer();
    attach(composer, "flowers", "falls");
    act(() => { composer.result.current.setDraft("What are these?"); });

    act(() => { composer.result.current.send(); });

    // Shown as sent, and the composer emptied, before anything has gone out.
    expect(composer.result.current.draft).toBe("");
    expect(waiting(composer)).toEqual([]);
    expect(composer.result.current.optimisticMessages).toMatchObject([{
      text: "What are these?", attachments: [{ name: "flowers.jpg" }, { name: "falls.jpg" }],
    }]);
    expect(composer.result.current.sentAttachments).toEqual({
      [placeOf("flowers")]: "file:///cache/flowers.jpg",
      [placeOf("falls")]: "file:///cache/falls.jpg",
    });

    await waitFor(() => expect(composer.result.current.isSending).toBe(false));
    expect(mockUploadChatAttachment.mock.calls.map((call) => [call[0], call[1], call[2].name])).toEqual([
      ["clerk-token", gatewayUrl, "flowers.jpg"],
      ["clerk-token", gatewayUrl, "falls.jpg"],
    ]);
    expect(mockCreateChat.mock.calls[0][2]).toMatchObject({ title: "What are these?" });
    expect(mockAdmitChatTurn.mock.calls[0][3].parts).toEqual([
      { type: "text", text: "What are these?" },
      partFor("flowers"),
      partFor("falls"),
    ]);
    expect(mockRemoveChatAttachment).not.toHaveBeenCalled();
    // The uploads went first: nothing was created or asked for before them.
    expect(mockUploadChatAttachment.mock.invocationCallOrder[1])
      .toBeLessThan(mockCreateChat.mock.invocationCallOrder[0]!);
  });

  it("asks for the session token again after uploading, for what follows", async () => {
    mockGetToken.mockResolvedValueOnce("clerk-token").mockResolvedValueOnce("fresh-token");
    const composer = renderComposer();
    attach(composer, "flowers");

    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    expect(mockUploadChatAttachment.mock.calls[0][0]).toBe("clerk-token");
    expect(mockCreateChat.mock.calls[0][0]).toBe("fresh-token");
    expect(mockAdmitChatTurn.mock.calls[0][0]).toBe("fresh-token");
  });

  it("sends attachments alone, with no text, and titles the new chat after them", async () => {
    const composer = renderComposer();
    attach(composer, "flowers");

    act(() => { composer.result.current.send(); });
    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "", attachments: [{ name: "flowers.jpg" }] }]);
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    expect(mockCreateChat.mock.calls[0][2]).toMatchObject({ title: "Photo" });
    expect(mockAdmitChatTurn.mock.calls[0][3].parts).toEqual([partFor("flowers")]);
  });

  it("sends nothing while there is neither text nor an attachment", () => {
    const composer = renderComposer();

    act(() => { composer.result.current.setDraft("   "); });
    act(() => { composer.result.current.send(); });

    expect(mockFetchActiveComputer).not.toHaveBeenCalled();
    expect(composer.result.current.optimisticMessages).toEqual([]);
  });

  it("creates no chat and admits no turn when an upload fails, removes the uploads that arrived, and keeps everything in the message", async () => {
    mockUploadChatAttachment
      .mockResolvedValueOnce({ path: placeOf("flowers"), created: true })
      .mockRejectedValueOnce(new Error("Could not upload the attachment. Try again."));
    const composer = renderComposer();
    attach(composer, "flowers", "falls");
    act(() => { composer.result.current.setDraft("What are these?"); });

    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg", "falls.jpg"]]));

    expect(composer.result.current.optimisticMessages).toMatchObject([{ text: "What are these?", failed: true }]);
    expect(mockCreateChat).not.toHaveBeenCalled();
    expect(mockAdmitChatTurn).not.toHaveBeenCalled();
    expect(mockRemoveChatAttachment.mock.calls).toEqual([["clerk-token", gatewayUrl, placeOf("flowers")]]);

    // "Edit" gives everything back to the composer.
    act(() => { composer.result.current.editUnsent(FIRST_SEND); });
    expect(composer.result.current.draft).toBe("What are these?");
    expect(waiting(composer)).toEqual(["flowers.jpg", "falls.jpg"]);
  });

  it("removes the uploads when the chat cannot be created, since no turn was asked for", async () => {
    mockCreateChat.mockRejectedValueOnce(new Error("Could not start a new chat. Try again."));
    const composer = renderComposer();
    attach(composer, "flowers");

    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg"]]));

    expect(mockAdmitChatTurn).not.toHaveBeenCalled();
    expect(mockRemoveChatAttachment.mock.calls.map((call) => call[2])).toEqual([placeOf("flowers")]);
  });

  it("still keeps the message when an unused upload cannot be removed", async () => {
    mockCreateChat.mockRejectedValueOnce(new Error("Could not start a new chat. Try again."));
    mockRemoveChatAttachment.mockRejectedValue(new Error("Could not remove the attachment."));
    const composer = renderComposer();
    attach(composer, "flowers");

    act(() => { composer.result.current.send(); });

    await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg"]]));
    expect(composer.result.current.isSending).toBe(false);
  });

  it("leaves the uploads in place when admission fails, and sends again as the same message", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Could not send message. Try again."));
    const composer = renderComposer();
    attach(composer, "flowers");
    act(() => { composer.result.current.setDraft("What is this?"); });

    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg"]]));

    // The answer may only have been lost, and the turn it admitted names the upload.
    expect(mockRemoveChatAttachment).not.toHaveBeenCalled();

    act(() => { composer.result.current.retrySend(FIRST_SEND); });
    await waitFor(() => expect(mockBindDraftChatId).toHaveBeenCalledWith("chat_new"));

    // The same request ids and the same upload place, so the computer sees one message.
    expect(mockCreateChat.mock.calls.map((call) => call[2].clientRequestId)).toEqual(["req_1", "req_1"]);
    expect(mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId)).toEqual(["req_2", "req_2"]);
    expect(mockAdmitChatTurn.mock.calls[1][3].parts).toEqual(mockAdmitChatTurn.mock.calls[0][3].parts);
    expect(mockUploadChatAttachment.mock.calls.map((call) => call[2].id)).toEqual([idOf("flowers"), idOf("flowers")]);
  });

  describe("sending again after the computer may have admitted the turn", () => {
    // The first try uploads both and the answer to its admission is lost. The
    // turn it admitted names both uploads, so nothing may remove them.
    async function loseTheAnswer(composer: ReturnType<typeof renderComposer>) {
      mockAdmitChatTurn.mockRejectedValueOnce(new Error("Could not send message. Try again."));
      attach(composer, "flowers", "falls");
      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg", "falls.jpg"]]));
      mockUploadChatAttachment.mockReset();
    }

    it("removes nothing when an upload fails on the second try", async () => {
      const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
      await loseTheAnswer(composer);
      // The computer still has the first; the second cannot be reached.
      mockUploadChatAttachment
        .mockResolvedValueOnce({ path: placeOf("flowers"), created: false })
        .mockRejectedValueOnce(new Error("Could not upload the attachment. Try again."));

      act(() => { composer.result.current.retrySend(FIRST_SEND); });
      await waitFor(() => expect(mockUploadChatAttachment).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));

      expect(mockRemoveChatAttachment).not.toHaveBeenCalled();
      expect(unsent(composer)).toEqual([["flowers.jpg", "falls.jpg"]]);
    });

    it("removes nothing when the chat cannot be reached on the second try", async () => {
      const composer = renderComposer();
      await loseTheAnswer(composer);
      mockUploadChatAttachment
        .mockResolvedValueOnce({ path: placeOf("flowers"), created: false })
        .mockResolvedValueOnce({ path: placeOf("falls"), created: false });
      mockCreateChat.mockRejectedValueOnce(new Error("Could not start a new chat. Try again."));

      act(() => { composer.result.current.retrySend(FIRST_SEND); });
      await waitFor(() => expect(mockCreateChat).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));

      expect(mockRemoveChatAttachment).not.toHaveBeenCalled();
    });

    it("removes only what the second try itself put on the computer", async () => {
      const composer = renderComposer();
      await loseTheAnswer(composer);
      // One upload had been cleared meanwhile, so this try puts it back.
      mockUploadChatAttachment
        .mockResolvedValueOnce({ path: placeOf("flowers"), created: false })
        .mockResolvedValueOnce({ path: placeOf("falls"), created: true });
      mockCreateChat.mockRejectedValueOnce(new Error("Could not start a new chat. Try again."));

      act(() => { composer.result.current.retrySend(FIRST_SEND); });
      await waitFor(() => expect(mockRemoveChatAttachment).toHaveBeenCalledTimes(1));

      expect(mockRemoveChatAttachment.mock.calls[0][2]).toBe(placeOf("falls"));
    });
  });

  it("sends the same text with other attachments as a new message", async () => {
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Could not send message. Try again."));
    const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
    attach(composer, "flowers");
    act(() => { composer.result.current.setDraft("What is this?"); });
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg"]]));
    act(() => { composer.result.current.editUnsent(FIRST_SEND); });
    expect(composer.result.current.draft).toBe("What is this?");

    act(() => { composer.result.current.removeAttachment(photo("flowers").id); });
    attach(composer, "falls");
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));

    const [first, second] = mockAdmitChatTurn.mock.calls.map((call) => call[3].clientRequestId);
    expect(second).not.toBe(first);
  });

  describe("room for attachments while a send is on its way", () => {
    function pendingAdmission() {
      let settle: { admit: (admission: unknown) => void; fail: (error: Error) => void } = { admit: () => {}, fail: () => {} };
      mockAdmitChatTurn.mockReturnValueOnce(new Promise((resolve, reject) => { settle = { admit: resolve, fail: reject }; }));
      return () => settle;
    }

    const eight = Array.from({ length: MAX_MESSAGE_ATTACHMENTS }, (_, index) => `p${index}`);

    it("is held for what is being sent, and stays held while it waits as not sent, so nothing is lost when it comes back", async () => {
      const settle = pendingAdmission();
      const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
      attach(composer, ...eight);
      expect(composer.result.current.attachmentRoom).toBe(0);

      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));

      // The composer is empty, but its places are spoken for.
      expect(waiting(composer)).toEqual([]);
      expect(composer.result.current.attachmentRoom).toBe(0);
      attach(composer, "one-more");
      expect(waiting(composer)).toEqual([]);

      await act(async () => { settle().fail(new Error("Could not send message. Try again.")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
      expect(unsent(composer)).toEqual([eight.map((name) => `${name}.jpg`)]);
      expect(composer.result.current.attachmentRoom).toBe(0);

      act(() => { composer.result.current.editUnsent(FIRST_SEND); });
      expect(waiting(composer)).toEqual(eight.map((name) => `${name}.jpg`));
    });

    it("leaves the rest of the places free", async () => {
      const settle = pendingAdmission();
      const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
      attach(composer, "a", "b", "c");

      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      expect(composer.result.current.attachmentRoom).toBe(5);
      attach(composer, ...eight);

      // Five of the eight fit beside the three that may come back.
      expect(waiting(composer)).toHaveLength(5);
      await act(async () => { settle().fail(new Error("Could not send message. Try again.")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));
      expect(composer.result.current.attachmentRoom).toBe(0);

      act(() => { composer.result.current.editUnsent(FIRST_SEND); });
      expect(waiting(composer)).toHaveLength(MAX_MESSAGE_ATTACHMENTS);
      expect(waiting(composer).slice(0, 3)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    });

    it("is given back once the send has gone through", async () => {
      const settle = pendingAdmission();
      const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
      attach(composer, ...eight);

      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      await act(async () => { settle().admit(admissionFor("chat_a", "msg_a")); });
      await waitFor(() => expect(composer.result.current.isSending).toBe(false));

      expect(composer.result.current.attachmentRoom).toBe(MAX_MESSAGE_ATTACHMENTS);
    });

    it("is held in the chat that is sending, not in another", async () => {
      pendingAdmission();
      const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
      attach(composer, ...eight);
      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));

      composer.rerender({ ...newChat, activeChatId: "chat_b", detail: detailFor("chat_b") });

      expect(composer.result.current.attachmentRoom).toBe(MAX_MESSAGE_ATTACHMENTS);
    });
  });

  it("puts what was being chosen for a new chat into the chat it became meanwhile", async () => {
    let admit: (admission: unknown) => void = () => {};
    mockAdmitChatTurn.mockReturnValueOnce(new Promise((resolve) => { admit = resolve; }));
    const composer = renderComposer();
    act(() => { composer.result.current.setDraft("Start"); });
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));

    // The library is opened from the new chat while its first message is on its way...
    const addToTheNewChat = composer.result.current.addAttachments;
    await act(async () => { admit(admissionFor("chat_new", "msg_new")); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));
    composer.rerender({ ...newChat, activeChatId: "chat_new", detail: detailFor("chat_new") });

    // ...and a photo is chosen once that chat exists and is the one on screen.
    act(() => { addToTheNewChat([photo("late")]); });

    expect(waiting(composer)).toEqual(["late.jpg"]);
    composer.rerender(newChat);
    expect(waiting(composer)).toEqual([]);
  });

  describe("attachments the selected model does not read", () => {
    it("hold the message back and are reported, until the model reads them or they are removed", async () => {
      const composer = renderComposer({ attachmentKinds: ["file"] });
      attach(composer, "flowers");
      act(() => { composer.result.current.setDraft("What is this?"); });

      expect(composer.result.current.unreadableAttachments.map((item) => item.name)).toEqual(["flowers.jpg"]);
      act(() => { composer.result.current.send(); });
      expect(mockFetchActiveComputer).not.toHaveBeenCalled();
      expect(composer.result.current.draft).toBe("What is this?");
      expect(waiting(composer)).toEqual(["flowers.jpg"]);

      composer.rerender({ ...newChat, attachmentKinds: ["image", "file"] });
      expect(composer.result.current.unreadableAttachments).toEqual([]);
      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
    });

    it("stop holding it back once removed", async () => {
      const composer = renderComposer({ attachmentKinds: [] });
      attach(composer, "flowers");
      act(() => { composer.result.current.setDraft("Never mind the photo"); });

      act(() => { composer.result.current.removeAttachment(photo("flowers").id); });
      act(() => { composer.result.current.send(); });

      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
      expect(mockUploadChatAttachment).not.toHaveBeenCalled();
    });

    it("keep a message that was not sent from being sent again, until the model reads them", async () => {
      mockAdmitChatTurn.mockRejectedValueOnce(new Error("Could not send message. Try again."));
      const inChat = { activeChatId: "chat_a", detail: detailFor("chat_a"), attachmentKinds: ["image", "file"] as const };
      const composer = renderComposer(inChat);
      attach(composer, "flowers");
      act(() => { composer.result.current.send(); });
      await waitFor(() => expect(unsent(composer)).toEqual([["flowers.jpg"]]));
      expect(composer.result.current.optimisticMessages).toMatchObject([{ retryBlocked: false }]);

      composer.rerender({ ...newChat, ...inChat, attachmentKinds: ["file"] });
      expect(composer.result.current.optimisticMessages).toMatchObject([{ retryBlocked: true }]);
      act(() => { composer.result.current.retrySend(FIRST_SEND); });
      expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1);

      mockAdmitChatTurn.mockResolvedValue(admissionFor("chat_a", "msg_a"));
      composer.rerender({ ...newChat, ...inChat });
      act(() => { composer.result.current.retrySend(FIRST_SEND); });
      await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(2));
    });

    it("are none where the screen does not say what the model reads", () => {
      const composer = renderComposer();
      attach(composer, "flowers");

      expect(composer.result.current.unreadableAttachments).toEqual([]);
    });
  });

  it("puts attachments taken back from a message ahead of any added while it was on its way", async () => {
    let fail: (error: Error) => void = () => {};
    mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const composer = renderComposer({ activeChatId: "chat_a", detail: detailFor("chat_a") });
    attach(composer, "sent");

    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
    attach(composer, "added-meanwhile");
    await act(async () => { fail(new Error("Could not send message. Try again.")); });
    await waitFor(() => expect(unsent(composer)).toEqual([["sent.jpg"]]));

    act(() => { composer.result.current.editUnsent(FIRST_SEND); });
    expect(waiting(composer)).toEqual(["sent.jpg", "added-meanwhile.jpg"]);
    // Only attachments were sent, so the draft gains no stray space.
    expect(composer.result.current.draft).toBe("");
  });

  it("carries attachments added during a first send into the chat it creates", async () => {
    let admit: (admission: unknown) => void = () => {};
    mockAdmitChatTurn.mockReturnValueOnce(new Promise((resolve) => { admit = resolve; }));
    const composer = renderComposer();
    attach(composer, "first");

    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));
    attach(composer, "next");
    await act(async () => { admit(admissionFor("chat_new", "msg_new")); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    // The new chat's composer is free again, and the created chat has what was added.
    expect(waiting(composer)).toEqual([]);
    composer.rerender({ ...newChat, activeChatId: "chat_new", detail: detailFor("chat_new") });
    expect(waiting(composer)).toEqual(["next.jpg"]);
  });

  it("keeps a held send waiting until its attachments fit beside those of a message that was not sent", async () => {
    let failFirst: (error: Error) => void = () => {};
    mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { failFirst = reject; }));
    const composer = renderComposer();
    attach(composer, "a1", "a2", "a3", "a4", "a5");
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));

    // The person leaves and comes back to a new chat, and starts another message there.
    composer.rerender({ ...newChat, activeChatId: "chat_other", detail: detailFor("chat_other") });
    composer.rerender(newChat);
    act(() => { composer.result.current.setDraft("Second"); });
    await act(async () => { failFirst(new Error("Could not send message. Try again.")); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    // The second message fails too, and stays here with its four attachments.
    mockAdmitChatTurn.mockRejectedValueOnce(new Error("Could not send message. Try again."));
    attach(composer, "b1", "b2", "b3", "b4");
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(unsent(composer)).toEqual([["b1.jpg", "b2.jpg", "b3.jpg", "b4.jpg"]]));

    // The first message's five would not fit beside the four held for it.
    expect(waiting(composer)).toEqual([]);
    expect(composer.result.current.draft).toBe("");

    // Taking the second one back gives back all four of its attachments.
    act(() => { composer.result.current.editUnsent("optimistic-req_4"); });
    expect(composer.result.current.draft).toBe("Second");
    expect(waiting(composer)).toEqual(["b1.jpg", "b2.jpg", "b3.jpg", "b4.jpg"]);

    // Once the composer is free and there is room, the first one comes back whole.
    act(() => { composer.result.current.setDraft(""); });
    for (const name of ["b1", "b2", "b3", "b4"]) {
      act(() => { composer.result.current.removeAttachment(photo(name).id); });
    }
    expect(composer.result.current.draft).toBe("");
    expect(waiting(composer)).toEqual(["a1.jpg", "a2.jpg", "a3.jpg", "a4.jpg", "a5.jpg"]);
  });

  it("holds a failed new chat's attachments until the new chat's composer is free again", async () => {
    let fail: (error: Error) => void = () => {};
    mockAdmitChatTurn.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const composer = renderComposer();
    attach(composer, "sent");
    act(() => { composer.result.current.send(); });
    await waitFor(() => expect(mockAdmitChatTurn).toHaveBeenCalledTimes(1));

    // The person leaves, comes back to a new chat and starts something else.
    composer.rerender({ ...newChat, activeChatId: "chat_other", detail: detailFor("chat_other") });
    composer.rerender(newChat);
    attach(composer, "other");
    await act(async () => { fail(new Error("Could not send message. Try again.")); });
    await waitFor(() => expect(composer.result.current.isSending).toBe(false));

    expect(waiting(composer)).toEqual(["other.jpg"]);

    act(() => { composer.result.current.removeAttachment(photo("other").id); });
    await waitFor(() => expect(waiting(composer)).toEqual(["sent.jpg"]));
  });
});
