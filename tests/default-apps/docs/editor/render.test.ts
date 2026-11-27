// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { DocxBlock, ParagraphBlock } from "../../../../home/apps/_shared/office-engine/index";
import { authorColorSlot } from "../../../../home/apps/docs/src/editor/index";
import type { ViewMode } from "../../../../home/apps/docs/src/editor/index";
import { type Mounted, OTHER, at, beforeInput, bodyParagraphs, bodyTables, caret, cellParagraphs, mount, paragraph, select, type } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

function element(id: string): HTMLElement {
  const found = m.editor.getBlockElement(id);
  if (found === null) throw new Error(`block ${id} is not shown`);
  return found;
}

/** The text of the shown body as lines: what a reader of the DOM sees, without labels and marks. */
function shownBody(): string {
  const story = m.host.querySelector(".doc-story-body")!;
  const clone = story.cloneNode(true) as HTMLElement;
  for (const decoration of Array.from(clone.querySelectorAll("[data-doc-skip]"))) decoration.remove();
  for (const lineBreak of Array.from(clone.querySelectorAll("br[data-s]"))) lineBreak.replaceWith("\n");
  return Array.from(clone.children)
    .map((child) => `${child.textContent ?? ""}\n`)
    .join("");
}

describe("rendering the view model", () => {
  it("renders headings, numbering labels, indents and alignment from the resolved styles", async () => {
    m = await mount({ fixture: "numbering.docx" });
    const blocks = bodyParagraphs(m.doc);
    expect(element(blocks[0]!.id).tagName).toBe("H1");
    for (const block of blocks) {
      const label = element(block.id).querySelector(".doc-num");
      if (block.numbering === null) expect(label).toBeNull();
      else expect(label?.textContent).toBe(block.numbering.text);
      // The label is decoration: it is not part of the paragraph's leaves.
      const leaves = Array.from(element(block.id).querySelectorAll("[data-s]")).map((leaf) => leaf.textContent).join("");
      expect(leaves).toBe(block.text);
    }
    const nested = blocks.find((block) => block.numbering?.text === "(a)")!;
    expect(element(nested.id).style.marginLeft).toBe(`${nested.style.indentLeftPt}pt`);
    expect(nested.style.indentLeftPt).toBeGreaterThan(0);
    m.session.apply([{ type: "setParagraphStyle", blockId: nested.id, style: { alignment: "right" } }]);
    expect(element(nested.id).style.textAlign).toBe("right");
  });

  it("renumbers the paragraphs after a list item that is split", async () => {
    m = await mount({ fixture: "numbering.docx" });
    const first = bodyParagraphs(m.doc).find((block) => block.numbering?.text === "1.")!;
    const second = bodyParagraphs(m.doc).find((block) => block.numbering?.text === "2.")!;
    caret(m, first.id, 5);
    beforeInput(m, "insertParagraph");
    expect(paragraph(m.doc, second.id).numbering?.text).toBe("3.");
    expect(element(second.id).querySelector(".doc-num")?.textContent).toBe("3.");
  });

  it("renders run formatting, links, tabs and fields", async () => {
    m = await mount({ fixture: "links-fields.docx" });
    const blocks = bodyParagraphs(m.doc);
    const withLink = blocks.find((block) => block.runs.some((run) => run.hyperlink?.href != null))!;
    const link = element(withLink.id).querySelector("a.doc-link")!;
    expect(link.getAttribute("href")).toBe("https://example.com/terms");
    expect(link.textContent).toBe("terms of service");
    const bold = blocks.find((block) => block.runs.some((run) => run.bold && block.style.headingLevel === 0))!;
    const boldRun = bold.runs.find((run) => run.bold)!;
    const boldLeaf = element(bold.id).querySelector<HTMLElement>(`[data-s="${boldRun.start}"]`)!;
    expect(boldLeaf.style.fontWeight).toBe("700");
    const toc = blocks.find((block) => block.text.includes("\t"))!;
    expect(element(toc.id).querySelector(".doc-tab")?.textContent).toBe("\t");
    const field = blocks.find((block) => block.runs.some((run) => run.field !== null))!;
    expect(element(field.id).querySelector(".doc-field")).not.toBeNull();
  });

  it("renders tables with merged cells, nested paragraphs and column widths", async () => {
    m = await mount({ fixture: "table.docx" });
    const table = bodyTables(m.doc)[0]!;
    const rendered = element(table.id);
    expect(rendered.tagName).toBe("TABLE");
    expect(rendered.querySelectorAll("tr")).toHaveLength(table.rows.length);
    expect(rendered.querySelectorAll("col")).toHaveLength(table.columnWidthsPt.length);
    const title = rendered.querySelector("tr")!.querySelector("td, th") as HTMLTableCellElement;
    expect(title.colSpan).toBe(table.rows[0]!.cells[0]!.colSpan);
    expect(title.colSpan).toBeGreaterThan(1);
    const shownCells = rendered.querySelectorAll("td, th").length;
    const modelCells = table.rows.flatMap((row) => row.cells).filter((cell) => !cell.mergedAbove).length;
    expect(shownCells).toBe(modelCells);
    expect(table.rows.flatMap((row) => row.cells).some((cell) => cell.rowSpan > 1)).toBe(true);
    const last = cellParagraphs(table, table.rows.length - 1, 3);
    expect(last).toHaveLength(2);
    expect(element(last[1]!.id).closest("td")).toBe(element(last[0]!.id).closest("td"));
  });

  it("renders footnote marks, the notes below the body and a read-only header and footer", async () => {
    m = await mount({ fixture: "footnotes-headers.docx" });
    const view = m.doc.getView();
    const marks = Array.from(m.host.querySelectorAll(".doc-story-body .doc-note-ref")).map((mark) => mark.textContent);
    expect(marks).toEqual(["1", "2", "3"]);
    // Raised once, by the mark itself, not a second time by the reference style of its run.
    const markLeaf = m.host.querySelector<HTMLElement>(".doc-story-body [data-object='note']")!;
    expect(markLeaf.classList.contains("doc-sup")).toBe(false);
    expect(markLeaf.style.fontSize).toBe("");
    const notes = Array.from(m.host.querySelectorAll(".doc-notes .doc-note"));
    expect(notes).toHaveLength(view.footnotes.length);
    expect(notes[0]!.textContent).toContain("Internal productivity study");
    expect(m.content.contains(notes[0]!)).toBe(true);
    const header = m.host.querySelector(".doc-header")!;
    expect(header.textContent).toContain("Confidential");
    expect(header.getAttribute("contenteditable")).toBe("false");
    expect(m.content.contains(header)).toBe(false);
    expect(m.host.querySelector(".doc-footer")!.textContent).toContain("Page");
    // A note is edited like any paragraph.
    const note = view.footnotes[0]!.blocks[0] as ParagraphBlock;
    caret(m, note.id, note.text.length);
    type(m, " (rev)");
    expect(paragraph(m.doc, note.id).text.endsWith(" (rev)")).toBe(true);
  });

  it("sizes the sheet from the section and sets text with textContent only", async () => {
    m = await mount({ paragraphs: ['<img src=x onerror="window.hacked=1"> & <b>not bold</b>'] });
    const page = m.host.querySelector<HTMLElement>(".doc-page")!;
    const section = m.doc.getView().sections[0]!;
    expect(page.style.width).toBe(`${section.pageWidthPt}pt`);
    expect(m.host.querySelector("img, b")).toBeNull();
    expect(element(bodyParagraphs(m.doc)[0]!.id).textContent).toBe('<img src=x onerror="window.hacked=1"> & <b>not bold</b>');
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });
});

