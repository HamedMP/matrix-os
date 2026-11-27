// @vitest-environment jsdom
/**
 * Table rows the view hides (a row marked as a pending deletion, shown gone
 * in the final view) are not part of what the owner edits: deleting,
 * formatting or typing over a selection that crosses such a row leaves its
 * cells alone, so rejecting the row deletion brings the row back as it was.
 * Word can mark a deletion on the row only, without marking its text.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { DocxDocument } from "../../../../home/apps/_shared/office-engine/index";
import { opc, openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { ModelIndex } from "../../../../home/apps/docs/src/editor/index";
import { type Mounted, OTHER, at, beforeInput, bodyParagraphs, bodyTables, cellParagraphs, fixtureBytes, mount, paragraph, select, type } from "./helpers";

let m: Mounted;
afterEach(() => m?.unmount());

const DELETION = `<w:trPr><w:del w:id="901" w:author="${OTHER}" w:date="2026-11-20T09:00:00Z"/></w:trPr>`;

/** table.docx with its "Build" row (row 3) marked deleted on the row only: its text carries no revision. */
async function tableWithRowOnlyDeletion(): Promise<DocxDocument> {
  const pkg = await opc.openPackage(fixtureBytes("table.docx"));
  const xml = await pkg.getPartText("/word/document.xml");
  const rows = xml.split("<w:tr>");
  expect(rows[4]).toContain("Build");
  rows[4] = DELETION + rows[4];
  pkg.setPart("/word/document.xml", rows.join("<w:tr>"));
  return openDocx(await pkg.save());
}

function rowTexts(doc: DocxDocument, row: number): string[] {
  const table = bodyTables(doc)[0]!;
  return table.rows[row]!.cells.flatMap((_, cell) => cellParagraphs(table, row, cell).map((block) => block.text));
}

async function openFinal(tracking = false): Promise<{ design: string; launch: string; intro: string; totals: string }> {
  const doc = await tableWithRowOnlyDeletion();
  m = await mount({ doc }, { viewMode: "final", tracking });
  const table = bodyTables(m.doc)[0]!;
  expect(table.rows[3]!.revision?.kind).toBe("delete");
  expect(paragraph(m.doc, cellParagraphs(table, 3, 0)[0]!.id).runs.every((run) => run.revision === null)).toBe(true);
  const body = bodyParagraphs(m.doc);
  return {
    design: cellParagraphs(table, 2, 0)[0]!.id,
    launch: cellParagraphs(table, 4, 0)[0]!.id,
    intro: body[1]!.id,
    totals: body[2]!.id,
  };
}

describe("a table row the final view hides", () => {
  it("is not rendered and keeps its cells when a deletion across it removes the rows around it", async () => {
    const { design, launch } = await openFinal();
    expect(m.host.querySelectorAll("tr[data-row='3']")).toHaveLength(0);
    select(m, at(design, 0), at(launch, 6));
    beforeInput(m, "deleteContentBackward");
    expect(paragraph(m.doc, design).text).toBe("");
    expect(paragraph(m.doc, launch).text).toBe("");
    expect(rowTexts(m.doc, 3)).toEqual(["Build", "", "30,000", "42,000"]);
    m.doc.rejectRevisions("all");
    expect(rowTexts(m.doc, 3)).toEqual(["Build", "", "30,000", "42,000"]);
  });

  it("keeps its cells when a deletion from the paragraph before the table to the one after it goes through the table", async () => {
    const { intro, totals } = await openFinal();
    select(m, at(intro, 9), at(totals, 6));
    beforeInput(m, "deleteContentBackward");
    expect(bodyTables(m.doc)).toHaveLength(1);
    expect(rowTexts(m.doc, 3)).toEqual(["Build", "", "30,000", "42,000"]);
    expect(rowTexts(m.doc, 2)).toEqual(["", "", "", ""]);
    expect(paragraph(m.doc, intro).text).toBe("The table");
  });

  it("keeps its formatting when a selection across it is bolded", async () => {
    const { design, launch } = await openFinal();
    select(m, at(design, 0), at(launch, 6));
    expect(m.editor.toggleFormat("bold")).toBe(true);
    const table = bodyTables(m.doc)[0]!;
    expect(paragraph(m.doc, design).runs.every((run) => run.bold)).toBe(true);
    const hidden = table.rows[3]!.cells.flatMap((_, cell) => cellParagraphs(table, 3, cell)).flatMap((block) => block.runs);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.some((run) => run.bold)).toBe(false);
  });

  it("keeps its cells when typing replaces a selection across it with Track changes on", async () => {
    const { design, launch } = await openFinal(true);
    select(m, at(design, 0), at(launch, 6));
    type(m, "X");
    expect(m.doc.getPlainText({ view: "original" })).toContain("Build");
    m.doc.rejectRevisions("all");
    expect(rowTexts(m.doc, 3)).toEqual(["Build", "", "30,000", "42,000"]);
  });

  it("follows edits that show or hide a row without other structural changes", async () => {
    await openFinal();
    const table = bodyTables(m.doc)[0]!;
    const build = cellParagraphs(table, 3, 0)[0]!.id;
    expect(m.editor.setSelection(at(build, 0))).toBe(false);
    // Rejecting the row deletion shows the row again: its cells take the caret.
    m.session.rejectRevisions(m.doc.listRevisions().map((revision) => revision.id));
    expect(m.host.querySelectorAll("tr[data-row='3']")).toHaveLength(1);
    expect(m.editor.setSelection(at(build, 2))).toBe(true);
    // A tracked row deletion hides it again: the caret cannot go there, and a deletion across it leaves it.
    m.session.apply([{ type: "deleteTableRow", tableId: table.id, rowIndex: 3 }], { track: true, author: OTHER });
    expect(m.host.querySelectorAll("tr[data-row='3']")).toHaveLength(0);
    expect(m.editor.setSelection(at(build, 2))).toBe(false);
  });

  it("tells when a table changed which rows the view shows, so the editor builds its index again", async () => {
    const doc = await tableWithRowOnlyDeletion();
    const table = bodyTables(doc)[0]!;
    const index = ModelIndex.build(doc.getView(), "final");
    const build = cellParagraphs(table, 3, 0)[0]!.id;
    expect(index.entry(build)).toBeNull();
    expect(ModelIndex.build(doc.getView()).entry(build)).not.toBeNull();
    const shown = { ...table, rows: table.rows.map((row) => ({ ...row, revision: null })) };
    expect(index.tableLayoutChanged([table.id], () => table)).toBe(false);
    expect(index.tableLayoutChanged([table.id], () => shown)).toBe(true);
    expect(index.tableLayoutChanged([build], () => shown)).toBe(false);
  });

  it("is editable again in the markup view, where it is shown", async () => {
    const { design, launch } = await openFinal();
    m.editor.setViewMode("markup");
    expect(m.host.querySelectorAll("tr[data-row='3']")).toHaveLength(1);
    select(m, at(design, 0), at(launch, 6));
    beforeInput(m, "deleteContentBackward");
    expect(rowTexts(m.doc, 3)).toEqual(["", "", "", ""]);
  });
});
