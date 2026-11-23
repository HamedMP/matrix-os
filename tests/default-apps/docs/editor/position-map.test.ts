// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { DocxBlock, ParagraphBlock } from "../../../../home/apps/_shared/office-engine/index";
import { domFromOffset, positionFromDom } from "../../../../home/apps/docs/src/editor/index";
import { type Mounted, OTHER, at, bodyParagraphs, bodyTables, cellParagraphs, mount, paragraph } from "./helpers";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function allParagraphs(blocks: readonly DocxBlock[]): ParagraphBlock[] {
  const found: ParagraphBlock[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") found.push(block);
    else if (block.type === "table") for (const row of block.rows) for (const cell of row.cells) found.push(...allParagraphs(cell.blocks));
  }
  return found;
}

/** Every offset of every shown paragraph must survive position -> DOM -> position. */
function expectRoundTrip(m: Mounted, expected: (block: ParagraphBlock, offset: number) => number = (_block, offset) => offset): number {
  const view = m.doc.getView();
  let checked = 0;
  for (const block of allParagraphs([...view.body.blocks, ...view.footnotes.flatMap((story) => story.blocks)])) {
    const element = m.editor.getBlockElement(block.id);
    if (element === null) continue;
    for (let offset = 0; offset <= block.text.length; offset++) {
      const point = domFromOffset(element, offset);
      const back = positionFromDom(m.content, point.node, point.offset);
      expect(back, `${block.id}@${offset}`).toEqual({ blockId: block.id, offset: expected(block, offset) });
      checked++;
    }
  }
  return checked;
}

