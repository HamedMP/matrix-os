// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorSelection } from "../../../../home/apps/docs/src/editor/index";
import { domFromOffset, positionFromDom } from "../../../../home/apps/docs/src/editor/index";
import { type Mounted, OTHER, at, beforeInput, bodyParagraphs, caret, caretOf, domCaret, mount, paragraph, select, type } from "./helpers";

let m: Mounted;
afterEach(() => {
  m?.unmount();
  vi.restoreAllMocks();
});

async function open(paragraphs: string[] = ["Hello world", "Second paragraph", "Third"]): Promise<string[]> {
  m = await mount({ paragraphs });
  return bodyParagraphs(m.doc).map((block) => block.id);
}

function classesAt(blockId: string, offset: number): string[] {
  const element = m.editor.getBlockElement(blockId)!;
  const leaf = Array.from(element.querySelectorAll<HTMLElement>("[data-s]")).find((candidate) => {
    const start = Number(candidate.getAttribute("data-s"));
    return offset >= start && offset < start + Number(candidate.getAttribute("data-l"));
  });
  return leaf === undefined ? [] : Array.from(leaf.classList);
}

describe("selection API", () => {
  it("reports the selection as engine positions with its direction", async () => {
    const [a, b] = await open();
    expect(m.editor.getSelection()).toBeNull();
    select(m, at(b!, 4), at(a!, 2));
    expect(m.editor.getSelection()).toEqual({
      anchor: at(b!, 4),
      focus: at(a!, 2),
      start: at(a!, 2),
      end: at(b!, 4),
      collapsed: false,
      backward: true,
    });
    expect(m.editor.getSelectedText()).toBe("llo world\nSeco");
    expect(m.editor.setSelection({ start: at(a!, 0), end: at(a!, 5) })).toBe(true);
    expect(m.editor.getSelection()).toMatchObject({ anchor: at(a!, 0), focus: at(a!, 5), backward: false });
    expect(document.getSelection()?.toString()).toBe("Hello");
    expect(m.editor.setSelection(at("missing", 0))).toBe(false);
  });

  it("tells listeners when the owner moves the selection in the document", async () => {
    const [a, b] = await open();
    const seen: Array<EditorSelection | null> = [];
    const stop = m.editor.onSelectionChange((selection) => seen.push(selection));
    // A click: the browser moves the DOM selection and fires selectionchange.
    const point = domFromOffset(m.editor.getBlockElement(b!)!, 3);
    document.getSelection()!.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
    document.dispatchEvent(new Event("selectionchange"));
    expect(seen.at(-1)).toMatchObject({ focus: at(b!, 3), collapsed: true });
    expect(m.editor.getSnapshot().selection).toMatchObject({ focus: at(b!, 3) });
    const count = seen.length;
    document.dispatchEvent(new Event("selectionchange"));
    expect(seen).toHaveLength(count);
    caret(m, a!, 1);
    expect(seen.at(-1)).toMatchObject({ focus: at(a!, 1) });
    stop();
    caret(m, a!, 2);
    expect(seen.at(-1)).toMatchObject({ focus: at(a!, 1) });
  });

  it("remembers the document selection while focus is elsewhere, so toolbar commands still apply", async () => {
    const [a] = await open();
    select(m, at(a!, 0), at(a!, 5));
    const button = document.createElement("button");
    document.body.append(button);
    document.getSelection()!.setBaseAndExtent(button, 0, button, 0);
    document.dispatchEvent(new Event("selectionchange"));
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 0), end: at(a!, 5) });
    expect(m.editor.format("bold")).toBe(true);
    expect(paragraph(m.doc, a!).runs[0]).toMatchObject({ text: "Hello", bold: true });
    button.remove();
  });

  it("carries the remembered selection through someone else's edit while focus is in a panel, without taking focus", async () => {
    const [a, b] = await open();
    // "world" is selected, then the owner types in a side panel.
    select(m, at(a!, 6), at(a!, 11));
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    document.getSelection()!.setBaseAndExtent(document.body, 0, document.body, 0);
    document.dispatchEvent(new Event("selectionchange"));
    const seen: Array<EditorSelection | null> = [];
    const stop = m.editor.onSelectionChange((selection) => seen.push(selection));
    // The Assistant inserts text before the remembered selection.
    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "Well. " }], { origin: "agent" });
    expect(document.activeElement).toBe(box);
    expect(m.content.contains(document.getSelection()!.anchorNode)).toBe(false);
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 12), end: at(a!, 17) });
    expect(m.editor.getSnapshot().selection).toMatchObject({ start: at(a!, 12), end: at(a!, 17) });
    expect(seen.at(-1)).toMatchObject({ start: at(a!, 12), end: at(a!, 17) });
    // The next toolbar command formats the words that moved, not the old offsets.
    expect(m.editor.format({ bold: true })).toBe(true);
    expect(paragraph(m.doc, a!).runs.map((run) => [run.text, run.bold])).toEqual([
      ["Well. Hello ", false],
      ["world", true],
    ]);
    // An edit in another paragraph leaves it where it is.
    box.focus();
    document.getSelection()!.setBaseAndExtent(document.body, 0, document.body, 0);
    m.session.apply([{ type: "insertText", at: at(b!, 0), text: "!" }], { origin: "agent" });
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 12), end: at(a!, 17) });
    expect(document.activeElement).toBe(box);
    stop();
    box.remove();
  });

  it("carries the remembered selection through rejecting a revision from a panel, so Bold reaches the selected word", async () => {
    const [a] = await open();
    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "Dear " }], { track: true });
    // "world" in "Dear Hello world", then focus moves to the Review panel.
    select(m, at(a!, 11), at(a!, 16));
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    document.getSelection()!.setBaseAndExtent(document.body, 0, document.body, 0);
    document.dispatchEvent(new Event("selectionchange"));
    m.session.rejectRevisions("all", { origin: "review" });
    expect(document.activeElement).toBe(button);
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 6), end: at(a!, 11) });
    expect(m.editor.getSnapshot().selection).toMatchObject({ start: at(a!, 6), end: at(a!, 11) });
    expect(m.editor.format({ bold: true })).toBe(true);
    expect(paragraph(m.doc, a!).runs.map((run) => [run.text, run.bold])).toEqual([
      ["Hello ", false],
      ["world", true],
    ]);
    button.remove();
  });

  it("puts the selection where the rejected text was when the owner selected it in the document", async () => {
    const [a] = await open();
    m.session.apply([{ type: "insertText", at: at(a!, 0), text: "Dear " }], { track: true });
    select(m, at(a!, 11), at(a!, 16));
    m.session.rejectRevisions("all", { origin: "agent" });
    expect(m.editor.getSelection()).toMatchObject({ start: at(a!, 6), end: at(a!, 11) });
    expect(m.editor.getSelectedText()).toBe("world");
  });

  it("drops a remembered selection whose place a change removed instead of keeping its old offsets", async () => {
    m = await mount({ paragraphs: ["Hello world"] }, { tracking: true });
    const [a] = bodyParagraphs(m.doc).map((block) => block.id);
    m.session.apply([{ type: "splitParagraph", at: at(a!, 6) }]);
    const second = bodyParagraphs(m.doc)[1]!.id;
    select(m, at(second, 0), at(second, 5));
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    document.getSelection()!.setBaseAndExtent(document.body, 0, document.body, 0);
    document.dispatchEvent(new Event("selectionchange"));
    const seen: Array<EditorSelection | null> = [];
    const stop = m.editor.onSelectionChange((selection) => seen.push(selection));
    m.session.rejectRevisions("all", { origin: "review" });
    expect(m.editor.getSelection()).toBeNull();
    expect(m.editor.getSnapshot().selection).toBeNull();
    expect(seen.at(-1)).toBeNull();
    // A toolbar command has nothing to act on rather than the wrong letters.
    expect(m.editor.format({ bold: true })).toBe(false);
    expect(paragraph(m.doc, a!).runs.every((run) => run.bold !== true)).toBe(true);
    stop();
    button.remove();
  });

  it("publishes toolbar state: view mode, selection and the formatting at it", async () => {
    m = await mount({ markdown: "# Title\n\nPlain **bold** text" });
    const [title, body] = bodyParagraphs(m.doc);
    let notified = 0;
    m.editor.subscribe(() => notified++);
    caret(m, title!.id, 2);
    expect(m.editor.getSnapshot()).toMatchObject({ viewMode: "markup", readOnly: false, activeFormat: { headingLevel: 1, inTable: false } });
    const bold = body!.runs.find((run) => run.bold)!;
    caret(m, body!.id, bold.start + 2);
    expect(m.editor.getSnapshot().activeFormat).toMatchObject({ bold: true, headingLevel: 0 });
    select(m, at(body!.id, 0), at(body!.id, body!.text.length));
    expect(m.editor.getSnapshot().activeFormat).toMatchObject({ bold: false });
    expect(notified).toBeGreaterThanOrEqual(3);
    const snapshot = m.editor.getSnapshot();
    document.dispatchEvent(new Event("selectionchange"));
    expect(m.editor.getSnapshot()).toBe(snapshot);
  });

  it("sets paragraph properties on the selected paragraphs", async () => {
    const [a, b, c] = await open();
    select(m, at(a!, 2), at(b!, 3));
    expect(m.editor.setParagraphStyle({ alignment: "center" })).toBe(true);
    expect(paragraph(m.doc, a!).style.alignment).toBe("center");
    expect(paragraph(m.doc, b!).style.alignment).toBe("center");
    expect(paragraph(m.doc, c!).style.alignment).toBe("left");
    expect(m.editor.getBlockElement(a!)!.style.textAlign).toBe("center");
    caret(m, c!, 0);
    m.editor.setParagraphStyle({ headingLevel: 2 });
    expect(m.editor.getBlockElement(c!)!.tagName).toBe("H2");
    expect(m.editor.getSnapshot().activeFormat?.headingLevel).toBe(2);
  });

  it("scrolls a block or a position into view", async () => {
    const [, b] = await open();
    const calls: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      calls.push(this);
    };
    expect(m.editor.scrollTo(b!)).toBe(true);
    expect(calls[0]).toBe(m.editor.getBlockElement(b!));
    expect(m.editor.scrollTo(at(b!, 3))).toBe(true);
    expect(m.editor.getBlockElement(b!)!.contains(calls[1]!)).toBe(true);
    expect(m.editor.scrollTo("missing")).toBe(false);
    m.editor.setSelection(at(b!, 1), { scroll: true });
    expect(calls).toHaveLength(3);
  });

  it("applyOps runs engine operations through the session and places the caret", async () => {
    const [a] = await open();
    caret(m, a!, 0);
    const result = m.editor.applyOps([{ type: "insertText", at: at(a!, 11), text: "!" }]);
    expect(result.changedBlockIds).toEqual([a!]);
    expect(caretOf(m)).toEqual(at(a!, 12));
    expect(m.session.getState().canUndo).toBe(true);
    expect(() => m.editor.applyOps([{ type: "insertText", at: at("missing", 0), text: "x" }])).toThrowError();
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world!");
  });
});

