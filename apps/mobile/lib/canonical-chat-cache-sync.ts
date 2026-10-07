import type { CanonicalChatContentFrame, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { applyCanonicalChatContentFrames } from "@/lib/canonical-chat-content";
import type { CanonicalChatInvalidation } from "@/lib/canonical-chat-events";

// A snapshot fetch normally lands within a few frames; this only bounds the
// queue if one never does.
const MAX_WAITING_FRAMES = 200;
// Events arrive in bursts -- a run starting, a replay ending. One refetch
// covers a burst, with one more when this interval ends for whatever arrived
// in between, instead of a request per event.
const REFRESH_INTERVAL_MS = 2_000;
// Streamed text and tool activity arrive many times a second for as long as a
// run lasts, and change nothing the chat list shows beyond the preview of an
// untitled chat. The events that do reorder or rename chats (a turn accepted,
// a run finished, a chat updated) still refresh the list straight away.
const QUIET_LIST_REFRESH_MS = 10_000;
const HIGH_FREQUENCY_EVENTS: ReadonlySet<string> = new Set(["run.message", "run.activity"]);
// Only a bot's chat emits these, so one of them outranks a cached "no bot".
const BOT_EVENT = /^(bot|interaction)\./;

/**
 * Refetches a query at most once per `REFRESH_INTERVAL_MS`, and never while a
 * fetch of it is still in flight: however many times it is asked, a burst
 * costs one request now and one more once things settle.
 */
function createCoalescedRefetch(queryClient: QueryClient, queryKey: QueryKey) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  const isInFlight = () => queryClient.isFetching({ queryKey, exact: true }) > 0;

  function run() {
    timer = undefined;
    if (isInFlight()) {
      // That request started before whatever asked for this refresh, so it
      // may not include it. Look again rather than piling a second one on.
      schedule(REFRESH_INTERVAL_MS);
      return;
    }
    lastRunAt = Date.now();
    void queryClient.invalidateQueries({ queryKey });
  }

  function schedule(delayMs: number) {
    const at = Date.now() + delayMs;
    if (timer !== undefined && dueAt <= at) return;
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(run, delayMs);
  }

  return {
    /** Refreshes now when the interval allows it, otherwise once when it ends. */
    request() {
      const wait = lastRunAt + REFRESH_INTERVAL_MS - Date.now();
      if (wait > 0) {
        schedule(wait);
      } else if (isInFlight()) {
        schedule(REFRESH_INTERVAL_MS);
      } else {
        clearTimeout(timer);
        run();
      }
    },
    /** Refreshes once within `delayMs`, for changes nobody is waiting to see. */
    requestWithin(delayMs: number) {
      schedule(delayMs);
    },
    /**
     * Stops refetching. A refresh that was still owed is not forgotten: the
     * query is left marked stale, so whoever shows it next refetches it.
     */
    dispose() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    },
  };
}

/** The chat on screen and the queries that show it. */
export interface CanonicalChatCacheSyncActiveChat {
  chatId: string;
  detailKey: QueryKey;
  /** Its bot-status query, when there is one to keep fresh. */
  botKey?: QueryKey | null;
}

export interface CanonicalChatCacheSync {
  handle(event: CanonicalChatInvalidation): void;
  /**
   * Points the sync at the chat now on screen, or at none while a draft has
   * not been created yet. The chat list's refresh state carries over, so a
   * list refresh that is pending survives the change.
   */
  setActiveChat(chat: CanonicalChatCacheSyncActiveChat | null): void;
  dispose(): void;
}

/**
 * Keeps the React Query cache in step with the chat event stream: streamed
 * content is written straight into the open chat's detail, and everything
 * else becomes a refetch of the list, the detail or the bot status -- as few
 * of them as the events allow.
 */
export function createCanonicalChatCacheSync(options: {
  queryClient: QueryClient;
  chatsKey: QueryKey;
  activeChat?: CanonicalChatCacheSyncActiveChat | null;
}): CanonicalChatCacheSync {
  const { queryClient, chatsKey } = options;
  const list = createCoalescedRefetch(queryClient, chatsKey);

  function openChat({ chatId, detailKey, botKey = null }: CanonicalChatCacheSyncActiveChat) {
    const detail = createCoalescedRefetch(queryClient, detailKey);
    const bot = botKey ? createCoalescedRefetch(queryClient, botKey) : null;
    // Streamed frames that don't fit the cached detail yet: the detail is
    // still loading, or a frame was missed. They wait here for a snapshot
    // instead of being dropped, so streaming picks up right after it.
    let waitingFrames: CanonicalChatContentFrame[] = [];
    let closed = false;

    function applyWaitingFrames() {
      if (closed) return;
      const cached = queryClient.getQueryData<CanonicalChatDetailResponse>(detailKey);
      if (!cached) return;
      const { detail: applied, unapplied } = applyCanonicalChatContentFrames(cached, waitingFrames);
      waitingFrames = unapplied;
      if (applied !== cached) queryClient.setQueryData(detailKey, applied);
    }

    return {
      chatId,
      refreshDetail: detail.request,
      applyFrame(frame: CanonicalChatContentFrame) {
        const wasWaiting = waitingFrames.length > 0;
        waitingFrames = [...waitingFrames, frame].slice(-MAX_WAITING_FRAMES);
        applyWaitingFrames();
        if (waitingFrames.length === 0) return;

        // A frame that doesn't fit needs a snapshot. The first one always starts a
        // fresh fetch, because one already in flight was requested before this
        // frame existed. Later frames queue behind that fetch, and start another
        // only if it has ended without unblocking them -- that is, it failed.
        const fetching = queryClient.isFetching({ queryKey: detailKey, exact: true }) > 0;
        if (!wasWaiting || !fetching) {
          void queryClient.invalidateQueries({ queryKey: detailKey }).then(applyWaitingFrames);
        }
      },
      /**
       * A chat that is not a bot's chat does not become one, so a cached `null`
       * is a final answer and is not asked about again unless `recheck` is set.
       */
      refreshBot({ recheck }: { recheck: boolean }) {
        if (!bot || !botKey) return;
        if (!recheck && queryClient.getQueryData(botKey) === null) return;
        bot.request();
      },
      close() {
        closed = true;
        detail.dispose();
        bot?.dispose();
        // Frames still waiting mean the cached detail is behind.
        if (waitingFrames.length > 0) void queryClient.invalidateQueries({ queryKey: detailKey, refetchType: "none" });
        waitingFrames = [];
      },
    };
  }

  let active = options.activeChat ? openChat(options.activeChat) : null;

  return {
    handle(event) {
      if (event.type === "chat.full_refresh") {
        list.request();
        active?.refreshDetail();
        active?.refreshBot({ recheck: true });
        return;
      }
      const highFrequency = HIGH_FREQUENCY_EVENTS.has(event.eventType);
      if (highFrequency) list.requestWithin(QUIET_LIST_REFRESH_MS);
      else list.request();

      if (!active || event.chatId !== active.chatId) return;
      if (event.content) active.applyFrame(event.content);
      else active.refreshDetail();
      // Bot status is interactions, tasks and access -- none of which a piece
      // of streamed text or a tool step changes.
      if (!highFrequency) active.refreshBot({ recheck: BOT_EVENT.test(event.eventType) });
    },
    setActiveChat(chat) {
      active?.close();
      active = chat ? openChat(chat) : null;
    },
    dispose() {
      list.dispose();
      active?.close();
      active = null;
    },
  };
}
