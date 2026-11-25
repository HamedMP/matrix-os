/**
 * Cut, Copy and Paste from the ribbon. The app runs in a sandboxed frame
 * where the async clipboard may be refused, so Cut and Copy first ask the
 * browser to run its own copy on the editor (whose copy handler writes the
 * selection, and whose cut handler deletes it through the session), and fall
 * back to `navigator.clipboard`. Paste can only read through
 * `navigator.clipboard`. Whatever the frame refuses, the text last copied or
 * cut in this document is kept, and Paste inserts it ("own"), so the three
 * commands keep working inside the document; the caller says that text from
 * other apps needs the keyboard shortcut.
 */

import type { TextPosition } from "../../../../_shared/office-engine/index";
import { type DocumentEditorController, parsePlainText } from "../../editor/index";

/** `own`: kept or pasted inside this document only. `blocked`: nothing could be pasted. */
export type ClipboardOutcome = "done" | "nothing" | "own" | "blocked";

/** The text last copied or cut in each open document. */
const ownCopies = new WeakMap<DocumentEditorController, string>();

/** Remembers the selected text as copied (the editor's own Ctrl+C and Ctrl+X call this). */
export function noteCopied(editor: DocumentEditorController): void {
  const text = editor.getSelectedText();
  if (text !== "") ownCopies.set(editor, text);
}

interface ClipboardEnv {
  execCommand?: (command: string) => boolean;
  clipboard?: Pick<Clipboard, "readText" | "writeText"> | null;
}

function defaultEnv(): ClipboardEnv {
  return {
    execCommand: typeof document !== "undefined" && typeof document.execCommand === "function" ? (command) => document.execCommand(command) : undefined,
    clipboard: typeof navigator !== "undefined" ? (navigator.clipboard ?? null) : null,
  };
}

const samePosition = (a: TextPosition, b: TextPosition) => a.blockId === b.blockId && a.offset === b.offset;

/**
 * Copies the selection, and with `cut` deletes it. A cut that has to wait for
 * the async clipboard deletes only when, once the write settled, the same
 * document is open, unchanged, with the same selection; otherwise the text
 * stays where it is and the cut acts as a copy.
 */
export async function copySelection(editor: DocumentEditorController, cut: boolean, env: ClipboardEnv = defaultEnv()): Promise<ClipboardOutcome> {
  const selection = editor.getSelection();
  if (selection === null || selection.collapsed) return "nothing";
  editor.setSelection({ anchor: selection.anchor, focus: selection.focus }, { focus: true });
  noteCopied(editor);
  try {
    // The browser's own copy runs the editor's handler with the full selection.
    if (env.execCommand?.(cut ? "cut" : "copy") === true) return "done";
  } catch (error) {
    console.warn("docs: the browser copy command failed", error instanceof Error ? error.name : error);
  }
  const { session } = editor;
  const documentKey = session.getState().documentKey;
  let edited = false;
  const stopWatching = cut ? session.onChange(() => { edited = true; }) : () => undefined;
  let outcome: ClipboardOutcome = "own";
  try {
    if (env.clipboard != null) {
      try {
        await env.clipboard.writeText(editor.getSelectedText());
        outcome = "done";
      } catch (error) {
        console.warn("docs: the clipboard refused the copy", error instanceof Error ? error.name : error);
      }
    }
  } finally {
    stopWatching();
  }
  if (!cut) return outcome;
  // The text is on the clipboard or kept for this document: the cut may now delete it, if it is still the one selected.
  const now = editor.getSelection();
  const unchanged = !edited && session.getState().documentKey === documentKey && now !== null && samePosition(now.anchor, selection.anchor) && samePosition(now.focus, selection.focus);
  if (unchanged) editor.deleteSelection();
  else console.warn("docs: the document or selection changed while cutting; the text was copied and left in place");
  return outcome;
}

async function readClipboard(env: ClipboardEnv): Promise<string | null> {
  if (env.clipboard == null) return null;
  try {
    return await env.clipboard.readText();
  } catch (error) {
    console.warn("docs: the clipboard refused the paste", error instanceof Error ? error.name : error);
    return null;
  }
}

/** Inserts the clipboard text at the selection, or else the text last copied or cut in this document. Nothing when another document opened meanwhile. */
export async function pasteText(editor: DocumentEditorController, env: ClipboardEnv = defaultEnv()): Promise<ClipboardOutcome> {
  const documentKey = editor.session.getState().documentKey;
  const system = await readClipboard(env);
  // Another document opened while the clipboard was read: the paste was meant for the one before.
  if (editor.session.getState().documentKey !== documentKey) return "nothing";
  const text = system ?? ownCopies.get(editor) ?? null;
  if (text === null) return "blocked";
  if (text === "") return "nothing";
  editor.focus();
  // The paste command Ctrl+V runs: one undo step, each line break starts a paragraph, and the caret
  // is carried through the engine from line to line instead of read back from the page in between.
  const changed = editor.paste(parsePlainText(text));
  if (!changed) return "nothing";
  return system === null ? "own" : "done";
}
