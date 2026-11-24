/**
 * What the engine reports must be what another word processor does with the
 * file. Three cases where the report and an independent accept-all or
 * reject-all of the saved file disagreed:
 *
 * - a paragraph mark or table row that one author inserted and another
 *   deleted carries both revisions; the deletion was not read;
 * - a move whose text a later edit split in two was paired on one piece
 *   only, so resolving it left half a move without its range markers;
 * - an inserted table in front of the last paragraph hid that paragraph's
 *   fate in the `original` view.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument, DocxTextView, ParagraphBlock, TableBlock } from "../../../packages/office/src/index.js";
import { compareDocx, createDocx, openDocx, toHtml, toMarkdown } from "../../../packages/office/src/index.js";
import { loadFixture } from "./package.js";
import { AGENT, DIRECT, OWNER } from "./scenarios.js";
import { wordProblems } from "./wml-rules.js";

function paragraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");
}

function firstTable(doc: DocxDocument): TableBlock {
  const table = doc.getView().body.blocks.find((block): block is TableBlock => block.type === "table");
  if (table === undefined) throw new Error("no table");
  return table;
}

async function resolved(doc: DocxDocument, accept: boolean): Promise<string> {
  const copy = await openDocx(await doc.save());
  if (accept) copy.acceptRevisions("all");
  else copy.rejectRevisions("all");
  expect(copy.listRevisions()).toEqual([]);
  return copy.getPlainText();
}

/** The views of a pending document are the texts that resolving everything gives. */
async function expectViewsMatchResolution(doc: DocxDocument): Promise<void> {
  expect(doc.getPlainText({ view: "final" })).toBe(await resolved(doc, true));
  expect(doc.getPlainText({ view: "original" })).toBe(await resolved(doc, false));
  for (const view of ["final", "original"] as DocxTextView[]) {
    const copy = await openDocx(await doc.save());
    if (view === "final") copy.acceptRevisions("all");
    else copy.rejectRevisions("all");
    expect(toMarkdown(doc, { view })).toBe(toMarkdown(copy, { view: "final" }));
  }
}

/** Three paragraphs; one author inserts a fourth in front of the second and another deletes it. */
function insertedThenDeleted(): { doc: DocxDocument; middle: string } {
  const doc = createDocx({ paragraphs: ["First paragraph.", "Second paragraph.", "Third paragraph."] });
  const second = paragraphs(doc)[1];
  if (second === undefined) throw new Error("no paragraph");
  const result = doc.applyOps([{ type: "insertParagraphBefore", blockId: second.id, text: "Inserted by the agent." }], AGENT);
  const middle = result.createdBlockIds[0];
  if (middle === undefined) throw new Error("no paragraph was created");
  doc.applyOps([{ type: "deleteParagraph", blockId: middle }], OWNER);
  return { doc, middle };
}

describe("a paragraph one author inserted and another deleted", () => {
  it("shows the deletion on its mark and lists it with the paragraph break", () => {
    const { doc, middle } = insertedThenDeleted();
    const block = doc.getBlock(middle);
    if (block === null || block.type !== "paragraph") throw new Error("the paragraph is gone");
    expect(block.markRevision).toMatchObject({ kind: "delete", author: OWNER.author });
    const revisions = doc.listRevisions().map((revision) => [revision.kind, revision.author, revision.text]);
    expect(revisions).toContainEqual(["delete", OWNER.author, "Inserted by the agent.\n"]);
    expect(revisions).toContainEqual(["insert", AGENT.author, "Inserted by the agent.\n"]);
  });

  it("is gone from both views, as it is after accepting or rejecting everything", async () => {
    const { doc } = insertedThenDeleted();
    const plain = "First paragraph.\nSecond paragraph.\nThird paragraph.\n";
    expect(doc.getPlainText({ view: "final" })).toBe(plain);
    expect(doc.getPlainText({ view: "original" })).toBe(plain);
    await expectViewsMatchResolution(doc);
    expect(toHtml(doc, { mode: "final" })).not.toContain("Inserted by the agent");
    expect(toHtml(doc, { mode: "original" })).not.toContain("Inserted by the agent");
    expect(await wordProblems(await doc.save())).toEqual([]);
  });

  it("reads the same after a save and reopen", async () => {
    const { doc } = insertedThenDeleted();
    const reopened = await openDocx(await doc.save());
    expect(reopened.getPlainText({ view: "final" })).toBe(doc.getPlainText({ view: "final" }));
    expect(reopened.listRevisions().map((revision) => [revision.kind, revision.author, revision.text])).toEqual(
      doc.listRevisions().map((revision) => [revision.kind, revision.author, revision.text]),
    );
  });

  it("resolves one revision at a time", async () => {
    // Rejecting the deletion leaves the insertion pending, with its paragraph break.
    const { doc } = insertedThenDeleted();
    const deletion = doc.listRevisions().find((revision) => revision.kind === "delete");
    if (deletion === undefined) throw new Error("no deletion");
    doc.rejectRevisions([deletion.id]);
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["insert", "Inserted by the agent.\n"]]);
    expect(doc.getPlainText({ view: "final" })).toBe("First paragraph.\nInserted by the agent.\nSecond paragraph.\nThird paragraph.\n");
    expect(await wordProblems(await doc.save())).toEqual([]);

    // Accepting the insertion leaves the deletion pending, with its paragraph break.
    const other = insertedThenDeleted().doc;
    const insertion = other.listRevisions().find((revision) => revision.kind === "insert");
    if (insertion === undefined) throw new Error("no insertion");
    other.acceptRevisions([insertion.id]);
    expect(other.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["delete", "Inserted by the agent.\n"]]);
    expect(other.getPlainText({ view: "original" })).toBe("First paragraph.\nInserted by the agent.\nSecond paragraph.\nThird paragraph.\n");
    expect(other.getPlainText({ view: "final" })).toBe("First paragraph.\nSecond paragraph.\nThird paragraph.\n");
    expect(await wordProblems(await other.save())).toEqual([]);
  });
});

