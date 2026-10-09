import type { CanonicalUpdateChatReadStateRequest } from "@matrix-os/contracts";
import type { ChatNavigationRecord } from "../chat-navigation/projection.js";

export function isChatUnread(record: ChatNavigationRecord): boolean {
  return record.readState?.unread ?? record.latestSuccessfulCompletion?.unacknowledged ?? false;
}

export function chatReadAction(record: ChatNavigationRecord): CanonicalUpdateChatReadStateRequest {
  return isChatUnread(record)
    ? { type: "mark_read", throughSeq: record.readState?.latestIncomingSeq ?? record.chat.messageCount, baseVersion: record.readState?.version ?? 0 }
    : { type: "mark_unread" };
}

// Read updates do not change the Chat revision or ordering. Apply only the
// versioned read projection, preserving newer transcript/project/title data.
export function mergeChatReadState<T extends ChatNavigationRecord>(current: T, response: ChatNavigationRecord): T {
  if (current.chat.id !== response.chat.id || !response.readState
    || (current.readState?.version ?? -1) > response.readState.version) return current;
  const latestIncomingSeq = Math.max(current.readState?.latestIncomingSeq ?? 0, response.readState.latestIncomingSeq);
  const state = response.readState;
  return { ...current, readState: {
    ...state, latestIncomingSeq, unread: state.markedUnread || latestIncomingSeq > state.readThroughSeq,
  } };
}
