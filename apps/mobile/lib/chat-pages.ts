import type { CanonicalChatRecord } from "@matrix-os/contracts";

/**
 * How many pages a paged chat list holds after its first. Every loaded page is
 * read again when the list is refreshed, so a list is not allowed to grow
 * without end; chats beyond it are reached through search.
 */
export const MAX_OLDER_CHAT_PAGES = 20;

/** Every chat on the given pages once, in page order; an earlier page's copy wins. */
export function mergeChatPages(pages: readonly (readonly CanonicalChatRecord[])[]): CanonicalChatRecord[] {
  const seen: Record<string, true> = Object.create(null);
  const merged: CanonicalChatRecord[] = [];
  for (const page of pages) {
    for (const record of page) {
      if (seen[record.chat.id]) continue;
      seen[record.chat.id] = true;
      merged.push(record);
    }
  }
  return merged;
}
