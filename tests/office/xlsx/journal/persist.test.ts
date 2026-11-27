import { describe, expect, it } from "vitest";
import { openPackage } from "../../../../packages/office/src/opc/index.js";
import {
  JOURNAL_CONTENT_TYPE,
  JOURNAL_PART_NAME,
  JOURNAL_RELATIONSHIP_TYPE,
  getJournalWarnings,
} from "../../../../packages/office/src/xlsx/journal/index.js";
import { openXlsx, parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { getWorkbookInternals } from "../../../../packages/office/src/xlsx/internal.js";
import { asyncCodeOf, buildXlsx, num } from "../workbook/helpers.js";
import { AGENT, OWNER, a1, at, changes, codeOf, loadFixture, sheetId, smallBook, valueAt } from "./helpers.js";

async function withJournalText(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const pkg = await openPackage(bytes);
  pkg.setPart(JOURNAL_PART_NAME, text, JOURNAL_CONTENT_TYPE);
  if (pkg.getRelationshipsByType("/xl/workbook.xml", JOURNAL_RELATIONSHIP_TYPE).length === 0) {
    pkg.addRelationship("/xl/workbook.xml", { type: JOURNAL_RELATIONSHIP_TYPE, target: "../matrix/changeJournal.json" });
  }
  return pkg.save();
}

describe("saving and reopening the journal", () => {
  it("writes a related part with its own content type", async () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.endProposal();
    const pkg = await openPackage(await workbook.save());
    expect(pkg.getContentType(JOURNAL_PART_NAME)).toBe(JOURNAL_CONTENT_TYPE);
    const [rel] = pkg.getRelationshipsByType("/xl/workbook.xml", JOURNAL_RELATIONSHIP_TYPE);
    expect(pkg.resolveTarget("/xl/workbook.xml", rel!.target)).toBe(JOURNAL_PART_NAME);
    const json = JSON.parse(await pkg.getPartText(JOURNAL_PART_NAME)) as { version: number };
    expect(json.version).toBe(1);
    // Saving twice keeps one relationship.
    await workbook.save();
    expect(workbook.package.getRelationshipsByType("/xl/workbook.xml", JOURNAL_RELATIONSHIP_TYPE)).toHaveLength(1);
  });

  it("reads changes back with the same ids, and they can still be rejected", async () => {
    const original = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(original, "Data");
    original.beginProposal(AGENT);
    original.setCell(data, a1("C2"), 20);
    original.setFormula(data, a1("E3"), "C3*D3*2");
    original.setStyle(data, parseA1Range("B2"), { font: { italic: true } });
    original.endProposal();
    original.beginProposal(OWNER);
    original.insertRows(sheetId(original, "Calc"), 0, 1);
    original.endProposal();
    const bytes = await original.save();
    const before = changes(original);
    expect(before.find((change) => change.row === 2)?.newValue).toBe(412.5);
    const reopened = await openXlsx(bytes);
    expect(getJournalWarnings(reopened)).toEqual([]);
    expect(changes(reopened)).toEqual(before);
    expect(reopened.listProposals()).toEqual(original.listProposals());
    reopened.rejectChanges("all");
    expect(valueAt(reopened, "Data", "C2")).toBe(12.5);
    expect(at(reopened, "Data", "E3")).toMatchObject({ formula: "C3*D3", value: 206.25 });
    expect(at(reopened, "Data", "F2").formula).toBe("E2*(1+Calc!$B$6)");
    expect(reopened.getCell(data, a1("B2")).styleId).toBe(0);
    // New changes get fresh ids.
    reopened.beginProposal(AGENT);
    reopened.setCell(data, a1("A1"), "x");
    reopened.endProposal();
    expect(before.map((change) => change.id)).not.toContain(changes(reopened)[0]!.id);
  });

  it("keeps deleted rows across save and open so a later reject restores them", async () => {
    const { workbook, sheet } = smallBook();
    workbook.setFormula(sheet, a1("B1"), "A2*10");
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheet, 1, 1);
    const added = workbook.addSheet("Notes");
    workbook.setCell(added.id, a1("A1"), "why");
    workbook.endProposal();
    const reopened = await openXlsx(await workbook.save());
    expect(changes(reopened).map((change) => change.kind)).toEqual(["deleteRows", "addSheet", "cell"]);
    reopened.rejectChanges("all");
    expect(at(reopened, "Data", "B1")).toMatchObject({ formula: "A2*10", value: 20 });
    expect(at(reopened, "Data", "A4")).toMatchObject({ formula: "SUM(A1:A3)", value: 6 });
    expect(reopened.getSheetByName("Notes")).toBeNull();
  });

  it("keeps inserted rows that later proposed edits filled, so a reject takes both back", async () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertRows(sheet, 0, 1);
    workbook.setCell(sheet, a1("A1"), "Header");
    workbook.endProposal();
    expect(changes(workbook).map((change) => [change.kind, change.stale])).toEqual([
      ["insertRows", false],
      ["cell", false],
    ]);
    const reopened = await openXlsx(await workbook.save());
    expect(getJournalWarnings(reopened)).toEqual([]);
    expect(changes(reopened).map((change) => [change.kind, change.stale])).toEqual([
      ["insertRows", false],
      ["cell", false],
    ]);
    expect(reopened.rejectChanges("all").stale).toEqual([]);
    expect([1, 2, 3, 4].map((row) => valueAt(reopened, "Data", `A${row}`))).toEqual([1, 2, 3, 6]);
  });

  it("drops inserted rows on open once something else filled them", async () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertRows(sheet, 0, 1);
    workbook.setCell(sheet, a1("A1"), "Header");
    workbook.endProposal();
    // Another program changes the proposed cell, keeping the journal part.
    getWorkbookInternals(workbook).writeRawCell(sheet, a1("A1"), { value: "Other", formula: null, styleId: 0 });
    const reopened = await openXlsx(await workbook.save());
    expect(changes(reopened)).toEqual([]);
    expect(getJournalWarnings(reopened).map((warning) => warning.code)).toEqual(["change_stale", "change_stale"]);
  });

  it("removes the part once nothing is pending", async () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.endProposal();
    const withJournal = await openXlsx(await workbook.save());
    withJournal.acceptChanges("all");
    const pkg = await openPackage(await withJournal.save());
    expect(pkg.hasPart(JOURNAL_PART_NAME)).toBe(false);
    expect(pkg.getRelationshipsByType("/xl/workbook.xml", JOURNAL_RELATIONSHIP_TYPE)).toEqual([]);
  });

  it("writes no part for a workbook without changes", async () => {
    const pkg = await openPackage(await (await openXlsx(loadFixture("basic.xlsx"))).save());
    expect(pkg.hasPart(JOURNAL_PART_NAME)).toBe(false);
  });
});