describe("a table row one author inserted and another deleted", () => {
  async function rowInsertedThenDeleted(): Promise<DocxDocument> {
    const doc = await openDocx(loadFixture("table.docx"));
    const table = firstTable(doc);
    doc.applyOps([{ type: "insertTableRow", tableId: table.id, rowIndex: 2, cells: ["Agent row", "X"] }], AGENT);
    doc.applyOps([{ type: "deleteTableRow", tableId: table.id, rowIndex: 2 }], OWNER);
    return doc;
  }

  it("shows the deletion on the row", async () => {
    const doc = await rowInsertedThenDeleted();
    expect(firstTable(doc).rows[2]?.revision).toMatchObject({ kind: "delete", author: OWNER.author });
    const rows = doc.listRevisions().filter((revision) => revision.scope === "tableRow");
    expect(rows.map((revision) => [revision.kind, revision.author])).toEqual([
      ["insert", AGENT.author],
      ["delete", OWNER.author],
    ]);
  });

  it("is gone from both views, as it is after accepting or rejecting everything", async () => {
    const doc = await rowInsertedThenDeleted();
    const before = (await openDocx(loadFixture("table.docx"))).getPlainText();
    expect(doc.getPlainText({ view: "final" })).toBe(before);
    expect(doc.getPlainText({ view: "original" })).toBe(before);
    await expectViewsMatchResolution(doc);
    expect(toHtml(doc, { mode: "final" })).not.toContain("Agent row");
    expect(toHtml(doc, { mode: "original" })).not.toContain("Agent row");
    expect(await wordProblems(await doc.save())).toEqual([]);
  });
});

describe("a move whose text a later edit split", () => {
  async function splitMove(): Promise<DocxDocument> {
    const doc = await openDocx(loadFixture("tracked.docx"));
    const source = paragraphs(doc).find((block) => block.runs.some((run) => run.revision?.kind === "moveFrom"));
    if (source === undefined) throw new Error("no moved paragraph");
    doc.applyOps([{ type: "insertText", at: { blockId: source.id, offset: 4 }, text: " (see below)" }], AGENT);
    return doc;
  }

  it("is still one move: resolving one piece resolves every piece and both halves", async () => {
    for (const accept of [true, false]) {
      const doc = await splitMove();
      const pieces = doc.listRevisions().filter((revision) => revision.kind === "moveFrom" || revision.kind === "moveTo");
      expect(pieces.length).toBeGreaterThan(2);
      const one = pieces.find((revision) => revision.kind === "moveFrom" && revision.pairedWith === null) ?? pieces[0];
      if (one === undefined) throw new Error("no move");
      const result = accept ? doc.acceptRevisions([one.id]) : doc.rejectRevisions([one.id]);
      expect([...result.resolvedIds].sort()).toEqual(pieces.map((revision) => revision.id).sort());
      expect(doc.listRevisions().filter((revision) => revision.kind === "moveFrom" || revision.kind === "moveTo")).toEqual([]);
      const text = doc.getPlainText({ view: "final" });
      expect(text.split("This paragraph will be moved to the end.").length - 1 + (text.split("This (see below) paragraph will be moved to the end.").length - 1)).toBe(1);
      expect(await wordProblems(await doc.save())).toEqual([]);
    }
  });
});

describe("a tracked table in front of the last paragraph", () => {
  it("does not leave an empty line in the view that is without both", async () => {
    // The revised version ends with a table and a paragraph the original does not have.
    const original = createDocx({ paragraphs: ["Budget", "Details follow.", ""] });
    const revised = await openDocx(loadFixture("table.docx"));
    const result = await compareDocx(await original.save(), await revised.save(), { author: "Compare", date: "2026-11-23T12:00:00Z" });
    expect(result.getPlainText({ view: "original" })).toBe(original.getPlainText());
    expect(result.getPlainText({ view: "final" })).toBe(revised.getPlainText());
    await expectViewsMatchResolution(result);

    // And the other way round: the table and the paragraph after it are deletions.
    const reverse = await compareDocx(await revised.save(), await original.save(), { author: "Compare", date: "2026-11-23T12:00:00Z" });
    expect(reverse.getPlainText({ view: "original" })).toBe(revised.getPlainText());
    expect(reverse.getPlainText({ view: "final" })).toBe(original.getPlainText());
    await expectViewsMatchResolution(reverse);
  });

  it("holds for the edited copy of the table fixture, compared both ways", async () => {
    const source = loadFixture("table.docx");
    const edited = await openDocx(source);
    const table = firstTable(edited);
    edited.applyOps(
      [
        { type: "insertParagraphAfter", blockId: table.id, text: "After the table." },
        { type: "insertParagraphBefore", blockId: table.id, text: "Before the table." },
      ],
      DIRECT,
    );
    const last = paragraphs(edited).at(-1);
    if (last === undefined) throw new Error("no paragraph");
    edited.applyOps([{ type: "deleteRange", range: { start: { blockId: last.id, offset: 0 }, end: { blockId: last.id, offset: last.text.length } } }], DIRECT);
    const changed = await edited.save();
    for (const [a, b] of [
      [source, changed],
      [changed, source],
    ] as const) {
      const result = await compareDocx(a, b, { author: "Compare", date: "2026-11-23T12:00:00Z" });
      expect(result.getPlainText({ view: "original" })).toBe((await openDocx(a)).getPlainText());
      expect(result.getPlainText({ view: "final" })).toBe((await openDocx(b)).getPlainText());
      await expectViewsMatchResolution(result);
    }
  });
});
