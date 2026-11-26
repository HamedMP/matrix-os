/**
 * Tracked cell insertions and deletions (`w:cellIns`, `w:cellDel`): what a
 * word processor writes for a tracked column insert or delete. They add and
 * remove content, so they are listed as insertions and deletions, and the
 * `final` and `original` views show the table as resolving them leaves it.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { toHtml, toMarkdown, toPlainText } from "../../../../packages/office/src/docx/index.js";
import { build, documentXml, reopen } from "../edit/helpers.js";
import { cell, p, r, row, tbl } from "../model/build.js";

const A = 'w:author="Alex Morgan" w:date="2026-01-05T09:30:00Z"';
const B = 'w:author="Priya Shah" w:date="2026-01-06T14:15:00Z"';
const cellDel = (id: number, who = A): string => `<w:cellDel w:id="${id}" ${who}/>`;
const cellIns = (id: number, who = A): string => `<w:cellIns w:id="${id}" ${who}/>`;

/** A 2x3 table whose second column is a tracked deletion and whose third column is a tracked insertion. */
const COLUMNS =
  tbl(
    row(cell(p(r("Item"))) + cell(p(r("Price")), cellDel(1)) + cell(p(r("Qty")), cellIns(3))) +
      row(cell(p(r("Widget"))) + cell(p(r("9.99")), cellDel(2)) + cell(p(r("4")), cellIns(4))),
  ) + p(r("end"));

/** Checks every text view of the document against the document with its changes resolved. */
function expectViewsToAgree(make: () => DocxDocument): { final: string; original: string } {
  const doc = make();
  const final = doc.getPlainText({ view: "final" });
  const original = doc.getPlainText({ view: "original" });
  const accepted = make();
  accepted.acceptRevisions("all");
  const rejected = make();
  rejected.rejectRevisions("all");
  expect(accepted.listRevisions()).toEqual([]);
  expect(rejected.listRevisions()).toEqual([]);
  expect(final).toBe(accepted.getPlainText());
  expect(original).toBe(rejected.getPlainText());
  expect(toPlainText(doc, { view: "final", numberingLabels: false })).toBe(final);
  expect(toPlainText(doc, { view: "original", numberingLabels: false })).toBe(original);
  expect(toHtml(doc, { mode: "final", fragment: true })).toBe(toHtml(accepted, { mode: "final", fragment: true }));
  expect(toHtml(doc, { mode: "original", fragment: true })).toBe(toHtml(rejected, { mode: "original", fragment: true }));
  expect(toMarkdown(doc, { view: "final" })).toBe(toMarkdown(accepted));
  expect(toMarkdown(doc, { view: "original" })).toBe(toMarkdown(rejected));
  return { final, original };
}

