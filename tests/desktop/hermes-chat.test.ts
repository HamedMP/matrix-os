import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";
import { advanceRuntimeGeneration } from
  "@desktop/renderer/src/stores/runtime-generation";
import { AppError } from "@desktop/shared/app-error";

const kernel = vi.hoisted(() => ({
  abortKernelRequest: vi.fn(),
  sendKernelMessage: vi.fn(),
  switchKernelSession: vi.fn(),
}));

vi.mock("@desktop/renderer/src/lib/kernel-wiring", () => kernel);

function conversation(id: string) {
  return {
    id,
    title: `Title ${id}`,
    preview: `Preview ${id}`,
    messageCount: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

const readyContext = {
  projectId: "matrix-os",
  projectName: "Matrix OS",
  projectKind: "github" as const,
  repositoryLabel: "FinnaAI/matrix-os",
  status: "ready" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
        context: readyContext,
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
          context: readyContext,
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
      context: readyContext,
      totalCount: 3,
      messages: [
        { index: 0, role: "user", content: "hello", contentTruncated: false, timestamp: 10 },
        {
          index: 1,
          role: "system",
          content: "Used Bash",
          contentTruncated: false,
          timestamp: 15,
          tool: "Bash",
          toolDisplay: { kind: "command", preview: "git status --short" },
        },
        { index: 2, role: "assistant", content: "hi", contentTruncated: false, timestamp: 20 },
      ],
      hasMore: false,
      limit: 50,
    });

    const opened = await useHermesChat.getState().openConversation({ get } as never, "conversation-two");

    expect(opened).toBe(true);
    expect(get).toHaveBeenCalledWith("/api/conversations/conversation-two?limit=50");
    expect(kernel.switchKernelSession).toHaveBeenCalledWith("conversation-two", {
      replayCompleted: false,
    });
    expect(useHermesChat.getState()).toMatchObject({
      view: "conversation",
      sessionId: "conversation-two",
      loadStatus: "idle",
      loadError: null,
      conversationContext: readyContext,
      messages: [
        { id: "conversation-two:0", role: "user", content: "hello", timestamp: 10 },
        {
          id: "conversation-two:1",
          role: "system",
          content: "Used Bash",
          timestamp: 15,
          tool: "Bash",
          toolDisplay: { kind: "command", preview: "git status --short" },
        },
        { id: "conversation-two:2", role: "assistant", content: "hi", timestamp: 20 },
      ],
    });
  });

  it("persists and clears the selected project through the strict context route", async () => {
    const patch = vi.fn()
      .mockResolvedValueOnce({ context: readyContext })
      .mockResolvedValueOnce({ context: null });
    const api = { patch } as never;

    await expect(
      useHermesChat.getState().updateConversationContext(api, "conversation-one", "matrix-os"),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenNthCalledWith(
      1,
      "/api/conversations/conversation-one/context",
      { projectId: "matrix-os" },
    );
    expect(useHermesChat.getState()).toMatchObject({
      conversationContext: readyContext,
      contextStatus: "ready",
      contextError: null,
    });

    await expect(
      useHermesChat.getState().updateConversationContext(api, "conversation-one", null),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenNthCalledWith(
      2,
      "/api/conversations/conversation-one/context",
      { projectId: null },
    );
    expect(useHermesChat.getState()).toMatchObject({
      conversationContext: null,
      contextStatus: "ready",
      contextError: null,
    });
  });

  it("keeps a successful context update when an older index refresh settles later", async () => {
    const staleContext = {
      projectId: "legacy-project",
      projectName: "Legacy project",
      projectKind: "folder" as const,
      repositoryLabel: "legacy-project",
      status: "unavailable" as const,
    };
    const pendingIndex = deferred<unknown>();
    const get = vi.fn(() => pendingIndex.promise);
    const patch = vi.fn().mockResolvedValue({ context: readyContext });
    const api = { get, patch } as never;

    useHermesChat.setState({
      sessionId: "conversation-one",
      view: "conversation",
      conversationContext: staleContext,
      contextStatus: "ready",
    });

    const refresh = useHermesChat.getState().refreshConversations(api);

    await expect(
      useHermesChat.getState().updateConversationContext(
        api,
        "conversation-one",
        "matrix-os",
      ),
    ).resolves.toBe(true);

    pendingIndex.resolve([
      {
        id: "conversation-one",
        preview: "Conversation one",
        messageCount: 1,
        createdAt: 1,
        updatedAt: 2,
        context: staleContext,
      },
    ]);
    await refresh;

    expect(useHermesChat.getState()).toMatchObject({
      conversationContext: readyContext,
      contextStatus: "ready",
      contextError: null,
      indexStatus: "ready",
    });
  });

  it("keeps a successful context update when an index refresh starts during it", async () => {
    const staleContext = {
      projectId: "legacy-project",
      projectName: "Legacy project",
      projectKind: "folder" as const,
      repositoryLabel: "legacy-project",
      status: "unavailable" as const,
    };
    const pendingIndex = deferred<unknown>();
    const pendingPatch = deferred<{ context: typeof readyContext }>();
    const api = {
      get: vi.fn(() => pendingIndex.promise),
      patch: vi.fn(() => pendingPatch.promise),
    } as never;

    useHermesChat.setState({
      sessionId: "conversation-one",
      view: "conversation",
      conversationContext: staleContext,
      contextStatus: "ready",
    });

    const mutation = useHermesChat.getState().updateConversationContext(
      api,
      "conversation-one",
      "matrix-os",
    );
    expect(useHermesChat.getState().contextStatus).toBe("loading");
    const refresh = useHermesChat.getState().refreshConversations(api);

    pendingPatch.resolve({ context: readyContext });
    await expect(mutation).resolves.toBe(true);
    pendingIndex.resolve([
      {
        id: "conversation-one",
        preview: "Conversation one",
        messageCount: 1,
        createdAt: 1,
        updatedAt: 2,
        context: staleContext,
      },
    ]);
    await refresh;

    expect(useHermesChat.getState()).toMatchObject({
      conversationContext: readyContext,
      contextStatus: "ready",
      contextError: null,
      indexStatus: "ready",
    });
  });

  it("keeps the opened conversation context when an older index refresh settles later", async () => {
    const staleContext = {
      projectId: "legacy-project",
      projectName: "Legacy project",
      projectKind: "folder" as const,
      repositoryLabel: "legacy-project",
      status: "unavailable" as const,
    };
    const pendingIndex = deferred<unknown>();
    const get = vi.fn((path: string) => {
      if (path === "/api/conversations") return pendingIndex.promise;
      return Promise.resolve({
        id: "conversation-two",
        createdAt: 10,
        updatedAt: 30,
        context: readyContext,
        totalCount: 0,
        messages: [],
        hasMore: false,
        limit: 50,
      });
    });
    const api = { get } as never;

    useHermesChat.setState({
      sessionId: "conversation-one",
      view: "conversation",
      conversationContext: staleContext,
      contextStatus: "ready",
    });

    const refresh = useHermesChat.getState().refreshConversations(api);
    await expect(
      useHermesChat.getState().openConversation(api, "conversation-two"),
    ).resolves.toBe(true);

    pendingIndex.resolve([
      {
        id: "conversation-two",
        preview: "Conversation two",
        messageCount: 0,
        createdAt: 10,
        updatedAt: 30,
        context: staleContext,
      },
    ]);
    await refresh;

    expect(useHermesChat.getState()).toMatchObject({
      sessionId: "conversation-two",
      conversationContext: readyContext,
      contextStatus: "ready",
      contextError: null,
      indexStatus: "ready",
    });
  });

  it("preserves the previous context when the response shape is not strict", async () => {
    useHermesChat.setState({ conversationContext: readyContext });
    const patch = vi.fn().mockResolvedValue({
      context: readyContext,
      localPath: "/private/repository",
    });

    await expect(useHermesChat.getState().updateConversationContext(
      { patch } as never,
      "conversation-one",
      "matrix-os",
    )).resolves.toBe(false);

    expect(useHermesChat.getState()).toMatchObject({
      conversationContext: readyContext,
      contextStatus: "error",
      contextError: "Project context could not be updated. Try again.",
    });
  });

  it.each([
    ["conversation_busy", "Stop the active response before changing its project."],
    ["project_unavailable", "That project is unavailable. Choose another project."],
    ["conversation_context_unavailable", "Project context is unavailable. Choose another project or remove it."],
  ])("allowlists the %s context mutation error", async (code, message) => {
    useHermesChat.setState({ conversationContext: readyContext });
    const patch = vi.fn().mockRejectedValue(new AppError("server", { detail: code }));

    await expect(useHermesChat.getState().updateConversationContext(
      { patch } as never,
      "conversation-one",
      "matrix-os",
    )).resolves.toBe(false);

    expect(useHermesChat.getState()).toMatchObject({
      conversationContext: readyContext,
      contextStatus: "error",
      contextError: message,
    });
  });

  it("suppresses duplicate context mutations", async () => {
    const pending = deferred<{ context: typeof readyContext }>();
    const patch = vi.fn(() => pending.promise);
    const api = { patch } as never;

    const first = useHermesChat.getState().updateConversationContext(
      api,
      "conversation-one",
      "matrix-os",
    );
    await expect(useHermesChat.getState().updateConversationContext(
      api,
      "conversation-one",
      null,
    )).resolves.toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);

    pending.resolve({ context: readyContext });
    await expect(first).resolves.toBe(true);
  });

  it("discards a context mutation that settles after a runtime reset", async () => {
    const pending = deferred<{ context: typeof readyContext }>();
    const mutation = useHermesChat.getState().updateConversationContext(
      { patch: vi.fn(() => pending.promise) } as never,
      "conversation-one",
      "matrix-os",
    );

    advanceRuntimeGeneration();
    useHermesChat.getState().resetRuntime();
    pending.resolve({ context: readyContext });

    await expect(mutation).resolves.toBe(false);
    expect(useHermesChat.getState()).toMatchObject({
      sessionId: null,
      conversationContext: null,
      contextStatus: "idle",
      contextError: null,
    });
  });

  it("replaces a suppressed completed replay with canonical history only", async () => {
    useHermesChat.setState({
      view: "conversation",
      sessionId: "conversation-live",
      messages: [{ id: "partial", role: "user", content: "current prompt", timestamp: 10 }],
      status: "thinking",
      activeRequestId: "request-live",
      seenReplayEventIds: ["event-live"],
    });
    const get = vi.fn().mockResolvedValue({
      id: "conversation-live",
      createdAt: 10,
      updatedAt: 40,
      totalCount: 2,
      messages: [
        { index: 0, role: "user", content: "current prompt", contentTruncated: false, timestamp: 10 },
        { index: 1, role: "assistant", content: "settled answer", contentTruncated: false, timestamp: 40 },
      ],
      hasMore: false,
      limit: 50,
    });

    const refreshed = await useHermesChat.getState().refreshConversationHistory(
      { get } as never,
      "conversation-live",
    );

    expect(refreshed).toBe(true);
    expect(kernel.switchKernelSession).not.toHaveBeenCalled();
    expect(useHermesChat.getState()).toMatchObject({
      messages: [
        { id: "conversation-live:0", role: "user", content: "current prompt" },
        { id: "conversation-live:1", role: "assistant", content: "settled answer" },
      ],
      status: "idle",
      activeRequestId: null,
      seenReplayEventIds: [],
    });
  });

  it("does not let a stale history refresh overwrite a newer transcript revision", async () => {
    useHermesChat.setState({
      view: "conversation",
      sessionId: "conversation-live",
      messages: [{ id: "partial", role: "user", content: "current prompt", timestamp: 10 }],
      status: "idle",
      activeRequestId: null,
    });
    const pending = deferred<unknown>();
    const refresh = useHermesChat.getState().refreshConversationHistory(
      { get: vi.fn(() => pending.promise) } as never,
      "conversation-live",
    );

    useHermesChat.getState().send("new prompt");
    pending.resolve({
      id: "conversation-live",
      createdAt: 10,
      updatedAt: 40,
      totalCount: 2,
      messages: [
        { index: 0, role: "user", content: "current prompt", contentTruncated: false, timestamp: 10 },
        { index: 1, role: "assistant", content: "old settled answer", contentTruncated: false, timestamp: 40 },
      ],
      hasMore: false,
      limit: 50,
    });

    expect(await refresh).toBe(false);
    expect(useHermesChat.getState().messages.at(-1)).toMatchObject({
      role: "user",
      content: "new prompt",
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

  it("keeps the selected transcript until deletion succeeds, then clears it", async () => {
    const pending = deferred<{ ok: true }>();
    const remove = vi.fn(() => pending.promise);
    useHermesChat.setState({
      conversations: [conversation("conversation-one"), conversation("conversation-two")],
      view: "conversation",
      sessionId: "conversation-one",
      messages: [{ id: "message-1", role: "assistant", content: "keep pending", timestamp: 1 }],
    });

    const deletion = useHermesChat.getState().deleteConversation(
      { delete: remove } as never,
      "conversation-one",
    );

    expect(remove).toHaveBeenCalledWith("/api/conversations/conversation-one");
    expect(useHermesChat.getState()).toMatchObject({
      deletingConversationId: "conversation-one",
      sessionId: "conversation-one",
      messages: [{ id: "message-1", content: "keep pending" }],
    });

    pending.resolve({ ok: true });
    await expect(deletion).resolves.toBe(true);
    expect(useHermesChat.getState()).toMatchObject({
      conversations: [expect.objectContaining({ id: "conversation-two" })],
      deletingConversationId: null,
      deleteError: null,
      view: "index",
      sessionId: null,
      messages: [],
    });
  });

  it("rejects invalid ids and suppresses duplicate deletion requests", async () => {
    const pending = deferred<{ ok: true }>();
    const remove = vi.fn(() => pending.promise);
    const api = { delete: remove } as never;

    await expect(useHermesChat.getState().deleteConversation(api, "../private"))
      .resolves.toBe(false);
    const first = useHermesChat.getState().deleteConversation(api, "conversation-one");
    await expect(useHermesChat.getState().deleteConversation(api, "conversation-two"))
      .resolves.toBe(false);

    expect(remove).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true });
    await expect(first).resolves.toBe(true);
  });

  it("keeps a busy conversation and exposes only approved recovery copy", async () => {
    const remove = vi.fn().mockRejectedValue(
      new AppError("server", { detail: "conversation_busy" }),
    );
    useHermesChat.setState({ conversations: [conversation("conversation-one")] });

    await expect(useHermesChat.getState().deleteConversation(
      { delete: remove } as never,
      "conversation-one",
    )).resolves.toBe(false);

    expect(useHermesChat.getState()).toMatchObject({
      conversations: [expect.objectContaining({ id: "conversation-one" })],
      deletingConversationId: null,
      deleteError: "Stop the active response before deleting this chat.",
    });
  });

  it("refreshes a stale not-found row from the canonical index", async () => {
    const remove = vi.fn().mockRejectedValue(
      new AppError("notFound", { detail: "conversation_not_found" }),
    );
    const get = vi.fn().mockResolvedValue([{
      id: "conversation-two",
      preview: "Still here",
      messageCount: 1,
      createdAt: 2,
      updatedAt: 3,
    }]);
    useHermesChat.setState({
      conversations: [conversation("conversation-one"), conversation("conversation-two")],
    });

    await expect(useHermesChat.getState().deleteConversation(
      { delete: remove, get } as never,
      "conversation-one",
    )).resolves.toBe(false);

    expect(get).toHaveBeenCalledWith("/api/conversations");
    expect(useHermesChat.getState()).toMatchObject({
      conversations: [expect.objectContaining({ id: "conversation-two" })],
      deleteError: "This chat no longer exists. Chats were refreshed.",
    });
  });

  it("allowlists delete errors and discards a late success after runtime reset", async () => {
    const unsafeRemove = vi.fn().mockRejectedValue(
      new AppError("server", { detail: "/home/matrix/private" }),
    );
    useHermesChat.setState({ conversations: [conversation("conversation-one")] });

    await useHermesChat.getState().deleteConversation(
      { delete: unsafeRemove } as never,
      "conversation-one",
    );
    expect(useHermesChat.getState().deleteError)
      .toBe("Chat could not be deleted. Try again.");

    const pending = deferred<{ ok: true }>();
    const deletion = useHermesChat.getState().deleteConversation(
      { delete: vi.fn(() => pending.promise) } as never,
      "conversation-one",
    );
    advanceRuntimeGeneration();
    useHermesChat.getState().resetRuntime();
    pending.resolve({ ok: true });

    await expect(deletion).resolves.toBe(false);
    expect(useHermesChat.getState()).toMatchObject({
      conversations: [],
      deletingConversationId: null,
      deleteError: null,
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

  it("shows a safe failure when Hermes ends with an unsuccessful result", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;

    useHermesChat.getState().ingest({
      type: "kernel:result",
      requestId,
      data: {
        errors: ["Anthropic API key failed at /home/matrix/private-config"],
      },
    });

    expect(useHermesChat.getState()).toMatchObject({
      status: "idle",
      activeRequestId: null,
      messages: [
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({
          role: "system",
          content: "The agent could not complete this turn. Try again.",
        }),
      ],
    });
    expect(JSON.stringify(useHermesChat.getState().messages)).not.toContain("Anthropic");
    expect(JSON.stringify(useHermesChat.getState().messages)).not.toContain("/home/matrix");
  });

  it("uses the completed result when Hermes emits no incremental text", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;

    useHermesChat.getState().ingest({
      type: "kernel:result",
      requestId,
      data: { result: "Final answer from Hermes" },
    });

    expect(useHermesChat.getState()).toMatchObject({
      status: "idle",
      activeRequestId: null,
      messages: [
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({ role: "assistant", content: "Final answer from Hermes" }),
      ],
    });
  });

  it("does not duplicate a completed result after incremental text", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;
    useHermesChat.getState().ingest({
      type: "kernel:text",
      requestId,
      text: "Final answer from Hermes",
    });

    useHermesChat.getState().ingest({
      type: "kernel:result",
      requestId,
      data: { result: "Final answer from Hermes" },
    });

    expect(useHermesChat.getState().messages.filter((message) => message.role === "assistant"))
      .toEqual([expect.objectContaining({ content: "Final answer from Hermes" })]);
  });

  it("turns an error-shaped completed result into a safe failure notice", () => {
    useHermesChat.getState().send("hello");
    const requestId = useHermesChat.getState().activeRequestId!;

    useHermesChat.getState().ingest({
      type: "kernel:result",
      requestId,
      data: {
        result: "Failed to authenticate. API Error: 401 {\"type\":\"authentication_error\",\"message\":\"API key is invalid\"}",
      },
    });

    expect(useHermesChat.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({
        role: "system",
        content: "The agent could not complete this turn. Try again.",
      }),
    ]);
    expect(JSON.stringify(useHermesChat.getState().messages)).not.toContain("API key");
    expect(JSON.stringify(useHermesChat.getState().messages)).not.toContain("401");
  });
});
