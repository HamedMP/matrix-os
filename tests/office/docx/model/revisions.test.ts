import { describe, expect, it } from "vitest";

import type { ParagraphBlock, Revision, TableBlock } from "../../../../packages/office/src/api/docx.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";
import { openFixture, paragraphStarting, paragraphsOf, tablesOf } from "./helpers.js";

const ALEX = "Alex Morgan";
const PRIYA = "Priya Shah";
const ALEX_DATE = "2026-01-05T09:30:00Z";
const PRIYA_DATE = "2026-01-06T14:15:00Z";

describe("tracked revisions (tracked.docx)", () => {
  it("lists the logical revisions in document order with kind, scope, author and text", async () => {
    const revisions = (await openFixture("tracked.docx")).listRevisions();
    expect(revisions.map((r) => [r.kind, r.scope, r.author, r.text])).toEqual([
      ["insert", "text", ALEX, "revised "],
      ["delete", "text", PRIYA, "ten"],
      ["insert", "text", PRIYA, "fifteen"],
      ["format", "runFormat", ALEX, "net thirty days"],
      ["moveFrom", "text", PRIYA, "This paragraph will be moved to the end.\n"],
      ["insert", "text", ALEX, " Thereafter fees may rise by up to five"],
      ["delete", "text", PRIYA, "five"],
      ["insert", "text", PRIYA, "three"],
      ["insert", "text", ALEX, " percent."],
      ["delete", "text", ALEX, "This obsolete sentence is removed.\n"],
      ["insert", "text", PRIYA, "A new confidentiality obligation applies.\n"],
      ["format", "paragraphFormat", ALEX, "Governing law: England and Wales."],
      ["insert", "tableRow", ALEX, "Widgets\t10"],
      ["moveTo", "text", PRIYA, "This paragraph will be moved to the end.\n"],
    ]);
    for (const revision of revisions) {
      expect(revision.date).toBe(revision.author === ALEX ? ALEX_DATE : PRIYA_DATE);
      expect(revision.storyId).toBe("body");
      expect(revision.blockIds.length).toBeGreaterThan(0);
    }
    expect(new Set(revisions.map((r) => r.id)).size).toBe(revisions.length);
    expect(revisions.filter((r) => r.author === ALEX)).toHaveLength(7);
    expect(revisions.filter((r) => r.author === PRIYA)).toHaveLength(7);
  });

  it("pairs replacements and the two halves of a move", async () => {
    const revisions = (await openFixture("tracked.docx")).listRevisions();
    const byText = (kind: string, text: string): Revision =>
      revisions.find((r) => r.kind === kind && r.text === text) as Revision;
    const ten = byText("delete", "ten");
    const fifteen = byText("insert", "fifteen");
    expect(ten.pairedWith).toBe(fifteen.id);
    expect(fifteen.pairedWith).toBe(ten.id);
    // A deletion nested in another author's insertion still pairs with its replacement.
    expect(byText("delete", "five").pairedWith).toBe(byText("insert", "three").id);
    const from = revisions.find((r) => r.kind === "moveFrom") as Revision;
    const to = revisions.find((r) => r.kind === "moveTo") as Revision;
    expect(from.pairedWith).toBe(to.id);
    expect(to.pairedWith).toBe(from.id);
    expect(byText("insert", "revised ").pairedWith).toBeNull();
  });

  it("gives ranges in markup coordinates, across the paragraph mark when the mark is part of the revision", async () => {
    const document = await openFixture("tracked.docx");
    const view = document.getView();
    const revisions = document.listRevisions();
    const second = paragraphStarting(view.body, "The supplier shall");
    expect(second.text).toBe("The supplier shall deliver the revised report within tenfifteen business days.");
    const revised = revisions[0] as Revision;
    expect(revised.blockIds).toEqual([second.id]);
    expect(revised.range).toEqual({ start: { blockId: second.id, offset: 31 }, end: { blockId: second.id, offset: 39 } });
    expect(second.text.slice(31, 39)).toBe("revised ");

    const removed = paragraphStarting(view.body, "This obsolete sentence");
    const added = paragraphStarting(view.body, "A new confidentiality");
    const deletion = revisions.find((r) => r.text.startsWith("This obsolete")) as Revision;
    expect(deletion.range).toEqual({ start: { blockId: removed.id, offset: 0 }, end: { blockId: added.id, offset: 0 } });
    expect(document.getPlainText({ range: deletion.range!, view: "markup" })).toBe("This obsolete sentence is removed.\n");

    const format = revisions.find((r) => r.scope === "paragraphFormat") as Revision;
    expect(format.range).toBeNull();
    const row = revisions.find((r) => r.scope === "tableRow") as Revision;
    expect(row.range).toBeNull();
    expect(row.blockIds[0]).toBe(tablesOf(view.body)[0]?.id);
  });

  it("describes formatting changes before and after", async () => {
    const revisions = (await openFixture("tracked.docx")).listRevisions();
    expect(revisions.find((r) => r.scope === "runFormat")?.formatChange).toEqual({
      before: { bold: false },
      after: { bold: true },
    });
    expect(revisions.find((r) => r.scope === "paragraphFormat")?.formatChange).toEqual({
      before: { alignment: "left" },
      after: { alignment: "center" },
    });
    expect(revisions.filter((r) => r.kind !== "format").every((r) => r.formatChange === null)).toBe(true);
  });

  it("marks runs, paragraph marks and table rows with their revision", async () => {
    const document = await openFixture("tracked.docx");
    const view = document.getView();
    const revisions = document.listRevisions();
    const idOf = (kind: string, text: string): string => (revisions.find((r) => r.kind === kind && r.text === text) as Revision).id;

    const second = paragraphStarting(view.body, "The supplier shall");
    expect(second.runs.map((run) => [run.text, run.revision?.kind ?? null, run.revision?.author ?? null])).toEqual([
      ["The supplier shall deliver the ", null, null],
      ["revised ", "insert", ALEX],
      ["report within ", null, null],
      ["ten", "delete", PRIYA],
      ["fifteen", "insert", PRIYA],
      [" business days.", null, null],
    ]);
    expect(second.runs[1]?.revision).toEqual({ revisionId: idOf("insert", "revised "), kind: "insert", author: ALEX, date: ALEX_DATE });
    expect(second.markRevision).toBeNull();

    // Text one author inserted and another deleted shows the innermost change.
    const fees = paragraphStarting(view.body, "Fees are fixed");
    expect(fees.runs.map((run) => [run.text, run.revision?.kind ?? null, run.revision?.author ?? null])).toEqual([
      ["Fees are fixed for the initial term.", null, null],
      [" Thereafter fees may rise by up to ", "insert", ALEX],
      ["five", "delete", PRIYA],
      ["three", "insert", PRIYA],
      [" percent.", "insert", ALEX],
    ]);

    const payment = paragraphStarting(view.body, "Payment terms");
    const bold = payment.runs.find((run) => run.text === "net thirty days");
    expect(bold).toMatchObject({ bold: true, revision: null });
    expect(bold?.formatRevision).toMatchObject({ kind: "format", author: ALEX });
    expect(payment.runs.filter((run) => run.formatRevision !== null)).toHaveLength(1);

    const marks = paragraphsOf(view.body).map((p) => p.markRevision?.kind ?? null);
    expect(marks).toEqual([null, null, null, "moveFrom", null, "delete", "insert", null, "moveTo", null]);
    const moved = paragraphsOf(view.body)[3] as ParagraphBlock;
    expect(moved.markRevision?.revisionId).toBe(moved.runs[0]?.revision?.revisionId);
    const governing = paragraphStarting(view.body, "Governing law");
    expect(governing.formatRevision).toMatchObject({ kind: "format", author: ALEX });
    expect(governing.style.alignment).toBe("center");

    const table = tablesOf(view.body)[0] as TableBlock;
    expect(table.rows.map((row) => row.revision?.kind ?? null)).toEqual([null, "insert"]);
    const widgets = table.rows[1]?.cells[0]?.blocks[0] as ParagraphBlock;
    // Content inserted with its row belongs to the row's revision.
    expect(widgets.runs[0]?.revision?.revisionId).toBe(table.rows[1]?.revision?.revisionId);
    expect(view.revisionCount).toBe(14);
  });

  it("exposes the XML elements of each revision to the engines", async () => {
    const index = getDocxIndex(await openFixture("tracked.docx"));
    const groups = index.revisions.groups;
    const shape = groups.map((group) => group.members.map((member) => `${member.role}:${member.element.name}`));
    expect(shape).toEqual([
      ["content:w:ins"],
      ["content:w:del"],
      ["content:w:ins"],
      ["runFormat:w:rPrChange"],
      ["content:w:moveFrom", "paragraphMark:w:moveFrom"],
      ["content:w:ins", "content:w:ins"],
      ["content:w:del"],
      ["content:w:ins"],
      ["content:w:ins"],
      ["content:w:del", "paragraphMark:w:del"],
      ["content:w:ins", "paragraphMark:w:ins"],
      ["paragraphFormat:w:pPrChange"],
      ["tableRow:w:ins", "content:w:ins", "content:w:ins"],
      ["content:w:moveTo", "paragraphMark:w:moveTo"],
    ]);
    expect(groups.filter((group) => group.moveName !== null).map((group) => group.moveName)).toEqual(["move1", "move1"]);
    const row = groups[12]!;
    expect(row.members[0]?.owner.name).toBe("w:tr");
    expect(index.revisions.byId.get(row.revision.id)).toBe(row);
    for (const group of groups) {
      for (const member of group.members) expect(index.revisions.marks.get(member.element)?.revisionId).toBe(group.revision.id);
    }
  });

  it("keeps revision ids stable across reads and for documents without revisions returns nothing", async () => {
    const document = await openFixture("tracked.docx");
    expect(document.listRevisions()).toEqual(document.listRevisions());
    const again = await openFixture("tracked.docx");
    expect(again.listRevisions()).toEqual(document.listRevisions());
    expect((await openFixture("basic.docx")).listRevisions()).toEqual([]);
    expect(document.getTrackRevisions()).toBe(false);
  });
});
