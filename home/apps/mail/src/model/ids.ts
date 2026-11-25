/**
 * Keys for threads and thread lists.
 *
 * Thread ids are unique only inside one account, so the store keys every
 * thread by account and thread. Keys are opaque: build them with these
 * helpers and never parse them; the parts are kept next to the key wherever
 * they are needed.
 */
import type { MailFolderRole } from "../../../_shared/office-accounts/types/mail";

/** Opaque key of one thread in one account. */
export type ThreadKey = string;
/** Opaque key of one thread list (a folder, the unified inbox or a search). */
export type ViewKey = string;

const SEPARATOR = "\u001f";

export function threadKey(accountId: string, threadId: string): ThreadKey {
  return `${accountId}${SEPARATOR}${threadId}`;
}

export type UnifiedRole = Exclude<MailFolderRole, "custom">;

/** What a thread list shows. */
export type ViewDescriptor =
  /** The folder with this role in every account, merged newest first. */
  | { kind: "unified"; role: UnifiedRole }
  | { kind: "folder"; accountId: string; folderId: string }
  | { kind: "search"; query: string };

export const UNIFIED_INBOX: ViewDescriptor = Object.freeze({ kind: "unified", role: "inbox" }) as ViewDescriptor;

export function viewKeyOf(descriptor: ViewDescriptor): ViewKey {
  switch (descriptor.kind) {
    case "unified":
      return `unified${SEPARATOR}${descriptor.role}`;
    case "folder":
      return `folder${SEPARATOR}${descriptor.accountId}${SEPARATOR}${descriptor.folderId}`;
    case "search":
      return `search${SEPARATOR}${descriptor.query}`;
  }
}

let localCounter = 0;

/** A process-unique id for local objects (drafts, triage operations). */
export function localId(prefix: string): string {
  localCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${localCounter.toString(36)}`;
}