describe("tracked cell insertions and deletions", () => {
  it("lists a deleted column and an inserted column as one deletion and one insertion, with the cell text", () => {
    const doc = build({ body: COLUMNS });
    const table = doc.getView().body.blocks[0]!;
    const revisions = doc.listRevisions();
    expect(revisions.map(({ kind, scope, text, author, range, formatChange, blockIds }) => ({ kind, scope, text, author, range, formatChange, blockIds }))).toEqual([
      { kind: "delete", scope: "tableRow", text: "Price\n9.99", author: "Alex Morgan", range: null, formatChange: null, blockIds: [table.id] },
      { kind: "insert", scope: "tableRow", text: "Qty\n4", author: "Alex Morgan", range: null, formatChange: null, blockIds: [table.id] },
    ]);
    // The two are separate changes, not the halves of a replacement.
    expect(revisions.map((revision) => revision.pairedWith)).toEqual([null, null]);
  });

  it("shows in each view what resolving the changes gives", () => {
    const views = expectViewsToAgree(() => build({ body: COLUMNS }));
    expect(views.final).toBe("Item\tQty\nWidget\t4\nend\n");
    expect(views.original).toBe("Item\tPrice\nWidget\t9.99\nend\n");
    const doc = build({ body: COLUMNS });
    expect(doc.getPlainText({ view: "markup" })).toBe("Item\tPrice\tQty\nWidget\t9.99\t4\nend\n");
    expect(toHtml(doc, { mode: "final", fragment: true })).not.toContain("Price");
    expect(toHtml(doc, { mode: "original", fragment: true })).not.toContain("Qty");
    expect(toHtml(doc, { mode: "markup", fragment: true })).toContain("Price");
  });

  it("reads one table in a view with only the cells the view keeps", () => {
    const doc = build({ body: COLUMNS });
    const table = doc.getView().body.blocks[0]!;
    expect(doc.getPlainText({ blockId: table.id, view: "final" })).toBe("Item\tQty\nWidget\t4\n");
    expect(doc.getPlainText({ blockId: table.id, view: "original" })).toBe("Item\tPrice\nWidget\t9.99\n");
    expect(doc.getPlainText({ blockId: table.id, view: "markup" })).toBe("Item\tPrice\tQty\nWidget\t9.99\t4\n");
    expect(() => doc.getPlainText({ blockId: "b999" })).toThrow(expect.objectContaining({ code: "stale_reference" }));
  });

  it("resolves the deletion and the insertion separately", async () => {
    const doc = build({ body: COLUMNS });
    const [deletion, insertion] = doc.listRevisions();
    doc.acceptRevisions([deletion!.id]);
    expect(doc.getPlainText({ view: "markup" })).toBe("Item\tQty\nWidget\t4\nend\n");
    expect(doc.listRevisions().map((revision) => [revision.id, revision.kind, revision.text])).toEqual([[insertion!.id, "insert", "Qty\n4"]]);
    doc.rejectRevisions([insertion!.id]);
    expect(doc.getPlainText({ view: "markup" })).toBe("Item\nWidget\nend\n");
    expect(doc.listRevisions()).toEqual([]);
    expect(documentXml(await reopen(doc))).not.toMatch(/w:cell(Ins|Del)/);

    const other = build({ body: COLUMNS });
    other.rejectRevisions([other.listRevisions()[0]!.id]);
    expect(other.getPlainText({ view: "markup" })).toBe("Item\tPrice\tQty\nWidget\t9.99\t4\nend\n");
    expect(other.listRevisions().map((revision) => revision.kind)).toEqual(["insert"]);
  });

  it("keeps a cell change apart from a formatting change of the same cell and from another author's", () => {
    const widthChange = `<w:tcW w:w="2000" w:type="dxa"/>${cellIns(1)}<w:tcPrChange w:id="5" ${A}><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr></w:tcPrChange>`;
    const body = tbl(row(cell(p(r("kept"))) + cell(p(r("new")), widthChange)) + row(cell(p(r("kept too"))) + cell(p(r("newer")), cellIns(2, B)))) + p("");
    const doc = build({ body });
    expect(doc.listRevisions().map(({ kind, scope, author, text }) => ({ kind, scope, author, text }))).toEqual([
      { kind: "format", scope: "paragraphFormat", author: "Alex Morgan", text: "" },
      { kind: "insert", scope: "tableRow", author: "Alex Morgan", text: "new" },
      { kind: "insert", scope: "tableRow", author: "Priya Shah", text: "newer" },
    ]);
    // Accepting the formatting change leaves the cell insertions pending and the cells in place.
    doc.acceptRevisions([doc.listRevisions()[0]!.id]);
    expect(doc.listRevisions().map((revision) => revision.kind)).toEqual(["insert", "insert"]);
    expect(doc.getPlainText({ view: "markup" })).toBe("kept\tnew\nkept too\tnewer\n\n");
    expectViewsToAgree(() => build({ body }));
  });

  it("puts two cells of one row in one change, separated like the cells of a row", () => {
    const body = tbl(row(cell(p(r("a"))) + cell(p(r("b")), cellDel(1)) + cell(p(r("c1")) + p(r("c2")), cellDel(2))) + row(cell(p(r("d"))) + cell(p(r("e")), cellDel(3)) + cell(p(r("f")), cellDel(4)))) + p("");
    const doc = build({ body });
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.text])).toEqual([["delete", "b\tc1\nc2\ne\tf"]]);
    expect(expectViewsToAgree(() => build({ body })).final).toBe("a\nd\n\n");
  });

  it("takes the tracked content of a cell into the change of the cell", () => {
    const inserted = `<w:ins w:id="7" ${A}><w:r><w:t>typed</w:t></w:r></w:ins>`;
    const body = tbl(row(cell(p(r("kept"))) + cell(p(inserted), cellIns(1)))) + p("");
    const doc = build({ body });
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.scope, revision.text])).toEqual([["insert", "tableRow", "typed"]]);
    const views = expectViewsToAgree(() => build({ body }));
    expect(views.final).toBe("kept\ttyped\n\n");
    expect(views.original).toBe("kept\n\n");
    doc.acceptRevisions("all");
    expect(documentXml(doc)).not.toMatch(/w:ins|w:cellIns/);
  });

  it("removes a row when its last cell goes, and a table when its last row does", async () => {
    const body =
      p(r("before")) +
      tbl(row(cell(p(r("a"))) + cell(p(r("b")))) + row(cell(p(r("c")), cellDel(1)) + cell(p(r("d")), cellDel(2)))) +
      tbl(row(cell(p(r("x")), cellIns(3)) + cell(p(r("y")), cellIns(4)))) +
      p(r("after"));
    const views = expectViewsToAgree(() => build({ body }));
    expect(views.final).toBe("before\na\tb\nx\ty\nafter\n");
    expect(views.original).toBe("before\na\tb\nc\td\nafter\n");
    const accepted = build({ body });
    accepted.acceptRevisions("all");
    expect(documentXml(accepted)).not.toContain("<w:tr/>");
    expect(documentXml(accepted).split("<w:tr>").length - 1).toBe(2);
    const rejected = build({ body });
    rejected.rejectRevisions("all");
    expect(documentXml(rejected).split("<w:tbl>").length - 1).toBe(1);
    expect((await reopen(rejected)).getPlainText()).toBe(views.original);
  });

  it("leaves a cell that one author inserted and another deleted out of both views", () => {
    const body = tbl(row(cell(p(r("kept"))) + cell(p(r("short-lived")), cellIns(1) + cellDel(2, B)))) + p("");
    const doc = build({ body });
    expect(doc.listRevisions().map((revision) => [revision.kind, revision.author, revision.text])).toEqual([
      ["insert", "Alex Morgan", "short-lived"],
      ["delete", "Priya Shah", "short-lived"],
    ]);
    expect(doc.getPlainText({ view: "final" })).toBe("kept\n\n");
    expect(doc.getPlainText({ view: "original" })).toBe("kept\n\n");
    expectViewsToAgree(() => build({ body }));
  });

  it("counts the columns of the cells that are left when it spans rows", () => {
    const merged = (text: string, properties: string): string => cell(p(r(text)), properties);
    const body =
      tbl(
        row(cell(p(r("gone")), cellDel(1)) + merged("tall", '<w:vMerge w:val="restart"/>') + cell(p(r("r1")))) +
          row(cell(p(r("gone too")), cellDel(2)) + merged("", "<w:vMerge/>") + cell(p(r("r2")))),
      ) + p("");
    const doc = build({ body });
    const accepted = build({ body });
    accepted.acceptRevisions("all");
    const html = toHtml(doc, { mode: "final", fragment: true });
    expect(html).toBe(toHtml(accepted, { mode: "final", fragment: true }));
    expect(html).toContain('rowspan="2"');
  });
});
