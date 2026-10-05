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
const BOT_KEY = ["native-bot-chat", "user", "https://example.test/vm/computer", "chat_content"];

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

/**
 * A query client with mounted chat-list, chat-detail and bot-status queries, as
 * the screens keep them. `bot` is what the bot-status query already holds:
 * a snapshot, `null` for a chat that has no bot, or `undefined` when unknown.
 */
function mountedQueries(
  fetchDetail: jest.Mock,
  initialDetail = detailAt(1),
  { bot, fetchList = jest.fn(async () => ({ items: [] })) }: { bot?: object | null; fetchList?: jest.Mock } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fetchBot = jest.fn(async () => bot ?? null);
  queryClient.setQueryData(CHATS_KEY, { items: [] });
  queryClient.setQueryData(DETAIL_KEY, initialDetail);
  if (bot !== undefined) queryClient.setQueryData(BOT_KEY, bot);
  const unmount = [
    new QueryObserver(queryClient, { queryKey: CHATS_KEY, queryFn: fetchList }).subscribe(() => undefined),
    new QueryObserver(queryClient, { queryKey: DETAIL_KEY, queryFn: fetchDetail }).subscribe(() => undefined),
    new QueryObserver(queryClient, { queryKey: BOT_KEY, queryFn: fetchBot, enabled: bot !== undefined })
      .subscribe(() => undefined),
  ];
  const sync = createCanonicalChatCacheSync({
    queryClient, chatsKey: CHATS_KEY, detailKey: DETAIL_KEY, botKey: BOT_KEY, activeChatId: "chat_content",
  });
  const shownText = () => {
    const part = queryClient.getQueryData<CanonicalChatDetailResponse>(DETAIL_KEY)?.messages[0]?.parts[0];
    return part?.type === "text" ? part.text : undefined;
  };
  return {
    sync, fetchList, fetchBot, shownText,
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

  it("refreshes the list only occasionally while text streams", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    for (let revision = 2; revision <= 6; revision += 1) {
      sync.handle(textDelta(revision, 0, "x", "chat_other"));
    }
    await jest.advanceTimersByTimeAsync(9_000);
    expect(fetchList).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("treats tool activity like streamed text when refreshing the list", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    for (let cursor = 2; cursor <= 30; cursor += 1) {
      sync.handle({ type: "chat.changed", chatId: "chat_other", cursor, eventType: "run.activity" });
    }
    await jest.advanceTimersByTimeAsync(9_000);
    expect(fetchList).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("collapses a burst of events into one list refresh now and one when the interval ends", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    for (let cursor = 2; cursor <= 12; cursor += 1) {
      sync.handle({ type: "chat.changed", chatId: "chat_other", cursor, eventType: "chat.updated" });
    }
    await settle();
    expect(fetchList).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchList).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchList).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("refreshes the list for a completed run even while a slow refresh is pending", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    sync.handle(textDelta(2, 0, "x", "chat_other"));
    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 3, eventType: "run.completed" });
    await settle();
    expect(fetchList).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("waits for a list refresh in flight instead of starting another", async () => {
    let finishFirst: (value: { items: never[] }) => void = () => undefined;
    const fetchList = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ items: [] });
    const { sync, cleanup } = mountedQueries(jest.fn(), detailAt(1), { fetchList });

    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 2, eventType: "chat.updated" });
    await jest.advanceTimersByTimeAsync(2_500);
    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 3, eventType: "chat.updated" });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchList).toHaveBeenCalledTimes(1);

    finishFirst({ items: [] });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchList).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("refreshes the list straight away for any other event", async () => {
    const { sync, fetchList, cleanup } = mountedQueries(jest.fn());

    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 9, eventType: "run.completed" });
    await settle();

    expect(fetchList).toHaveBeenCalledTimes(1);
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

  it("collapses a burst of content-less events for the open chat into one refetch now and one later", async () => {
    const fetchDetail = jest.fn(async () => detailAt(2, "hello"));
    const { sync, cleanup } = mountedQueries(fetchDetail);

    for (let cursor = 9; cursor <= 20; cursor += 1) {
      sync.handle({ type: "chat.changed", chatId: "chat_content", cursor, eventType: "chat.updated" });
    }
    await settle();
    expect(fetchDetail).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchDetail).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("refreshes bot status for the open chat, but not for streamed text or tool activity", async () => {
    const { sync, fetchBot, cleanup } = mountedQueries(
      jest.fn(async () => detailAt(41)), detailAt(1), { bot: { agentId: "bot_one" } },
    );

    for (let revision = 2; revision <= 40; revision += 1) sync.handle(textDelta(revision, revision - 2, "x"));
    sync.handle({ type: "chat.changed", chatId: "chat_content", cursor: 41, eventType: "run.activity" });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchBot).not.toHaveBeenCalled();

    sync.handle({ type: "chat.changed", chatId: "chat_content", cursor: 42, eventType: "interaction.requested" });
    await settle();
    expect(fetchBot).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("collapses a burst of bot events into one status refresh now and one later", async () => {
    const { sync, fetchBot, cleanup } = mountedQueries(
      jest.fn(async () => detailAt(2)), detailAt(1), { bot: { agentId: "bot_one" } },
    );

    for (let cursor = 2; cursor <= 12; cursor += 1) {
      sync.handle({ type: "chat.changed", chatId: "chat_content", cursor, eventType: "bot.task.updated" });
    }
    await settle();
    expect(fetchBot).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchBot).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("leaves bot status alone for another chat's events", async () => {
    const { sync, fetchBot, cleanup } = mountedQueries(jest.fn(), detailAt(1), { bot: { agentId: "bot_one" } });

    sync.handle({ type: "chat.changed", chatId: "chat_other", cursor: 2, eventType: "interaction.requested" });
    await jest.advanceTimersByTimeAsync(5_000);

    expect(fetchBot).not.toHaveBeenCalled();
    cleanup();
  });

  it("never asks again whether a chat without a bot has one, until a full refresh", async () => {
    const { sync, fetchBot, cleanup } = mountedQueries(jest.fn(async () => detailAt(2)), detailAt(1), { bot: null });

    sync.handle({ type: "chat.changed", chatId: "chat_content", cursor: 2, eventType: "run.completed" });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetchBot).not.toHaveBeenCalled();

    sync.handle({ type: "chat.full_refresh" });
    await settle();
    expect(fetchBot).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("lets a first load already in flight stand in for the refresh", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let finishLoad: (value: { items: never[] }) => void = () => undefined;
    const fetchList = jest.fn(() => new Promise((resolve) => { finishLoad = resolve; }));
    const stop = new QueryObserver(queryClient, { queryKey: CHATS_KEY, queryFn: fetchList }).subscribe(() => undefined);
    const sync = createCanonicalChatCacheSync({
      queryClient, chatsKey: CHATS_KEY, detailKey: DETAIL_KEY, activeChatId: null,
    });

    sync.handle({ type: "chat.full_refresh" });
    finishLoad({ items: [] });
    await jest.advanceTimersByTimeAsync(10_000);

    expect(fetchList).toHaveBeenCalledTimes(1);
    sync.dispose();
    stop();
    queryClient.clear();
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
