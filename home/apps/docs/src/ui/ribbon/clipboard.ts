/**
 * Cut, Copy and Paste from the ribbon. The app runs in a sandboxed frame
 * where the async clipboard may be refused, so Cut and Copy first ask the
 * browser to run its own copy on the editor (whose copy handler writes the
 * selection, and whose cut handler deletes it through the session), and fall
 * back to `navigator.clipboard`. Paste can only read through
 * `navigator.clipboard`; when the browser refuses, the caller tells the
 * owner to press Ctrl+V, which always works.
 */

import type { DocumentEditorController } from "../../editor/index";

export type ClipboardOutcome = "done" | "nothing" | "blocked";

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

/** Copies the selection, and with `cut` deletes it. */
export async function copySelection(editor: DocumentEditorController, cut: boolean, env: ClipboardEnv = defaultEnv()): Promise<ClipboardOutcome> {
  const selection = editor.getSelection();
  if (selection === null || selection.collapsed) return "nothing";
  editor.setSelection({ anchor: selection.anchor, focus: selection.focus }, { focus: true });
  try {
    // The browser's own copy runs the editor's handler with the full selection.
    if (env.execCommand?.(cut ? "cut" : "copy") === true) return "done";
  } catch (error) {
    console.warn("docs: the browser copy command failed", error instanceof Error ? error.name : error);
  }
  const text = editor.getSelectedText();
  if (env.clipboard == null) return "blocked";
  try {
    await env.clipboard.writeText(text);
  } catch (error) {
    console.warn("docs: the clipboard refused the copy", error instanceof Error ? error.name : error);
    return "blocked";
  }
  if (cut) editor.deleteSelection();
  return "done";
}

/** Inserts the clipboard text at the selection. */
export async function pasteText(editor: DocumentEditorController, env: ClipboardEnv = defaultEnv()): Promise<ClipboardOutcome> {
  if (env.clipboard == null) return "blocked";
  let text: string;
  try {
    text = await env.clipboard.readText();
  } catch (error) {
    console.warn("docs: the clipboard refused the paste", error instanceof Error ? error.name : error);
    return "blocked";
  }
  if (text === "") return "nothing";
  editor.focus();
  const lines = text.split(/\r\n|\r|\n/);
  // One undo step; each line break of the clipboard text starts a paragraph, as Ctrl+V does.
  return editor.session.batch(() => {
    let changed = false;
    lines.forEach((line, index) => {
      if (line !== "") changed = editor.insertText(line) || changed;
      if (index < lines.length - 1) changed = editor.insertParagraph() || changed;
    });
    return changed;
  }, { origin: "editor" })
    ? "done"
    : "nothing";
}
