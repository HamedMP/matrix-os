// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DATE, type Mounted, OTHER, at, beforeInput, bodyParagraphs, bodyTables, caret, caretOf, cellParagraphs, domCaret, finalText, keydown, mount, originalText, paragraph, select, type } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

async function open(paragraphs: string[] = ["Hello world", "Second paragraph", "Third"]): Promise<string[]> {
  m = await mount({ paragraphs });
  return bodyParagraphs(m.doc).map((block) => block.id);
}

function shownText(blockId: string): string {
  return m.editor.getBlockElement(blockId)?.textContent ?? "";
}

/** Two paragraphs, each with a pending deletion by another author: "brave " and "hidden ". */
async function openWithHiddenDeletions(): Promise<string[]> {
  const doc = createDocx({ paragraphs: ["Hello brave world", "Second hidden part", "Third"] });
  const [a, b] = bodyParagraphs(doc).map((block) => block.id);
  doc.applyOps(
    [
      { type: "deleteRange", range: { start: at(b!, 7), end: at(b!, 14) } },
      { type: "deleteRange", range: { start: at(a!, 6), end: at(a!, 12) } },
    ],
    { track: true, author: OTHER, date: DATE },
  );
  m = await mount({ doc }, { viewMode: "final" });
  return [a!, b!];
}

describe("input with tracking off in the final view: hidden pending deletions survive", () => {
  it("deletes a selection across paragraphs without removing the deletions it hides", async () => {
    const [a, b] = await openWithHiddenDeletions();
    expect(finalText(m)).toBe("Hello world\nSecond part\nThird\n");
    // "Hel|lo world" to "Second pa|rt", as shown.
    select(m, at(a!, 3), at(b!, 16));
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe("Helrt\nThird\n");
    // Both pending deletions are still there to accept or reject.
    expect(originalText(m)).toBe("Helbrave hidden rt\nThird\n");
    expect(m.doc.listRevisions().every((revision) => revision.kind === "delete")).toBe(true);
  });

  it("types over a selection across paragraphs without removing the deletions it hides", async () => {
    const [a, b] = await openWithHiddenDeletions();
    select(m, at(a!, 3), at(b!, 16));
    type(m, "p");
    expect(finalText(m)).toBe("Helprt\nThird\n");
    expect(originalText(m)).toContain("brave ");
    expect(originalText(m)).toContain("hidden ");
  });
});

