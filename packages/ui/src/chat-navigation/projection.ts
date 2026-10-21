import type { CanonicalChatNavigationItem, CanonicalChatRecord } from "@matrix-os/contracts";
import { mergeChatReadState } from "../chat/read-state.js";
/** Both detail records and list summaries satisfy this display-only projection. */
export type ChatNavigationRecord = Pick<CanonicalChatNavigationItem, "chat" | "importSource" | "projectId" | "providerBinding" | "activeRun" | "latestSuccessfulCompletion"> & {
  readState?: CanonicalChatNavigationItem["readState"];
};
export function mergeChatNavigationRecord<T extends ChatNavigationRecord>(current: T, incoming: ChatNavigationRecord): T {
  const { id, title, titleVersion, activityAt, lifecycle, attention, revision, messageCount, userState, createdAt, updatedAt } = incoming.chat;
  const snapshot = incoming.chat.revision >= current.chat.revision ? { ...current, importSource: incoming.importSource ?? current.importSource, projectId: incoming.projectId,
    providerBinding: incoming.providerBinding ? { ...current.providerBinding, driverKind: incoming.providerBinding.driverKind } : undefined,
    activeRun: incoming.activeRun, latestSuccessfulCompletion: incoming.latestSuccessfulCompletion,
    chat: { ...current.chat, id, title, titleVersion, activityAt, lifecycle, attention, revision, messageCount, userState, createdAt, updatedAt } } : current;
  // Read choices and incoming reply sequences have clocks independent of Chat revision.
  const readSource = incoming.readState && (!current.readState || incoming.readState.version >= current.readState.version)
    ? incoming : current;
  const read = readSource.readState ? mergeChatReadState(snapshot, {
    ...readSource,
    readState: {
      ...readSource.readState,
      latestIncomingSeq: Math.max(current.readState?.latestIncomingSeq ?? 0, incoming.readState?.latestIncomingSeq ?? 0),
    },
  }) : snapshot;
  const source = (incoming.chat.titleVersion ?? 0) > (current.chat.titleVersion ?? 0) ? incoming
    : (incoming.chat.titleVersion ?? 0) < (current.chat.titleVersion ?? 0) ? current : read;
  return { ...read, chat: { ...read.chat, title: source.chat.title, titleVersion: source.chat.titleVersion } };
}
export function projectDetailNavigation(record: CanonicalChatRecord, current: CanonicalChatNavigationItem): CanonicalChatNavigationItem {
  const { chat, importSource, projectId, providerBinding, activeRun, latestSuccessfulCompletion, readState } = record;
  return mergeChatNavigationRecord(current, { chat, importSource, projectId, providerBinding: providerBinding ? { driverKind: providerBinding.driverKind } : undefined, activeRun, latestSuccessfulCompletion, readState });
}
