/**
 * "Save" in the unsaved-changes question: saves the document the way its
 * source saves (a write to the home, or a download for a document from the
 * computer) and says whether the app may now leave it.
 */

import type { DocumentSession } from "../session/index";

export type LeaveSaveOutcome =
  /** Saved (or nothing to save): go ahead. */
  | { status: "saved" }
  /** A new document without a place in the home: ask where first. */
  | { status: "needs-path" }
  /** Not saved; the message is safe to show. The document stays open. */
  | { status: "failed"; message: string };

export const CONFLICT_MESSAGE = "This file changed elsewhere since you opened it, so your version was not written. Save a copy, or discard your changes.";

export async function saveForLeave(session: DocumentSession): Promise<LeaveSaveOutcome> {
  const state = session.getState();
  if (state.source === "matrix" && state.path === null) return { status: "needs-path" };
  if (state.conflict !== null) return { status: "failed", message: CONFLICT_MESSAGE };
  const result = await session.save();
  switch (result.status) {
    case "saved":
    case "downloaded":
      return { status: "saved" };
    case "conflict":
      return { status: "failed", message: CONFLICT_MESSAGE };
    case "error":
      return { status: "failed", message: result.error.message };
    default:
      return result.reason === "no_path" ? { status: "needs-path" } : { status: "saved" };
  }
}
