/**
 * Comment anchors, bookmarks and field characters outlive the content
 * around them.
 *
 * A comment whose `w:commentReference` went with deleted text is an orphan
 * other word processors do not show; a range start without its end and a
 * field that begins and never ends are refused by strict readers. Each case
 * here removed one of them before the engine kept its anchors.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument, ParagraphBlock } from "../../../packages/office/src/index.js";
import { openDocx } from "../../../packages/office/src/index.js";
import { attr, loadFixture, readPackage, walk } from "./package.js";
import { AGENT, DIRECT, OWNER } from "./scenarios.js";
import { wordProblems } from "./wml-rules.js";

function paragraph(doc: DocxDocument, start: string): ParagraphBlock {
  const found = doc.getView().body.blocks.find((block) => block.type === "paragraph" && block.text.startsWith(start));
  if (found === undefined || found.type !== "paragraph") throw new Error(`no paragraph starts with ${start}`);
  return found;
}

/** The comment markers of the body in document order, as `start:0`, `end:0`, `ref:0`. */
async function markers(doc: DocxDocument): Promise<string[]> {
  const pkg = await readPackage(await doc.save());
  const root = pkg.parts.get("/word/document.xml")?.root;
  if (root === undefined) throw new Error("no document part");
  const kinds: Record<string, string> = { "w:commentRangeStart": "start", "w:commentRangeEnd": "end", "w:commentReference": "ref" };
  const out: string[] = [];
  for (const element of walk(root)) {
    const kind = kinds[element.name];
    if (kind !== undefined) out.push(`${kind}:${attr(element, "w:id")}`);
  }
  return out;
}

async function fieldCharacters(doc: DocxDocument): Promise<string> {
  const pkg = await readPackage(await doc.save());
  const root = pkg.parts.get("/word/document.xml")?.root;
  if (root === undefined) throw new Error("no document part");
  let out = "";
  for (const element of walk(root)) if (element.name === "w:fldChar") out += (attr(element, "w:fldCharType") ?? "?").slice(0, 1);
  return out;
}

/** No problems, apart from the cached table of contents of the fixture, which holds a raw tab. */
async function expectValid(doc: DocxDocument): Promise<void> {
  const problems = await wordProblems(await doc.save());
  expect(problems.filter((problem) => !problem.includes("holds a raw tab or line break"))).toEqual([]);
}

