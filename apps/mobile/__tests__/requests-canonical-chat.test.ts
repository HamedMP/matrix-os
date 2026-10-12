import {
  cancelChatRun,
  chatActivityAt,
  fetchChats,
  fetchProjectChats,
  isChatUnread,
  searchChats,
} from "@/lib/requests/canonical-chat";

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const token = "clerk-token";
const at = "2026-10-08T09:00:00.000Z";
const cursor = "chatcur_eyJ2ZXJzaW9uIjoyfQ";
const projectId = "proj_0f8fad5b-d9cb-469f-a165-70867728950e";

function chatRecord(id: string, extra: Record<string, unknown> = {}, chatExtra: Record<string, unknown> = {}) {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "user_a" },
      title: "Trip plan",
      lifecycle: "active",
      attention: "none",
      revision: 3,
      messageCount: 4,
      createdAt: at,
      updatedAt: at,
      ...chatExtra,
    },
    ...extra,
  };
}

const run = {
  id: "run_one",
  chatId: "chat_one",
  turnId: "cturn_one",
  attempt: 1,
  driverKind: "codex",
  instanceId: "codex_fixture",
  selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
  interactionMode: "default",
  permissionMode: "supervised",
  status: "aborted",
  outcome: "aborted",
  startedAt: at,
  completedAt: at,
  historyBoundarySeq: 0,
  capabilitySnapshot: {
    revision: "catalog_fixture_1",
    rootChat: true,
    attachments: [],
    resources: [],
    tools: [],
    approvals: true,
    userInput: true,
    resume: true,
    cancellation: true,
    worktrees: "optional",
    interactionModes: ["default"],
    permissionModes: ["supervised"],
  },
  createdAt: at,
  updatedAt: at,
};

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function requestedUrl(fetchMock: jest.SpyInstance, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]));
}

