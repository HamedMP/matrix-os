import { describe, expect, it } from "vitest";

import type { DocxDocument, DocxOp, ParagraphBlock } from "../../../../packages/office/src/api/docx.js";
import { openDocx } from "../../../../packages/office/src/docx/index.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { expectedText, loadFixture } from "../model/helpers.js";
import { p, r } from "../model/build.js";
import { DATE, DIRECT, RAE, TRACKED, bodyXml, build, documentXml, paragraphStarting, paragraphs, revisionXmlIds, text } from "./helpers.js";

/** Indexes of the top-level body nodes whose XML differs between two states. */
function changedNodes(before: string[], after: string[]): number[] {
  expect(after).toHaveLength(before.length);
  return before.map((xml, at) => (xml === after[at] ? -1 : at)).filter((at) => at >= 0);
}

function topLevelIndex(doc: DocxDocument, blockId: string): number {
  return doc.getView().body.blocks.filter((block) => block.type !== "sectionBreak").findIndex((block) => block.id === blockId);
}

describe("applyOps through the public module", () => {
  it("edits a real contract with tracked revisions and touches only the edited paragraphs", async () => {
    const doc = await openDocx(loadFixture("contract.docx"));
    const original = text(doc, "markup");
    expect(original).toBe(expectedText("contract.docx.txt"));
    const before = bodyXml(doc);
    const term = paragraphs(doc).find((block) => block.text.includes("24 months")) as ParagraphBlock;
    const notice = paragraphs(doc).find((block) => block.text.includes("90 days")) as ParagraphBlock;
    const payment = paragraphs(doc).find((block) => block.text.includes("30 days")) as ParagraphBlock;
    const at = (block: ParagraphBlock, needle: string) => block.text.indexOf(needle);
    const ops: DocxOp[] = [
      {
        type: "replaceRange",
        range: { start: { blockId: payment.id, offset: at(payment, "30 days") }, end: { blockId: payment.id, offset: at(payment, "30 days") + 2 } },
        text: "45",
      },
      {
        type: "replaceRange",
        range: { start: { blockId: notice.id, offset: 0 }, end: { blockId: notice.id, offset: notice.text.length } },
        text: notice.text.replace("90 days", "60 days"),
        granularity: "words",
      },
      { type: "insertText", at: { blockId: term.id, offset: at(term, "24 months") }, text: "at least " },
    ];
    const result = doc.applyOps(ops, { ...TRACKED, positions: [{ blockId: term.id, offset: term.text.length }] });

    const touched = [term, notice, payment].map((block) => topLevelIndex(doc, block.id)).sort((a, b) => a - b);
    expect(changedNodes(before, bodyXml(doc))).toEqual(touched);
    expect(result.changedBlockIds.sort()).toEqual([term.id, notice.id, payment.id].sort());
    expect(result.createdBlockIds).toEqual([]);
    expect(result.removedBlockIds).toEqual([]);
    expect(result.changedStoryIds).toEqual(["body"]);
    expect(result.positions).toEqual([{ blockId: term.id, offset: term.text.length + "at least ".length }]);
    expect(result.results.map((entry) => entry.revisionIds.length)).toEqual([2, 2, 1]);
    expect(result.revisionIds).toEqual(doc.listRevisions().map((revision) => revision.id));
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text, revision.author, revision.date])).toEqual(
      expect.arrayContaining([
        ["delete", "30", RAE, DATE],
        ["insert", "45", RAE, DATE],
        ["delete", "90", RAE, DATE],
        ["insert", "60", RAE, DATE],
        ["insert", "at least ", RAE, DATE],
      ]),
    );
    const ids = revisionXmlIds(doc);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(text(doc, "original")).toBe(original);

    // Every other part of the package is byte for byte what it was.
    const source = await openDocx(loadFixture("contract.docx"));
    const saved = await openDocx(await doc.save());
    for (const part of source.package.listParts()) {
      if (part.name === "/word/document.xml") continue;
      expect(await saved.package.getPartBytes(part.name), part.name).toEqual(await source.package.getPartBytes(part.name));
    }
    expect(saved.listRevisions()).toHaveLength(5);
    saved.acceptRevisions("all");
    expect(text(saved, "markup")).toBe(
      original.replace("30 days", "45 days").replace("90 days", "60 days").replace("24 months", "at least 24 months"),
    );
    const untouched = await openDocx(await doc.save());
    untouched.rejectRevisions("all");
    expect(text(untouched, "markup")).toBe(original);
  });

  it("leaves a document that was opened, edited and restored identical when saved", async () => {
    const doc = await openDocx(loadFixture("contract.docx"));
    const before = documentXml(doc);
    const snapshot = doc.snapshot();
    const block = paragraphStarting(doc, "");
    doc.applyOps([{ type: "insertText", at: { blockId: block.id, offset: 0 }, text: "X" }], TRACKED);
    expect(documentXml(doc)).not.toBe(before);
    doc.restore(snapshot);
    expect(documentXml(doc)).toBe(before);
  });
});