describe("unreadable and stale journals", () => {
  it.each([
    ["not JSON", "{oops", "journal_unreadable"],
    ["a wrong shape", JSON.stringify({ version: 1, proposals: "x", changes: [] }), "journal_unreadable"],
    ["a later version", JSON.stringify({ version: 7, proposals: [], changes: [] }), "journal_unsupported_version"],
    [
      "a bad cell value",
      JSON.stringify({
        version: 1,
        nextProposal: 2,
        nextChange: 2,
        nextSeq: 2,
        proposals: [{ id: "p1", author: "a", date: "d", label: "l", seq: 1 }],
        changes: [{ kind: "cell", id: "c1", proposalId: "p1", seq: 1, sheet: "1", row: 0, col: 0, old: { value: { evil: true }, formula: null, styleId: 0 }, new: { value: 1, formula: null, styleId: 0 } }],
      }),
      "journal_unreadable",
    ],
    [
      "two changes on one cell",
      JSON.stringify({
        version: 1,
        nextProposal: 2,
        nextChange: 3,
        nextSeq: 4,
        proposals: [{ id: "p1", author: "a", date: "d", label: "l", seq: 1 }],
        changes: [1, 2].map((n) => ({ kind: "cell", id: `c${n}`, proposalId: "p1", seq: n + 1, sheet: "1", row: 0, col: 0, old: { value: null, formula: null, styleId: 0 }, new: { value: n, formula: null, styleId: 0 } })),
      }),
      "journal_unreadable",
    ],
  ])("ignores %s with a typed warning", async (_name, text, code) => {
    const bytes = await withJournalText(loadFixture("basic.xlsx"), text);
    const workbook = await openXlsx(bytes);
    expect(changes(workbook)).toEqual([]);
    expect(getJournalWarnings(workbook)).toEqual([{ code, changeId: null, sheet: null, row: null, col: null }]);
    // The workbook still works and the unreadable part is dropped on save.
    const sheet = workbook.listSheets()[0]!.id;
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("Z1"), 1);
    workbook.endProposal();
    const saved = await openXlsx(await workbook.save());
    expect(getJournalWarnings(saved)).toEqual([]);
    expect(changes(saved)).toHaveLength(1);
  });

  it("drops a change whose cell no longer holds the new content on open", async () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.setCell(sheet, a1("A2"), 20);
    workbook.endProposal();
    const [first] = changes(workbook);
    // Another program edits A1 but keeps the journal part.
    const internals = getWorkbookInternals(workbook);
    internals.writeRawCell(sheet, a1("A1"), { value: 77, formula: null, styleId: 0 });
    const reopened = await openXlsx(await workbook.save());
    expect(changes(reopened).map((change) => change.row)).toEqual([1]);
    expect(getJournalWarnings(reopened)).toEqual([{ code: "change_stale", changeId: first!.id, sheet, row: 0, col: 0 }]);
    expect(valueAt(reopened, "Data", "A1")).toBe(77);
  });

  it("flags an in-session stale change and does not revert it", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.setCell(sheet, a1("A2"), 20);
    workbook.endProposal();
    getWorkbookInternals(workbook).writeRawCell(sheet, a1("A1"), { value: 77, formula: null, styleId: 0 });
    const list = changes(workbook);
    expect(list.map((change) => change.stale)).toEqual([true, false]);
    const result = workbook.rejectChanges("all");
    expect(result.resolvedIds).toEqual([list[1]!.id]);
    expect(result.stale).toEqual([list[0]!.id]);
    expect(valueAt(workbook, "Data", "A1")).toBe(77);
    expect(valueAt(workbook, "Data", "A2")).toBe(2);
    // A stale change can still be accepted.
    expect(workbook.acceptChanges([list[0]!.id]).resolvedIds).toEqual([list[0]!.id]);
  });

  it("does not reject an inserted row that has gained content", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.insertRows(sheet, 0, 1);
    workbook.endProposal();
    getWorkbookInternals(workbook).writeRawCell(sheet, a1("B1"), { value: "typed", formula: null, styleId: 0 });
    const [change] = changes(workbook);
    expect(change!.stale).toBe(true);
    const result = workbook.rejectChanges("all");
    expect(result.stale).toEqual([change!.id]);
    expect(valueAt(workbook, "Data", "B1")).toBe("typed");
  });
});

