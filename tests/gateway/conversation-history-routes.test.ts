import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { KernelConversationHistoryResponseSchema } from "../../packages/contracts/src/index.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import type { ConversationStore } from "../../packages/gateway/src/conversations.js";
import { registerConversationHistoryRoutes } from "../../packages/gateway/src/server/conversation-history-routes.js";

const TOKEN = "conversation-history-test-token";

function createStore(overrides: Partial<ConversationStore> = {}): ConversationStore {
  return {
    begin: vi.fn(),
    addUserMessage: vi.fn(),
    appendAssistantText: vi.fn(),
    addToolStart: vi.fn(),
    addToolEnd: vi.fn(),
    finalize: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    create: vi.fn(() => "conversation-1"),
    delete: vi.fn(() => false),
    search: vi.fn(() => []),
    ...overrides,
  };
}

function createApp(store: ConversationStore) {
  const app = new Hono();
  app.use("*", authMiddleware(TOKEN));
  registerConversationHistoryRoutes(app, { conversations: store });
  return app;
}

function authenticated(path: string) {
  return new Request(`http://localhost${path}`, {
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
});