describe("comment anchors", () => {
  const ALL = ["start:0", "start:2", "end:0", "ref:0", "end:2", "ref:2", "start:1", "end:1", "ref:1"];

  it("start in the fixture as two threads with a reply", async () => {
    const doc = await openDocx(loadFixture("comments.docx"));
    expect(await markers(doc)).toEqual(ALL);
  });

  it("stay when the commented text is deleted directly", async () => {
    const doc = await openDocx(loadFixture("comments.docx"));
    const target = paragraph(doc, "We propose");
    doc.applyOps([{ type: "deleteRange", range: { start: { blockId: target.id, offset: 10 }, end: { blockId: target.id, offset: 50 } } }], DIRECT);
    expect((await markers(doc)).sort()).toEqual([...ALL].sort());
    expect(doc.listComments().map((comment) => [comment.id, comment.anchorText])).toEqual([
      ["0", ""],
      ["2", ""],
      ["1", "EUR 240,000"],
    ]);
    await expectValid(doc);
  });

  it("stay when the paragraph that holds them is deleted directly", async () => {
    const doc = await openDocx(loadFixture("comments.docx"));
    doc.applyOps([{ type: "deleteParagraph", blockId: paragraph(doc, "We propose").id }], DIRECT);
    // The anchors moved to the start of the paragraph that follows.
    expect(await markers(doc)).toEqual(ALL);
    expect(doc.listComments().map((comment) => comment.id)).toEqual(["0", "2", "1"]);
    expect(doc.listComments().every((comment) => comment.range !== null)).toBe(true);
    await expectValid(doc);
  });

  it("stay when a tracked deletion of their paragraph is accepted", async () => {
    const doc = await openDocx(loadFixture("comments.docx"));
    doc.applyOps([{ type: "deleteParagraph", blockId: paragraph(doc, "The expected annual rent").id }], AGENT);
    await expectValid(doc);
    doc.acceptRevisions("all");
    expect((await markers(doc)).sort()).toEqual([...ALL].sort());
    expect(doc.getPlainText()).not.toContain("annual rent");
    await expectValid(doc);
  });

  it("stay in order when an insertion that holds a deletion with anchors is rejected", async () => {
    const doc = await openDocx(loadFixture("comments.docx"));
    const target = paragraph(doc, "A decision is needed");
    // One author inserts text, another deletes part of it, and two comments end and start inside the deleted part.
    doc.applyOps([{ type: "insertText", at: { blockId: target.id, offset: 2 }, text: "quick and final " }], AGENT);
    doc.applyOps([{ type: "deleteRange", range: { start: { blockId: target.id, offset: 6 }, end: { blockId: target.id, offset: 14 } } }], OWNER);
    doc.applyOps(
      [
        { type: "addComment", range: { start: { blockId: target.id, offset: 2 }, end: { blockId: target.id, offset: 10 } }, text: "First." },
        { type: "addComment", range: { start: { blockId: target.id, offset: 9 }, end: { blockId: target.id, offset: 17 } }, text: "Second." },
      ],
      AGENT,
    );
    await expectValid(doc);
    const reopened = await openDocx(await doc.save());
    reopened.rejectRevisions("all");
    expect(reopened.getPlainText()).toContain("A decision is needed at the next board meeting.");
    const after = await markers(reopened);
    for (const id of ["3", "4"]) {
      expect(after.indexOf(`start:${id}`)).toBeGreaterThanOrEqual(0);
      expect(after.indexOf(`start:${id}`)).toBeLessThan(after.indexOf(`end:${id}`));
      expect(after.indexOf(`end:${id}`)).toBeLessThan(after.indexOf(`ref:${id}`));
    }
    await expectValid(reopened);
  });

  it("stay when a table row with a commented cell is deleted, tracked and accepted or directly", async () => {
    for (const options of [AGENT, DIRECT]) {
      const doc = await openDocx(loadFixture("table.docx"));
      const table = doc.getView().body.blocks.find((block) => block.type === "table");
      if (table === undefined || table.type !== "table") throw new Error("no table");
      const cell = table.rows[2]?.cells[0]?.blocks[0];
      if (cell === undefined || cell.type !== "paragraph") throw new Error("no cell paragraph");
      doc.applyOps([{ type: "addComment", range: { start: { blockId: cell.id, offset: 0 }, end: { blockId: cell.id, offset: 2 } }, text: "On a cell." }], AGENT);
      doc.applyOps([{ type: "deleteTableRow", tableId: table.id, rowIndex: 2 }], options);
      await expectValid(doc);
      doc.acceptRevisions("all");
      expect((await markers(doc)).sort()).toEqual(["end:0", "ref:0", "start:0"]);
      await expectValid(doc);
    }
  });
});

describe("fields", () => {
  it("start in the fixture as one field over two paragraphs and two inside one", async () => {
    const doc = await openDocx(loadFixture("links-fields.docx"));
    expect(await fieldCharacters(doc)).toBe("bsebsebse");
  });

  it("keep their end when the paragraph that holds it is deleted directly", async () => {
    const doc = await openDocx(loadFixture("links-fields.docx"));
    // The table of contents is one field: it begins in the first entry and ends in the second.
    doc.applyOps([{ type: "deleteParagraph", blockId: paragraph(doc, "2 Definitions").id }], DIRECT);
    expect(await fieldCharacters(doc)).toBe("bsebsebse");
    expect(doc.getPlainText()).not.toContain("2 Definitions");
    await expectValid(doc);
  });

  it("keep their begin when the paragraph that holds it is deleted directly", async () => {
    const doc = await openDocx(loadFixture("links-fields.docx"));
    doc.applyOps([{ type: "deleteParagraph", blockId: paragraph(doc, "1 Introduction").id }], DIRECT);
    expect(await fieldCharacters(doc)).toBe("bsebsebse");
    await expectValid(doc);
  });

  it("keep both ends when a tracked deletion of one of their paragraphs is accepted", async () => {
    const doc = await openDocx(loadFixture("links-fields.docx"));
    doc.applyOps([{ type: "deleteParagraph", blockId: paragraph(doc, "2 Definitions").id }], AGENT);
    await expectValid(doc);
    doc.acceptRevisions("all");
    expect(await fieldCharacters(doc)).toBe("bsebsebse");
    await expectValid(doc);
  });

  it("go as a whole with the paragraph that holds all of them", async () => {
    for (const options of [AGENT, DIRECT]) {
      const doc = await openDocx(loadFixture("links-fields.docx"));
      // This paragraph holds a REF and a PAGEREF field, each complete.
      doc.applyOps([{ type: "deleteParagraph", blockId: paragraph(doc, "As explained in").id }], options);
      doc.acceptRevisions("all");
      expect(await fieldCharacters(doc)).toBe("bse");
      await expectValid(doc);
    }
  });
});
