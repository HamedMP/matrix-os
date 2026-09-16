import type { CanonicalChatRecord } from "@matrix-os/contracts";

/** Title and transcript snapshots have independent clocks. */
export function mergeCanonicalChatRecord(current: CanonicalChatRecord, incoming: CanonicalChatRecord): CanonicalChatRecord {
  if (current.chat.id !== incoming.chat.id) return incoming;
  const latest = incoming.chat.revision >= current.chat.revision ? incoming : current;
  const currentVersion = current.chat.titleVersion ?? 0;
  const incomingVersion = incoming.chat.titleVersion ?? 0;
  const title = incomingVersion > currentVersion ? incoming
    : incomingVersion < currentVersion ? current : latest;
  if (latest.chat.title === title.chat.title && latest.chat.titleVersion === title.chat.titleVersion) return latest;
  return { ...latest, chat: { ...latest.chat, title: title.chat.title, titleVersion: title.chat.titleVersion } };
}

export function compareCanonicalChatActivity(a: CanonicalChatRecord, b: CanonicalChatRecord): number {
  const left = a.chat.activityAt ?? a.chat.createdAt;
  const right = b.chat.activityAt ?? b.chat.createdAt;
  return right.localeCompare(left) || a.chat.id.localeCompare(b.chat.id);
}
