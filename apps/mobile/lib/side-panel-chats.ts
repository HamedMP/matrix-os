import type { CanonicalChatRecord } from "@matrix-os/contracts";

type Chats = readonly CanonicalChatRecord[];

/** Whether the chat is waiting on the person: an approval, an answer, or a failed run. */
export function chatNeedsUser(record: CanonicalChatRecord): boolean {
  return record.chat.attention !== "none";
}

export interface SidePanelChatGroups {
  needsYou: CanonicalChatRecord[];
  recent: CanonicalChatRecord[];
}

/** The side panel's two groups. Each keeps the order of `chats`, which the server sorts by activity. */
export function groupSidePanelChats(chats: Chats): SidePanelChatGroups {
  const groups: SidePanelChatGroups = { needsYou: [], recent: [] };
  for (const record of chats) {
    (chatNeedsUser(record) ? groups.needsYou : groups.recent).push(record);
  }
  return groups;
}

/** The chat of every agent whose status read has found one. Empty until the statuses are known. */
export function agentChatIds(statuses: Readonly<Record<string, { chatId: string | null }>>): string[] {
  const chatIds: string[] = [];
  for (const status of Object.values(statuses)) {
    if (status.chatId) chatIds.push(status.chatId);
  }
  return chatIds;
}

/** `chats` without the agents' own conversations, which belong to the Agents tab. */
export function withoutAgentChats(chats: Chats, agentChats: readonly string[]): Chats {
  if (agentChats.length === 0) return chats;
  const hidden: Record<string, true> = Object.create(null);
  for (const chatId of agentChats) hidden[chatId] = true;
  return chats.filter((record) => !hidden[record.chat.id]);
}

/**
 * What a search shows: the loaded chats whose title contains the query, then
 * the server's results (chats with a message that matches) not already listed.
 */
export function searchSidePanelChats(chats: Chats, query: string, results: Chats): CanonicalChatRecord[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const listed: Record<string, true> = Object.create(null);
  const rows: CanonicalChatRecord[] = [];
  const add = (record: CanonicalChatRecord) => {
    if (listed[record.chat.id]) return;
    listed[record.chat.id] = true;
    rows.push(record);
  };
  for (const record of chats) {
    if (record.chat.title.toLowerCase().includes(text)) add(record);
  }
  for (const record of results) add(record);
  return rows;
}