describe("highlights", () => {
  it("paints ranges of a layer without changing the text, the document or the selection", async () => {
    const [a, b] = await open();
    caret(m, a!, 3);
    m.editor.setHighlights("search", [
      { id: "hit-1", range: { start: at(a!, 6), end: at(a!, 11) } },
      { id: "hit-2", range: { start: at(b!, 0), end: at(b!, 6) }, className: "is-current" },
    ]);
    expect(classesAt(a!, 6)).toEqual(expect.arrayContaining(["doc-hl", "doc-hl-search"]));
    expect(classesAt(a!, 5)).not.toContain("doc-hl");
    expect(classesAt(b!, 2)).toEqual(expect.arrayContaining(["doc-hl-search", "is-current"]));
    const painted = m.editor.getBlockElement(a!)!.querySelector(".doc-hl-search")!;
    expect(painted.textContent).toBe("world");
    expect(painted.getAttribute("data-hl-id")).toBe("hit-1");
    expect(m.editor.getBlockElement(a!)!.textContent).toBe("Hello world");
    expect(m.session.getState()).toMatchObject({ dirty: false, canUndo: false });
    expect(domCaret(m)).toEqual(at(a!, 3));
  });

  it("keeps layers independent, lets them overlap and clears them one by one", async () => {
    const [a] = await open();
    m.editor.setHighlights("search", [{ range: { start: at(a!, 0), end: at(a!, 8) } }]);
    m.editor.setHighlights("proposal", [{ id: "p1", range: { start: at(a!, 6), end: at(a!, 11) } }]);
    expect(classesAt(a!, 2)).toContain("doc-hl-search");
    expect(classesAt(a!, 2)).not.toContain("doc-hl-proposal");
    expect(classesAt(a!, 7)).toEqual(expect.arrayContaining(["doc-hl-search", "doc-hl-proposal"]));
    expect(classesAt(a!, 9)).toContain("doc-hl-proposal");
    m.editor.clearHighlights("search");
    expect(classesAt(a!, 2)).not.toContain("doc-hl");
    expect(classesAt(a!, 7)).toContain("doc-hl-proposal");
    m.editor.setHighlights("proposal", []);
    expect(m.host.querySelector(".doc-hl")).toBeNull();
    expect(() => m.editor.setHighlights("Not A Layer", [])).toThrowError();
  });

  it("paints a range that spans paragraphs and keeps positions mapping through the cut leaves", async () => {
    const [a, b, c] = await open();
    m.editor.setHighlights("comment", [{ id: "c1", range: { start: at(a!, 6), end: at(c!, 2) } }]);
    expect(classesAt(a!, 5)).not.toContain("doc-hl-comment");
    expect(classesAt(a!, 6)).toContain("doc-hl-comment");
    expect(classesAt(b!, 0)).toContain("doc-hl-comment");
    expect(classesAt(b!, 15)).toContain("doc-hl-comment");
    expect(classesAt(c!, 1)).toContain("doc-hl-comment");
    expect(classesAt(c!, 2)).not.toContain("doc-hl-comment");
    for (const id of [a!, b!, c!]) {
      const element = m.editor.getBlockElement(id)!;
      for (let offset = 0; offset <= paragraph(m.doc, id).text.length; offset++) {
        const point = domFromOffset(element, offset);
        expect(positionFromDom(m.content, point.node, point.offset)).toEqual(at(id, offset));
      }
    }
  });

  it("keeps painting while the paragraph is edited and after undo", async () => {
    const [a] = await open();
    m.editor.setHighlights("search", [{ range: { start: at(a!, 6), end: at(a!, 11) } }]);
    caret(m, a!, 8);
    type(m, "xy");
    // The range is in engine coordinates and does not move by itself: the caller refreshes its ranges.
    expect(m.editor.getBlockElement(a!)!.querySelector(".doc-hl-search")!.textContent).toBe("woxyr");
    expect(domCaret(m)).toEqual(at(a!, 10));
    beforeInput(m, "insertParagraph");
    expect(m.host.querySelectorAll(".doc-hl-search").length).toBeGreaterThan(0);
    m.editor.undo();
    m.editor.undo();
    expect(m.editor.getBlockElement(a!)!.querySelector(".doc-hl-search")!.textContent).toBe("world");
  });

  it("drops highlights when another document is loaded", async () => {
    const [a] = await open();
    m.editor.setHighlights("search", [{ range: { start: at(a!, 0), end: at(a!, 5) } }]);
    await m.session.createNew({ discardChanges: true });
    expect(m.host.querySelector(".doc-hl")).toBeNull();
    expect(m.host.querySelectorAll("[data-block-type='paragraph']")).toHaveLength(1);
  });
});

