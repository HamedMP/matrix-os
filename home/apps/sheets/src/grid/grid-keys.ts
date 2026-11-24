/** Keyboard and clipboard events of the grid surface and of the text inputs, turned into actions. */

import { copySelection, pasteClipboard } from "./actions-clipboard";
import { editorKey, updateEditText } from "./actions-edit";
import { runGridCommand } from "./commands";
import type { GridContext } from "./context";
import { type GridCommand, gridKeyCommand, isCompositionKey, keyInputOf } from "./keymap";

/** Commands that change the workbook, refused when the grid is read-only. */
const CHANGING: ReadonlySet<GridCommand["type"]> = new Set(["edit", "clear", "undo", "redo", "fill", "format"]);

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** 229 while an input method handles the key. */
  keyCode?: number;
  /** True between the start and the end of a composition. */
  isComposing?: boolean;
}

/** A key that belongs to an input method conversion in progress: it must reach the text input untouched. */
function composing(event: KeyLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

interface ClipboardLike {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  clipboardData: { setData(format: string, data: string): void; getData(format: string): string };
  preventDefault(): void;
}

/** A key in the in-cell editor or the formula bar. True when it was handled. */
export function handleEditorKey(ctx: GridContext, event: KeyLike): boolean {
  const edit = ctx.store.getState().edit;
  if (edit === null || composing(event)) return false;
  if (event.key === "Enter" && event.altKey) {
    // Alt+Enter: a line break inside the cell.
    const text = `${edit.text.slice(0, edit.selectionStart)}\n${edit.text.slice(edit.selectionEnd)}`;
    updateEditText(ctx, text, edit.selectionStart + 1, edit.selectionStart + 1);
    return true;
  }
  return editorKey(ctx, keyInputOf(event));
}

/** A key on the grid itself. True when it was handled and the default action must not run. */
export function handleGridKey(ctx: GridContext, event: KeyLike, readOnly: boolean): boolean {
  // The focus is on the grid while a formula points at cells: the key still belongs to the editor.
  if (ctx.store.getState().edit !== null) return composing(event) ? false : editorKey(ctx, keyInputOf(event));
  if (isCompositionKey(event.key, event.keyCode) || event.isComposing === true) {
    // A dead key or an input method: open an empty editor and leave the key to the browser, which composes the character into it.
    if (!readOnly) runGridCommand(ctx, { type: "edit", initial: "" });
    return false;
  }
  const command = gridKeyCommand(keyInputOf(event));
  if (command === null) return false;
  if (!(readOnly && CHANGING.has(command.type))) runGridCommand(ctx, command);
  return true;
}

function onGridItself(ctx: GridContext, event: ClipboardLike): boolean {
  return ctx.store.getState().edit === null && event.target === event.currentTarget;
}

/** Ctrl+C and Ctrl+X on the grid: tab-separated text and an HTML table go to the clipboard. */
export function handleCopy(ctx: GridContext, event: ClipboardLike, cut: boolean, readOnly: boolean): void {
  if (!onGridItself(ctx, event) || (cut && readOnly)) return;
  const payload = copySelection(ctx, cut);
  if (payload === null) return;
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData("text/html", payload.html);
  event.preventDefault();
}

/** Ctrl+V on the grid. */
export function handlePaste(ctx: GridContext, event: ClipboardLike, readOnly: boolean): void {
  if (!onGridItself(ctx, event) || readOnly) return;
  event.preventDefault();
  pasteClipboard(ctx, { text: event.clipboardData.getData("text/plain"), html: event.clipboardData.getData("text/html") });
}
