/**
 * Dragging conversations onto folders. The payload is a JSON list of thread
 * keys under a private media type; a drop only ever triggers the same triage
 * the toolbar offers (move, archive, trash, flag), never a send or a delete.
 */
import type { MailFolder } from "../../../_shared/office-accounts/types/mail";
import type { MailState, MailStore, ThreadKey } from "../model";

export const THREAD_DRAG_TYPE = "application/x-matrix-mail-threads";
/** Upper bound on keys read from one drop. */
export const MAX_DRAG_KEYS = 500;

export function encodeThreadDrag(keys: readonly ThreadKey[]): string {
  return JSON.stringify({ keys: keys.slice(0, MAX_DRAG_KEYS) });
}

export function decodeThreadDrag(payload: string): ThreadKey[] {
  if (!payload || payload.length > 200_000) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) return [];
  return (keys as string[]).slice(0, MAX_DRAG_KEYS);
}

export type DropAction =
  | { kind: "move"; folderId: string }
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "flag" }
  | { kind: "none" };

const NONE: DropAction = Object.freeze({ kind: "none" }) as DropAction;

/** What dropping `keys` on `folder` of `accountId` does, or `none` when it is not a valid target. */
export function dropActionFor(state: MailState, accountId: string, folder: MailFolder, keys: readonly ThreadKey[]): DropAction {
  const summaries = keys.map((key) => state.threads[key]).filter(Boolean);
  if (summaries.length === 0 || summaries.length !== keys.length) return NONE;
  if (summaries.some((summary) => summary.accountId !== accountId)) return NONE;
  switch (folder.role) {
    case "starred":
      return { kind: "flag" };
    case "trash":
      return { kind: "trash" };
    case "archive":
      return { kind: "archive" };
    case "drafts":
    case "sent":
      return NONE;
    default:
      if (folder.virtual) return NONE;
      if (summaries.every((summary) => summary.folderIds.includes(folder.id))) return NONE;
      return { kind: "move", folderId: folder.id };
  }
}

/** Carries out a drop. Resolves true when the provider accepted it. */
export async function performDrop(store: MailStore, action: DropAction, keys: ThreadKey[]): Promise<boolean> {
  switch (action.kind) {
    case "move":
      return store.moveTo(action.folderId, keys);
    case "archive":
      return store.archive(keys);
    case "trash":
      return store.trash(keys);
    case "flag":
      return store.setFlag(true, keys);
    case "none":
      return false;
  }
}
