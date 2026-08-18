import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  KernelConversationContextProjectionSchema,
  KernelConversationDeleteResponseSchema,
  KernelConversationHistoryResponseSchema,
} from "../../packages/contracts/src/index.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import type { ConversationStore } from "../../packages/gateway/src/conversations.js";
import { ConversationRunRegistry } from
  "../../packages/gateway/src/conversation-run-registry.js";
import { registerConversationHistoryRoutes } from "../../packages/gateway/src/server/conversation-history-routes.js";

const TOKEN = "conversation-history-test-token";

function createStore(overrides: Partial<ConversationStore> = {}): ConversationStore {
  return {
    begin: vi.fn(),
    addUserMessage: vi.fn(),
    appendAssistantText: vi.fn(),
    addToolStart: vi.fn(),
    addToolEnd: vi.fn(),
    finalize: vi.fn(async () => undefined),
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    create: vi.fn(() => "conversation-1"),
    updateContext: vi.fn(async () => "not_found" as const),
    delete: vi.fn(async () => "not_found" as const),
    search: vi.fn(() => []),
    ...overrides,
  };
}

function createApp(
  store: ConversationStore,
  conversationRuns = new ConversationRunRegistry(),
  contextResolver = {
    resolve: vi.fn(async () => null),
  },
) {
  const app = new Hono();
  app.use("*", authMiddleware(TOKEN));
  registerConversationHistoryRoutes(app, {
    conversations: store,
    conversationRuns,
    contextResolver,
    getOwnerScope: () => ({ type: "user" as const, id: "user_123" }),
    conversationLifecycle: {
      deleteIfIdle: (id) => store.delete(id, () => conversationRuns.isActive(id)),
    },
  });
  return app;
}

