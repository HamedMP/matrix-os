import type { QueryClient } from "@tanstack/react-query";
import {
  applyCanonicalChatContent,
  mergeCanonicalChatListRecord,
  preferCanonicalChatDetailSnapshot,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
} from "@matrix-os/contracts/canonical-chat-streaming";

import type { CanonicalChatInvalidation } from "@/lib/canonical-chat-events";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

const MAX_FENCED_CHATS = 100;

export interface CanonicalChatStreamFence {
  cursor?: number;
  revisions: Record<string, number>;
  deletedChatIds: string[];
  chatOrder: string[];
}

const EMPTY_FENCE: CanonicalChatStreamFence = {
  revisions: {},
  deletedChatIds: [],
  chatOrder: [],
};

export function readCanonicalChatStreamFence(
  queryClient: QueryClient,
  userId: string,
  computerKey: string,
): CanonicalChatStreamFence {
  return queryClient.getQueryData<CanonicalChatStreamFence>(
    mobileQueryKeys.canonicalChatStreamFence(userId, computerKey),
  ) ?? EMPTY_FENCE;
}

function recordFence(
  queryClient: QueryClient,
  userId: string,
  computerKey: string,
  event: Extract<CanonicalChatInvalidation, { type: "chat.changed" }>,
): void {
  const key = mobileQueryKeys.canonicalChatStreamFence(userId, computerKey);
  queryClient.setQueryData<CanonicalChatStreamFence>(key, (existing = EMPTY_FENCE) => {
    const chatOrder = [...existing.chatOrder.filter((id) => id !== event.chatId), event.chatId]
      .slice(-MAX_FENCED_CHATS);
    const retained = new Set(chatOrder);
    const revisions = Object.fromEntries(
      Object.entries(existing.revisions).filter(([id]) => retained.has(id)),
    );
    revisions[event.chatId] = Math.max(revisions[event.chatId] ?? 0, event.revision);
    const deleted = event.eventType === "chat.deleted"
      ? [...existing.deletedChatIds.filter((id) => id !== event.chatId), event.chatId]
      : existing.deletedChatIds.filter((id) => id !== event.chatId);
    return {
      cursor: Math.max(existing.cursor ?? 0, event.cursor),
      revisions,
      deletedChatIds: deleted.filter((id) => retained.has(id)).slice(-MAX_FENCED_CHATS),
      chatOrder,
    };
  });
}

function recordRefreshCursor(
  queryClient: QueryClient,
  userId: string,
  computerKey: string,
  cursor: number | undefined,
): void {
  if (cursor === undefined) return;
  const key = mobileQueryKeys.canonicalChatStreamFence(userId, computerKey);
  queryClient.setQueryData<CanonicalChatStreamFence>(key, (existing = EMPTY_FENCE) => ({
    ...existing,
    cursor: Math.max(existing.cursor ?? 0, cursor),
  }));
}

export function applyCanonicalChatEventToCache(options: {
  queryClient: QueryClient;
  userId: string;
  computerKey: string;
  activeChatId: string | null;
  event: CanonicalChatInvalidation;
}): { refreshList: boolean; refreshDetail: boolean } {
  const { queryClient, userId, computerKey, activeChatId, event } = options;
  if (event.type === "chat.full_refresh") {
    recordRefreshCursor(queryClient, userId, computerKey, event.cursor);
    return { refreshList: true, refreshDetail: activeChatId !== null };
  }
  recordFence(queryClient, userId, computerKey, event);
  const listKey = mobileQueryKeys.canonicalChats(userId, computerKey);
  const detailKey = mobileQueryKeys.canonicalChatDetail(userId, computerKey, event.chatId);

  if (event.eventType === "chat.deleted") {
    queryClient.setQueryData<CanonicalChatListResponse>(listKey, (current) => current && ({
      ...current,
      items: current.items.filter((item) => item.chat.id !== event.chatId),
    }));
    queryClient.removeQueries({ queryKey: detailKey, exact: true });
    return { refreshList: true, refreshDetail: false };
  }

  if (event.content) {
    queryClient.setQueryData<CanonicalChatListResponse>(listKey, (current) => (
      current ? mergeCanonicalChatListRecord(current, event.content!.content.record) : current
    ));
    if (event.chatId !== activeChatId) return { refreshList: false, refreshDetail: false };
    let needsRecovery = false;
    queryClient.setQueryData<CanonicalChatDetailResponse>(detailKey, (current) => {
      if (!current) {
        needsRecovery = true;
        return current;
      }
      const next = applyCanonicalChatContent(current, event.content!);
      if (!next) {
        needsRecovery = true;
        return current;
      }
      return next;
    });
    return { refreshList: false, refreshDetail: needsRecovery };
  }

  const hotContentEvent = event.eventType === "run.message" || event.eventType === "run.activity";
  return {
    refreshList: event.eventType === "chat.created" || !hotContentEvent,
    refreshDetail: event.chatId === activeChatId,
  };
}

export function reconcileCanonicalChatDetailResponse(options: {
  queryClient: QueryClient;
  userId: string;
  computerKey: string;
  chatId: string;
  incoming: CanonicalChatDetailResponse;
}): CanonicalChatDetailResponse | undefined {
  const { queryClient, userId, computerKey, chatId, incoming } = options;
  const latestFence = readCanonicalChatStreamFence(queryClient, userId, computerKey);
  const current = queryClient.getQueryData<CanonicalChatDetailResponse>(
    mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId),
  );
  return preferCanonicalChatDetailSnapshot(current, incoming, latestFence.revisions[chatId] ?? 0);
}

export function reconcileCanonicalChatListResponse(options: {
  queryClient: QueryClient;
  userId: string;
  computerKey: string;
  requestFence: CanonicalChatStreamFence;
  incoming: CanonicalChatListResponse;
}): CanonicalChatListResponse {
  const { queryClient, userId, computerKey } = options;
  const latestFence = readCanonicalChatStreamFence(queryClient, userId, computerKey);
  const deleted = new Set(latestFence.deletedChatIds);
  let next: CanonicalChatListResponse = {
    ...options.incoming,
    items: options.incoming.items.filter((item) => !deleted.has(item.chat.id)),
  };
  const current = queryClient.getQueryData<CanonicalChatListResponse>(
    mobileQueryKeys.canonicalChats(userId, computerKey),
  );
  const streamAdvancedDuringRequest = (latestFence.cursor ?? 0) !== (options.requestFence.cursor ?? 0);
  const incomingIds = new Set(next.items.map((record) => record.chat.id));
  for (const record of current?.items ?? []) {
    if (!deleted.has(record.chat.id)
      && (streamAdvancedDuringRequest || incomingIds.has(record.chat.id))) {
      next = mergeCanonicalChatListRecord(next, record);
    }
  }
  return next;
}
