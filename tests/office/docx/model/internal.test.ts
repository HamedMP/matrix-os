import { describe, expect, it } from "vitest";

import type { DocxDocument, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import type { XmlElement } from "../../../../packages/office/src/api/xml.js";
import {
  type DocxIndex,
  atomInView,
  getDocxIndex,
  liftToParagraph,
  markupToViewOffset,
  openDocxWith,
  paragraphText,
  resolvePosition,
  scanText,
  splitContainerAt,
  splitRunAt,
  textSegments,
  viewToMarkupOffset,
} from "../../../../packages/office/src/docx/internal.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import {
  appendChild,
  createElement,
  findAll,
  getAttr,
  insertBefore,
  serializeXml,
} from "../../../../packages/office/src/xml/index.js";
import { buildDocument, buildPackage, p, r } from "./build.js";
import { loadFixture, openFixture, paragraphStarting } from "./helpers.js";

async function open(name: string): Promise<{ document: DocxDocument; index: DocxIndex }> {
  const document = await openFixture(name);
  return { document, index: getDocxIndex(document) };
}

function blockStarting(document: DocxDocument, prefix: string): ParagraphBlock {
  return paragraphStarting(document.getView().body, prefix);
}

const thrown = (code: Parameters<typeof isOfficeError>[1]) => expect.toSatisfy((error) => isOfficeError(error, code));

