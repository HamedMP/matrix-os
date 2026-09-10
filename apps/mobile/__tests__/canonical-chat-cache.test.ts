import { QueryClient } from "@tanstack/react-query";
import type {
  CanonicalChatContentFrame,
  CanonicalChatDetailResponse,
  CanonicalChatListResponse,
} from "@matrix-os/contracts/canonical-chat-streaming";

import {
  applyCanonicalChatEventToCache,
  readCanonicalChatStreamFence,
  reconcileCanonicalChatDetailResponse,
  reconcileCanonicalChatListResponse,
} from "@/lib/canonical-chat-cache";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

const userId = "user_mobile";
const computerKey = "computer:primary";
const chatId = "chat_mobile";
const createdAt = "2026-09-10T00:00:00.000Z";
const record = (revision: number) => ({ chat: {
  id: chatId,
  ownerScope: { type: "personal" as const, ownerId: userId },
  title: `Revision ${revision}`,
  lifecycle: "active" as const,
  attention: "none" as const,
  revision,
  messageCount: revision > 0 ? 1 : 0,
  createdAt,
  updatedAt: createdAt,
} });
const detail = (revision: number): CanonicalChatDetailResponse => ({
  record: record(revision), messages: [], turns: [], runs: [], activities: [],
});
const frame = (cursor: number, revision: number): CanonicalChatContentFrame => ({
  type: "chat.content",
  event: { cursor, revision, chatId, eventType: "chat.updated", createdAt },
  content: { record: record(revision) },
});
const queryClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

describe("Native Mobile canonical Chat cache recovery", () => {
  it("merges progressive content without list invalidation and records a revision fence", () => {
    const client = queryClient();
    const listKey = mobileQueryKeys.canonicalChats(userId, computerKey);
    const detailKey = mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId);
    client.setQueryData<CanonicalChatListResponse>(listKey, { items: [record(1)] });
    client.setQueryData(detailKey, detail(1));

    const recovery = applyCanonicalChatEventToCache({
      queryClient: client, userId, computerKey, activeChatId: chatId, event: {
        type: "chat.changed", chatId, cursor: 2, revision: 2,
        eventType: "chat.updated", content: frame(2, 2),
      },
    });

    expect(recovery).toEqual({ refreshList: false, refreshDetail: false });
    expect(client.getQueryData<CanonicalChatListResponse>(listKey)?.items[0]?.chat.revision).toBe(2);
    expect(client.getQueryData<CanonicalChatDetailResponse>(detailKey)?.record.chat.revision).toBe(2);
    expect(readCanonicalChatStreamFence(client, userId, computerKey)).toMatchObject({
      cursor: 2,
      revisions: { [chatId]: 2 },
    });
  });

  it("recovers a missing delta, removes deleted chats, and never refreshes the list per token", () => {
    const client = queryClient();
    const listKey = mobileQueryKeys.canonicalChats(userId, computerKey);
    client.setQueryData<CanonicalChatListResponse>(listKey, { items: [record(1)] });

    expect(applyCanonicalChatEventToCache({
      queryClient: client, userId, computerKey, activeChatId: chatId, event: {
        type: "chat.changed", chatId, cursor: 3, revision: 3,
        eventType: "run.message", content: frame(3, 3),
      },
    })).toEqual({ refreshList: false, refreshDetail: true });

    expect(applyCanonicalChatEventToCache({
      queryClient: client, userId, computerKey, activeChatId: chatId, event: {
        type: "chat.changed", chatId, cursor: 4, revision: 4, eventType: "chat.deleted",
      },
    })).toEqual({ refreshList: true, refreshDetail: false });
    expect(client.getQueryData<CanonicalChatListResponse>(listKey)?.items).toEqual([]);
  });

  it("prevents REST responses started before a stream event from rolling caches backward", () => {
    const client = queryClient();
    const listKey = mobileQueryKeys.canonicalChats(userId, computerKey);
    const detailKey = mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId);
    client.setQueryData<CanonicalChatListResponse>(listKey, { items: [record(1)] });
    client.setQueryData(detailKey, detail(1));
    const before = readCanonicalChatStreamFence(client, userId, computerKey);
    applyCanonicalChatEventToCache({
      queryClient: client, userId, computerKey, activeChatId: chatId, event: {
        type: "chat.changed", chatId, cursor: 2, revision: 2,
        eventType: "chat.updated", content: frame(2, 2),
      },
    });

    expect(reconcileCanonicalChatDetailResponse({
      queryClient: client, userId, computerKey, chatId, incoming: detail(1),
    })?.record.chat.revision).toBe(2);
    expect(reconcileCanonicalChatListResponse({
      queryClient: client, userId, computerKey, requestFence: before, incoming: { items: [record(1)] },
    }).items[0]?.chat.revision).toBe(2);
  });

  it("keeps a newer cached record when a REST list is already stale at request start", () => {
    const client = queryClient();
    const listKey = mobileQueryKeys.canonicalChats(userId, computerKey);
    client.setQueryData<CanonicalChatListResponse>(listKey, { items: [record(3)] });
    const requestFence = readCanonicalChatStreamFence(client, userId, computerKey);

    expect(reconcileCanonicalChatListResponse({
      queryClient: client,
      userId,
      computerKey,
      requestFence,
      incoming: { items: [record(1)] },
    }).items[0]?.chat.revision).toBe(3);
  });

  it("ignores out-of-order content after applying a terminal projection", () => {
    const client = queryClient();
    const detailKey = mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId);
    const running = detail(1);
    running.record = { ...running.record, activeRun: {
      runId: "run_mobile",
      turnId: "cturn_mobile",
      status: "running",
    } };
    client.setQueryData(detailKey, running);
    const completed: CanonicalChatContentFrame = {
      type: "chat.content",
      event: { cursor: 3, revision: 2, chatId, eventType: "run.completed", createdAt },
      content: {
        record: record(2),
        messages: [{
          id: "msg_mobile",
          chatId,
          seq: 1,
          role: "assistant",
          state: "committed",
          parts: [{ type: "text", text: "Finished" }],
          createdAt,
        }],
      },
    };
    applyCanonicalChatEventToCache({
      queryClient: client, userId, computerKey, activeChatId: chatId, event: {
        type: "chat.changed", chatId, cursor: 3, revision: 2,
        eventType: "run.completed", content: completed,
      },
    });
    applyCanonicalChatEventToCache({
      queryClient: client, userId, computerKey, activeChatId: chatId, event: {
        type: "chat.changed", chatId, cursor: 2, revision: 1,
        eventType: "run.message", content: frame(2, 1),
      },
    });

    const settled = client.getQueryData<CanonicalChatDetailResponse>(detailKey);
    expect(settled?.record.activeRun).toBeUndefined();
    expect(settled?.record.chat.revision).toBe(2);
    expect(settled?.messages[0]).toMatchObject({ state: "committed", parts: [{ text: "Finished" }] });
  });

  it("advances the cursor fence when a replay gap requests an authoritative refresh", () => {
    const client = queryClient();

    expect(applyCanonicalChatEventToCache({
      queryClient: client,
      userId,
      computerKey,
      activeChatId: chatId,
      event: { type: "chat.full_refresh", cursor: 12 },
    })).toEqual({ refreshList: true, refreshDetail: true });
    expect(readCanonicalChatStreamFence(client, userId, computerKey).cursor).toBe(12);
  });
});
