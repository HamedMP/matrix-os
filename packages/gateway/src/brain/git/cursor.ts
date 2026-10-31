/**
 * Git source adapter: the cursor text stored in brain_sync_cursors. Pure.
 *
 *   <sha>                      every window up to <sha> is applied, and <sha>
 *                              was the tip of the run that applied it
 *   <sha>><tip>                every window up to <sha> is applied; the run
 *                              stopped before its tip <tip>, and spec documents
 *                              may already hold their content at <tip>
 *   [<sha>]><tip>@<receiptId>  the run with that receipt is applying the
 *                              window after <sha> (after the root when <sha>
 *                              is empty) toward <tip>
 *
 * Shas are 40 or 64 lowercase hex. The in-progress form makes a window
 * exclusive to one run: its first batch moves the cursor to the run's token,
 * so a concurrent run's batch fails its compare-and-set before it writes
 * anything, and a later run takes over a crashed run's token the same way.
 */
import { BRAIN_RECEIPT_ID_PATTERN } from "../index.js";
import { GitSourceError } from "./types.js";

const SHA = "[0-9a-f]{40}|[0-9a-f]{64}";
const CURSOR_PATTERN = new RegExp(`^(${SHA})?(?:>(${SHA}))?(?:@(rcp_[0-9a-f]{32}))?$`);

export interface GitCursor {
  /** The last fully applied first-parent commit; null before the first window. */
  readonly position: string | null;
  /** The tip of the run that wrote the cursor, when it is not `position`. */
  readonly tip: string | null;
  /** The receipt of the run applying the next window, for an in-progress cursor. */
  readonly receiptId: string | null;
}

/** Null when the text is none of the three forms (an unknown cursor is treated as rewritten history). */
export function parseGitCursor(text: string): GitCursor | null {
  const match = CURSOR_PATTERN.exec(text);
  if (match === null) return null;
  const [, position = null, tip = null, receiptId = null] = match;
  if (receiptId === null ? position === null || tip === position : tip === null) return null;
  return { position, tip, receiptId };
}

/** The cursor a window's final batch commits: the window end, plus the tip when the run has not reached it. */
export function appliedCursor(windowEnd: string, tip: string): string {
  return windowEnd === tip ? windowEnd : `${windowEnd}>${tip}`;
}

/** The cursor every non-final batch of a window commits. */
export function inProgressCursor(windowStart: string | null, tip: string, receiptId: string): string {
  if (!BRAIN_RECEIPT_ID_PATTERN.test(receiptId)) throw new GitSourceError("internal_error");
  return `${windowStart ?? ""}>${tip}@${receiptId}`;
}