describe("rendering tracked changes", () => {
  it("marks insertions, deletions and moves inline with the author's colour, and changed paragraphs in the margin", async () => {
    m = await mount({ fixture: "tracked.docx" });
    const revisions = m.doc.listRevisions();
    for (const kind of ["insert", "delete", "moveFrom", "moveTo"] as const) {
      const revision = revisions.find((candidate) => candidate.kind === kind && candidate.scope === "text")!;
      const leaf = m.host.querySelector<HTMLElement>(`.doc-rev-${kind}[data-revision-id="${revision.id}"]`);
      expect(leaf, kind).not.toBeNull();
      expect(leaf!.getAttribute("data-author-color")).toBe(String(authorColorSlot(revision.author)));
      expect(leaf!.title).toContain(revision.author);
    }
    for (const block of bodyParagraphs(m.doc)) {
      const changed = block.markRevision !== null || block.formatRevision !== null || block.runs.some((run) => run.revision !== null || run.formatRevision !== null);
      expect(element(block.id).classList.contains("doc-changed"), block.text).toBe(changed);
    }
    const table = bodyTables(m.doc)[0]!;
    const insertedRow = table.rows.findIndex((row) => row.revision?.kind === "insert");
    expect(element(table.id).querySelectorAll("tr")[insertedRow]!.classList.contains("doc-row-rev-insert")).toBe(true);
    expect(authorColorSlot("Rae Okafor")).toBe(authorColorSlot("Rae Okafor"));
    expect(authorColorSlot(OTHER)).toBeGreaterThanOrEqual(1);
    expect(authorColorSlot(OTHER)).toBeLessThanOrEqual(8);
  });

  it("shows a formatting change with a margin bar and, in the original view, the formatting before it", async () => {
    m = await mount({ paragraphs: ["Hello world"] });
    const id = bodyParagraphs(m.doc)[0]!.id;
    m.session.apply([{ type: "setRunFormat", range: { start: at(id, 0), end: at(id, 5) }, format: { bold: true } }], { track: true, author: OTHER });
    const leaf = (): HTMLElement => element(id).querySelector<HTMLElement>('[data-s="0"]')!;
    expect(element(id).classList.contains("doc-changed")).toBe(true);
    expect(leaf().classList.contains("doc-rev-format")).toBe(true);
    expect(leaf().style.fontWeight).toBe("700");
    m.editor.setViewMode("original");
    expect(leaf().style.fontWeight).toBe("");
    m.editor.setViewMode("final");
    expect(leaf().style.fontWeight).toBe("700");
    expect(element(id).classList.contains("doc-changed")).toBe(false);
  });

  it("shows the paragraph style before a tracked paragraph change in the original view: heading level and alignment", async () => {
    m = await mount({ paragraphs: ["Scope of work", "Between", "Body text"] });
    const [heading, , body] = bodyParagraphs(m.doc).map((block) => block.id);
    m.session.apply(
      [
        { type: "setParagraphStyle", blockId: heading!, style: { headingLevel: 2 } },
        { type: "setParagraphStyle", blockId: body!, style: { alignment: "center" } },
      ],
      { track: true, author: OTHER },
    );
    expect(element(heading!).tagName).toBe("H2");
    expect(element(body!).style.textAlign).toBe("center");
    m.editor.setViewMode("original");
    expect(element(heading!).tagName).toBe("P");
    expect(element(heading!).hasAttribute("data-heading")).toBe(false);
    expect(element(heading!).getAttribute("data-style-id")).toBe(bodyParagraphs(m.doc)[1]!.style.styleId);
    expect(element(body!).style.textAlign).toBe("");
    m.editor.setViewMode("final");
    expect(element(heading!).tagName).toBe("H2");
    expect(element(body!).style.textAlign).toBe("center");
  });

  it("restores each paragraph's own old style when one tracked change covers several paragraphs", async () => {
    m = await mount({ paragraphs: ["One", "Two", "Three"] });
    const [one, two, three] = bodyParagraphs(m.doc).map((block) => block.id);
    m.session.apply([{ type: "setParagraphStyle", blockId: three!, style: { alignment: "right" } }], { track: false });
    // Adjacent paragraphs changed by one author in one minute make one revision.
    m.session.apply([one, two, three].map((blockId) => ({ type: "setParagraphStyle" as const, blockId: blockId!, style: { alignment: "center" as const } })), { track: true, author: OTHER });
    expect(m.doc.listRevisions()).toHaveLength(1);
    m.editor.setViewMode("original");
    expect([one, two, three].map((id) => element(id!).style.textAlign)).toEqual(["", "", "right"]);
    m.editor.setViewMode("markup");
    expect([one, two, three].map((id) => element(id!).style.textAlign)).toEqual(["center", "center", "center"]);
  });

  it("never gives a paragraph the old style of another paragraph in the same change", async () => {
    m = await mount({ paragraphs: ["Title", "Body text"] });
    const [title, body] = bodyParagraphs(m.doc).map((block) => block.id);
    m.session.apply([{ type: "setParagraphStyle", blockId: title!, style: { headingLevel: 1 } }], { track: false });
    const bodyStyle = paragraph(m.doc, body!).style.styleId;
    m.session.apply(
      [
        { type: "setParagraphStyle", blockId: title!, style: { headingLevel: 0 } },
        { type: "setParagraphStyle", blockId: body!, style: { alignment: "center" } },
      ],
      { track: true, author: OTHER },
    );
    m.editor.setViewMode("original");
    expect(element(title!).tagName).toBe("H1");
    expect(element(body!).tagName).toBe("P");
    expect(element(body!).getAttribute("data-style-id")).toBe(bodyStyle);
    expect(element(body!).style.textAlign).toBe("");
    // Reading the old styles leaves the document as it was.
    expect(m.doc.listRevisions()).toHaveLength(1);
    expect(paragraph(m.doc, body!).style.alignment).toBe("center");
    expect(m.session.getState().dirty).toBe(true);
    m.editor.undo();
    expect(paragraph(m.doc, body!).style.alignment).toBe("left");
  });

  it("hides what a view drops: deleted paragraphs and rows in final, inserted ones in original", async () => {
    m = await mount({ fixture: "tracked.docx" });
    const blocks = bodyParagraphs(m.doc);
    const deleted = blocks.find((block) => block.markRevision?.kind === "delete" && block.runs.every((run) => run.revision?.kind === "delete"))!;
    const inserted = blocks.find((block) => block.markRevision?.kind === "insert" && block.runs.every((run) => run.revision?.kind === "insert"))!;
    const table = bodyTables(m.doc)[0]!;
    m.editor.setViewMode("final");
    expect(m.editor.getBlockElement(deleted.id)).toBeNull();
    expect(m.editor.getBlockElement(inserted.id)).not.toBeNull();
    expect(element(table.id).querySelectorAll("tr")).toHaveLength(2);
    m.editor.setViewMode("original");
    expect(m.editor.getBlockElement(deleted.id)).not.toBeNull();
    expect(m.editor.getBlockElement(inserted.id)).toBeNull();
    expect(element(table.id).querySelectorAll("tr")).toHaveLength(1);
    m.editor.setViewMode("markup");
    expect(m.editor.getBlockElement(deleted.id)).not.toBeNull();
    expect(m.editor.getBlockElement(inserted.id)).not.toBeNull();
  });

  it("shows the same text as the engine in every view after a run of tracked edits", async () => {
    m = await mount({ paragraphs: ["Alpha one", "Beta two", "Gamma three", "Delta four", "Epsilon five"] }, { tracking: true });
    const [a, b, c, d, e] = bodyParagraphs(m.doc).map((block) => block.id);
    // The owner and another author edit, joining, splitting and removing paragraphs.
    caret(m, b!, 0);
    beforeInput(m, "deleteContentBackward");
    caret(m, c!, 5);
    beforeInput(m, "insertParagraph");
    type(m, "new ");
    select(m, at(d!, 0), at(e!, 0));
    beforeInput(m, "deleteContentBackward");
    m.session.apply([{ type: "insertParagraphAfter", blockId: e!, text: "Zeta six" }], { track: true, author: OTHER });
    m.session.apply([{ type: "deleteRange", range: { start: at(a!, 0), end: at(a!, 6) } }], { track: true, author: OTHER });
    for (const mode of ["markup", "final", "original"] as ViewMode[]) {
      m.editor.setViewMode(mode);
      expect(shownBody(), mode).toBe(m.doc.getPlainText({ view: mode }));
    }
    // Still true after part of it is resolved and after undo.
    m.editor.setViewMode("final");
    const first = m.doc.listRevisions()[0]!;
    m.session.acceptRevisions([first.id]);
    expect(shownBody()).toBe(m.doc.getPlainText({ view: "final" }));
    m.session.undo();
    m.session.rejectRevisions("all");
    expect(shownBody()).toBe("Alpha one\nBeta two\nGamma three\nDelta four\nEpsilon five\n");
  });

  it("keeps the DOM in step with the model: every shown paragraph's leaves spell its visible text", async () => {
    m = await mount({ fixture: "contract.docx" }, { tracking: true });
    const all = (blocks: readonly DocxBlock[]): ParagraphBlock[] =>
      blocks.flatMap((block) => (block.type === "paragraph" ? [block] : block.type === "table" ? block.rows.flatMap((row) => row.cells.flatMap((cell) => all(cell.blocks))) : []));
    const target = bodyParagraphs(m.doc).find((block) => block.text.length > 40)!;
    select(m, at(target.id, 5), at(target.id, 20));
    type(m, "changed");
    beforeInput(m, "insertParagraph");
    let checked = 0;
    for (const block of all(m.doc.getView().body.blocks)) {
      const shown = m.editor.getBlockElement(block.id);
      if (shown === null) continue;
      const leaves = Array.from(shown.querySelectorAll<HTMLElement>("[data-s]")).filter((leaf) => leaf.closest("[data-block-type='paragraph']") === shown);
      let expected = 0;
      for (const leaf of leaves) {
        expect(Number(leaf.getAttribute("data-s"))).toBe(expected);
        expected += Number(leaf.getAttribute("data-l"));
      }
      expect(expected).toBe(block.text.length);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});