function authenticated(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe("kernel conversation history route", () => {
  it("updates canonical project context and returns only the safe projection", async () => {
    const projection = KernelConversationContextProjectionSchema.parse({
      projectId: "matrix-os",
      projectName: "Matrix OS",
      projectKind: "github",
      repositoryLabel: "FinnaAI/matrix-os",
      status: "ready",
    });
    const updateContext = vi.fn(async () => "updated" as const);
    const resolve = vi.fn(async () => ({
      projection,
      workingDirectory: "/private/repository",
    }));
    const app = createApp(createStore({
      get: vi.fn(() => ({
        id: "conversation-1",
        createdAt: 1,
        updatedAt: 2,
        messages: [],
      })),
      updateContext,
    }), new ConversationRunRegistry(), { resolve });

    const response = await app.request(authenticated(
      "/api/conversations/conversation-1/context",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "matrix-os" }),
      },
    ));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ context: projection });
    expect(JSON.stringify(body)).not.toContain("/private/repository");
    expect(resolve).toHaveBeenCalledWith(
      "matrix-os",
      { type: "user", id: "user_123" },
    );
    expect(updateContext).toHaveBeenCalledWith(
      "conversation-1",
      "matrix-os",
      expect.any(Function),
    );
  });

  it("requires authentication and validates bounded strict context requests before dependencies", async () => {
    const get = vi.fn(() => ({
      id: "conversation-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    }));
    const updateContext = vi.fn(async () => "updated" as const);
    const resolve = vi.fn(async () => null);
    const app = createApp(createStore({ get, updateContext }), new ConversationRunRegistry(), { resolve });

    const unauthenticated = await app.request("/api/conversations/conversation-1/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "matrix-os" }),
    });
    const invalidId = await app.request(authenticated("/api/conversations/..%2Fsystem/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "matrix-os" }),
    }));
    const pathInjection = await app.request(authenticated(
      "/api/conversations/conversation-1/context",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "matrix-os", localPath: "/private/repository" }),
      },
    ));
    const oversized = await app.request(authenticated(
      "/api/conversations/conversation-1/context",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "matrix-os", padding: "x".repeat(4096) }),
      },
    ));

    expect(unauthenticated.status).toBe(401);
    expect(invalidId.status).toBe(400);
    expect(pathInjection.status).toBe(400);
    expect(await pathInjection.json()).toEqual({
      error: { code: "invalid_conversation_context" },
    });
    expect(oversized.status).toBe(413);
    expect(get).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(updateContext).not.toHaveBeenCalled();
  });

  it("rejects missing, busy, stale, and failed context mutations with safe codes", async () => {
    const record = {
      id: "conversation-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const request = authenticated("/api/conversations/conversation-1/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "matrix-os" }),
    });

    const missing = await createApp(createStore()).request(request.clone());

    const runs = new ConversationRunRegistry();
    runs.begin("conversation-1");
    const busyResolve = vi.fn(async () => null);
    const busy = await createApp(createStore({ get: vi.fn(() => record) }), runs, {
      resolve: busyResolve,
    }).request(request.clone());

    const stale = await createApp(createStore({ get: vi.fn(() => record) })).request(request.clone());

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await createApp(createStore({
      get: vi.fn(() => record),
      updateContext: vi.fn(async () => {
        throw new Error("/private/repository atomic write failed");
      }),
    }), new ConversationRunRegistry(), {
      resolve: vi.fn(async () => ({
        projection: {
          projectId: "matrix-os",
          projectName: "Matrix OS",
          projectKind: "github" as const,
          repositoryLabel: "FinnaAI/matrix-os",
          status: "ready" as const,
        },
        workingDirectory: "/private/repository",
      })),
    }).request(request.clone());

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "conversation_not_found" } });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: { code: "conversation_busy" } });
    expect(busyResolve).not.toHaveBeenCalled();
    expect(stale.status).toBe(404);
    expect(await stale.json()).toEqual({ error: { code: "project_unavailable" } });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: { code: "conversation_context_unavailable" },
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("clears context without resolving a project and seals active-run races inside the lock", async () => {
    const record = {
      id: "conversation-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const resolve = vi.fn(async () => null);
    const clearContext = vi.fn(async () => "updated" as const);
    const cleared = await createApp(createStore({
      get: vi.fn(() => record),
      updateContext: clearContext,
    }), new ConversationRunRegistry(), { resolve }).request(authenticated(
      "/api/conversations/conversation-1/context",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: null }),
      },
    ));
    const racedBusy = await createApp(createStore({
      get: vi.fn(() => record),
      updateContext: vi.fn(async () => "busy" as const),
    }), new ConversationRunRegistry(), {
      resolve: vi.fn(async () => ({
        projection: {
          projectId: "matrix-os",
          projectName: "Matrix OS",
          projectKind: "github" as const,
          repositoryLabel: "FinnaAI/matrix-os",
          status: "ready" as const,
        },
        workingDirectory: "/private/repository",
      })),
    }).request(authenticated("/api/conversations/conversation-1/context", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "matrix-os" }),
    }));

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ context: null });
    expect(resolve).not.toHaveBeenCalled();
    expect(clearContext).toHaveBeenCalledWith(
      "conversation-1",
      null,
      expect.any(Function),
    );
    expect(racedBusy.status).toBe(409);
    expect(await racedBusy.json()).toEqual({ error: { code: "conversation_busy" } });
  });

  it("projects unavailable persisted context safely in list and history reads", async () => {
    const record = {
      id: "conversation-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      context: { projectId: "missing-project" },
    };
    const app = createApp(createStore({
      list: vi.fn(() => [{
        id: record.id,
        preview: "Inspect repository",
        messageCount: 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        context: record.context,
      }]),
      get: vi.fn(() => record),
    }));

    const list = await app.request(authenticated("/api/conversations"));
    const history = await app.request(authenticated("/api/conversations/conversation-1"));
    const listBody = await list.json();
    const historyBody = await history.json();
    const unavailable = {
      projectId: "missing-project",
      projectName: "missing-project",
      projectKind: "folder",
      status: "unavailable",
    };

    expect(list.status).toBe(200);
    expect(listBody).toEqual([{
      id: record.id,
      preview: "Inspect repository",
      messageCount: 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      context: unavailable,
    }]);
    expect(history.status).toBe(200);
    expect(historyBody).toMatchObject({ id: record.id, context: unavailable });
    expect(JSON.stringify({ listBody, historyBody })).not.toContain("/private/");
  });

  it("bounds context projection concurrency while preserving list order", async () => {
    const summaries = Array.from({ length: 12 }, (_, index) => ({
      id: `conversation-${index}`,
      preview: `Conversation ${index}`,
      messageCount: index,
      createdAt: index + 1,
      updatedAt: index + 1,
      context: { projectId: `project-${index}` },
    }));
    let active = 0;
    let maxActive = 0;
    const resolve = vi.fn(async (projectId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((done) => setTimeout(done, 2));
      active -= 1;
      return {
        projection: {
          projectId,
          projectName: projectId,
          projectKind: "folder" as const,
          repositoryLabel: projectId,
          status: "ready" as const,
        },
        workingDirectory: `/private/${projectId}`,
      };
    });
    const app = createApp(createStore({ list: vi.fn(() => summaries) }),
      new ConversationRunRegistry(), { resolve });

    const response = await app.request(authenticated("/api/conversations"));
    const body = await response.json() as Array<{ id: string }>;

    expect(response.status).toBe(200);
    expect(body.map((summary) => summary.id)).toEqual(summaries.map((summary) => summary.id));
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(JSON.stringify(body)).not.toContain("/private/");
  });

  it("requires gateway authentication", async () => {
    const get = vi.fn(() => null);
    const response = await createApp(createStore({ get })).request("/api/conversations/conversation-1");

    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("requires gateway authentication before deleting storage", async () => {
    const remove = vi.fn(async () => "deleted" as const);
    const response = await createApp(createStore({ delete: remove })).request(
      "/api/conversations/conversation-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(401);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns the newest bounded page in chronological order", async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}`,
      timestamp: index + 1,
    }));
    const app = createApp(createStore({
      get: vi.fn(() => ({
        id: "conversation-1",
        createdAt: 1,
        updatedAt: 5,
        messages,
      })),
    }));

    const response = await app.request(authenticated("/api/conversations/conversation-1?limit=2"));
    const body = KernelConversationHistoryResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.messages.map((message) => message.index)).toEqual([3, 4]);
    expect(body.messages.map((message) => message.content)).toEqual(["message-3", "message-4"]);
    expect(body).toMatchObject({ totalCount: 5, hasMore: true, nextCursor: "3", limit: 2 });
  });

  it("uses the cursor to load the preceding page", async () => {
    const app = createApp(createStore({
      get: vi.fn(() => ({
        id: "conversation-1",
        createdAt: 1,
        updatedAt: 5,
        messages: Array.from({ length: 5 }, (_, index) => ({
          role: "user" as const,
          content: `message-${index}`,
          timestamp: index + 1,
        })),
      })),
    }));

    const response = await app.request(authenticated(
      "/api/conversations/conversation-1?limit=2&cursor=3",
    ));
    const body = KernelConversationHistoryResponseSchema.parse(await response.json());

    expect(body.messages.map((message) => message.index)).toEqual([1, 2]);
    expect(body.nextCursor).toBe("1");
    expect(body.hasMore).toBe(true);
  });

  it("truncates large content and never returns raw tool inputs", async () => {
    const app = createApp(createStore({
      get: vi.fn(() => ({
        id: "conversation-1",
        createdAt: 1,
        updatedAt: 2,
        messages: [{
          role: "system",
          content: "x".repeat(40_000),
          timestamp: 2,
          tool: "Read",
          toolInput: { path: "/home/private", token: "secret" },
        }],
      })),
    }));

    const response = await app.request(authenticated("/api/conversations/conversation-1"));
    const body = KernelConversationHistoryResponseSchema.parse(await response.json());

    expect(body.messages[0]?.content).toHaveLength(32_000);
    expect(body.messages[0]?.contentTruncated).toBe(true);
    expect(body.messages[0]).not.toHaveProperty("toolInput");
  });

  it("rejects invalid identifiers and pagination before reading storage", async () => {
    const get = vi.fn(() => null);
    const app = createApp(createStore({ get }));

    const invalidId = await app.request(authenticated("/api/conversations/..%2Fsystem"));
    const invalidLimit = await app.request(authenticated(
      "/api/conversations/conversation-1?limit=500",
    ));

    expect(invalidId.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("maps missing and failed storage reads to safe errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const missing = await createApp(createStore()).request(authenticated(
      "/api/conversations/conversation-1",
    ));
    const failed = await createApp(createStore({
      get: vi.fn(() => { throw new Error("/home/private invalid JSON token"); }),
    })).request(authenticated("/api/conversations/conversation-1"));

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "Conversation unavailable. Refresh and try again.",
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: "Conversation history is temporarily unavailable. Try again.",
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("rejects invalid delete identifiers before active-run or storage access", async () => {
    const remove = vi.fn(async () => "deleted" as const);
    const runs = new ConversationRunRegistry();
    const active = vi.spyOn(runs, "isActive");
    const app = createApp(createStore({ delete: remove }), runs);

    const response = await app.request(authenticated(
      "/api/conversations/..%2Fsystem",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_conversation_id" },
    });
    expect(active).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects deletion while the authoritative run is active", async () => {
    const remove = vi.fn(async (_id, isActive: () => boolean) =>
      isActive() ? "busy" as const : "deleted" as const);
    const runs = new ConversationRunRegistry();
    runs.begin("conversation-1");
    const app = createApp(createStore({ delete: remove }), runs);

    const response = await app.request(authenticated(
      "/api/conversations/conversation-1",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "conversation_busy" } });
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("conversation-1", expect.any(Function));
  });

  it("maps deleted and stale records to bounded responses", async () => {
    const deleted = await createApp(createStore({
      delete: vi.fn(async () => "deleted" as const),
    })).request(authenticated("/api/conversations/conversation-1", { method: "DELETE" }));
    const missing = await createApp(createStore({
      delete: vi.fn(async () => "not_found" as const),
    })).request(authenticated("/api/conversations/conversation-1", { method: "DELETE" }));

    expect(deleted.status).toBe(200);
    expect(KernelConversationDeleteResponseSchema.parse(await deleted.json()))
      .toEqual({ ok: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "conversation_not_found" } });
  });

  it("applies a body limit before DELETE route handling", async () => {
    const remove = vi.fn(async () => "deleted" as const);
    const app = createApp(createStore({ delete: remove }));

    const response = await app.request(authenticated(
      "/api/conversations/conversation-1",
      { method: "DELETE", body: "x".repeat(513) },
    ));

    expect(response.status).toBe(413);
    expect(remove).not.toHaveBeenCalled();
  });

  it("logs internal deletion detail and returns a generic bounded code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApp(createStore({
      delete: vi.fn(async () => {
        throw new Error("/home/matrix/private conversation record failed");
      }),
    }));

    const response = await app.request(authenticated(
      "/api/conversations/conversation-1",
      { method: "DELETE" },
    ));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "conversation_delete_unavailable" },
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
