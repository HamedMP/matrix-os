// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { type Mounted, OTHER, OWNER, at, beforeInput, bodyParagraphs, caret, caretOf, domCaret, finalText, mount, originalText, paragraph, select, type } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

const START = "Hello world\nSecond paragraph\nThird\n";

async function open(paragraphs: string[] = ["Hello world", "Second paragraph", "Third"]): Promise<string[]> {
  m = await mount({ paragraphs }, { tracking: true });
  return bodyParagraphs(m.doc).map((block) => block.id);
}

function revisions(): Array<{ kind: string; text: string; author: string }> {
  return m.doc.listRevisions().map(({ kind, text, author }) => ({ kind, text, author }));
}

function runs(blockId: string): Array<[string, string]> {
  return paragraph(m.doc, blockId).runs.map((run) => [run.text, run.revision?.kind ?? ""]);
}

describe("input with tracking on: edits become native revisions", () => {
  it("insertText records one insertion for a typed word and keeps the original text", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    type(m, " there");
    expect(revisions()).toEqual([{ kind: "insert", text: " there", author: OWNER }]);
    expect(finalText(m)).toBe("Hello there world\nSecond paragraph\nThird\n");
    expect(originalText(m)).toBe(START);
    expect(caretOf(m)).toEqual(at(a!, 11));
    expect(domCaret(m)).toEqual(at(a!, 11));
    const inserted = m.editor.getBlockElement(a!)!.querySelector(".doc-rev-insert")!;
    expect(inserted.textContent).toBe(" there");
    expect(inserted.getAttribute("data-revision-id")).toBe(m.doc.listRevisions()[0]!.id);
  });

  it("deleteContentBackward keeps the text as a deletion and steps the caret over it", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "deleteContentBackward");
    beforeInput(m, "deleteContentBackward");
    expect(runs(a!)).toEqual([
      ["Hel", ""],
      ["lo", "delete"],
      [" world", ""],
    ]);
    expect(revisions()).toEqual([{ kind: "delete", text: "lo", author: OWNER }]);
    expect(finalText(m)).toBe("Hel world\nSecond paragraph\nThird\n");
    expect(originalText(m)).toBe(START);
    expect(caretOf(m)).toEqual(at(a!, 3));
    // The deleted text is still shown, struck through.
    expect(m.editor.getBlockElement(a!)!.querySelector(".doc-rev-delete")?.textContent).toBe("lo");
  });

  it("backspace over text that is already a deletion only moves the caret", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "deleteContentBackward");
    caret(m, a!, 5);
    beforeInput(m, "deleteContentBackward");
    expect(revisions()).toEqual([{ kind: "delete", text: "o", author: OWNER }]);
    expect(caretOf(m)).toEqual(at(a!, 4));
    expect(m.session.getState().canUndo).toBe(true);
    m.session.undo();
    expect(m.session.getState().canUndo).toBe(false);
  });

  it("deleteContentForward marks the next character and moves the caret past it", async () => {
    const [a] = await open();
    caret(m, a!, 0);
    beforeInput(m, "deleteContentForward");
    beforeInput(m, "deleteContentForward");
    expect(runs(a!)).toEqual([
      ["He", "delete"],
      ["llo world", ""],
    ]);
    expect(caretOf(m)).toEqual(at(a!, 2));
    expect(finalText(m)).toBe("llo world\nSecond paragraph\nThird\n");
  });

  it("a reported line delete forward leaves the caret after the text that stays as a deletion", async () => {
    const [a] = await open();
    caret(m, a!, 6);
    const text = m.editor.getBlockElement(a!)!.querySelector("[data-s]")!.firstChild!;
    beforeInput(m, "deleteSoftLineForward", { targetRange: { startContainer: text, startOffset: 6, endContainer: text, endOffset: 11 } });
    expect(revisions()).toEqual([{ kind: "delete", text: "world", author: OWNER }]);
    expect(caretOf(m)).toEqual(at(a!, 11));
    expect(finalText(m)).toBe("Hello \nSecond paragraph\nThird\n");
  });

  it("backspace removes the owner's own pending insertion outright", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    type(m, "abc");
    beforeInput(m, "deleteContentBackward");
    expect(revisions()).toEqual([{ kind: "insert", text: "ab", author: OWNER }]);
    expect(caretOf(m)).toEqual(at(a!, 7));
    beforeInput(m, "deleteContentBackward");
    beforeInput(m, "deleteContentBackward");
    expect(revisions()).toEqual([]);
    expect(paragraph(m.doc, a!).text).toBe("Hello world");
  });

  it("insertParagraph records an inserted paragraph mark", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    beforeInput(m, "insertParagraph");
    expect(finalText(m)).toBe("Hello\n world\nSecond paragraph\nThird\n");
    expect(originalText(m)).toBe(START);
    expect(paragraph(m.doc, a!).markRevision).toMatchObject({ kind: "insert", author: OWNER });
    const created = bodyParagraphs(m.doc)[1]!;
    expect(caretOf(m)).toEqual(at(created.id, 0));
    expect(m.editor.getBlockElement(a!)!.querySelector(".doc-mark.doc-rev-insert")).not.toBeNull();
  });

  it("backspace at the start of a paragraph marks the paragraph mark before it as deleted", async () => {
    const [a, b] = await open();
    caret(m, b!, 0);
    beforeInput(m, "deleteContentBackward");
    expect(paragraph(m.doc, a!).markRevision).toMatchObject({ kind: "delete", author: OWNER });
    expect(finalText(m)).toBe("Hello worldSecond paragraph\nThird\n");
    expect(originalText(m)).toBe(START);
    expect(caretOf(m)).toEqual(at(a!, 11));
    expect(m.doc.getBlock(b!)).not.toBeNull();
    // The next backspace continues in the first paragraph.
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe("Hello worlSecond paragraph\nThird\n");
  });

  it("typing over a selection records a deletion and an insertion that belong together", async () => {
    const [a] = await open();
    select(m, at(a!, 6), at(a!, 11));
    type(m, "you");
    expect(runs(a!)).toEqual([
      ["Hello ", ""],
      ["world", "delete"],
      ["you", "insert"],
    ]);
    const [deleted, inserted] = m.doc.listRevisions();
    expect(deleted).toMatchObject({ kind: "delete", text: "world", pairedWith: inserted!.id });
    expect(finalText(m)).toBe("Hello you\nSecond paragraph\nThird\n");
    expect(originalText(m)).toBe(START);
    expect(caretOf(m)).toEqual(at(a!, 14));
  });

  it("deleteByCut across paragraphs marks text and paragraph marks", async () => {
    const [a, , c] = await open();
    select(m, at(a!, 5), at(c!, 2));
    beforeInput(m, "deleteByCut");
    expect(finalText(m)).toBe("Helloird\n");
    expect(originalText(m)).toBe(START);
    expect(bodyParagraphs(m.doc)).toHaveLength(3);
    expect(caretOf(m)).toEqual(at(a!, 5));
  });

  it("formatBold records a formatting revision that can be rejected", async () => {
    const [a] = await open();
    select(m, at(a!, 0), at(a!, 5));
    beforeInput(m, "formatBold");
    const [revision] = m.doc.listRevisions();
    expect(revision).toMatchObject({ kind: "format", scope: "runFormat", author: OWNER, text: "Hello" });
    expect(paragraph(m.doc, a!).runs[0]).toMatchObject({ text: "Hello", bold: true });
    const element = m.editor.getBlockElement(a!)!;
    expect(element.classList.contains("doc-changed")).toBe(true);
    expect(element.querySelector(".doc-rev-format")?.textContent).toBe("Hello");
    m.session.rejectRevisions("all");
    expect(paragraph(m.doc, a!).runs[0]).toMatchObject({ text: "Hello world", bold: false });
    expect(m.editor.getBlockElement(a!)!.classList.contains("doc-changed")).toBe(false);
  });

  it("follows the Track changes toggle from one keystroke to the next", async () => {
    const [a] = await open();
    caret(m, a!, 5);
    type(m, "A");
    m.editor.setTracking(false);
    type(m, "B");
    m.editor.setTracking(true);
    type(m, "C");
    expect(runs(a!)).toEqual([
      ["Hello", ""],
      ["A", "insert"],
      ["B", ""],
      ["C", "insert"],
      [" world", ""],
    ]);
    expect(originalText(m)).toBe("HelloB world\nSecond paragraph\nThird\n");
  });

  it("rejecting everything after a run of tracked edits restores the original text, accepting gives the final text", async () => {
    const [a, b, c] = await open();
    caret(m, a!, 5);
    type(m, ", dear");
    beforeInput(m, "insertParagraph");
    type(m, "New line");
    select(m, at(b!, 0), at(b!, 6));
    beforeInput(m, "deleteContentBackward");
    caret(m, c!, 0);
    beforeInput(m, "deleteContentBackward");
    select(m, at(c!, 0), at(c!, 5));
    beforeInput(m, "formatItalic");
    beforeInput(m, "insertFromPaste", { transfer: { "text/plain": "one\ntwo" } });
    const final = finalText(m);
    expect(final).toBe("Hello, dear\nNew line world\n paragraphone\ntwo\n");
    expect(originalText(m)).toBe(START);

    const snapshot = m.doc.snapshot();
    m.session.rejectRevisions("all");
    expect(finalText(m)).toBe(START);
    expect(m.doc.listRevisions()).toEqual([]);
    m.doc.restore(snapshot);
    m.session.acceptRevisions("all");
    expect(finalText(m)).toBe(final);
    expect(originalText(m)).toBe(final);
  });
});

