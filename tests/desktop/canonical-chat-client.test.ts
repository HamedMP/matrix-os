import { describe, expect, it, vi } from "vitest";
import {
  createCanonicalChatClient,
} from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";

const record = {
  chat: {
    id: "chat_client_test",
    ownerScope: { type: "personal" as const, ownerId: "owner_1" },
    title: "Client test",
    lifecycle: "active" as const,
    attention: "none" as const,
    revision: 0,
    messageCount: 0,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
};

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get: vi.fn(async () => ({ items: [record] })),
    post: vi.fn(async () => record),
    getText: vi.fn(),
    getBlob: vi.fn(),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
    ...overrides,
  } as ApiClient;
}

describe("canonical Chat client", () => {
  it("lists Chats through one filtered Gateway endpoint", async () => {
    const get = vi.fn(async () => ({ items: [record], nextCursor: "chatcur_next" }));
    const client = createCanonicalChatClient(api({ get }));

    const page = await client.list({
      limit: 25,
      lifecycle: "active",
      projectId: "project_1",
      cursor: "chatcur_prev",
    });

    expect(get).toHaveBeenCalledWith(
      "/api/chats?limit=25&lifecycle=active&projectId=project_1&cursor=chatcur_prev",
    );
    expect(page.items[0]?.chat.id).toBe("chat_client_test");
  });

  it("lists Global Chats without mixing in Project-bound Chats", async () => {
    const get = vi.fn(async () => ({ items: [record] }));
    const client = createCanonicalChatClient(api({ get }));

    await client.list({ projectId: null });

    expect(get).toHaveBeenCalledWith("/api/chats?scope=global");
  });

  it("searches the same Chat identity within Global or Project scope", async () => {
    const get = vi.fn(async () => ({ items: [record] }));
    const client = createCanonicalChatClient(api({ get }));

    await client.search("release plan", { projectId: "project_1", limit: 10 });
    await client.search("release plan", { projectId: null });

    expect(get).toHaveBeenNthCalledWith(
      1,
      "/api/chats/search?query=release+plan&limit=10&projectId=project_1",
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/chats/search?query=release+plan&scope=global",
    );
  });

  it("creates a Chat without accepting client-owned identity fields", async () => {
    const post = vi.fn(async () => record);
    const client = createCanonicalChatClient(api({ post }));

    await client.create({
      clientRequestId: "req_client_create",
      title: "Client test",
    });

    expect(post).toHaveBeenCalledWith("/api/chats", {
      clientRequestId: "req_client_create",
      title: "Client test",
    });
    await expect(client.create({
      clientRequestId: "req_client_create",
      title: "Client test",
      ownerScope: { type: "personal", ownerId: "other" },
    } as never)).rejects.toThrow();
  });

  it("moves a Chat between Global and Project scopes through one guarded mutation", async () => {
    const movedRecord = { ...record, projectId: "project_1" };
    const patch = vi.fn(async () => movedRecord);
    const client = createCanonicalChatClient(api({ patch }));

    await expect(client.updateProject(record.chat.id, {
      baseRevision: 0,
      projectId: "project_1",
    })).resolves.toEqual(movedRecord);
    expect(patch).toHaveBeenCalledWith("/api/chats/chat_client_test/project", {
      baseRevision: 0,
      projectId: "project_1",
    });

    await expect(client.updateProject(record.chat.id, {
      baseRevision: 1,
      projectId: null,
    })).resolves.toEqual(movedRecord);
  });

  it("loads a bounded message page and rejects malformed Gateway projections", async () => {
    const get = vi.fn(async () => ({
      record,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
      nextCursor: "chatcur_older",
    }));
    const client = createCanonicalChatClient(api({ get }));

    const detail = await client.getDetail("chat_client_test", {
      limit: 100,
      cursor: "chatcur_current",
    });
    expect(get).toHaveBeenCalledWith(
      "/api/chats/chat_client_test?limit=100&cursor=chatcur_current",
    );
    expect(detail.nextCursor).toBe("chatcur_older");

    const malformed = createCanonicalChatClient(api({
      get: vi.fn(async () => ({ record: { chat: { id: "leaked" } } })),
    }));
    await expect(malformed.getDetail("chat_client_test")).rejects.toThrow();
  });

  it("sends strict Turn and cancel commands through the shared Gateway client", async () => {
    const turnInput = {
      clientRequestId: "req_client_turn",
      baseRevision: 0,
      parts: [{ type: "text" as const, text: "ship it" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    };
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/cancel")) {
        return {
          run: {
            id: "run_client",
            chatId: record.chat.id,
            turnId: "cturn_client",
            attempt: 1,
            driverKind: "codex",
            instanceId: "codex_default",
            selection: turnInput.selection,
            interactionMode: "default",
            permissionMode: "supervised",
            status: "aborted",
            outcome: "aborted",
            startedAt: "2026-08-26T00:00:00.000Z",
            completedAt: "2026-08-26T00:01:00.000Z",
            historyBoundarySeq: 0,
            capabilitySnapshot,
            createdAt: "2026-08-26T00:00:00.000Z",
            updatedAt: "2026-08-26T00:01:00.000Z",
          },
          cancellation: "aborted",
        };
      }
      if (path.endsWith("/turns/cturn_client/runs")) {
        const admitted = admissionResponse(turnInput);
        return {
          record: admitted.record,
          turn: admitted.turn,
          run: { ...admitted.run, id: "run_client_retry", attempt: 2 },
          admission: "accepted",
        };
      }
      return admissionResponse(turnInput);
    });
    const client = createCanonicalChatClient(api({ post }));

    await client.admitTurn(record.chat.id, turnInput);
    await client.cancelRun(record.chat.id, "run_client", { clientRequestId: "req_client_cancel" });
    await client.retryTurn(record.chat.id, "cturn_client", {
      clientRequestId: "req_client_retry",
      baseRevision: 2,
    });

    expect(post).toHaveBeenNthCalledWith(1, "/api/chats/chat_client_test/turns", turnInput);
    expect(post).toHaveBeenNthCalledWith(2, "/api/chats/chat_client_test/runs/run_client/cancel", {
      clientRequestId: "req_client_cancel",
    });
    expect(post).toHaveBeenNthCalledWith(3, "/api/chats/chat_client_test/turns/cturn_client/runs", {
      clientRequestId: "req_client_retry",
      baseRevision: 2,
    });
  });
});

