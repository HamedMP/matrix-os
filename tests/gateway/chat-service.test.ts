import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { ChatExecutionRootError } from "../../packages/gateway/src/chat/execution-root.js";
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

function repository(overrides: Partial<Pick<ChatRepository, "create" | "list" | "search" | "getDetailPage" | "update" | "hardDelete">> = {}) {
  return {
    create: vi.fn(async () => record()),
    list: vi.fn(async () => ({ items: [record()] } satisfies ChatListPage)),
    search: vi.fn(async () => [record()]),
    getDetailPage: vi.fn(async () => ({
      record: record(),
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    } satisfies ChatDetailPage)),
    update: vi.fn(async () => ({ ...record(), projectId: "project_1" })),
    hardDelete: vi.fn(async () => ({ chatId: "chat_service_test", deletedAt: "2026-08-26T12:00:00.000Z" })),
    ...overrides,
  } as Pick<ChatRepository, "create" | "list" | "search" | "getDetailPage" | "update" | "hardDelete">;
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

  it("moves a Chat without changing its identity or bypassing revision guards", async () => {
    const update = vi.fn(async () => ({ ...record(), projectId: "project_1" }));
    const resolve = vi.fn(async () => ({
      ref: { kind: "project" as const, projectId: "project_1" },
      primaryWorkspaceRoot: "/private/project",
      projectSlug: "project-1",
      fingerprint: "a".repeat(64),
    }));
    const service = createCanonicalChatService(repository({ update }), {
      executionRoots: { resolve },
    });

    const moved = await service.updateProject(owner, "chat_service_test", {
      baseRevision: 0,
      projectId: "project_1",
    });

    expect(update).toHaveBeenCalledWith(owner, "chat_service_test", {
      baseRevision: 0,
      projectId: "project_1",
    });
    expect(resolve).toHaveBeenCalledWith(owner, {
      kind: "project",
      projectId: "project_1",
    });
    expect(moved.chat.id).toBe("chat_service_test");
    expect(moved.projectId).toBe("project_1");
  });

  it("delegates canonical deletion to the existing atomic repository tombstone flow", async () => {
    const hardDelete = vi.fn(async () => ({
      chatId: "chat_service_test",
      deletedAt: "2026-08-26T12:00:00.000Z",
    }));
    const service = createCanonicalChatService(repository({ hardDelete }));

    await service.delete(owner, "chat_service_test", "req_service_delete");

    expect(hardDelete).toHaveBeenCalledWith(owner, {
      chatId: "chat_service_test",
      clientRequestId: "req_service_delete",
    });
  });

  it("fails closed before mutation when the target Project is stale", async () => {
    const update = vi.fn(async () => ({ ...record(), projectId: "project_missing" }));
    const service = createCanonicalChatService(repository({ update }), {
      executionRoots: {
        resolve: vi.fn(async () => {
          throw new ChatExecutionRootError("invalid_root");
        }),
      },
    });

    await expect(service.updateProject(owner, "chat_service_test", {
      baseRevision: 0,
      projectId: "project_missing",
    })).rejects.toMatchObject({
      status: 409,
      safeError: {
        code: "project_unavailable",
        safeMessage: "The Project workspace is unavailable.",
        retryable: false,
      },
    });
    expect(update).not.toHaveBeenCalled();
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

  it("preserves the explicit Global scope as a null Project filter", async () => {
    const list = vi.fn(async () => ({ items: [record()] } satisfies ChatListPage));
    const service = createCanonicalChatService(repository({ list }));

    await service.list(owner, { limit: 50, scope: "global", projectId: null });

    expect(list).toHaveBeenCalledWith(owner, { limit: 50, projectId: null });
  });

  it("searches the same owner-local index with a Project scope", async () => {
    const search = vi.fn(async () => [{ ...record(), projectId: "project_1" }]);
    const service = createCanonicalChatService(repository({ search }));

    const result = await service.search(owner, {
      query: "release plan",
      limit: 10,
      projectId: "project_1",
    });

    expect(search).toHaveBeenCalledWith(owner, "release plan", 10, "project_1");
    expect(result.items[0]?.projectId).toBe("project_1");
  });

  it("normalizes malformed opaque cursor payloads as validation errors", async () => {
    const repository = {
      create: vi.fn(),
      list: vi.fn(),
      getDetailPage: vi.fn(),
    };
    const service = createCanonicalChatService(repository as never);

    await expect(service.list(owner, { limit: 25, cursor: "chatcur_ew" }))
      .rejects.toMatchObject({ issues: expect.any(Array) });
    expect(repository.list).not.toHaveBeenCalled();
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