describe("input with tracking off: every beforeinput becomes engine operations", () => {
  it("insertText inserts at the caret, cancels the browser's own edit and leaves no revision", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    const event = beforeInput(m, "insertText", { data: "," });
    expect(event.defaultPrevented).toBe(true);
    expect(paragraph(m.doc, a!).text).toBe("Hello, world");
    expect(m.doc.listRevisions()).toEqual([]);
    expect(caretOf(m)).toEqual(at(a!, 6));
    expect(domCaret(m)).toEqual(at(a!, 6));
    expect(shownText(a!)).toBe("Hello, world");
    expect(m.session.getState().dirty).toBe(true);
  });

  it("insertText replaces a selection inside one paragraph and across paragraphs", async () => {
    const [a, b] = await open();
    select(m, at(a!, 6), at(a!, 11));
    type(m, "you");
    expect(paragraph(m.doc, a!).text).toBe("Hello you");
    expect(caretOf(m)).toEqual(at(a!, 9));

    select(m, at(b!, 6), at(a!, 5));
    beforeInput(m, "insertText", { data: "!" });
    expect(finalText(m)).toBe("Hello! paragraph\nThird\n");
    expect(caretOf(m)).toEqual(at(a!, 6));
    expect(m.doc.getBlock(b!)).toBeNull();
    expect(m.editor.getBlockElement(b!)).toBeNull();
  });

  it("insertParagraph splits the paragraph and puts the caret at the start of the new one", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "insertParagraph");
    expect(finalText(m)).toBe("Hello\n world\nSecond paragraph\nThird\n");
    const created = bodyParagraphs(m.doc)[1]!;
    expect(caretOf(m)).toEqual(at(created.id, 0));
    expect(domCaret(m)).toEqual(at(created.id, 0));
    // At the end of a paragraph it makes an empty one that can hold the caret.
    caret(m, created.id, created.text.length);
    beforeInput(m, "insertParagraph");
    const empty = bodyParagraphs(m.doc)[2]!;
    expect(empty.text).toBe("");
    expect(domCaret(m)).toEqual(at(empty.id, 0));
    type(m, "x");
    expect(paragraph(m.doc, empty.id).text).toBe("x");
  });

  it("insertLineBreak adds a line break inside the paragraph", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "insertLineBreak");
    expect(paragraph(m.doc, a!).text).toBe("Hello\n world");
    expect(bodyParagraphs(m.doc)).toHaveLength(3);
    expect(caretOf(m)).toEqual(at(a!, 6));
    expect(m.editor.getBlockElement(a!)?.querySelector("br[data-s]")).not.toBeNull();
  });

  it("deleteContentBackward removes one character, and joins paragraphs at the start of one", async () => {
    const [a, b] = await open();
    caret(m, a!, 5);
    beforeInput(m, "deleteContentBackward");
    expect(paragraph(m.doc, a!).text).toBe("Hell world");
    expect(caretOf(m)).toEqual(at(a!, 4));

    caret(m, b!, 0);
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe("Hell worldSecond paragraph\nThird\n");
    expect(caretOf(m)).toEqual(at(a!, 10));
    expect(domCaret(m)).toEqual(at(a!, 10));

    // At the very start of the document there is nothing to delete.
    caret(m, a!, 0);
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe("Hell worldSecond paragraph\nThird\n");
  });

  it("deleteContentBackward removes a whole emoji, not half of it", async () => {
    const [a] = await open(["Hi 👍🏽!"]);
    const text = paragraph(m.doc, a!).text;
    caret(m, a!, text.length - 1);
    beforeInput(m, "deleteContentBackward");
    expect(paragraph(m.doc, a!).text).toBe("Hi !");
    expect(caretOf(m)).toEqual(at(a!, 3));
  });

  it("deleteContentForward removes the next character, and joins with the next paragraph at the end", async () => {
    const [a] = await open();
    caret(m, a!, 0);
    beforeInput(m, "deleteContentForward");
    expect(paragraph(m.doc, a!).text).toBe("ello world");
    expect(caretOf(m)).toEqual(at(a!, 0));
    caret(m, a!, 10);
    beforeInput(m, "deleteContentForward");
    expect(finalText(m)).toBe("ello worldSecond paragraph\nThird\n");
    expect(caretOf(m)).toEqual(at(a!, 10));
  });

  it("deleteWordBackward and deleteWordForward remove a word", async () => {
    const [a] = await open(["one two  three"]);
    caret(m, a!, 7);
    beforeInput(m, "deleteWordBackward");
    expect(paragraph(m.doc, a!).text).toBe("one   three");
    expect(caretOf(m)).toEqual(at(a!, 4));
    beforeInput(m, "deleteWordForward");
    expect(paragraph(m.doc, a!).text).toBe("one ");
  });

  it("a delete uses the range the browser reports for it", async () => {
    const [a] = await open();
    caret(m, a!, 11);
    const text = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    beforeInput(m, "deleteSoftLineBackward", { targetRange: { startContainer: text, startOffset: 6, endContainer: text, endOffset: 11 } });
    expect(paragraph(m.doc, a!).text).toBe("Hello ");
    expect(caretOf(m)).toEqual(at(a!, 6));
  });

  it("deletes to the edge of the paragraph for a line delete the browser gives no range for", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "deleteSoftLineBackward");
    expect(paragraph(m.doc, a!).text).toBe(" world");
    expect(caretOf(m)).toEqual(at(a!, 0));
    beforeInput(m, "deleteHardLineForward");
    expect(paragraph(m.doc, a!).text).toBe("");
    expect(bodyParagraphs(m.doc)).toHaveLength(3);
  });

  it("measures character and word deletes in the model, whatever range the browser reports", async () => {
    const [a, b] = await open();
    caret(m, a!, 5);
    const text = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    beforeInput(m, "deleteContentBackward", { targetRange: { startContainer: text, startOffset: 0, endContainer: text, endOffset: 5 } });
    expect(paragraph(m.doc, a!).text).toBe("Hell world");
    // A reported line range that leaves the caret's paragraph is not used either.
    const other = m.editor.getBlockElement(b!)!.querySelector("[data-s]")!.firstChild!;
    const mine = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    beforeInput(m, "deleteSoftLineForward", { targetRange: { startContainer: mine, startOffset: 4, endContainer: other, endOffset: 6 } });
    expect(finalText(m)).toBe("Hell\nSecond paragraph\nThird\n");
  });

  it("deleteByCut removes the selection", async () => {
    const [a, b, c] = await open();
    select(m, at(a!, 5), at(c!, 2));
    beforeInput(m, "deleteByCut");
    expect(finalText(m)).toBe("Helloird\n");
    expect(caretOf(m)).toEqual(at(a!, 5));
    expect(m.doc.getBlock(b!)).toBeNull();
  });

  it("never deletes a table by backspacing at the paragraph after it", async () => {
    m = await mount({ fixture: "table.docx" });
    const table = bodyTables(m.doc)[0]!;
    const blocks = m.doc.getView().body.blocks;
    const after = blocks[blocks.findIndex((block) => block.id === table.id) + 1]!;
    const before = finalText(m);
    caret(m, after.id, 0);
    const event = beforeInput(m, "deleteContentBackward");
    expect(event.defaultPrevented).toBe(true);
    expect(finalText(m)).toBe(before);
    expect(m.doc.getBlock(table.id)).not.toBeNull();
    // And the first paragraph of a cell does not join the cell before it.
    const cell = cellParagraphs(table, 2, 1)[0]!;
    caret(m, cell.id, 0);
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe(before);
  });

  it("edits inside a table cell and clears cell text without removing the table for a selection that leaves the body", async () => {
    m = await mount({ fixture: "table.docx" });
    const table = bodyTables(m.doc)[0]!;
    const design = cellParagraphs(table, 2, 0)[0]!;
    caret(m, design.id, 6);
    type(m, "ing");
    expect(paragraph(m.doc, design.id).text).toBe("Designing");
    expect(caretOf(m)).toEqual(at(design.id, 9));
    expect(m.editor.getBlockElement(design.id)?.closest("table")).not.toBeNull();

    const intro = bodyParagraphs(m.doc)[1]!;
    const owner = cellParagraphs(table, 1, 1)[0]!;
    select(m, at(intro.id, 9), at(owner.id, 3));
    beforeInput(m, "deleteContentBackward");
    expect(paragraph(m.doc, intro.id).text).toBe("The table");
    expect(paragraph(m.doc, owner.id).text).toBe("er");
    expect(paragraph(m.doc, cellParagraphs(bodyTables(m.doc)[0]!, 1, 0)[0]!.id).text).toBe("");
    expect(bodyTables(m.doc)[0]!.rows).toHaveLength(table.rows.length);
    expect(caretOf(m)).toEqual(at(intro.id, 9));
  });

  it("formatBold, formatItalic and formatUnderline toggle formatting on the selection", async () => {
    const [a] = await open();
    select(m, at(a!, 0), at(a!, 5));
    beforeInput(m, "formatBold");
    beforeInput(m, "formatItalic");
    beforeInput(m, "formatUnderline");
    const first = paragraph(m.doc, a!).runs[0]!;
    expect(first).toMatchObject({ text: "Hello", bold: true, italic: true, underline: true });
    expect(paragraph(m.doc, a!).runs[1]).toMatchObject({ text: " world", bold: false });
    // The selection survives, so the next toggle turns it off again.
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 0), end: at(a!, 5) });
    expect(m.editor.getSnapshot().activeFormat).toMatchObject({ bold: true, italic: true, underline: true });
    beforeInput(m, "formatBold");
    expect(paragraph(m.doc, a!).runs[0]).toMatchObject({ text: "Hello", bold: false, italic: true });
  });

  it("formatBold with a caret arms the format for the text typed next", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    keydown(m, "b", { ctrl: true });
    expect(m.editor.getSnapshot().activeFormat?.bold).toBe(true);
    expect(m.session.getState().dirty).toBe(false);
    type(m, "!!");
    const runs = paragraph(m.doc, a!).runs.map((run) => [run.text, run.bold]);
    expect(runs).toEqual([
      ["Hello", false],
      ["!!", true],
      [" world", false],
    ]);
  });

  it("historyUndo and historyRedo, and the keyboard shortcuts, go through the session history", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "insertText", { data: "," });
    beforeInput(m, "insertParagraph");
    expect(bodyParagraphs(m.doc)).toHaveLength(4);
    expect(beforeInput(m, "historyUndo").defaultPrevented).toBe(true);
    expect(finalText(m)).toBe("Hello, world\nSecond paragraph\nThird\n");
    expect(keydown(m, "z", { ctrl: true }).defaultPrevented).toBe(true);
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\nThird\n");
    keydown(m, "z", { meta: true, shift: true });
    expect(finalText(m)).toBe("Hello, world\nSecond paragraph\nThird\n");
    beforeInput(m, "historyRedo");
    expect(bodyParagraphs(m.doc)).toHaveLength(4);
    keydown(m, "z", { ctrl: true });
    keydown(m, "y", { ctrl: true });
    expect(bodyParagraphs(m.doc)).toHaveLength(4);
  });

  it("insertReplacementText replaces the word the browser names (spelling correction)", async () => {
    const [a] = await open(["Helo world"]);
    caret(m, a!, 2);
    const text = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    beforeInput(m, "insertReplacementText", { data: "Hello", targetRange: { startContainer: text, startOffset: 0, endContainer: text, endOffset: 4 } });
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
  });

  it("cancels input types it does not support and changes nothing", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    for (const inputType of ["insertOrderedList", "formatIndent", "insertHorizontalRule", "formatFontColor"]) {
      expect(beforeInput(m, inputType).defaultPrevented).toBe(true);
    }
    expect(finalText(m)).toBe("Hello world\nSecond paragraph\nThird\n");
    expect(m.session.getState().dirty).toBe(false);
  });

  it("Tab inserts a tab in the body and moves between cells in a table", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    expect(keydown(m, "Tab").defaultPrevented).toBe(true);
    expect(paragraph(m.doc, a!).text).toBe("Hello\t world");
    m.unmount();

    m = await mount({ fixture: "table.docx" });
    const table = bodyTables(m.doc)[0]!;
    const before = finalText(m);
    caret(m, cellParagraphs(table, 2, 0)[0]!.id, 2);
    keydown(m, "Tab");
    expect(caretOf(m)).toEqual(at(cellParagraphs(table, 2, 1)[0]!.id, 0));
    keydown(m, "Tab", { shift: true });
    expect(caretOf(m)).toEqual(at(cellParagraphs(table, 2, 0)[0]!.id, 0));
    expect(finalText(m)).toBe(before);
  });

  it("ignores input while read-only, still cancelling it", async () => {
    m = await mount({ paragraphs: ["Hello"] }, { readOnly: true });
    const [a] = bodyParagraphs(m.doc);
    expect(m.content.getAttribute("contenteditable")).toBe("false");
    caret(m, a!.id, 2);
    expect(beforeInput(m, "insertText", { data: "x" }).defaultPrevented).toBe(true);
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe("Hello\n");
    m.editor.setReadOnly(false);
    beforeInput(m, "insertText", { data: "x" });
    expect(finalText(m)).toBe("Hexllo\n");
  });
});
