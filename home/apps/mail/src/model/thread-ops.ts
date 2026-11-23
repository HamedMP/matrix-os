/**
 * Pure per-thread triage logic: which provider change a triage action means
 * for one thread, what that change does to the cached summary, how to reverse
 * it, and whether a thread belongs in a list afterwards.
 */
import {
  archiveChange,
  moveChange,
  trashChange,
  type MailFolder,
  type MailProviderId,
  type ThreadChange,
  type ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";
import type { ViewDescriptor } from "./ids";
import type { TriageKind } from "./types";

/** The summary as it will look once the provider has applied the change. */
export function applyChangeToSummary(summary: ThreadSummary, change: ThreadChange, provider: MailProviderId): ThreadSummary {
  let folderIds = summary.folderIds;
  if (provider === "outlook" && change.restore) {
    const removed = new Set(change.removeFolders ?? []);
    folderIds = [...new Set([...(change.addFolders ?? []), ...folderIds.filter((id) => !removed.has(id))])];
  } else if (provider === "outlook") {
    if (change.addFolders?.length) folderIds = [change.addFolders[0]];
  } else if (change.addFolders?.length || change.removeFolders?.length) {
    const removed = new Set(change.removeFolders ?? []);
    const next = folderIds.filter((id) => !removed.has(id));
    for (const id of change.addFolders ?? []) if (!next.includes(id)) next.push(id);
    folderIds = next;
  }
  return {
    ...summary,
    folderIds,
    unread: change.read === undefined ? summary.unread : !change.read,
    flagged: change.flagged === undefined ? summary.flagged : change.flagged,
  };
}

/** The change that puts `before` back after `change` was applied to it. */
export function inverseChange(before: ThreadSummary, change: ThreadChange, provider: MailProviderId): ThreadChange {
  const inverse: ThreadChange = {};
  if (provider === "outlook") {
    // Messages of one conversation can sit in several folders; the provider
    // remembers each moved message's folder and `restore` sends it back there.
    const target = change.addFolders?.[0];
    const previous = target ? before.folderIds.filter((id) => id !== target) : [];
    if (target && previous.length) {
      inverse.addFolders = previous;
      inverse.removeFolders = [target];
      inverse.restore = true;
    }
  } else {
    const add = (change.removeFolders ?? []).filter((id) => before.folderIds.includes(id));
    const remove = (change.addFolders ?? []).filter((id) => !before.folderIds.includes(id));
    if (add.length) inverse.addFolders = add;
    if (remove.length) inverse.removeFolders = remove;
  }
  if (change.read !== undefined) inverse.read = !before.unread;
  if (change.flagged !== undefined) inverse.flagged = before.flagged;
  return inverse;
}

export interface TriageContext {
  folders: readonly MailFolder[];
  provider: MailProviderId;
  /** The real folder the owner is looking at, when there is one. */
  fromFolderId?: string;
  /** The target of a move. */
  toFolderId?: string;
}

function roleId(folders: readonly MailFolder[], role: MailFolder["role"]): string | undefined {
  return folders.find((folder) => folder.role === role && !folder.virtual)?.id;
}

/**
 * The real folder the thread is leaving. Outside a real folder view an Outlook
 * conversation has no single source (its messages can sit in Inbox, Sent Items
 * and more), so none is guessed and the change applies to the whole thread.
 */
function sourceFolder(summary: ThreadSummary, ctx: TriageContext): string | undefined {
  const viewed = ctx.fromFolderId;
  if (viewed && summary.folderIds.includes(viewed) && !ctx.folders.find((f) => f.id === viewed)?.virtual) return viewed;
  if (ctx.provider === "outlook") return undefined;
  const inbox = roleId(ctx.folders, "inbox");
  return inbox && summary.folderIds.includes(inbox) ? inbox : undefined;
}

/**
 * The provider change one triage kind means for one thread. Throws a
 * `ProviderError("not_supported")` when the account lacks the folder and a
 * `RangeError` for an unknown or virtual move target. Snooze is local and has
 * no provider change.
 */
export function triageChangeFor(kind: Exclude<TriageKind, "snooze" | "unsnooze" | "undo">, summary: ThreadSummary, ctx: TriageContext): ThreadChange {
  switch (kind) {
    case "archive":
      return archiveChange(ctx.folders);
    case "trash":
      return trashChange(ctx.folders, sourceFolder(summary, ctx));
    case "move": {
      const target = ctx.folders.find((folder) => folder.id === ctx.toFolderId);
      if (!target || target.virtual) throw new RangeError("Unknown move target");
      const from = sourceFolder(summary, ctx);
      return from && from !== target.id ? moveChange(from, target.id) : { addFolders: [target.id] };
    }
    case "markRead":
      return { read: true };
    case "markUnread":
      return { read: false };
    case "flag":
      return { flagged: true };
    case "unflag":
      return { flagged: false };
  }
}

function belongsToFolder(folder: MailFolder | undefined, folderId: string, summary: ThreadSummary, folders: readonly MailFolder[]): boolean {
  if (!folder) return summary.folderIds.includes(folderId);
  if (!folder.virtual) return summary.folderIds.includes(folder.id);
  if (folder.role === "starred") return summary.flagged;
  if (folder.role === "archive") {
    const excluded = ["inbox", "trash", "spam"].map((role) => roleId(folders, role as MailFolder["role"]));
    return !excluded.some((id) => id !== undefined && summary.folderIds.includes(id));
  }
  return true;
}

/**
 * Whether the summary belongs in a list. `folders` are the folders of the
 * summary's own account. Search lists keep whatever the provider returned.
 */
export function belongsToView(descriptor: ViewDescriptor, summary: ThreadSummary, folders: readonly MailFolder[] | undefined): boolean {
  switch (descriptor.kind) {
    case "search":
      return true;
    case "folder": {
      if (descriptor.accountId !== summary.accountId) return false;
      const list = folders ?? [];
      return belongsToFolder(list.find((f) => f.id === descriptor.folderId), descriptor.folderId, summary, list);
    }
    case "unified": {
      const list = folders ?? [];
      const folder = list.find((f) => f.role === descriptor.role);
      return folder ? belongsToFolder(folder, folder.id, summary, list) : false;
    }
  }
}

