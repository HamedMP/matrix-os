// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { type Mounted, OTHER, at, beforeInput, bodyParagraphs, caret, caretOf, domCaret, finalText, keydown, mount, paragraph, select, type } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

async function open(paragraphs: string[] = ["Hello world", "Second paragraph", "Third"], tracking = false): Promise<string[]> {
  m = await mount({ paragraphs }, { tracking });
  return bodyParagraphs(m.doc).map((block) => block.id);
}

/** The DOM selection must sit in connected nodes of the editing surface. */
function expectLiveCaret(expected: { blockId: string; offset: number }): void {
  const selection = document.getSelection()!;
  expect(selection.focusNode?.isConnected).toBe(true);
  expect(m.content.contains(selection.focusNode)).toBe(true);
  expect(selection.isCollapsed).toBe(true);
  expect(domCaret(m)).toEqual(expected);
  expect(caretOf(m)).toEqual(expected);
}

describe("caret restoration", () => {
  it("puts the caret back at the remapped position after the paragraph is rendered again", async () => {
    const [a] = await open();
    const before = m.editor.getBlockElement(a!);
    caret(m, a!, 5);
    type(m, "abc");
    // The paragraph was replaced by a new element, and the caret is in the new one.
    expect(m.editor.getBlockElement(a!)).not.toBe(before);
    expectLiveCaret(at(a!, 8));
    beforeInput(m, "deleteContentBackward");
    expectLiveCaret(at(a!, 7));
    beforeInput(m, "insertLineBreak");
    expectLiveCaret(at(a!, 8));
    beforeInput(m, "insertParagraph");
    expectLiveCaret(at(bodyParagraphs(m.doc)[1]!.id, 0));
  });

  it("keeps the elements of paragraphs that did not change", async () => {
    const [a, b, c] = await open();
    const untouched = [m.editor.getBlockElement(b!), m.editor.getBlockElement(c!)];
    caret(m, a!, 5);
    type(m, "x");
    beforeInput(m, "insertParagraph");
    expect([m.editor.getBlockElement(b!), m.editor.getBlockElement(c!)]).toEqual(untouched);
    expect(untouched.every((element) => element?.isConnected)).toBe(true);
  });

  it("keeps the caret between runs of different formatting and in tracked text", async () => {
    const [a] = await open(["Hello world"], true);
    caret(m, a!, 5);
    type(m, "X");
    expectLiveCaret(at(a!, 6));
    // Leave the insertion and type on the other side of unchanged text.
    caret(m, a!, 0);
    type(m, "Y");
    expectLiveCaret(at(a!, 1));
    caret(m, a!, paragraph(m.doc, a!).text.length);
    beforeInput(m, "deleteContentBackward");
    expectLiveCaret(at(a!, paragraph(m.doc, a!).text.length - 1));
  });

  it("moves the owner's caret with the text when someone else edits before it", async () => {
    const [a, b] = await open();
    caret(m, a!, 8);
    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "Well. " }], { origin: "agent", track: true, author: OTHER });
    expectLiveCaret(at(a!, 14));
    type(m, "*");
    expect(paragraph(m.doc, a!).text).toBe("Well. Hello wo*rld");
    // A change in another paragraph leaves the caret where it is.
    m.session.apply([{ type: "insertText", at: at(b!, 0), text: "!" }], { origin: "agent" });
    expectLiveCaret(at(a!, 15));
  });

  it("moves the caret to the nearest text when its paragraph is removed by someone else", async () => {
    const [a, b] = await open();
    caret(m, b!, 4);
    m.session.apply([{ type: "deleteRange", range: { start: at(a!, 5), end: at(b!, 16) } }], { origin: "agent" });
    expect(m.doc.getBlock(b!)).toBeNull();
    expectLiveCaret(at(a!, 5));
  });

  it("keeps a usable caret when revisions are accepted or rejected", async () => {
    const [a] = await open(["Hello world"], true);
    caret(m, a!, 5);
    type(m, " big");
    m.session.rejectRevisions("all");
    expect(finalText(m)).toBe("Hello world\n");
    const position = domCaret(m);
    expect(position?.blockId).toBe(a!);
    expect(position!.offset).toBeLessThanOrEqual(11);
    type(m, "!");
    expect(paragraph(m.doc, a!).text).toContain("!");
  });

  it("recovers when the document was changed behind the editor's back", async () => {
    const [a, b] = await open();
    caret(m, b!, 3);
    // Not through the session: the editor still shows the removed paragraph.
    m.doc.applyOps([{ type: "deleteParagraph", blockId: b! }], { track: false, author: OTHER, date: "2026-11-23T10:00:00Z" });
    expect(m.editor.getBlockElement(b!)).not.toBeNull();
    beforeInput(m, "insertText", { data: "x" });
    // The engine refused the stale position; the editor rendered the real document again.
    expect(finalText(m)).toBe("Hello world\nThird\n");
    expect(m.editor.getBlockElement(b!)).toBeNull();
    caret(m, a!, 0);
    type(m, "ok ");
    expect(finalText(m)).toBe("ok Hello world\nThird\n");
  });
});

