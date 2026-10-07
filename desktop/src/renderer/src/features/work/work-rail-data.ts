import { mergeCanonicalChatRecord } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import type { CanonicalChatTitleProjection } from "./WorkSurfaceRuntime";

const MAX_CHAT_PAGES = 10;

export function applyProjectedChats(
  records: CanonicalChatRecord[],
  projections: CanonicalChatTitleProjection[] | undefined,
): CanonicalChatRecord[] {
  if (!projections?.length) return records;
  return records.map((record) => {
    const projection = projections.find((candidate) => candidate.chatId === record.chat.id);
    if (!projection || ((record.chat.titleVersion ?? 0) === (projection.titleVersion ?? 0)
      && record.chat.revision >= projection.revision)) return record;
    return mergeCanonicalChatRecord(record, {
      ...record,
      chat: { ...record.chat, title: projection.title, titleVersion: projection.titleVersion, revision: projection.revision },
    });
  });
}


export async function loadWorkRailChats(client: CanonicalChatClient, unreadOnly = false, projectId?: string): Promise<CanonicalChatRecord[]> {
  const records: CanonicalChatRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHAT_PAGES; page += 1) {
    const response = await client.list({ ...(projectId ? {projectId} : {}), ...(unreadOnly ? { unreadOnly: true } : {}), limit: 100, conversationKind: "all", ...(cursor ? { cursor } : {}) });
    records.push(...response.items);
    if (!response.nextCursor || response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }
  return records;
}
