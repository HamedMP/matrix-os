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
        // A first load on its way is the refresh; only a refetch of data
        // already on screen can predate what asked for this one.
        if (queryClient.getQueryData(queryKey) !== undefined) schedule(REFRESH_INTERVAL_MS);
      } else {
        clearTimeout(timer);
        run();
      }
    },
    /** Refreshes once within `delayMs`, for changes nobody is waiting to see. */
    requestWithin(delayMs: number) {
      schedule(delayMs);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
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
  /** The chat on screen, or null while a draft has not been created yet. */
  activeChatId: string | null;
  /** The detail query of the chat on screen. */
  detailKey: QueryKey;
  /** The bot-status query of the chat on screen, when there is one to keep fresh. */
  botKey?: QueryKey | null;
}): { handle(event: CanonicalChatInvalidation): void; dispose(): void } {
  const { queryClient, chatsKey, activeChatId, detailKey, botKey } = options;
  // Streamed frames that don't fit the cached detail yet: the detail is still
  // loading, or a frame was missed. They wait here for a snapshot instead of
  // being dropped, so streaming picks up right after it.
  let waitingFrames: CanonicalChatContentFrame[] = [];

  const list = createCoalescedRefetch(queryClient, chatsKey);
  const detail = createCoalescedRefetch(queryClient, detailKey);
  const bot = botKey ? createCoalescedRefetch(queryClient, botKey) : null;

  function applyWaitingFrames() {
    const cached = queryClient.getQueryData<CanonicalChatDetailResponse>(detailKey);
    if (!cached) return;
    const { detail: applied, unapplied } = applyCanonicalChatContentFrames(cached, waitingFrames);
    waitingFrames = unapplied;
    if (applied !== cached) queryClient.setQueryData(detailKey, applied);
  }

  function applyFrame(frame: CanonicalChatContentFrame) {
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
  }

  /** A chat that is not a bot's chat does not become one: a cached `null` is a final answer. */
  const hasNoBot = () => botKey != null && queryClient.getQueryData(botKey) === null;

  return {
    handle(event) {
      if (event.type === "chat.full_refresh") {
        list.request();
        if (activeChatId) {
          detail.request();
          bot?.request();
        }
        return;
      }
      const highFrequency = HIGH_FREQUENCY_EVENTS.has(event.eventType);
      if (highFrequency) list.requestWithin(QUIET_LIST_REFRESH_MS);
      else list.request();

      if (event.chatId !== activeChatId) return;
      if (event.content) applyFrame(event.content);
      else detail.request();
      // Bot status is interactions, tasks and access -- none of which a piece
      // of streamed text or a tool step changes.
      if (!highFrequency && !hasNoBot()) bot?.request();
    },
    dispose() {
      list.dispose();
      detail.dispose();
      bot?.dispose();
    },
  };
}
