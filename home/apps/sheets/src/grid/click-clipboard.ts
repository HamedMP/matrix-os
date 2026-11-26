/**
 * Cut, Copy and Paste started by a click (a ribbon button, a menu entry).
 *
 * The app runs in a sandboxed frame where the browser may refuse the async
 * clipboard. A click therefore first uses the browser's own copy command,
 * which needs no permission. When that is refused too, the cells stay marked
 * as copied and Paste takes them from there, so cut, copy and paste keep
 * working inside the workbook.
 *
 * Reading the clipboard waits for the browser. A paste writes where the owner
 * clicked: when the sheet, the selection, the workbook or the cell editor
 * changed while the browser was answering, it writes nothing.
 */

import { type ClipboardPayload, copySelection, pasteClipboard, pasteOwnCopy } from "./actions-clipboard";
import type { GridContext } from "./context";
import { commandClipboard, readSystemClipboard, writeSystemClipboard } from "./system-clipboard";

/** `system`: on the clipboard. `own`: kept for pasting in this window only. `nothing`: nothing to copy. */
export type ClickCopyOutcome = "system" | "own" | "nothing";
/**
 * `system`: pasted the clipboard. `own`: pasted the cells copied in this window.
 * `blocked`: neither was possible. `cancelled`: the destination changed while the clipboard was read; nothing was written.
 */
export type ClickPasteOutcome = "system" | "own" | "blocked" | "cancelled";

/** Copies or cuts the selection. */
export async function clickCopy(ctx: GridContext, cut: boolean): Promise<ClickCopyOutcome> {
  const payload: ClipboardPayload | null = copySelection(ctx, cut);
  if (payload === null) return "nothing";
  if (commandClipboard(payload)) return "system";
  return (await writeSystemClipboard(payload)) ? "system" : "own";
}

/** Pastes at the selection: the system clipboard, or else what was last copied or cut in this window. */
export async function clickPaste(ctx: GridContext): Promise<ClickPasteOutcome> {
  const unchanged = destinationCheck(ctx);
  const data = await readSystemClipboard();
  if (!unchanged()) return "cancelled";
  if (data !== null) {
    pasteClipboard(ctx, data);
    return "system";
  }
  return pasteOwnCopy(ctx) ? "own" : "blocked";
}

/** Remembers where a paste goes; the returned check is true while that is still where it would go. */
function destinationCheck(ctx: GridContext): () => boolean {
  const session = ctx.session;
  const workbook = session.workbook;
  const mark = session.editMark();
  const sheet = ctx.sheet;
  const selection = ctx.selection;
  const edit = ctx.store.getState().edit;
  return () =>
    session.workbook === workbook &&
    session.editMark() === mark &&
    ctx.sheet === sheet &&
    ctx.selection === selection &&
    ctx.store.getState().edit === edit;
}