const capabilitySnapshot = {
  revision: "catalog_client",
  rootChat: true,
  attachments: ["file" as const],
  resources: ["file" as const, "folder" as const, "project" as const],
  tools: [],
  approvals: true,
  userInput: true,
  resume: true,
  cancellation: true,
  worktrees: "optional" as const,
  interactionModes: ["default"],
  permissionModes: ["supervised"],
};

function admissionResponse(input: {
  clientRequestId: string;
  selection: { instanceId: string; model: string };
}) {
  const currentRecord = {
    chat: { ...record.chat, revision: 1, messageCount: 1, currentSelection: input.selection },
    providerBinding: { driverKind: "codex", instanceId: "codex_default", lockedAtTurnId: "cturn_client" },
    activeRun: { runId: "run_client", turnId: "cturn_client", status: "accepted" },
  };
  const message = {
    id: "msg_client",
    chatId: record.chat.id,
    seq: 1,
    role: "user",
    state: "committed",
    turnId: "cturn_client",
    parts: [{ type: "text", text: "ship it" }],
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  const turn = {
    id: "cturn_client",
    chatId: record.chat.id,
    clientRequestId: input.clientRequestId,
    baseMessageSeq: 0,
    inputMessageId: message.id,
    status: "accepted",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  return {
    record: currentRecord,
    message,
    turn,
    run: {
      id: "run_client",
      chatId: record.chat.id,
      turnId: turn.id,
      attempt: 1,
      driverKind: "codex",
      instanceId: "codex_default",
      selection: input.selection,
      interactionMode: "default",
      permissionMode: "supervised",
      status: "accepted",
      historyBoundarySeq: 0,
      capabilitySnapshot,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
    admission: "accepted",
  };
}