describe("keeping the caret in view", () => {
  it("scrolls the editor just far enough to show the caret after an edit", async () => {
    const [a] = await open();
    const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
    m.host.getBoundingClientRect = () => rect(0, 400);
    let caretRect = rect(500, 520);
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () => caretRect;
    try {
      caret(m, a!, 5);
      // Placing the caret from the outside does not scroll; typing does.
      expect(m.host.scrollTop).toBe(0);
      type(m, "x");
      expect(m.host.scrollTop).toBe(144);
      caretRect = rect(100, 120);
      type(m, "y");
      expect(m.host.scrollTop).toBe(144);
      caretRect = rect(-30, -10);
      type(m, "z");
      expect(m.host.scrollTop).toBe(90);
    } finally {
      Range.prototype.getBoundingClientRect = original;
    }
  });
});

describe("undo and redo", () => {
  it("undoes a typed word in one step and returns the caret to where it was", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    type(m, "abc");
    type(m, " ");
    type(m, "de");
    expect(paragraph(m.doc, a!).text).toBe("Helloabc de world");
    keydown(m, "z", { ctrl: true });
    expect(paragraph(m.doc, a!).text).toBe("Helloabc  world");
    expectLiveCaret(at(a!, 9));
    keydown(m, "z", { ctrl: true });
    keydown(m, "z", { ctrl: true });
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expectLiveCaret(at(a!, 5));
    expect(m.session.getState()).toMatchObject({ canUndo: false, dirty: false });
  });

  it("starts a new undo step when the owner moves the caret between two bursts of typing", async () => {
    const [a] = await open();
    caret(m, a!, 0);
    type(m, "ab");
    // A click elsewhere in the same paragraph.
    const leaf = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(leaf, 13, leaf, 13);
    document.dispatchEvent(new Event("selectionchange"));
    type(m, "cd");
    expect(paragraph(m.doc, a!).text).toBe("abHello worldcd");
    m.editor.undo();
    expect(paragraph(m.doc, a!).text).toBe("abHello world");
    m.editor.undo();
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
  });

  it("redo restores the text and the caret after the edit", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "insertParagraph");
    const created = bodyParagraphs(m.doc)[1]!.id;
    type(m, "new");
    m.editor.undo();
    m.editor.undo();
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\nThird\n");
    expect(m.editor.getBlockElement(created)).toBeNull();
    expectLiveCaret(at(a!, 5));
    m.editor.redo();
    expect(m.editor.getBlockElement(created)).not.toBeNull();
    expectLiveCaret(at(created, 0));
    m.editor.redo();
    expect(finalText(m)).toBe("Hello\nnew world\nSecond paragraph\nThird\n");
    expectLiveCaret(at(created, 3));
  });

  it("undoes a selection replacement back to the selection", async () => {
    const [a] = await open();
    select(m, at(a!, 6), at(a!, 11));
    beforeInput(m, "insertText", { data: "you" });
    m.editor.undo();
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 6), end: at(a!, 11), collapsed: false });
  });

  it("undoes a word typed over a selection in one step", async () => {
    const [a] = await open();
    select(m, at(a!, 0), at(a!, 5));
    type(m, "Howdy");
    expect(paragraph(m.doc, a!).text).toBe("Howdy world");
    m.editor.undo();
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
    expect(m.session.getState().canUndo).toBe(false);
    m.editor.redo();
    expect(paragraph(m.doc, a!).text).toBe("Howdy world");
  });

  it("undoes tracked edits together with their revisions, and a paste as one step", async () => {
    const [a] = await open(["Hello world"], true);
    caret(m, a!, 5);
    beforeInput(m, "insertFromPaste", { transfer: { "text/plain": " one\ntwo\nthree" } });
    expect(bodyParagraphs(m.doc)).toHaveLength(3);
    expect(m.doc.listRevisions().length).toBeGreaterThan(0);
    m.editor.undo();
    expect(finalText(m)).toBe("Hello world\n");
    expect(m.doc.listRevisions()).toEqual([]);
    expect(m.host.querySelectorAll("[data-block-type='paragraph']")).toHaveLength(1);
    expect(m.session.getState().canUndo).toBe(false);
  });

  it("undo from outside the editor (a toolbar) also re-renders and places the caret", async () => {
    const [a] = await open();
    caret(m, a!, 11);
    type(m, "!");
    m.session.undo();
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world");
    expectLiveCaret(at(a!, 11));
  });
});
