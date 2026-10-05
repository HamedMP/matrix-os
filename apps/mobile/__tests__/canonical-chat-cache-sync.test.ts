import type {
  CanonicalChatContentFrame,
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
} from "@matrix-os/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { createCanonicalChatCacheSync } from "../lib/canonical-chat-cache-sync";

const createdAt = "2026-09-06T00:00:00.000Z";
// Shaped like mobileQueryKeys: the list key is not a prefix of the detail key.
const CHATS_KEY = ["mobile", "chats", "user", "computer"];
const DETAIL_KEY = ["mobile", "chats", "detail", "user", "computer", "chat_content"];

const message: CanonicalChatMessage = {
  id: "msg_stream", chatId: "chat_content", seq: 1, role: "assistant", state: "pending",
  parts: [{ type: "text", text: "hello" }], createdAt,
};

function detailAt(revision: number, text?: string): CanonicalChatDetailResponse {
  return {
    record: { chat: {
      id: "chat_content", ownerScope: { type: "personal", ownerId: "owner_test" },
      title: "Content", lifecycle: "active", attention: "none", revision, messageCount: 0,
      createdAt, updatedAt: createdAt,
    } },
    messages: text === undefined ? [] : [{ ...message, parts: [{ type: "text", text }] }],
    turns: [], runs: [], activities: [],
  };
}

function textDelta(revision: number, offset: number, text: string, chatId = "chat_content") {
  const content: CanonicalChatContentFrame = {
    type: "chat.content",
    event: { cursor: revision, revision, chatId, eventType: "run.message", createdAt },
    content: {
      record: detailAt(revision).record,
      messageDelta: { message: { ...message, parts: [{ type: "text", text }] }, partIndex: 0, offset },
    },
  };
  return { type: "chat.changed" as const, chatId, cursor: revision, eventType: "run.message" as const, content };
}

/** A query client with mounted chat-list and chat-detail queries, as the screens keep them. */
function mountedQueries(fetchDetail: jest.Mock, initialDetail = detailAt(1)) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fetchList = jest.fn(async () => ({ items: [] }));
  queryClient.setQueryData(CHATS_KEY, { items: [] });
  queryClient.setQueryData(DETAIL_KEY, initialDetail);
  const unmount = [
    new QueryObserver(queryClient, { queryKey: CHATS_KEY, queryFn: fetchList }).subscribe(() => undefined),
    new QueryObserver(queryClient, { queryKey: DETAIL_KEY, queryFn: fetchDetail }).subscribe(() => undefined),
  ];
  const sync = createCanonicalChatCacheSync({
    queryClient, chatsKey: CHATS_KEY, detailKey: DETAIL_KEY, activeChatId: "chat_content",
  });
  const shownText = () => {
    const part = queryClient.getQueryData<CanonicalChatDetailResponse>(DETAIL_KEY)?.messages[0]?.parts[0];
    return part?.type === "text" ? part.text : undefined;
  };
  return {
    sync, fetchList, shownText,
    cleanup() {
      sync.dispose();
      unmount.forEach((stop) => stop());
      queryClient.clear();
    },
  };
}

const settle = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("createCanonicalChatCacheSync", () => {
  it("writes streamed text into the open chat without fetching anything", async () => {
    const fetchDetail = jest.fn();
    const { sync, shownText, fetchList, cleanup } = mountedQueries(fetchDetail);

    sync.handle(textDelta(2, 0, "hello"));
    sync.handle(textDelta(3, 5, " world"));
    await settle();

    expect(shownText()).toBe("hello world");
    expect(fetchDetail).not.toHaveBeenCalled();
    expect(fetchList).not.toHaveBeenCalled();
    cleanup();
  });

  it("holds frames that do not fit until a snapshot arrives, then applies them", async () => {
    const fetchDetail = jest.fn(async () => detailAt(2, "hello"));
    const { sync, shownText, cleanup } = mountedQueries(fetchDetail);

    sync.handle(textDelta(3, 5, " world"));
    sync.handle(textDelta(4, 11, "!"));
    await settle();

    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(shownText()).toBe("hello world!");
    cleanup();
  });

  it("fetches another snapshot when the first attempt fails", async () => {
    const fetchDetail = jest.fn()
      .mockRejectedValueOnce(new Error("Chat unavailable."))
      .mockResolvedValue(detailAt(2, "hello"));
    const { sync, shownText, cleanup } = mountedQueries(fetchDetail);

    sync.handle(textDelta(3, 5, " world"));
    await settle();
    expect(shownText()).toBeUndefined();

    sync.handle(textDelta(4, 11, "!"));
    await settle();

    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(shownText()).toBe("hello world!");
    cleanup();
  });

  it("refreshes the list at most once per interval while text streams", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    for (let revision = 2; revision <= 6; revision += 1) {
      sync.handle(textDelta(revision, 0, "x", "chat_other"));
    }
    await settle();
    expect(fetchList).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("refreshes the list straight away for any other event", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 9, eventType: "run.completed" });
    await settle();

    expect(fetchList).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("shares one follow-up list refresh between events that arrive in a burst", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 9, eventType: "turn.accepted" });
    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 10, eventType: "run.activity" });
    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 11, eventType: "run.completed" });
    await settle();
    expect(fetchList).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchList).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchList).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("brings a refresh waiting on streamed text forward for any other event", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 9, eventType: "turn.accepted" });
    await settle();
    await jest.advanceTimersByTimeAsync(500);
    sync.handle(textDelta(10, 0, "x", "chat_other"));
    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 11, eventType: "run.completed" });
    expect(fetchList).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(500);
    expect(fetchList).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("refetches the open chat for an event that carries no content", async () => {
    const fetchDetail = jest.fn(async () => detailAt(2, "hello"));
    const { sync, shownText, cleanup } = mountedQueries(fetchDetail);

    sync.handle({ type: "chat.changed", chatId: "chat_content", cursor: 9, eventType: "chat.updated" });
    await settle();

    expect(shownText()).toBe("hello");
    cleanup();
  });

  it("refetches the list and the open chat on a full refresh", async () => {
    const fetchDetail = jest.fn(async () => detailAt(2, "hello"));
    const { sync, fetchList, cleanup } = mountedQueries(fetchDetail);

    sync.handle({ type: "chat.full_refresh" });
    await settle();

    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("cancels a pending list refresh when disposed", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    sync.handle(textDelta(2, 0, "x", "chat_other"));
    sync.dispose();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(fetchList).not.toHaveBeenCalled();
    cleanup();
  });
});
