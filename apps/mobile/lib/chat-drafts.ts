/**
 * Composer drafts, one per chat plus one for the new chat being composed --
 * the mobile counterpart of desktop's Chat-keyed draft store. Serializable,
 * and bounded: past the cap, the least recently written draft is dropped.
 */
export type ChatDrafts = Readonly<Record<string, string>>;

export const MAX_CHAT_DRAFTS = 100;

const NEW_CHAT_DRAFT_KEY = "new";

/** The draft a chat's composer shows; null is the new chat not yet created. */
export function chatDraftKey(chatId: string | null): string {
  return chatId === null ? NEW_CHAT_DRAFT_KEY : `chat:${chatId}`;
}

/** Sets a draft, or removes it when `text` is empty. */
export function writeChatDraft(drafts: ChatDrafts, key: string, text: string): ChatDrafts {
  if (!text && !(key in drafts)) return drafts;
  const others = Object.entries(drafts).filter(([existing]) => existing !== key);
  if (!text) return Object.fromEntries(others);
  // Written last, so it is the most recent and the last to be dropped.
  return Object.fromEntries([...others, [key, text] as const].slice(-MAX_CHAT_DRAFTS));
}

/**
 * Carries a draft over when its chat changes identity: text typed into a new
 * chat's composer belongs to that chat once it has been created.
 */
export function moveChatDraft(drafts: ChatDrafts, from: string, to: string): ChatDrafts {
  const text = drafts[from];
  if (!text) return drafts;
  return writeChatDraft(writeChatDraft(drafts, from, ""), to, text);
}