describe("chat list requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reads the first page of every chat, asking for read state", async () => {
    const page = { items: [chatRecord("chat_one")], nextCursor: cursor };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(page));

    await expect(fetchChats(token, gatewayUrl)).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/alice/api/chats?limit=100&readStateVersion=1",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0]![1]!.method).toBeUndefined();
  });

  it("continues from a cursor", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ items: [] }));

    await fetchChats(token, gatewayUrl, { cursor });

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/vm/alice/api/chats");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "100", readStateVersion: "1", cursor });
  });

  it("keeps what the server sends for a list row: preview, attention, read state and project", async () => {
    const record = chatRecord(
      "chat_one",
      {
        projectId,
        readState: { unread: true, markedUnread: false, version: 2, readThroughSeq: 3, latestIncomingSeq: 4 },
      },
      { attention: "approval_required", lastMessagePreview: "Shall I book it?" },
    );
    jest.spyOn(global, "fetch").mockResolvedValue(respond({ items: [record] }));

    const [parsed] = (await fetchChats(token, gatewayUrl)).items;

    expect(parsed!.chat.lastMessagePreview).toBe("Shall I book it?");
    expect(parsed!.chat.attention).toBe("approval_required");
    expect(parsed!.projectId).toBe(projectId);
    expect(parsed!.readState?.unread).toBe(true);
    expect(isChatUnread(parsed!)).toBe(true);
  });

  it("rejects a page that is not a chat list", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond({ items: [{ chat: { id: "chat_one" } }] }));

    await expect(fetchChats(token, gatewayUrl)).rejects.toThrow("Chats unavailable. Try again.");
  });

  it.each([400, 401, 503])("reports HTTP %s with the generic message only", async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond({ error: "postgres://internal detail" }, status));

    await expect(fetchChats(token, gatewayUrl)).rejects.toThrow("Chats unavailable. Try again.");
  });

  it("does not send a cursor the server would reject", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(fetchChats(token, gatewayUrl, { cursor: "page 2" })).rejects.toThrow("Chats unavailable. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one project's chats, a page at a time", async () => {
    const page = { items: [chatRecord("chat_one", { projectId })], nextCursor: cursor };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(page));

    await expect(fetchProjectChats(token, gatewayUrl, projectId)).resolves.toEqual(page);
    await fetchProjectChats(token, gatewayUrl, projectId, { cursor, limit: 25 });

    expect(Object.fromEntries(requestedUrl(fetchMock, 0).searchParams)).toEqual({
      limit: "100",
      readStateVersion: "1",
      projectId,
    });
    expect(Object.fromEntries(requestedUrl(fetchMock, 1).searchParams)).toEqual({
      limit: "25",
      readStateVersion: "1",
      projectId,
      cursor,
    });
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({
      headers: { Authorization: "Bearer clerk-token" },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ["a project reference the server would reject", "../etc", undefined],
    ["a page size above the server's maximum", projectId, 101],
    ["a page size below one", projectId, 0],
  ])("does not ask for %s", async (_label, id, limit) => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(fetchProjectChats(token, gatewayUrl, id, { limit })).rejects.toThrow("Chats unavailable. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("chat list row helpers", () => {
  it("reads the activity time from whichever field this wire version carries it in", () => {
    // Without the metadata header the gateway puts the activity time in `updatedAt`.
    expect(chatActivityAt(chatRecord("chat_one") as never)).toBe(at);
    expect(chatActivityAt(chatRecord("chat_one", {}, { activityAt: "2026-10-08T12:00:00.000Z" }) as never))
      .toBe("2026-10-08T12:00:00.000Z");
  });

  it("treats a chat without read state as read", () => {
    expect(isChatUnread(chatRecord("chat_one") as never)).toBe(false);
    expect(isChatUnread(chatRecord("chat_one", {
      readState: { unread: false, markedUnread: false, version: 1, readThroughSeq: 4, latestIncomingSeq: 4 },
    }) as never)).toBe(false);
  });
});

describe("searchChats", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("searches every chat by default", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ items: [chatRecord("chat_one")] }));

    await expect(searchChats(token, gatewayUrl, "  lisbon trip ")).resolves.toEqual([chatRecord("chat_one")]);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/vm/alice/api/chats/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "lisbon trip",
      limit: "50",
      readStateVersion: "1",
    });
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({
      headers: { Authorization: "Bearer clerk-token" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("can narrow to chats outside any project, or to one project", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ items: [] }));

    await searchChats(token, gatewayUrl, "lisbon", { scope: "global", limit: 10 });
    await searchChats(token, gatewayUrl, "lisbon", { projectId });

    expect(Object.fromEntries(requestedUrl(fetchMock, 0).searchParams)).toEqual({
      query: "lisbon",
      limit: "10",
      readStateVersion: "1",
      scope: "global",
    });
    expect(Object.fromEntries(requestedUrl(fetchMock, 1).searchParams)).toEqual({
      query: "lisbon",
      limit: "50",
      readStateVersion: "1",
      projectId,
    });
  });

  it("shortens a query to what the server accepts", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ items: [] }));

    await searchChats(token, gatewayUrl, "a".repeat(300));

    expect(requestedUrl(fetchMock).searchParams.get("query")).toHaveLength(200);
  });

  it("answers an empty query with no results and no request", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(searchChats(token, gatewayUrl, "   ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses both a project and the outside-projects scope, which the server rejects together", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(searchChats(token, gatewayUrl, "lisbon", { scope: "global", projectId }))
      .rejects.toThrow("Search unavailable. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a failed request", respond({ error: "Invalid request" }, 400)],
    ["a malformed payload", respond({ results: [] })],
  ])("reports %s with the generic message only", async (_label, response) => {
    jest.spyOn(global, "fetch").mockResolvedValue(response);

    await expect(searchChats(token, gatewayUrl, "lisbon")).rejects.toThrow("Search unavailable. Try again.");
  });
});

describe("cancelChatRun", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("posts the request id to the run's cancel route", async () => {
    const answer = { run, cancellation: "aborted" };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(answer));

    await expect(cancelChatRun(token, gatewayUrl, "chat_one", "run_one", "req_stop1")).resolves.toEqual(answer);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/alice/api/chats/chat_one/runs/run_one/cancel",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
        body: JSON.stringify({ clientRequestId: "req_stop1" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("accepts the answer for a run that had already ended", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond({ run, cancellation: "already_terminal" }));

    await expect(cancelChatRun(token, gatewayUrl, "chat_one", "run_one", "req_stop1"))
      .resolves.toMatchObject({ cancellation: "already_terminal" });
  });

  it.each([
    ["chat", "chat one", "run_one", "req_stop1"],
    ["run", "chat_one", "../run", "req_stop1"],
    ["request", "chat_one", "run_one", "stop"],
  ])("does not call the server with an invalid %s id", async (_label, chatId, runId, requestId) => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(cancelChatRun(token, gatewayUrl, chatId, runId, requestId))
      .rejects.toThrow("Could not stop the run. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing chat", respond({ error: { code: "chat_not_found", safeMessage: "Chat not found." } }, 404)],
    ["an unavailable service", respond({ error: { code: "service_unavailable" } }, 503)],
    ["a malformed payload", respond({ cancellation: "aborted" })],
  ])("reports %s with the generic message only", async (_label, response) => {
    jest.spyOn(global, "fetch").mockResolvedValue(response);

    await expect(cancelChatRun(token, gatewayUrl, "chat_one", "run_one", "req_stop1"))
      .rejects.toThrow("Could not stop the run. Try again.");
  });
});