// Outcome protected: whatever save writes as pending changes opens again, so the owner can still review them.
// Fault detected: the journal writer keeping more, or longer, fields than the reader accepts, so the
// whole journal is dropped as unreadable on the next open.
describe("a saved journal holds only what it can read back", () => {
  it("keeps the heights of more than ten thousand deleted rows, so a reject after reopening restores them", async () => {
    const { workbook, sheet } = smallBook();
    for (let row = 10; row < 10_011; row++) workbook.setRowHeight(sheet, row, 30);
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheet, 10, 10_001);
    workbook.endProposal();
    const reopened = await openXlsx(await workbook.save());
    expect(getJournalWarnings(reopened)).toEqual([]);
    expect(reopened.rejectChanges("all").stale).toEqual([]);
    const rows = reopened.getSheet(sheetId(reopened, "Data")).rows.filter((row) => row.heightPt === 30);
    expect(rows).toHaveLength(10_001);
  });

  it("keeps the merged ranges of a sheet with more than ten thousand of them", async () => {
    let merges = "";
    for (let row = 2; row <= 10_002; row++) merges += `<mergeCell ref="A${row}:B${row}"/>`;
    const workbook = await openXlsx(
      await buildXlsx({ sheets: [{ name: "Data", rows: `<row r="1">${num("A1", 1)}</row>`, after: `<mergeCells>${merges}</mergeCells>` }] }),
    );
    const sheet = sheetId(workbook, "Data");
    workbook.beginProposal(AGENT);
    workbook.deleteRows(sheet, 0, 1);
    workbook.endProposal();
    const reopened = await openXlsx(await workbook.save());
    expect(getJournalWarnings(reopened)).toEqual([]);
    expect(reopened.rejectChanges("all").stale).toEqual([]);
    const after = reopened.getSheet(sheetId(reopened, "Data")).mergedRanges;
    expect(after).toHaveLength(10_001);
    expect(after.some((range) => range.start.row === 1 && range.end.col === 1)).toBe(true);
  });

  it("refuses, before changing anything, a deletion whose kept rows a journal could not hold", async () => {
    const workbook = await openXlsx(
      await buildXlsx({ sheets: [{ name: "Data", rows: `<row r="1">${num("A1", 1)}</row><row r="2" hidden="1" note="${"x".repeat(2000)}">${num("A2", 2)}</row>` }] }),
    );
    const sheet = sheetId(workbook, "Data");
    workbook.beginProposal(AGENT);
    expect(codeOf(() => workbook.deleteRows(sheet, 1, 1))).toBe("limit_exceeded");
    workbook.endProposal();
    expect(valueAt(workbook, "Data", "A2")).toBe(2);
    expect(changes(workbook)).toEqual([]);
  });

  // Outcome protected: rejecting a proposed deletion gives back every formula it turned into #REF!. Fault detected:
  // past the kept-rewrite limit the deletion went ahead without the old formulas, so a reject put the rows back but
  // left the references to them broken.
  it("refuses, before changing anything, a deletion that rewrites more formulas than a journal keeps", async () => {
    const last = 200_002;
    const parts = [`<row r="1">${num("A1", 1)}</row>`, `<row r="2"><c r="B2"><f t="shared" ref="B2:B${last}" si="0">$A$1</f><v>1</v></c></row>`];
    for (let r = 3; r <= last; r++) parts.push(`<row r="${r}"><c r="B${r}"><f t="shared" si="0"/><v>1</v></c></row>`);
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "Data", rows: parts.join("") }] }));
    const sheet = sheetId(workbook, "Data");
    workbook.beginProposal(AGENT);
    expect(codeOf(() => workbook.deleteRows(sheet, 0, 1))).toBe("limit_exceeded");
    workbook.endProposal();
    expect(valueAt(workbook, "Data", "A1")).toBe(1);
    expect(at(workbook, "Data", "B2").formula).toBe("$A$1");
    expect(at(workbook, "Data", `B${last}`).formula).toBe("$A$1");
    expect(changes(workbook)).toEqual([]);
  }, 120_000);

  it("takes back an insertion whose rewritten names a journal could not hold", async () => {
    const refersTo = Array.from({ length: 819 }, () => "Data!$A$9").join("+");
    const workbook = await openXlsx(
      await buildXlsx({
        sheets: [{ name: "Data", rows: `<row r="9">${num("A9", 4)}</row>` }],
        definedNames: `<definedName name="Wide">${refersTo}</definedName>`,
      }),
    );
    const sheet = sheetId(workbook, "Data");
    workbook.beginProposal(AGENT);
    expect(codeOf(() => workbook.insertRows(sheet, 0, 1))).toBe("limit_exceeded");
    workbook.endProposal();
    expect(valueAt(workbook, "Data", "A9")).toBe(4);
    expect(workbook.listDefinedNames()[0]!.refersTo).toBe(refersTo);
    expect(changes(workbook)).toEqual([]);
  });

  it("refuses a proposed edit to a cell whose formula is longer than a journal holds", async () => {
    const formula = Array.from({ length: 4200 }, () => "1").join("+");
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "Data", rows: `<row r="1"><c r="A1"><f>${formula}</f><v>3000</v></c></row>` }] }));
    const sheet = sheetId(workbook, "Data");
    workbook.beginProposal(AGENT);
    expect(codeOf(() => workbook.setCell(sheet, a1("A1"), 5))).toBe("limit_exceeded");
    workbook.endProposal();
    expect(at(workbook, "Data", "A1").formula).toBe(formula);
    expect(changes(workbook)).toEqual([]);
  });

  it("refuses to save pending changes it could not read back, until they are accepted or rejected", async () => {
    const { workbook, sheet } = smallBook();
    const notes = workbook.addSheet("Notes").id;
    // As long as a typed formula may be.
    const long = `Data!A9&"${"x".repeat(8182)}"`;
    workbook.beginProposal(AGENT);
    workbook.setFormula(notes, a1("B1"), long);
    workbook.endProposal();
    // Moving the rows it reads, outside a proposal, lengthens the pending formula past what a journal holds.
    workbook.insertRows(sheet, 0, 1);
    expect(at(workbook, "Notes", "B1").formula).toHaveLength(8193);
    expect(await asyncCodeOf(() => workbook.save())).toBe("limit_exceeded");
    workbook.acceptChanges("all");
    const reopened = await openXlsx(await workbook.save());
    expect(getJournalWarnings(reopened)).toEqual([]);
  });
});