describe("internal index: blocks and scans", () => {
  it("finds the XML element, story and container of a block id", async () => {
    const { document, index } = await open("table.docx");
    const view = document.getView();
    const heading = view.body.blocks[0] as ParagraphBlock;
    const record = index.requireBlock(heading.id, "paragraph");
    expect(record.element.name).toBe("w:p");
    expect(record).toMatchObject({ storyId: "body", parentTableId: null, topLevelId: heading.id, indexInContainer: 0 });
    expect(record.container.name).toBe("w:body");
    expect(index.blockOf(record.element)).toBe(record);

    const table = index.requireBlock(view.body.blocks[2]!.id, "table");
    expect(table.element.name).toBe("w:tbl");
    const nested = index.blocksIn(findAll(table.element, "w:tc")[0]!)[0]!;
    expect(nested).toMatchObject({ parentTableId: table.id, topLevelId: table.id, type: "paragraph" });
    expect(nested.container.name).toBe("w:tc");
    expect(index.story("body")?.paragraphs).toHaveLength(21);

    expect(() => index.requireBlock("missing")).toThrowError(thrown("stale_reference"));
    expect(() => index.requireBlock(table.id, "paragraph")).toThrowError(thrown("invalid_operation"));
    expect(index.block("missing")).toBeNull();
  });

  it("scans a paragraph into atoms that cover runs, tabs, breaks and hyphens", async () => {
    const { document, index } = await open("unicode.docx");
    const tabs = index.scan(blockStarting(document, "Name").id);
    expect(tabs.atoms.map((atom) => [atom.start, atom.kind, atom.text, atom.node.name])).toEqual([
      [0, "text", "Name", "w:t"],
      [4, "tab", "\t", "w:tab"],
      [5, "text", "Value", "w:t"],
      [10, "tab", "\t", "w:tab"],
      [11, "text", "Notes", "w:t"],
    ]);
    expect(new Set(tabs.atoms.map((atom) => atom.run)).size).toBe(1);
    const hyphens = index.scan(blockStarting(document, "well").id);
    expect(hyphens.atoms.map((atom) => atom.kind)).toEqual(["text", "noBreakHyphen", "text", "softHyphen", "text"]);
    expect(index.scan(blockStarting(document, "First line").id).atoms[1]).toMatchObject({ kind: "lineBreak", text: "\n" });
  });

  it("leaves field codes out of the text and ties field results to their field", async () => {
    const { document, index } = await open("links-fields.docx");
    const scan = index.scan(blockStarting(document, "As explained in").id);
    expect(scan.text).toBe("As explained in Definitions on page 1, terms are capitalised.");
    const result = scan.atoms.find((atom) => atom.text === "Definitions")!;
    expect(result.context.fields).toHaveLength(1);
    expect(result.context.fields[0]).toMatchObject({ state: "result", instruction: " REF _Ref_Definitions \\h " });
    expect(result.context.fields[0]?.key.name).toBe("w:fldChar");
    expect(scan.atoms[0]?.context.fields).toHaveLength(0);
    // The table of contents begins in one paragraph and ends in the next.
    const second = index.scan(blockStarting(document, "2 Definitions").id);
    expect(second.fieldsIn).toHaveLength(1);
    expect(second.fieldsOut).toHaveLength(0);
    const link = index.scan(blockStarting(document, "Read the full").id).atoms.find((atom) => atom.text === "definitions")!;
    expect(getAttr(link.context.hyperlink!, "w:anchor")).toBe("_Ref_Definitions");
  });

  it("iterates the text of a paragraph in the original, final and markup views", async () => {
    const { document, index } = await open("tracked.docx");
    const scan = index.scan(blockStarting(document, "Fees are fixed").id);
    expect(scanText(scan, "markup")).toBe("Fees are fixed for the initial term. Thereafter fees may rise by up to fivethree percent.");
    expect(scanText(scan, "final")).toBe("Fees are fixed for the initial term. Thereafter fees may rise by up to three percent.");
    expect(scanText(scan, "original")).toBe("Fees are fixed for the initial term.");
    expect(paragraphText(scan, "final", 36, 75)).toBe(" Thereafter fees may rise by up to ");
    const five = scan.atoms.find((atom) => atom.text === "five")!;
    expect(five.node.name).toBe("w:delText");
    expect(five.context.revisions.map((element) => element.name)).toEqual(["w:ins", "w:del"]);
    expect([atomInView(five, "final"), atomInView(five, "original"), atomInView(five, "markup")]).toEqual([false, false, true]);
    expect(textSegments(scan, "final").map((segment) => [segment.markupStart, segment.viewStart, segment.text])).toEqual([
      [0, 0, "Fees are fixed for the initial term."],
      [36, 36, " Thereafter fees may rise by up to "],
      [75, 71, "three"],
      [80, 76, " percent."],
    ]);
    expect(scan.mark).toBeNull();
    expect(index.scan(blockStarting(document, "This obsolete").id).mark?.name).toBe("w:del");
  });

  it("converts offsets between a view and the markup text", async () => {
    const { document, index } = await open("tracked.docx");
    const scan = index.scan(blockStarting(document, "The supplier shall").id);
    // Markup: "…report within " + del "ten" (53..56) + ins "fifteen" (56..63) + " business days."
    expect(markupToViewOffset(scan, "final", 56)).toBe(53);
    expect(markupToViewOffset(scan, "final", 63)).toBe(60);
    expect(markupToViewOffset(scan, "original", 63)).toBe(48);
    expect(markupToViewOffset(scan, "markup", 63)).toBe(63);
    expect(viewToMarkupOffset(scan, "final", 53, "before")).toBe(53);
    expect(viewToMarkupOffset(scan, "final", 53, "after")).toBe(56);
    expect(viewToMarkupOffset(scan, "final", 54)).toBe(57);
    expect(viewToMarkupOffset(scan, "final", 0)).toBe(0);
    expect(viewToMarkupOffset(scan, "final", 999)).toBe(scan.text.length);
    expect(viewToMarkupOffset(scan, "original", 34, "after")).toBe(42);
    for (let offset = 0; offset <= scanText(scan, "final").length; offset++) {
      expect(markupToViewOffset(scan, "final", viewToMarkupOffset(scan, "final", offset, "before"))).toBe(offset);
      expect(markupToViewOffset(scan, "final", viewToMarkupOffset(scan, "final", offset, "after"))).toBe(offset);
    }
  });
});

