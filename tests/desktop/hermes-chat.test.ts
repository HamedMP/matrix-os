import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";

const kernel = vi.hoisted(() => ({
  abortKernelRequest: vi.fn(),
  sendKernelMessage: vi.fn(),
  switchKernelSession: vi.fn(),
}));

vi.mock("@desktop/renderer/src/lib/kernel-wiring", () => kernel);

describe("useHermesChat", () => {
  beforeEach(() => {
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    kernel.abortKernelRequest.mockReset();
    kernel.sendKernelMessage.mockReset();
    kernel.switchKernelSession.mockReset();
    kernel.sendKernelMessage.mockReturnValue(true);
    kernel.switchKernelSession.mockReturnValue(true);
  });

  it("aborts the active kernel request before starting a new chat", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId;

    useHermesChat.getState().newChat();

    expect(requestId).toEqual(expect.any(String));
    expect(kernel.abortKernelRequest).toHaveBeenCalledWith(requestId);
    expect(useHermesChat.getState()).toMatchObject({
      messages: [],
      sessionId: null,
      status: "idle",
      activeRequestId: null,
    });
  });

  it("returns to idle and shows an error when the kernel socket is unavailable", () => {
    kernel.sendKernelMessage.mockReturnValue(false);

    useHermesChat.getState().send("hello");

    expect(useHermesChat.getState().status).toBe("idle");
    expect(useHermesChat.getState().activeRequestId).toBeNull();
    expect(useHermesChat.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({
        role: "system",
        content: "Can't reach Matrix OS. Check your connection.",
      }),
    ]);
  });

  it("returns to idle when abort cannot be sent", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId;
    kernel.abortKernelRequest.mockReturnValue(false);

    useHermesChat.getState().abort();

    expect(kernel.abortKernelRequest).toHaveBeenCalledWith(requestId);
    expect(useHermesChat.getState()).toMatchObject({
      status: "idle",
      activeRequestId: null,
    });
  });

  it("discovers bounded persistent conversations in newest-first order", async () => {
    const get = vi.fn().mockResolvedValue([
      {
        id: "conversation-old",
        preview: "  Plan the old release  ",
        messageCount: 3,
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: "conversation-new",
        preview: `${"Newest conversation ".repeat(20)}\nprivate second line`,
        messageCount: 2,
        createdAt: 30,
        updatedAt: 40,
      },
      {
        id: "../invalid",
        preview: "must be rejected",
        messageCount: 1,
        createdAt: 50,
        updatedAt: 60,
      },
    ]);

    await useHermesChat.getState().refreshConversations({ get } as never);

    expect(get).toHaveBeenCalledWith("/api/conversations");
    expect(useHermesChat.getState()).toMatchObject({
      indexStatus: "ready",
      indexError: null,
      conversations: [
        {
          id: "conversation-new",
          title: "Newest conversation Newest conversation Newest conversation Newest conversation",
          preview: expect.stringMatching(/^Newest conversation/),
          messageCount: 2,
          updatedAt: 40,
        },
        {
          id: "conversation-old",
          title: "Plan the old release",
          preview: "Plan the old release",
          messageCount: 3,
          updatedAt: 20,
        },
      ],
    });
    expect(useHermesChat.getState().conversations[0]?.preview.length).toBeLessThanOrEqual(240);
  });

  it("creates a server-backed conversation, opens it empty, and refreshes the index", async () => {
    const post = vi.fn().mockResolvedValue({ id: "conversation-created" });
    const get = vi.fn().mockResolvedValue([
      {
        id: "conversation-created",
        preview: "",
        messageCount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
    ]);

    const created = await useHermesChat.getState().createConversation({ post, get } as never);

    expect(created).toBe("conversation-created");
    expect(post).toHaveBeenCalledWith("/api/conversations", {});
    expect(get).toHaveBeenCalledWith("/api/conversations");
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-created",
      messages: [],
      loadStatus: "idle",
      loadError: null,
    });
  });

  it("keeps the current conversation when server-backed creation fails", async () => {
    useHermesChat.setState({
      view: "conversation",
      sessionId: "conversation-current",
      messages: [{ id: "current", role: "assistant", content: "still visible", timestamp: 1 }],
      status: "streaming",
      activeRequestId: "request-current",
    });
    const post = vi.fn().mockRejectedValue(new Error("provider /home/private failure"));

    const created = await useHermesChat.getState().createConversation({ post } as never);

    expect(created).toBeNull();
    expect(kernel.abortKernelRequest).not.toHaveBeenCalled();
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-current",
      messages: [{ id: "current", role: "assistant", content: "still visible", timestamp: 1 }],
      status: "streaming",
      activeRequestId: "request-current",
      loadStatus: "error",
      loadError: "Conversation could not be opened. Try again.",
    });
  });

  it("hydrates bounded history and switches the canonical kernel session", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "conversation-two",
      createdAt: 10,
      updatedAt: 30,
      totalCount: 2,
      messages: [
        { index: 0, role: "user", content: "hello", contentTruncated: false, timestamp: 10 },
        { index: 1, role: "assistant", content: "hi", contentTruncated: false, timestamp: 20 },
      ],
      hasMore: false,
      limit: 50,
    });

    const opened = await useHermesChat.getState().openConversation({ get } as never, "conversation-two");

    expect(opened).toBe(true);
    expect(get).toHaveBeenCalledWith("/api/conversations/conversation-two?limit=50");
    expect(kernel.switchKernelSession).toHaveBeenCalledWith("conversation-two");
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-two",
      loadStatus: "idle",
      loadError: null,
      messages: [
        { id: "conversation-two:0", role: "user", content: "hello", timestamp: 10 },
        { id: "conversation-two:1", role: "assistant", content: "hi", timestamp: 20 },
      ],
    });
  });

  it("keeps the current conversation visible when switching fails", async () => {
    useHermesChat.setState({
      view: "conversation",
      sessionId: "conversation-one",
      messages: [{ id: "old", role: "assistant", content: "keep me", timestamp: 1 }],
    });
    const get = vi.fn().mockRejectedValue(new Error("/home/matrix/private provider failure"));

    const opened = await useHermesChat.getState().openConversation({ get } as never, "conversation-two");

    expect(opened).toBe(false);
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-one",
      messages: [{ id: "old", role: "assistant", content: "keep me", timestamp: 1 }],
      loadStatus: "error",
      loadError: "Conversation could not be opened. Try again.",
    });
  });

  it("restores an authoritative active request from replay without duplicating events", () => {
    useHermesChat.setState({ sessionId: "conversation-live", view: "conversation" });

    useHermesChat.getState().ingest({
      type: "kernel:init",
      sessionId: "conversation-live",
      requestId: "request-live",
      eventId: "conversation-live:request-live:0",
    });
    useHermesChat.getState().ingest({
      type: "kernel:text",
      text: "streamed once",
      requestId: "request-live",
      eventId: "conversation-live:request-live:1",
    });
    useHermesChat.getState().ingest({
      type: "kernel:text",
      text: "streamed once",
      requestId: "request-live",
      eventId: "conversation-live:request-live:1",
    });

    expect(useHermesChat.getState()).toMatchObject({
      status: "streaming",
      activeRequestId: "request-live",
      messages: [expect.objectContaining({ content: "streamed once" })],
    });
  });
});
