/**
 * Cut, Copy and Paste started by a click (a ribbon button, a menu entry).
 *
 * The app runs in a sandboxed frame where the browser may refuse the async
 * clipboard. A click therefore first uses the browser's own copy command,
 * which needs no permission. When that is refused too, the cells stay marked
 * as copied and Paste takes them from there, so cut, copy and paste keep
 * working inside the workbook.
 */

import { type ClipboardPayload, copySelection, pasteClipboard, pasteOwnCopy } from "./actions-clipboard";
import type { GridContext } from "./context";
import { commandClipboard, readSystemClipboard, writeSystemClipboard } from "./system-clipboard";

/** `system`: on the clipboard. `own`: kept for pasting in this window only. `nothing`: nothing to copy. */
export type ClickCopyOutcome = "system" | "own" | "nothing";
/** `system`: pasted the clipboard. `own`: pasted the cells copied in this window. `blocked`: neither was possible. */
export type ClickPasteOutcome = "system" | "own" | "blocked";

/** Copies or cuts the selection. */
export async function clickCopy(ctx: GridContext, cut: boolean): Promise<ClickCopyOutcome> {
  const payload: ClipboardPayload | null = copySelection(ctx, cut);
  if (payload === null) return "nothing";
  if (commandClipboard(payload)) return "system";
  return (await writeSystemClipboard(payload)) ? "system" : "own";
}

/** Pastes at the selection: the system clipboard, or else what was last copied or cut in this window. */
export async function clickPaste(ctx: GridContext): Promise<ClickPasteOutcome> {
  const data = await readSystemClipboard();
  if (data !== null) {
    pasteClipboard(ctx, data);
    return "system";
  }
  return pasteOwnCopy(ctx) ? "own" : "blocked";
}