describe("input on a document that already has revisions by someone else", () => {
  it("in the final view, backspace skips hidden deleted text and removes the character the owner sees", async () => {
    m = await mount({ paragraphs: ["Hello brave new world"] }, { viewMode: "final" });
    const [block] = bodyParagraphs(m.doc);
    const id = block!.id;
    // Another author deleted "brave " as a tracked change.
    m.session.apply([{ type: "deleteRange", range: { start: at(id, 6), end: at(id, 12) } }], { track: true, author: OTHER });
    expect(m.editor.getBlockElement(id)!.textContent).toBe("Hello new world");
    // The caret sits after the hidden text: before "new".
    caret(m, id, 12);
    beforeInput(m, "deleteContentBackward");
    // Untracked: the visible space before the hidden text is gone, the other author's deletion is untouched.
    expect(paragraph(m.doc, id).runs.map((run) => [run.text, run.revision?.kind ?? ""])).toEqual([
      ["Hello", ""],
      ["brave ", "delete"],
      ["new world", ""],
    ]);
    expect(m.doc.listRevisions()).toHaveLength(1);
    expect(m.editor.getBlockElement(id)!.textContent).toBe("Hellonew world");
    type(m, "-");
    expect(finalText(m)).toBe("Hello-new world\n");
    expect(m.doc.listRevisions()).toMatchObject([{ kind: "delete", author: OTHER, text: "brave " }]);
  });

  it("deleting a selection in the final view leaves the hidden deletion of another author alone", async () => {
    m = await mount({ paragraphs: ["Hello brave new world"] }, { viewMode: "final" });
    const id = bodyParagraphs(m.doc)[0]!.id;
    m.session.apply([{ type: "deleteRange", range: { start: at(id, 6), end: at(id, 12) } }], { track: true, author: OTHER });
    select(m, at(id, 3), at(id, 15));
    beforeInput(m, "deleteContentBackward");
    expect(finalText(m)).toBe("Hel world\n");
    expect(m.doc.listRevisions()).toMatchObject([{ kind: "delete", author: OTHER, text: "brave " }]);
    m.session.rejectRevisions("all");
    expect(finalText(m)).toBe("Helbrave  world\n");
  });

  it("types inside another author's insertion as the owner's own tracked change", async () => {
    m = await mount({ fixture: "tracked.docx" }, { tracking: true });
    const block = bodyParagraphs(m.doc).find((candidate) => candidate.text.includes("revised "))!;
    const inserted = block.runs.find((run) => run.revision?.kind === "insert")!;
    const authorBefore = inserted.revision!.author;
    const before = originalText(m);
    caret(m, block.id, inserted.start + 3);
    type(m, "X");
    expect(originalText(m)).toBe(before);
    const mine = m.doc.listRevisions().filter((revision) => revision.author === OWNER);
    expect(mine).toMatchObject([{ kind: "insert", text: "X" }]);
    expect(authorBefore).not.toBe(OWNER);
    expect(caretOf(m)).toEqual(at(block.id, inserted.start + 4));
  });
});
