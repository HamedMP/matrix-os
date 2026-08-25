import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import type {
  ChatDetailPage,
  ChatListPage,
  ChatRepository,
} from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_1" };

function record(id = "chat_service_test"): CanonicalChatRecord {
  return {
    chat: {
      id,
      ownerScope: owner,
      title: "Service test",
      lifecycle: "active",
      attention: "none",
      revision: 0,
      messageCount: 0,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    },
  };
}

function repository(overrides: Partial<Pick<ChatRepository, "create" | "list" | "getDetailPage">> = {}) {
  return {
    create: vi.fn(async () => record()),
    list: vi.fn(async () => ({ items: [record()] } satisfies ChatListPage)),
    getDetailPage: vi.fn(async () => ({
      record: record(),
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    } satisfies ChatDetailPage)),
    ...overrides,
  } as Pick<ChatRepository, "create" | "list" | "getDetailPage">;
}

describe("canonical Chat service", () => {
  it("generates server-owned Chat ids and a bounded default title", async () => {
    const create = vi.fn(async (_owner, input) => record(input.id));
    const repo = repository({ create });
    const service = createCanonicalChatService(repo);

    const created = await service.create(owner, { clientRequestId: "req_service_create" });

    expect(created.chat.id).toMatch(/^chat_[A-Za-z0-9_-]+$/);
    expect(create).toHaveBeenCalledWith(owner, expect.objectContaining({
      id: created.chat.id,
      clientRequestId: "req_service_create",
      title: "New chat",
    }));
  });

  it("round-trips opaque list cursors without exposing repository cursor fields", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        items: [record()],
        nextCursor: {
          updatedAt: "2026-08-25T12:00:00.123456Z",
          chatId: "chat_service_test",
        },
      } satisfies ChatListPage)
      .mockResolvedValueOnce({ items: [] } satisfies ChatListPage);
    const service = createCanonicalChatService(repository({ list }));

    const first = await service.list(owner, { limit: 25 });
    expect(first.nextCursor).toMatch(/^chatcur_[A-Za-z0-9_-]+$/);
    expect(first.nextCursor).not.toContain("updatedAt");
    await service.list(owner, { limit: 25, cursor: first.nextCursor });
    expect(list).toHaveBeenLastCalledWith(owner, {
      limit: 25,
      cursor: {
        updatedAt: "2026-08-25T12:00:00.123456Z",
        chatId: "chat_service_test",
      },
    });
  });

  it("binds older-message cursors to the requested Chat", async () => {
    const getDetailPage = vi.fn()
      .mockResolvedValueOnce({
        record: record(),
        messages: [],
        turns: [],
        runs: [],
        activities: [],
        nextBeforeSeq: 41,
      } satisfies ChatDetailPage)
      .mockResolvedValueOnce({
        record: record(),
        messages: [],
        turns: [],
        runs: [],
        activities: [],
      } satisfies ChatDetailPage);
    const service = createCanonicalChatService(repository({ getDetailPage }));

    const first = await service.getDetail(owner, "chat_service_test", { limit: 100 });
    expect(first?.nextCursor).toMatch(/^chatcur_[A-Za-z0-9_-]+$/);
    await service.getDetail(owner, "chat_service_test", {
      limit: 100,
      cursor: first?.nextCursor,
    });
    expect(getDetailPage).toHaveBeenLastCalledWith(owner, "chat_service_test", {
      limit: 100,
      beforeSeq: 41,
    });
    await expect(service.getDetail(owner, "chat_other", {
      limit: 100,
      cursor: first?.nextCursor,
    })).rejects.toThrow();
  });
});