describe("internal index: positions and splitting", () => {
  it("maps a position to the atom, run and offset it falls in", async () => {
    const { document, index } = await open("unicode.docx");
    const block = blockStarting(document, "Mat");
    const inside = resolvePosition(index, { blockId: block.id, offset: 4 });
    expect(inside.atom?.text).toBe("rix");
    expect(inside.offsetInAtom).toBe(1);
    expect(inside.before).toBe(inside.atom);
    const boundary = resolvePosition(index, { blockId: block.id, offset: 3 });
    expect([boundary.before?.text, boundary.atom?.text, boundary.offsetInAtom]).toEqual(["Mat", "rix", 0]);
    expect(boundary.atom?.run).not.toBe(boundary.before?.run);
    const start = resolvePosition(index, { blockId: block.id, offset: 0 });
    expect([start.before, start.atom?.text]).toEqual([null, "Mat"]);
    const end = resolvePosition(index, { blockId: block.id, offset: block.text.length });
    expect([end.atom, end.atomIndex]).toEqual([null, end.scan.atoms.length]);
    expect(end.before?.text.endsWith('"quotes"')).toBe(true);

    expect(() => resolvePosition(index, { blockId: block.id, offset: block.text.length + 1 })).toThrowError(thrown("stale_reference"));
    expect(() => resolvePosition(index, { blockId: block.id, offset: -1 })).toThrowError(thrown("stale_reference"));
    expect(() => resolvePosition(index, { blockId: block.id, offset: 1.5 })).toThrowError(thrown("stale_reference"));
    expect(() => resolvePosition(index, { blockId: "gone", offset: 0 })).toThrowError(thrown("stale_reference"));
  });

  it("splits a run inside its text and keeps the run properties on both halves", async () => {
    const { document, index } = await open("unicode.docx");
    const block = blockStarting(document, "  two leading");
    const before = document.getBlock(block.id) as ParagraphBlock;
    const boundary = splitRunAt(index, { blockId: block.id, offset: 42 });
    expect(serializeXml(boundary.before!)).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> sp</w:t></w:r>');
    expect(serializeXml(boundary.after!)).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">aced </w:t></w:r>');
    expect(boundary.point.before).toBe(boundary.after);
    expect(boundary.point.parent.name).toBe("w:p");
    // The view is unchanged: same id, same text, same merged runs.
    expect(document.getBlock(block.id)).toEqual(before);
    // Splitting at an existing boundary changes nothing.
    const xml = serializeXml(index.requireBlock(block.id).element);
    const again = splitRunAt(index, { blockId: block.id, offset: 42 });
    expect(serializeXml(index.requireBlock(block.id).element)).toBe(xml);
    expect([again.before, again.after]).toEqual([boundary.before, boundary.after]);
  });

  it("splits a run between text and a tab, and reports the edges of a paragraph", async () => {
    const { document, index } = await open("unicode.docx");
    const block = blockStarting(document, "Name");
    const boundary = splitRunAt(index, { blockId: block.id, offset: 4 });
    expect(serializeXml(boundary.before!)).toBe("<w:r><w:t>Name</w:t></w:r>");
    expect(serializeXml(boundary.after!)).toBe("<w:r><w:tab/><w:t>Value</w:t><w:tab/><w:t>Notes</w:t></w:r>");
    expect((document.getBlock(block.id) as ParagraphBlock).text).toBe("Name\tValue\tNotes");

    const start = splitRunAt(index, { blockId: block.id, offset: 0 });
    expect([start.before, start.after, start.point.before]).toEqual([null, boundary.before, boundary.before]);
    const end = splitRunAt(index, { blockId: block.id, offset: block.text.length });
    expect([end.before, end.after, end.point.before]).toEqual([boundary.after, null, null]);
    expect(end.point.parent).toBe(index.requireBlock(block.id).element);
  });

  it("keeps typed text out of a field result and a hyperlink that end at the position", async () => {
    const { document, index } = await open("links-fields.docx");
    const explained = blockStarting(document, "As explained in");
    // "As explained in " + REF result "Definitions" (16..27) + " on page " + PAGEREF result "1" + ...
    const end = splitRunAt(index, { blockId: explained.id, offset: 27 });
    expect(serializeXml(end.before!)).toBe("<w:r><w:t>Definitions</w:t></w:r>");
    expect(end.point).toBe(end.beforeNext);
    expect(serializeXml(end.point.before as XmlElement)).toBe('<w:r><w:t xml:space="preserve"> on page </w:t></w:r>');
    expect(serializeXml(end.afterPrevious!.before as XmlElement)).toBe('<w:r><w:fldChar w:fldCharType="end"/></w:r>');
    // In front of the field, text joins the run before it.
    const start = splitRunAt(index, { blockId: explained.id, offset: 16 });
    expect(start.point).toBe(start.afterPrevious);
    expect(serializeXml(start.point.before as XmlElement)).toBe('<w:r><w:fldChar w:fldCharType="begin"/></w:r>');

    const read = blockStarting(document, "Read the full");
    const afterLink = splitRunAt(index, { blockId: read.id, offset: 30 });
    expect(afterLink.afterPrevious?.parent.name).toBe("w:hyperlink");
    expect(afterLink.point.parent.name).toBe("w:p");
    const inLink = splitRunAt(index, { blockId: read.id, offset: 20 });
    expect(inLink.point.parent.name).toBe("w:hyperlink");
    expect(document.getPlainText()).toBe((await openFixture("links-fields.docx")).getPlainText());
  });

  it("refuses to split a surrogate pair", async () => {
    const { document, index } = await open("unicode.docx");
    const block = blockStarting(document, "Launch");
    expect(block.text.slice(7, 9)).toBe("\u{1F680}");
    expect(() => splitRunAt(index, { blockId: block.id, offset: 8 })).toThrowError(thrown("invalid_argument"));
    expect(splitRunAt(index, { blockId: block.id, offset: 9 }).after).not.toBeNull();
  });

  it("gives a split revision wrapper a fresh w:id and keeps the revision whole", async () => {
    const { document, index } = await open("tracked.docx");
    const block = blockStarting(document, "The supplier shall");
    const revisionsBefore = document.listRevisions();
    const boundary = splitRunAt(index, { blockId: block.id, offset: 35 });
    expect(boundary.point.parent.name).toBe("w:ins");
    const lifted = liftToParagraph(index, boundary.point);
    expect(lifted.parent).toBe(index.requireBlock(block.id).element);
    const tail = lifted.before as XmlElement;
    expect(tail.name).toBe("w:ins");
    expect(serializeXml(tail)).toMatch(/^<w:ins w:id="124" w:author="Alex Morgan" w:date="2026-01-05T09:30:00Z"><w:r><w:t xml:space="preserve">sed <\/w:t><\/w:r><\/w:ins>$/);
    // Two elements, still one logical revision with the id it had.
    expect(document.listRevisions()).toEqual(revisionsBefore);
    expect(index.revisions.groups[0]?.members).toHaveLength(2);
    // At the edge of a wrapper nothing is cut.
    const edge = splitRunAt(index, { blockId: block.id, offset: 39 });
    const count = findAll(index.requireBlock(block.id).element, "w:ins").length;
    const outside = splitContainerAt(index, edge.point);
    expect(outside.parent.name).toBe("w:p");
    expect(findAll(index.requireBlock(block.id).element, "w:ins")).toHaveLength(count);
  });

  it("allocates ids that no element of the document uses", async () => {
    const { index } = await open("tracked.docx");
    expect([index.allocateAnnotationId(), index.allocateAnnotationId()]).toEqual(["124", "125"]);
    const comments = await open("comments.docx");
    expect([comments.index.allocateCommentId(), comments.index.allocateCommentId()]).toEqual(["3", "4"]);
    expect(comments.index.allocateParaId()).toBe("1A2B3C04");
    expect(comments.index.allocateParaId()).toBe("1A2B3C05");
    const plain = await open("basic.docx");
    expect(plain.index.allocateCommentId()).toBe("0");
    expect(plain.index.allocateParaId()).toMatch(/^[0-9A-F]{8}$/);
  });
});

