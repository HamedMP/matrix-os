/**
 * Ribbon Cut, Copy and Paste: the browser's own copy command first (so the
 * editor's copy and cut handlers run), the async clipboard as the fallback,
 * and, when the frame may use neither, the text kept for pasting in the same
 * document ("own"). "blocked" is left for a Paste with nothing copied here,
 * so the ribbon can point to the keyboard shortcut.
 */

import { describe, expect, it, vi } from "vitest";
import type { DocumentEditorController } from "../../../../home/apps/docs/src/editor/index";
import { copySelection, noteCopied, pasteText } from "../../../../home/apps/docs/src/ui/ribbon/clipboard";

const at = (offset: number) => ({ blockId: "b1", offset });

function fakeEditor(collapsed = false) {
  const inserted: string[] = [];
  const editor = {
    getSelection: () => ({ anchor: at(0), focus: at(5), start: at(0), end: at(5), collapsed, backward: false }),
    setSelection: vi.fn(() => true),
    getSelectedText: () => "Hello",
    deleteSelection: vi.fn(() => true),
    focus: vi.fn(),
    insertText: vi.fn((text: string) => {
      inserted.push(text);
      return true;
    }),
    insertParagraph: vi.fn(() => {
      inserted.push("¶");
      return true;
    }),
    session: { batch: <T,>(fn: () => T) => fn() },
  };
  return { editor: editor as unknown as DocumentEditorController, raw: editor, inserted };
}

describe("ribbon clipboard", () => {
  it("uses the browser copy command on the editor selection when it is allowed", async () => {
    const { editor, raw } = fakeEditor();
    const execCommand = vi.fn(() => true);
    const writeText = vi.fn();
    expect(await copySelection(editor, true, { execCommand, clipboard: { writeText, readText: vi.fn() } })).toBe("done");
    expect(execCommand).toHaveBeenCalledWith("cut");
    expect(raw.setSelection).toHaveBeenCalledWith({ anchor: at(0), focus: at(5) }, { focus: true });
    expect(writeText).not.toHaveBeenCalled();
    // The editor's own cut handler deletes; the ribbon does not delete twice.
    expect(raw.deleteSelection).not.toHaveBeenCalled();
  });

  it("falls back to the async clipboard and deletes on cut only after the write succeeded", async () => {
    const { editor, raw } = fakeEditor();
    const writeText = vi.fn(async () => undefined);
    expect(await copySelection(editor, true, { execCommand: () => false, clipboard: { writeText, readText: vi.fn() } })).toBe("done");
    expect(writeText).toHaveBeenCalledWith("Hello");
    expect(raw.deleteSelection).toHaveBeenCalledTimes(1);

  });

  it("keeps a copy or a cut for pasting in this document when the frame may not use the clipboard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refusing = { execCommand: () => false, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))), readText: vi.fn(async () => Promise.reject(new Error("denied"))) } };
    const cut = fakeEditor();
    expect(await copySelection(cut.editor, true, refusing)).toBe("own");
    // The text is kept, so the cut may delete it.
    expect(cut.raw.deleteSelection).toHaveBeenCalledTimes(1);
    expect(await pasteText(cut.editor, refusing)).toBe("own");
    expect(cut.inserted).toEqual(["Hello"]);

    const copied = fakeEditor();
    expect(await copySelection(copied.editor, false, { execCommand: () => false, clipboard: null })).toBe("own");
    expect(copied.raw.deleteSelection).not.toHaveBeenCalled();
    expect(await pasteText(copied.editor, { clipboard: null })).toBe("own");
    expect(copied.inserted).toEqual(["Hello"]);
    warn.mockRestore();
  });

  it("remembers what the keyboard copied, for a later Paste from the ribbon", async () => {
    const { editor, inserted } = fakeEditor();
    noteCopied(editor);
    expect(await pasteText(editor, { clipboard: null })).toBe("own");
    expect(inserted).toEqual(["Hello"]);
  });

  it("does nothing without a selection", async () => {
    const { editor } = fakeEditor(true);
    expect(await copySelection(editor, false, { execCommand: () => true, clipboard: null })).toBe("nothing");
  });

  it("pastes clipboard lines as paragraphs, and reports a refused read", async () => {
    const { editor, inserted } = fakeEditor();
    expect(await pasteText(editor, { clipboard: { readText: async () => "One\r\nTwo\n\nThree", writeText: vi.fn() } })).toBe("done");
    expect(inserted).toEqual(["One", "¶", "Two", "¶", "¶", "Three"]);

    // Nothing was copied in this document: the ribbon can only point to the keyboard.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await pasteText(editor, { clipboard: { readText: async () => Promise.reject(new Error("denied")), writeText: vi.fn() } })).toBe("blocked");
    expect(await pasteText(editor, { clipboard: null })).toBe("blocked");
    warn.mockRestore();
  });
});