describe("view modes", () => {
  async function tracked(): Promise<string> {
    m = await mount({ paragraphs: ["Hello brave world"] });
    const id = bodyParagraphs(m.doc)[0]!.id;
    m.session.apply(
      [
        { type: "insertText", at: at(id, 17), text: " again" },
        { type: "deleteRange", range: { start: at(id, 6), end: at(id, 12) } },
      ],
      { track: true, author: OTHER },
    );
    return id;
  }

  it("shows all markup, the final text or the original text", async () => {
    const id = await tracked();
    const shown = (): string => m.editor.getBlockElement(id)!.textContent ?? "";
    expect(shown()).toBe("Hello brave world again");
    expect(m.host.querySelector(".doc-rev-delete")?.textContent).toBe("brave ");
    expect(m.host.querySelector(".doc-rev-insert")?.textContent).toBe(" again");
    m.editor.setViewMode("final");
    expect(shown()).toBe("Hello world again");
    expect(m.host.querySelector(".doc-rev, .doc-changed")).toBeNull();
    m.editor.setViewMode("original");
    expect(shown()).toBe("Hello brave world");
    expect(m.host.querySelector(".doc-rev, .doc-changed")).toBeNull();
    expect(m.editor.getViewMode()).toBe("original");
    expect(m.host.querySelector(".doc-page")?.getAttribute("data-view-mode")).toBe("original");
  });

  it("makes the original view read-only and the other views editable", async () => {
    const id = await tracked();
    m.editor.setViewMode("original");
    expect(m.editor.getSnapshot()).toMatchObject({ viewMode: "original", readOnly: true });
    expect(m.content.getAttribute("contenteditable")).toBe("false");
    caret(m, id, 3);
    expect(beforeInput(m, "insertText", { data: "x" }).defaultPrevented).toBe(true);
    expect(paragraph(m.doc, id).text).toBe("Hello brave world again");
    m.editor.setViewMode("final");
    expect(m.content.getAttribute("contenteditable")).toBe("true");
    beforeInput(m, "insertText", { data: "x" });
    expect(paragraph(m.doc, id).text).toBe("Helxlo brave world again");
  });

  it("keeps the selection across a change of view mode and copies what the view shows", async () => {
    const id = await tracked();
    select(m, at(id, 0), at(id, 23));
    expect(m.editor.getSelectedText()).toBe("Hello brave world again");
    m.editor.setViewMode("final");
    expect(m.editor.getSelection()).toMatchObject({ start: at(id, 0), end: at(id, 23) });
    expect(m.editor.getSelectedText()).toBe("Hello world again");
    m.editor.setViewMode("original");
    expect(m.editor.getSelectedText()).toBe("Hello brave world");
  });
});