describe("applyOps results", () => {
  it("applies operations in order and reports created, removed and changed blocks", () => {
    const doc = build({ body: p(r("One")) + p(r("Two")) + p(r("Three")) });
    const [one, two, three] = paragraphs(doc).map((block) => block.id) as [string, string, string];
    const result = doc.applyOps(
      [
        { type: "insertText", at: { blockId: three, offset: 5 }, text: "!" },
        { type: "splitParagraph", at: { blockId: one, offset: 1 } },
        { type: "deleteParagraph", blockId: two },
        { type: "insertParagraphBefore", blockId: one, text: "Zero" },
      ],
      DIRECT,
    );
    expect(text(doc)).toBe("Zero\nO\nne\nThree!\n");
    const ids = paragraphs(doc).map((block) => block.id);
    expect(result.createdBlockIds).toEqual([ids[0], ids[2]]);
    expect(result.removedBlockIds).toEqual([two]);
    expect(result.changedBlockIds).toEqual([one, three]);
    expect(result.results.map((entry) => entry.createdBlockIds)).toEqual([[], [ids[2]], [], [ids[0]]]);
    expect(result.results.map((entry) => entry.type)).toEqual(["insertText", "splitParagraph", "deleteParagraph", "insertParagraphBefore"]);
    expect(result.revisionIds).toEqual([]);
  });

  it("reports numbered paragraphs whose label changed", () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const numbered = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
    const doc = build({ body: p(r("First"), numbered) + p(r("Second"), numbered) + p(r("Third"), numbered), numbering });
    const [first, second, third] = paragraphs(doc).map((block) => block.id) as [string, string, string];
    const result = doc.applyOps([{ type: "insertParagraphAfter", blockId: first, text: "New" }], DIRECT);
    expect(paragraphs(doc).map((block) => block.numbering?.text)).toEqual(["1.", "2.", "3.", "4."]);
    expect(result.changedBlockIds).toEqual([second, third]);
  });

  it("is all or nothing: a failing operation undoes the ones before it", () => {
    const doc = build({ body: p(r("One")) + p(r("Two")) });
    const [one] = paragraphs(doc).map((block) => block.id) as [string];
    const before = documentXml(doc);
    let code = "none";
    try {
      doc.applyOps(
        [
          { type: "insertText", at: { blockId: one, offset: 1 }, text: "changed" },
          { type: "addComment", range: { start: { blockId: one, offset: 0 }, end: { blockId: one, offset: 2 } }, text: "note" },
          { type: "deleteParagraph", blockId: "gone" },
        ],
        TRACKED,
      );
    } catch (error) {
      code = isOfficeError(error) ? error.code : "other";
    }
    expect(code).toBe("stale_reference");
    expect(documentXml(doc)).toBe(before);
    expect(doc.listRevisions()).toEqual([]);
    expect(doc.listComments()).toEqual([]);
    // Block ids are still the ones the caller holds.
    expect(paragraphs(doc)[0]?.id).toBe(one);
    doc.applyOps([{ type: "insertText", at: { blockId: one, offset: 3 }, text: "!" }], DIRECT);
    expect(text(doc)).toBe("One!\nTwo\n");
  });

  it("validates the options", () => {
    const doc = build({ body: p(r("One")) });
    const attempt = (options: unknown): string => {
      try {
        doc.applyOps([], options as never);
      } catch (error) {
        return isOfficeError(error) ? error.code : "other";
      }
      return "none";
    };
    expect(attempt({ track: true, author: RAE, date: DATE })).toBe("none");
    expect(attempt({ track: "yes", author: RAE, date: DATE })).toBe("invalid_argument");
    expect(attempt({ track: true, author: 5, date: DATE })).toBe("invalid_argument");
    expect(attempt({ track: true, author: RAE, date: "yesterday" })).toBe("invalid_argument");
    expect(attempt({ track: true, author: RAE })).toBe("invalid_argument");
    expect(attempt({ track: true, author: RAE, date: DATE, positions: "caret" })).toBe("invalid_argument");
    expect(attempt(null)).toBe("invalid_argument");
  });

  it("carries positions through insertions, deletions and removed blocks", () => {
    const doc = build({ body: p(r("0123456789")) + p(r("second")) });
    const [first, second] = paragraphs(doc).map((block) => block.id) as [string, string];
    const positions = [
      { blockId: first, offset: 2 },
      { blockId: first, offset: 5 },
      { blockId: first, offset: 9 },
      { blockId: second, offset: 3 },
      { blockId: "unknown", offset: 1 },
    ];
    const inserted = doc.applyOps([{ type: "insertText", at: { blockId: first, offset: 5 }, text: "abc" }], { ...DIRECT, positions });
    // A position exactly at the insertion point stays in front of the new text.
    expect(inserted.positions).toEqual([
      { blockId: first, offset: 2 },
      { blockId: first, offset: 5 },
      { blockId: first, offset: 12 },
      { blockId: second, offset: 3 },
      null,
    ]);
    const deleted = doc.applyOps(
      [{ type: "deleteRange", range: { start: { blockId: first, offset: 1 }, end: { blockId: first, offset: 8 } } }],
      { ...DIRECT, positions: inserted.positions.filter((position) => position !== null) },
    );
    expect(deleted.positions).toEqual([
      { blockId: first, offset: 1 },
      { blockId: first, offset: 1 },
      { blockId: first, offset: 5 },
      { blockId: second, offset: 3 },
    ]);
    const tracked = doc.applyOps(
      [{ type: "deleteRange", range: { start: { blockId: first, offset: 0 }, end: { blockId: first, offset: 4 } } }],
      { ...TRACKED, positions: [{ blockId: first, offset: 2 }] },
    );
    // Tracked, the deleted text is still part of the markup text.
    expect(tracked.positions).toEqual([{ blockId: first, offset: 2 }]);
    const removed = doc.applyOps([{ type: "deleteParagraph", blockId: first }], { ...DIRECT, positions: [{ blockId: first, offset: 2 }] });
    expect(removed.positions).toEqual([{ blockId: second, offset: 0 }]);
  });

  it("edits other stories and reports them", async () => {
    const doc = await openDocx(loadFixture("footnotes-headers.docx"));
    const footnote = doc.getView().footnotes[0];
    const header = doc.getView().headers[0];
    const note = footnote?.blocks.find((block): block is ParagraphBlock => block.type === "paragraph");
    const head = header?.blocks.find((block): block is ParagraphBlock => block.type === "paragraph");
    if (note === undefined || head === undefined || footnote === undefined || header === undefined) throw new Error("fixture changed");
    const result = doc.applyOps(
      [
        { type: "insertText", at: { blockId: note.id, offset: note.text.length }, text: " (amended)" },
        { type: "insertText", at: { blockId: head.id, offset: 0 }, text: "Draft: " },
      ],
      TRACKED,
    );
    expect(result.changedStoryIds).toEqual([header.id, footnote.id]);
    expect(doc.listRevisions().map((revision) => revision.storyId).sort()).toEqual([header.id, footnote.id].sort());
    const saved = await openDocx(await doc.save());
    expect(saved.getPlainText({ storyId: footnote.id })).toContain("(amended)");
    expect(saved.getPlainText({ storyId: header.id })).toContain("Draft: ");
    saved.rejectRevisions("all");
    expect(saved.getPlainText({ storyId: footnote.id })).not.toContain("(amended)");
    expect(saved.listRevisions()).toEqual([]);
  });
});
