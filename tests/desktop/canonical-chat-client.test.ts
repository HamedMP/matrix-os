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
});
