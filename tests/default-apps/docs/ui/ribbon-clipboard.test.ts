// @vitest-environment jsdom
/**
 * Ribbon Cut, Copy and Paste: the browser's own copy command first (so the
 * editor's copy and cut handlers run), the async clipboard as the fallback,
 * and, when the frame may use neither, the text kept for pasting in the same
 * document ("own"). "blocked" is left for a Paste with nothing copied here,
 * so the ribbon can point to the keyboard shortcut.
 */

import { describe, expect, it, vi } from "vitest";
import type { DocumentEditorController, PasteContent } from "../../../../home/apps/docs/src/editor/index";
import { MAX_PASTE_CHARACTERS } from "../../../../home/apps/docs/src/editor/paste";
import { copySelection, noteCopied, pasteText } from "../../../../home/apps/docs/src/ui/ribbon/clipboard";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { at as position, bodyParagraphs, caret, caretOf, mount, select } from "../editor/helpers";

const at = (offset: number) => ({ blockId: "b1", offset });

function fakeEditor(collapsed = false, selected = "Hello") {
  const inserted: string[] = [];
  const editor = {
    session: { getState: () => ({ documentKey: 1 }), onChange: () => () => undefined },
    getSelection: () => ({ anchor: at(0), focus: at(5), start: at(0), end: at(5), collapsed, backward: false }),
    setSelection: vi.fn(() => true),
    getSelectedText: () => selected,
    deleteSelection: vi.fn(() => true),
    focus: vi.fn(),
    // Records the pasted paragraphs, with "¶" for each paragraph break.
    paste: vi.fn((content: PasteContent) => {
      content.paragraphs.forEach((segments, index) => {
        if (index > 0) inserted.push("¶");
        if (segments.length > 0) inserted.push(segments.map((segment) => segment.text).join(""));
      });
      return true;
    }),
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

  it("copies a selection too large to paste back instead of cutting it", async () => {
    const big = "x".repeat(MAX_PASTE_CHARACTERS + 1);
    const { editor, raw } = fakeEditor(false, big);
    const execCommand = vi.fn(() => true);
    expect(await copySelection(editor, true, { execCommand, clipboard: null })).toBe("too-large");
    // The browser runs a copy, not a cut, so the editor's cut handler never deletes either.
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(execCommand).not.toHaveBeenCalledWith("cut");
    const writeText = vi.fn(async () => undefined);
    expect(await copySelection(editor, true, { execCommand: () => false, clipboard: { writeText, readText: vi.fn() } })).toBe("too-large");
    expect(writeText).toHaveBeenCalledWith(big);
    expect(raw.deleteSelection).not.toHaveBeenCalled();
  });

  it("refuses to paste text larger than it can insert whole, and leaves the document alone", async () => {
    const big = "x".repeat(MAX_PASTE_CHARACTERS + 1);
    const { editor, raw } = fakeEditor();
    expect(await pasteText(editor, { clipboard: { readText: async () => big, writeText: vi.fn() } })).toBe("too-large");
    // The same for a large text copied in this document while the clipboard was refused.
    const own = fakeEditor(false, big);
    noteCopied(own.editor);
    expect(await pasteText(own.editor, { clipboard: null })).toBe("too-large");
    expect(raw.paste).not.toHaveBeenCalled();
    expect(own.raw.paste).not.toHaveBeenCalled();
  });

  /** A clipboard whose write waits until the test lets it finish. */
  function slowClipboard() {
    let finish = () => undefined as void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    return { clipboard: { writeText, readText: vi.fn() }, finish: () => finish() };
  }

  it("keeps the text the owner selected while a ribbon Cut waited for the clipboard", async () => {
    const m = await mount({ paragraphs: ["Hello world"] });
    try {
      const [id] = bodyParagraphs(m.doc).map((block) => block.id);
      select(m, position(id!, 0), position(id!, 5));
      const slow = slowClipboard();
      const cutting = copySelection(m.editor, true, { execCommand: () => false, clipboard: slow.clipboard });
      // The owner selects "world" before the clipboard answers: the cut must not delete it.
      select(m, position(id!, 6), position(id!, 11));
      slow.finish();
      await cutting;
      expect(slow.clipboard.writeText).toHaveBeenCalledWith("Hello");
      expect(bodyParagraphs(m.doc).map((block) => block.text)).toEqual(["Hello world"]);
    } finally {
      m.unmount();
    }
  });

  it("keeps the document unchanged when it was edited while a ribbon Cut waited", async () => {
    const m = await mount({ paragraphs: ["Hello world"] });
    try {
      const [id] = bodyParagraphs(m.doc).map((block) => block.id);
      select(m, position(id!, 6), position(id!, 11));
      const slow = slowClipboard();
      const cutting = copySelection(m.editor, true, { execCommand: () => false, clipboard: slow.clipboard });
      // An edit before the selection shifts what the old offsets point at.
      m.session.apply([{ type: "insertText", at: position(id!, 0), text: "Oh " }]);
      m.editor.setSelection({ anchor: position(id!, 6), focus: position(id!, 11) });
      slow.finish();
      await cutting;
      expect(bodyParagraphs(m.doc).map((block) => block.text)).toEqual(["Oh Hello world"]);
    } finally {
      m.unmount();
    }
  });

  it("leaves another document alone when it opened while a ribbon Cut waited", async () => {
    const m = await mount({ paragraphs: ["Hello world"] });
    try {
      const [id] = bodyParagraphs(m.doc).map((block) => block.id);
      select(m, position(id!, 0), position(id!, 5));
      const slow = slowClipboard();
      const cutting = copySelection(m.editor, true, { execCommand: () => false, clipboard: slow.clipboard });
      const other = createDocx({ paragraphs: ["Other text"] });
      await m.session.adopt(other, { name: "Other", dirty: false });
      const [otherId] = bodyParagraphs(other).map((block) => block.id);
      m.editor.setSelection({ anchor: position(otherId!, 0), focus: position(otherId!, 5) });
      slow.finish();
      await cutting;
      expect(bodyParagraphs(other).map((block) => block.text)).toEqual(["Other text"]);
    } finally {
      m.unmount();
    }
  });

  it("does not paste into another document that opened while the clipboard was read", async () => {
    const m = await mount({ paragraphs: ["Hello world"] });
    try {
      const [id] = bodyParagraphs(m.doc).map((block) => block.id);
      m.editor.focus();
      caret(m, id!, 5);
      let answer = (_text: string) => undefined as void;
      const clipboard = { readText: vi.fn(() => new Promise<string>((resolve) => { answer = resolve; })), writeText: vi.fn() };
      const pasting = pasteText(m.editor, { clipboard });
      const other = createDocx({ paragraphs: ["Other text"] });
      await m.session.adopt(other, { name: "Other", dirty: false });
      answer("Pasted");
      expect(await pasting).toBe("nothing");
      expect(bodyParagraphs(other).map((block) => block.text)).toEqual(["Other text"]);
    } finally {
      m.unmount();
    }
  });

  it("does not paste text kept in another document that was open before", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = await mount({ paragraphs: ["Hello world"] });
    try {
      const [id] = bodyParagraphs(m.doc).map((block) => block.id);
      select(m, position(id!, 0), position(id!, 5));
      // The frame refuses the clipboard: the copy is kept for this document only.
      expect(await copySelection(m.editor, false, { execCommand: () => false, clipboard: null })).toBe("own");
      const other = createDocx({ paragraphs: ["Other text"] });
      await m.session.adopt(other, { name: "Other", dirty: false });
      const [otherId] = bodyParagraphs(other).map((block) => block.id);
      m.editor.focus();
      caret(m, otherId!, 5);
      // Nothing was copied in this document, so the ribbon points to the keyboard instead.
      expect(await pasteText(m.editor, { clipboard: null })).toBe("blocked");
      expect(bodyParagraphs(other).map((block) => block.text)).toEqual(["Other text"]);
      // A copy made in the new document is pasted as before.
      select(m, position(otherId!, 0), position(otherId!, 5));
      noteCopied(m.editor);
      caret(m, otherId!, 10);
      expect(await pasteText(m.editor, { clipboard: null })).toBe("own");
      expect(bodyParagraphs(other).map((block) => block.text)).toEqual(["Other textOther"]);
    } finally {
      m.unmount();
      warn.mockRestore();
    }
  });

  it("pastes several lines into the live document: each line lands after the one before, as Ctrl+V does", async () => {
    const m = await mount({ paragraphs: ["Hello world", "Last"] });
    try {
      const [first] = bodyParagraphs(m.doc).map((block) => block.id);
      // The ribbon refocuses the editor before pasting; focus it first so jsdom keeps the caret in place.
      m.editor.focus();
      caret(m, first!, 5);
      const clipboard = { readText: async () => "One two three\nSecond line\n\nFourth", writeText: vi.fn() };
      expect(await pasteText(m.editor, { clipboard })).toBe("done");
      expect(bodyParagraphs(m.doc).map((block) => block.text)).toEqual(["HelloOne two three", "Second line", "", "Fourth world", "Last"]);
      expect(caretOf(m)).toEqual({ blockId: bodyParagraphs(m.doc)[3]!.id, offset: 6 });
      // One undo step takes the whole paste back.
      m.editor.undo();
      expect(bodyParagraphs(m.doc).map((block) => block.text)).toEqual(["Hello world", "Last"]);
    } finally {
      m.unmount();
    }
  });
});