describe("internal index: edits, dirty tracking and snapshots", () => {
  /** Inserts a paragraph with the given text in front of a block, the way an editing engine would. */
  function insertParagraphBefore(index: DocxIndex, blockId: string, text: string): XmlElement {
    const target = index.requireBlock(blockId).element;
    const paragraph = createElement("w:p", [], [createElement("w:r", [], [createElement("w:t", [], [text])])]);
    insertBefore(target, paragraph);
    index.markDirty(paragraph);
    return paragraph;
  }

  it("keeps block ids stable when blocks are added around them and never reuses an id", async () => {
    const { document, index } = await open("numbering.docx");
    const before = document.getView().body.blocks.map((block) => block.id);
    const added = insertParagraphBefore(index, before[0]!, "A new first paragraph");
    const after = document.getView().body.blocks;
    expect(after.slice(1).map((block) => block.id)).toEqual(before);
    const newId = index.blockOf(added)!.id;
    expect(after[0]).toMatchObject({ id: newId, text: "A new first paragraph" });
    expect(before).not.toContain(newId);
  });

  it("recomputes numbering labels after a structural edit", async () => {
    const { document, index } = await open("numbering.docx");
    const scope = blockStarting(document, "Scope of work");
    const record = index.requireBlock(scope.id);
    const copy = createElement("w:p", [], [
      createElement("w:pPr", [], [
        createElement("w:pStyle", { "w:val": "ListParagraph" }),
        createElement("w:numPr", [], [createElement("w:ilvl", { "w:val": "0" }), createElement("w:numId", { "w:val": "1" })]),
      ]),
      createElement("w:r", [], [createElement("w:t", [], ["Preliminaries"])]),
    ]);
    insertBefore(record.element, copy);
    index.markDirty(copy);
    expect(blockStarting(document, "Preliminaries").numbering?.text).toBe("1.");
    expect((document.getBlock(scope.id) as ParagraphBlock).numbering?.text).toBe("2.");
    expect(blockStarting(document, "Discovery workshops").numbering?.text).toBe("2.1.");
    // The restarted list is not affected.
    expect(blockStarting(document, "Collect feedback").numbering?.text).toBe("1.");
  });

  it("reindexes an edited paragraph and saves only the changed part", async () => {
    const { document, index } = await open("contract.docx");
    const block = blockStarting(document, "2.2\t");
    const paragraph = index.requireBlock(block.id).element;
    const { point } = splitRunAt(index, { blockId: block.id, offset: block.text.length });
    expect(point).toEqual({ parent: paragraph, before: null });
    // Change the tree with the XML helpers, then tell the index.
    appendChild(
      point.parent,
      createElement("w:r", [], [createElement("w:t", [["xml:space", "preserve"]], [" See also clause 99."])]),
    );
    index.markDirty(paragraph);

    const edited = document.getBlock(block.id) as ParagraphBlock;
    expect(edited.text.endsWith("current period. See also clause 99.")).toBe(true);
    const broken = document.getCrossReferences().filter((reference) => reference.broken);
    expect(broken.map((reference) => reference.text)).toEqual(["clause 99", "clause 14.3"]);

    const saved = await document.save();
    const reopened = await openDocx(saved);
    expect(reopened.getPlainText()).toBe(document.getPlainText());
    const modified = document.package.listParts({ includeRelationships: true }).filter((part) => part.modified);
    expect(modified.map((part) => part.name)).toEqual(["/word/document.xml"]);
  });

  it("restores trees, ids and text from a snapshot, and shares unchanged blocks", async () => {
    const { document, index } = await open("tracked.docx");
    const original = document.getView();
    const revisions = document.listRevisions();
    const first = document.snapshot();
    expect(document.snapshot()).not.toBe(first);

    const block = blockStarting(document, "Payment terms");
    const added = insertParagraphBefore(index, block.id, "Inserted for the test");
    splitRunAt(index, { blockId: block.id, offset: 4 });
    const addedId = index.blockOf(added)!.id;
    expect(document.getView().body.blocks).toHaveLength(original.body.blocks.length + 1);
    const second = document.snapshot();

    document.restore(first);
    expect(document.getView()).toEqual(original);
    expect(document.listRevisions()).toEqual(revisions);
    expect(document.getBlock(addedId)).toBeNull();
    // Restoring the opened state leaves nothing to write.
    await document.save();
    expect(document.package.listParts().filter((part) => part.modified)).toEqual([]);

    document.restore(second);
    expect(document.getBlock(addedId)).toMatchObject({ text: "Inserted for the test" });
    expect(document.getView().body.blocks).toHaveLength(original.body.blocks.length + 1);
    document.restore(first);
    expect(document.getView()).toEqual(original);

    // A later block never gets the id of the one that was removed by the restore.
    const again = insertParagraphBefore(index, block.id, "Another");
    expect(index.blockOf(again)!.id).not.toBe(addedId);
  });

  it("rejects a snapshot of another document", async () => {
    const one = await openFixture("basic.docx");
    const other = await openFixture("basic.docx");
    expect(() => one.restore(other.snapshot())).toThrowError(thrown("invalid_argument"));
    expect(() => one.restore({ kind: "docx-snapshot" })).toThrowError(thrown("invalid_argument"));
  });

  it("copies only the blocks an edit touched into the next snapshot", async () => {
    const { document, index } = await open("contract.docx");
    interface Entry { slot: { name: string }; part: { units: unknown[] } }
    const unitsOf = (snapshot: unknown): unknown[] =>
      (snapshot as { entries: Entry[] }).entries.find((entry) => entry.slot.name === "/word/document.xml")!.part.units;
    const before = unitsOf(document.snapshot());
    splitRunAt(index, { blockId: blockStarting(document, "2.2\t").id, offset: 10 });
    const after = unitsOf(document.snapshot());
    expect(after).toHaveLength(before.length);
    expect(after.filter((unit, position) => unit !== before[position])).toHaveLength(1);
  });

  it("creates a missing part on demand and registers it when the document is saved", async () => {
    const { document, index } = await open("basic.docx");
    expect(index.partRoot("comments")).toBeNull();
    const snapshot = document.snapshot();
    const root = index.ensurePart("comments");
    expect(root.name).toBe("w:comments");
    expect(index.ensurePart("comments")).toBe(root);
    expect(document.package.hasPart("/word/comments.xml")).toBe(false);

    const saved = await document.save();
    const reopened = await openDocx(saved);
    expect(reopened.package.hasPart("/word/comments.xml")).toBe(true);
    expect(reopened.package.getContentType("/word/comments.xml")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    );
    expect(reopened.package.getRelationships("/word/document.xml").filter((r) => r.target === "comments.xml")).toHaveLength(1);
    expect(reopened.listComments()).toEqual([]);

    // Restoring to before the part existed removes it again on the next save.
    document.restore(snapshot);
    expect(index.partRoot("comments")).toBeNull();
    const again = await openDocx(await document.save());
    expect(again.package.hasPart("/word/comments.xml")).toBe(false);
    expect(again.package.getRelationships("/word/document.xml").some((r) => r.target === "comments.xml")).toBe(false);
  });

  it("forgets styles that a restore removes", () => {
    const document = buildDocument({ body: p(r("text")) });
    const index = getDocxIndex(document);
    const block = document.getView().body.blocks[0] as ParagraphBlock;
    const snapshot = document.snapshot();
    const styles = index.ensurePart("styles");
    appendChild(
      styles,
      createElement("w:style", { "w:type": "paragraph", "w:default": "1", "w:styleId": "Normal" }, [
        createElement("w:name", { "w:val": "Normal" }),
        createElement("w:rPr", [], [createElement("w:b")]),
      ]),
    );
    index.markDirty(styles);
    expect(document.getBlock(block.id)).toMatchObject({ style: { styleId: "Normal" }, runs: [{ bold: true }] });
    document.restore(snapshot);
    expect(document.getBlock(block.id)).toMatchObject({ style: { styleId: null }, runs: [{ bold: false }] });
  });

  it("writes an edited part back in UTF-16 when its declaration says so", async () => {
    const { pkg } = buildPackage({ body: p(r("caf\u00E9 \u{1F680}")) });
    const text = (await pkg.getPartText("/word/document.xml")).replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let at = 0; at < text.length; at++) bytes.set([text.charCodeAt(at) & 0xff, text.charCodeAt(at) >> 8], 2 + at * 2);
    pkg.setPart("/word/document.xml", bytes);
    const document = await openDocx(await pkg.save());
    const block = document.getView().body.blocks[0] as ParagraphBlock;
    expect(block.text).toBe("caf\u00E9 \u{1F680}");
    splitRunAt(getDocxIndex(document), { blockId: block.id, offset: 3 });
    const saved = await openDocx(await document.save());
    const written = await saved.package.getPartBytes("/word/document.xml");
    expect([written[0], written[1]]).toEqual([0xff, 0xfe]);
    expect(saved.getPlainText()).toBe("caf\u00E9 \u{1F680}\n");
  });

  it("sets and clears the track-revisions flag in settings.xml", async () => {
    const document = await openFixture("basic.docx");
    expect(document.getTrackRevisions()).toBe(false);
    document.setTrackRevisions(false);
    expect(document.package.listParts().filter((part) => part.modified)).toEqual([]);
    document.setTrackRevisions(true);
    expect(document.getTrackRevisions()).toBe(true);
    expect(document.getView().trackRevisions).toBe(true);
    const reopened = await openDocx(await document.save());
    expect(reopened.getTrackRevisions()).toBe(true);
    const settings = await reopened.package.getPartText("/word/settings.xml");
    // Schema order: after w:proofState, before w:defaultTabStop.
    expect(settings).toContain('<w:proofState w:spelling="clean" w:grammar="clean"/><w:trackRevisions/><w:defaultTabStop w:val="720"/>');
    reopened.setTrackRevisions(false);
    expect(await (await openDocx(await reopened.save())).package.getPartText("/word/settings.xml")).toBe(
      await (await openFixture("basic.docx")).package.getPartText("/word/settings.xml"),
    );
  });

  it("throws invalid_operation from the editing methods when no engine is plugged in", async () => {
    const bare = await openDocxWith({}, loadFixture("basic.docx"));
    expect(() => bare.applyOps([], { track: true, author: "A", date: "2026-01-01T00:00:00Z" })).toThrowError(thrown("invalid_operation"));
    expect(() => bare.acceptRevisions("all")).toThrowError(thrown("invalid_operation"));
    const calls: unknown[] = [];
    const wired = await openDocxWith(
      {
        applyOps: (index, ops, options) => {
          calls.push([index === getDocxIndex(wired), ops.length, options.author]);
          return { results: [], revisionIds: [], createdBlockIds: [], removedBlockIds: [], changedBlockIds: [], changedStoryIds: [], positions: [] };
        },
      },
      loadFixture("basic.docx"),
    );
    wired.applyOps([], { track: false, author: "Sam", date: "2026-01-01T00:00:00Z" });
    expect(calls).toEqual([[true, 0, "Sam"]]);
    expect(() => getDocxIndex({} as DocxDocument)).toThrowError(thrown("invalid_argument"));
  });
});
