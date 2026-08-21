import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
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
    delete: vi.fn(async () => "not_found" as const),
    search: vi.fn(() => []),
    ...overrides,
  };
}

function createApp(
  store: ConversationStore,
  conversationRuns = new ConversationRunRegistry(),
) {
  const app = new Hono();
  app.use("*", authMiddleware(TOKEN));
  registerConversationHistoryRoutes(app, {
    conversations: store,
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

  it("truncates large content and returns only bounded, redacted tool display data", async () => {
    const app = createApp(createStore({
      get: vi.fn(() => ({
        id: "conversation-1",
        createdAt: 1,
        updatedAt: 2,
        messages: [
          {
            role: "system",
            content: "x".repeat(40_000),
            timestamp: 2,
            tool: "Read",
            toolInput: { path: "/home/private/README.md", token: "secret" },
          },
          {
            role: "system",
            content: "Used Bash",
            timestamp: 3,
            tool: "Bash",
            toolInput: {
              command: "curl -H 'Authorization: Bearer super-secret' https://example.com && git status --short",
            },
          },
          {
            role: "system",
            content: "Used Grep",
            timestamp: 4,
            tool: "Grep",
            toolInput: { query: "stack trace in /home/private" },
          },
          {
            role: "system",
            content: "Used Bash",
            timestamp: 5,
            tool: "Bash",
            toolInput: {
              command: "AWS_SECRET_ACCESS_KEY=aws-secret curl -u alice:pw https://example.com",
            },
          },
        ],
      })),
    }));

    const response = await app.request(authenticated("/api/conversations/conversation-1"));
    const body = KernelConversationHistoryResponseSchema.parse(await response.json());

    expect(body.messages[0]?.content).toHaveLength(32_000);
    expect(body.messages[0]?.contentTruncated).toBe(true);
    expect(body.messages[0]).not.toHaveProperty("toolInput");
    expect(body.messages[0]?.toolDisplay).toEqual({ kind: "file", preview: "README.md" });
    expect(body.messages[1]).not.toHaveProperty("toolInput");
    expect(body.messages[1]?.toolDisplay).toEqual({
      kind: "command",
      preview: "curl -H 'Authorization: [redacted]' https://example.com && git status --short",
    });
    expect(body.messages[2]).not.toHaveProperty("toolDisplay");
    expect(body.messages[3]?.toolDisplay).toEqual({
      kind: "command",
      preview: "AWS_SECRET_ACCESS_KEY=[redacted] curl -u [redacted] https://example.com",
    });
    expect(JSON.stringify(body)).not.toContain("super-secret");
    expect(JSON.stringify(body)).not.toContain("aws-secret");
    expect(JSON.stringify(body)).not.toContain("alice:pw");
    expect(JSON.stringify(body)).not.toContain("/home/private");
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