describe("position map: engine position <-> DOM", () => {
  it("round-trips every offset across runs with different formatting and links", async () => {
    mounted = await mount({ markdown: "# Title\n\nA **bold** and *italic* [link](https://example.com) text.\n\nPlain" });
    expect(expectRoundTrip(mounted)).toBeGreaterThan(40);
  });

  it("round-trips every offset across insertions, deletions and moves in the markup view", async () => {
    mounted = await mount({ fixture: "tracked.docx" });
    expect(expectRoundTrip(mounted)).toBeGreaterThan(300);
  });

  it("round-trips tabs, line breaks and inline objects, one offset each", async () => {
    mounted = await mount({ fixture: "links-fields.docx" });
    const toc = bodyParagraphs(mounted.doc).find((block) => block.text.includes("\t"))!;
    mounted.session.apply([{ type: "insertText", at: at(toc.id, 2), text: "a\nb\n" }]);
    expectRoundTrip(mounted);
    const element = mounted.editor.getBlockElement(toc.id)!;
    const tab = paragraph(mounted.doc, toc.id).text.indexOf("\t");
    // Before and after the tab are different DOM points that map to consecutive offsets.
    const before = domFromOffset(element, tab);
    const after = domFromOffset(element, tab + 1);
    expect(before).not.toEqual(after);
    expect(positionFromDom(mounted.content, after.node, after.offset)?.offset).toBe(tab + 1);

    mounted.unmount();
    mounted = await mount({ fixture: "footnotes-headers.docx" });
    expect(expectRoundTrip(mounted)).toBeGreaterThan(200);
    // The footnote reference mark is one offset wide.
    const withNote = bodyParagraphs(mounted.doc).find((block) => block.runs.some((run) => run.footnoteRef !== null))!;
    const mark = withNote.runs.find((run) => run.footnoteRef !== null)!;
    const noteElement = mounted.editor.getBlockElement(withNote.id)!;
    const leaf = noteElement.querySelector(`[data-s="${mark.start}"]`)!;
    expect(leaf.getAttribute("data-l")).toBe("1");
    expect(leaf.textContent).toBe(mark.footnoteRef!.label);
    // A point inside the non-editable mark counts as after it.
    expect(positionFromDom(mounted.content, leaf.firstChild!.firstChild!, 1)).toEqual(at(withNote.id, mark.start + 1));
  });

  it("round-trips offsets inside table cells and keeps cells apart", async () => {
    mounted = await mount({ fixture: "table.docx" });
    expect(expectRoundTrip(mounted)).toBeGreaterThan(150);
    const table = bodyTables(mounted.doc)[0]!;
    const first = cellParagraphs(table, 2, 0)[0]!;
    const second = cellParagraphs(table, 2, 1)[0]!;
    const firstElement = mounted.editor.getBlockElement(first.id)!;
    const secondElement = mounted.editor.getBlockElement(second.id)!;
    expect(firstElement.closest("td")).not.toBe(secondElement.closest("td"));
    expect(firstElement.closest("table")?.getAttribute("data-block-id")).toBe(table.id);
    // A point on the row, between two cells, resolves to the start of the next cell's paragraph.
    const row = firstElement.closest("tr")!;
    expect(positionFromDom(mounted.content, row, 1)).toEqual(at(second.id, 0));
  });

  it("maps positions in hidden text to the shown boundary before it in the final view", async () => {
    mounted = await mount({ fixture: "tracked.docx" }, { viewMode: "final" });
    const block = bodyParagraphs(mounted.doc).find((candidate) => candidate.text.includes("tenfifteen"))!;
    const deleted = block.runs.find((run) => run.revision?.kind === "delete")!;
    const hiddenStart = deleted.start;
    const hiddenEnd = deleted.start + deleted.text.length;
    expectRoundTrip(mounted, (candidate, offset) => {
      if (candidate.id !== block.id) {
        // Other paragraphs: offsets inside any hidden run collapse to its start.
        const run = candidate.runs.find((r) => (r.revision?.kind === "delete" || r.revision?.kind === "moveFrom") && offset > r.start && offset < r.start + r.text.length);
        return run === undefined ? offset : run.start;
      }
      return offset > hiddenStart && offset < hiddenEnd ? hiddenStart : offset;
    });
    const element = mounted.editor.getBlockElement(block.id)!;
    expect(element.textContent).toBe("The supplier shall deliver the revised report within fifteen business days.");
  });

  it("maps element-level points: the paragraph, the surface and points outside it", async () => {
    mounted = await mount({ paragraphs: ["First", "", "Third"] });
    const [first, empty, third] = bodyParagraphs(mounted.doc);
    const firstElement = mounted.editor.getBlockElement(first!.id)!;
    const emptyElement = mounted.editor.getBlockElement(empty!.id)!;
    expect(positionFromDom(mounted.content, firstElement, 0)).toEqual(at(first!.id, 0));
    expect(positionFromDom(mounted.content, firstElement, firstElement.childNodes.length)).toEqual(at(first!.id, 5));
    expect(positionFromDom(mounted.content, firstElement.firstChild!, 0)).toEqual(at(first!.id, 0));
    expect(positionFromDom(mounted.content, firstElement.firstChild!, 1)).toEqual(at(first!.id, 5));
    // An empty paragraph holds the caret before its filler line break.
    expect(positionFromDom(mounted.content, emptyElement, 0)).toEqual(at(empty!.id, 0));
    expect(positionFromDom(mounted.content, emptyElement, 1)).toEqual(at(empty!.id, 0));
    const point = domFromOffset(emptyElement, 0);
    expect(point.node).toBe(emptyElement);
    // The surface itself (select all): start of the first paragraph, end of the last.
    expect(positionFromDom(mounted.content, mounted.content, 0)).toEqual(at(first!.id, 0));
    expect(positionFromDom(mounted.content, mounted.content, mounted.content.childNodes.length)).toEqual(at(third!.id, 5));
    expect(positionFromDom(mounted.content, document.body, 0)).toBeNull();
  });

  it("does not trust text the browser put in the DOM: offsets stay inside the leaf the model rendered", async () => {
    mounted = await mount({ paragraphs: ["Hello"] });
    const [block] = bodyParagraphs(mounted.doc);
    const leaf = mounted.editor.getBlockElement(block!.id)!.querySelector("[data-s]")!;
    leaf.firstChild!.nodeValue = "Hello and a lot of text that is not in the model";
    expect(positionFromDom(mounted.content, leaf.firstChild!, 30)).toEqual(at(block!.id, 5));
  });

  it("keeps positions of a numbered paragraph clear of its label", async () => {
    mounted = await mount({ fixture: "numbering.docx" });
    const numbered = bodyParagraphs(mounted.doc).find((block) => block.numbering?.text === "1.1.")!;
    const element = mounted.editor.getBlockElement(numbered.id)!;
    const label = element.querySelector(".doc-num")!;
    expect(label.textContent).toBe("1.1.");
    expect(label.getAttribute("contenteditable")).toBe("false");
    // A point inside the label is the start of the paragraph text.
    expect(positionFromDom(mounted.content, label.firstChild!, 2)).toEqual(at(numbered.id, 0));
    const start = domFromOffset(element, 0);
    expect(label.contains(start.node)).toBe(false);
    expectRoundTrip(mounted);
  });

  it("puts the caret at the start of the text when the numbering label is clicked", async () => {
    mounted = await mount({ fixture: "numbering.docx" });
    const numbered = bodyParagraphs(mounted.doc).filter((block) => block.numbering !== null);
    mounted.editor.setSelection(at(numbered[3]!.id, 4));
    const label = mounted.editor.getBlockElement(numbered[0]!.id)!.querySelector(".doc-num")!;
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    label.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mounted.editor.getSelection()).toMatchObject({ focus: at(numbered[0]!.id, 0), collapsed: true });
    mounted.content.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "*", bubbles: true, cancelable: true }));
    expect(paragraph(mounted.doc, numbered[0]!.id).text.startsWith("*")).toBe(true);
    expect(paragraph(mounted.doc, numbered[3]!.id).text.includes("*")).toBe(false);
  });

  it("maps positions in a paragraph that runs on into the previous one in the final view", async () => {
    mounted = await mount({ paragraphs: ["Alpha", "Beta", "Gamma"] }, { viewMode: "final" });
    const [alpha, beta] = bodyParagraphs(mounted.doc);
    // Another author joins the first two paragraphs as a tracked change.
    mounted.session.apply([{ type: "deleteRange", range: { start: at(alpha!.id, 5), end: at(beta!.id, 0) } }], { track: true, author: OTHER });
    expect(mounted.doc.getPlainText({ view: "final" })).toBe("AlphaBeta\nGamma\n");
    const alphaElement = mounted.editor.getBlockElement(alpha!.id)!;
    const betaElement = mounted.editor.getBlockElement(beta!.id)!;
    expect(alphaElement.contains(betaElement)).toBe(true);
    expect(alphaElement.textContent).toBe("AlphaBeta");
    expectRoundTrip(mounted);
    const inBeta = domFromOffset(betaElement, 2);
    expect(positionFromDom(mounted.content, inBeta.node, inBeta.offset)).toEqual(at(beta!.id, 2));
  });
});
