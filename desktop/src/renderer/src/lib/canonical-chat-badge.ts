import { isChatUnread } from "@matrix-os/ui";
import type { CanonicalChatClient, CanonicalChatEventSource } from "./canonical-chat-client";

const MAX_BADGE_COUNT = 999;
const MAX_PAGES = 10;
const REFRESH_MS = 30_000;

/** Native projection of the same server read state used by the Chat history rail. */
export function wireCanonicalChatBadge({ client, eventSource, setBadge }: {
  client: Pick<CanonicalChatClient, "list">;
  eventSource: Pick<CanonicalChatEventSource, "subscribe"> | null;
  setBadge: (count: number) => Promise<void>;
}): () => void {
  let current = true;
  let inFlight = false;
  let pending = false;
  let lastRequestedCount: number | undefined;
  let writeSequence = 0;
  const write = async (count: number) => {
    if (count === lastRequestedCount) return;
    // IPC applies the badge before its promise resolves. Track the request now
    // so teardown can clear a write whose acknowledgement is still in flight.
    const sequence = ++writeSequence;
    lastRequestedCount = count;
    try {
      await setBadge(count);
    } catch (error: unknown) {
      if (sequence === writeSequence) lastRequestedCount = undefined;
      console.warn("[chat-badge] badge update failed:", error instanceof Error ? error.name : "UnknownError");
    }
  };
  const refresh = async () => {
    if (!current) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    do {
      pending = false;
      try {
        // Request unread across all projects, independently of rail search/filter state.
        // The set is scoped to this refresh and bounded by ten pages of 100 records.
        const unreadIds = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES && current; page += 1) {
          const result = await client.list({ unreadOnly: true, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!current) return;
          for (const record of result.items.slice(0, 100)) {
            if (isChatUnread(record)) unreadIds.add(record.chat.id);
          }
          if (unreadIds.size >= MAX_BADGE_COUNT || !result.nextCursor || result.nextCursor === cursor) break;
          cursor = result.nextCursor;
        }
        if (current && !pending) await write(Math.min(unreadIds.size, MAX_BADGE_COUNT));
      } catch (error: unknown) {
        if (current) console.warn("[chat-badge] history refresh failed:", error instanceof Error ? error.name : "UnknownError");
      }
    } while (current && pending);
    inFlight = false;
  };
  const subscription = eventSource?.subscribe((event) => {
    if (event.type === "chat.changed" && event.eventType === "run.message") return;
    void refresh();
  });
  // Clear the previous runtime's badge before loading this owner's history.
  void write(0);
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  return () => {
    current = false;
    pending = false;
    clearInterval(timer);
    subscription?.dispose();
    void write(0);
  };
}
