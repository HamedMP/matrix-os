import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellChange, ResolveChangesResult } from "../../../../packages/office/src/api/xlsx.js";
import { findAll, getAttr, setAttr } from "../../../../packages/office/src/xml/index.js";
import { createXlsx, openXlsx, parseA1, parseA1Range, parseCsv } from "../../../../packages/office/src/xlsx/index.js";
import {
  type CellMutation,
  type WorkbookInternals,
  type WorkbookJournal,
  attachJournal,
  getWorkbookInternals,
  setJournalProvider,
} from "../../../../packages/office/src/xlsx/internal.js";
import { at, codeOf, err, loadFixture, sheetId, valueAt } from "./helpers.js";

/** A journal that records calls, with one pending change on Data!B2. */
function fakeJournal(sheet: string, calls: string[]): WorkbookJournal {
  const change = { id: "c1", sheet, row: 1, col: 1 } as CellChange;
  const resolved = (ids: readonly string[] | "all"): ResolveChangesResult => ({ resolvedIds: ids === "all" ? ["c1"] : [...ids], restored: [], stale: [] });
  return {
    beginProposal: (options) => (calls.push(`begin:${options.label}`), "p1"),
    endProposal: () => void calls.push("end"),
    listProposals: () => [{ id: "p1", author: "a", date: "2026-11-23T00:00:00Z", label: "l", pendingCount: 1 }],
    listChanges: () => [change],
    acceptChanges: (ids) => (calls.push("accept"), resolved(ids)),
    rejectChanges: (ids) => (calls.push("reject"), resolved(ids)),
    pendingChangeId: (id, row, col) => (id === sheet && row === 1 && col === 1 ? "c1" : null),
    pendingChangeCount: (id) => (id === sheet ? 1 : 0),
    beforeSave: () => void calls.push("beforeSave"),
  };
}

// Importing the workbook module registers the change journal. These tests are about the seam itself, so each starts without one.
beforeEach(() => setJournalProvider(null));
afterEach(() => setJournalProvider(null));

describe("a workbook without a journal", () => {
  it("has no proposals and refuses to start one", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    expect(codeOf(() => workbook.beginProposal({ author: "a", date: "2026-11-23T00:00:00Z", label: "x" }))).toBe("invalid_operation");
    workbook.endProposal();
    expect(workbook.listProposals()).toEqual([]);
    expect(workbook.listChanges()).toEqual([]);
    expect(workbook.acceptChanges("all")).toEqual({ resolvedIds: [], restored: [], stale: [] });
    expect(workbook.rejectChanges([])).toEqual({ resolvedIds: [], restored: [], stale: [] });
    expect(codeOf(() => workbook.acceptChanges(["c9"]))).toBe("stale_reference");
    expect(codeOf(() => workbook.rejectChanges(["c9"]))).toBe("stale_reference");
  });
});

describe("the journal seam", () => {
  it("hands every proposal method to the attached journal", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    const calls: string[] = [];
    attachJournal(workbook, fakeJournal(data, calls));
    expect(getWorkbookInternals(workbook).getJournal()).not.toBeNull();
    expect(workbook.beginProposal({ author: "a", date: "2026-11-23T00:00:00Z", label: "fix" })).toBe("p1");
    workbook.endProposal();
    expect(workbook.listProposals().map((proposal) => proposal.id)).toEqual(["p1"]);
    expect(workbook.listChanges().map((change) => change.id)).toEqual(["c1"]);
    expect(workbook.acceptChanges("all").resolvedIds).toEqual(["c1"]);
    expect(workbook.rejectChanges(["c1"]).resolvedIds).toEqual(["c1"]);
    expect(at(workbook, "Data", "B2").pendingChangeId).toBe("c1");
    expect(at(workbook, "Data", "B3").pendingChangeId).toBeNull();
    expect(at(workbook, "Calc", "B2").pendingChangeId).toBeNull();
    expect(workbook.getSheet(data).pendingChangeCount).toBe(1);
    expect(workbook.getSheet(sheetId(workbook, "Calc")).pendingChangeCount).toBe(0);
    await workbook.save();
    expect(calls).toEqual(["begin:fix", "end", "accept", "reject", "beforeSave"]);
  });

  it("refuses structural edits and removal while a sheet has pending changes", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const data = sheetId(workbook, "Data");
    const calc = sheetId(workbook, "Calc");
    attachJournal(workbook, fakeJournal(data, []));
    expect(codeOf(() => workbook.insertRows(data, 0, 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.deleteRows(data, 0, 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.insertColumns(data, 0, 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.deleteColumns(data, 0, 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.removeSheet(data))).toBe("invalid_operation");
    // Other sheets are free, and ordinary edits are always allowed.
    workbook.insertRows(calc, 0, 1);
    workbook.setCell(data, parseA1("B2"), "edited");
    attachJournal(workbook, null);
    workbook.insertRows(data, 0, 1);
    expect(valueAt(workbook, "Data", "B3")).toBe("edited");
  });

  it("uses the registered provider for opened, created and imported workbooks", async () => {
    const seen: string[] = [];
    const make = (kind: string, internals: WorkbookInternals): WorkbookJournal => {
      seen.push(`${kind}:${internals.workbookPartName}`);
      return fakeJournal("1", []);
    };
    setJournalProvider({
      open: async (internals) => {
        expect(await internals.readPartText("/matrix/changeJournal.json")).toBeNull();
        expect(await internals.readPartText("/xl/workbook.xml")).toContain("<workbook");
        return make("open", internals);
      },
      create: (internals) => make("create", internals),
    });
    const opened = await openXlsx(loadFixture("basic.xlsx"));
    const created = createXlsx();
    const imported = parseCsv("a,b\n1,2");
    expect(seen).toEqual(["open:/xl/workbook.xml", "create:/xl/workbook.xml", "create:/xl/workbook.xml"]);
    for (const workbook of [opened, created, imported]) expect(workbook.listSheets()[0]!.pendingChangeCount).toBe(1);
    setJournalProvider(null);
    expect(createXlsx().listSheets()[0]!.pendingChangeCount).toBe(0);
  });
});

describe("workbook internals", () => {
  it("reads and writes raw cells without telling listeners", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const internals = getWorkbookInternals(workbook);
    const data = sheetId(workbook, "Data");
    const seen: CellMutation[] = [];
    internals.onCellMutation((mutation) => seen.push(mutation));
    expect(internals.readRawCell(data, parseA1("E2"))).toEqual({ value: 500, formula: "C2*D2", styleId: 0 });
    expect(internals.readRawCell(data, parseA1("Z99"))).toEqual({ value: null, formula: null, styleId: 0 });
    internals.writeRawCell(data, parseA1("E2"), { value: 7, formula: null, styleId: 0 });
    internals.writeRawCell(data, parseA1("Z99"), { value: "x", formula: "A1&\"x\"", styleId: 0 });
    expect(seen).toEqual([]);
    expect(at(workbook, "Data", "E2")).toMatchObject({ value: 7, formula: null });
    expect(at(workbook, "Data", "Z99")).toMatchObject({ value: "x", formula: 'A1&"x"' });
    // Dependants are out of date after a raw write, as after an edit.
    workbook.recalc();
    expect(valueAt(workbook, "Data", "F2")).toBeCloseTo(8.4, 9);
    expect(valueAt(workbook, "Data", "Z99")).toBe("SKUx");
    expect(codeOf(() => internals.readRawCell("nope", parseA1("A1")))).toBe("not_found");
    expect(codeOf(() => internals.writeRawCell(data, { row: -1, col: 0 }, { value: 1, formula: null, styleId: 0 }))).toBe("invalid_argument");
    expect(codeOf(() => getWorkbookInternals({} as never))).toBe("invalid_argument");
  });

  it("reports each changed cell once, with what it held before and after", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const internals = getWorkbookInternals(workbook);
    const data = sheetId(workbook, "Data");
    const calc = sheetId(workbook, "Calc");
    const seen: CellMutation[] = [];
    const markups: Array<string | null> = [];
    const stop = internals.onCellMutation(({ beforeMarkup, ...mutation }) => {
      if (beforeMarkup !== undefined) markups.push(beforeMarkup());
      seen.push(mutation);
    });
    workbook.setCell(data, parseA1("D2"), 50);
    workbook.setCell(data, parseA1("D2"), 50);
    workbook.setFormula(data, parseA1("G1"), "=D2*2");
    workbook.setCellInput(data, parseA1("G2"), "12%");
    workbook.setRange(data, parseA1("H1"), [[1, null]]);
    workbook.clearRange(data, parseA1Range("A6:B6"));
    workbook.setStyle(data, parseA1Range("C2:C2"), { font: { bold: true } });
    workbook.recalc();
    const bold = at(workbook, "Data", "C2").styleId;
    const percent = at(workbook, "Data", "G2").styleId;
    expect(seen).toEqual([
      { sheet: data, row: 1, col: 3, reason: "edit", before: { value: 40, formula: null, styleId: 0 }, after: { value: 50, formula: null, styleId: 0 } },
      { sheet: data, row: 0, col: 6, reason: "edit", before: { value: null, formula: null, styleId: 0 }, after: { value: null, formula: "D2*2", styleId: 0 } },
      { sheet: data, row: 1, col: 6, reason: "edit", before: { value: null, formula: null, styleId: 0 }, after: { value: 0.12, formula: null, styleId: percent } },
      { sheet: data, row: 0, col: 7, reason: "edit", before: { value: null, formula: null, styleId: 0 }, after: { value: 1, formula: null, styleId: 0 } },
      { sheet: data, row: 5, col: 0, reason: "edit", before: { value: "SKU-005", formula: null, styleId: 0 }, after: { value: null, formula: null, styleId: 0 } },
      { sheet: data, row: 5, col: 1, reason: "edit", before: { value: "Sprocket", formula: null, styleId: 0 }, after: { value: null, formula: null, styleId: 0 } },
      { sheet: data, row: 1, col: 2, reason: "edit", before: { value: 12.5, formula: null, styleId: 0 }, after: { value: 12.5, formula: null, styleId: bold } },
    ]);
    // An edit of a cell that existed says what its element held besides its content: nothing, for these plain cells.
    expect(markups).toEqual([null, null, null, null]);
    // Formula text rewritten by a structural edit elsewhere is reported as a rewrite.
    seen.length = 0;
    workbook.insertRows(calc, 0, 1);
    const rewrites = seen.filter((mutation) => mutation.sheet === data);
    expect(rewrites.length).toBe(5);
    expect(rewrites[0]).toEqual({
      sheet: data,
      row: 1,
      col: 5,
      reason: "rewrite",
      before: { value: 750, formula: "E2*(1+Calc!$B$6)", styleId: 0 },
      after: { value: 750, formula: "E2*(1+Calc!$B$7)", styleId: 0 },
    });
    seen.length = 0;
    workbook.renameSheet(calc, "Sums");
    expect(seen.filter((mutation) => mutation.reason === "rewrite").length).toBe(5);
    stop();
    seen.length = 0;
    workbook.setCell(data, parseA1("D3"), 1);
    expect(seen).toEqual([]);
    // An error value in a mutation is a copy.
    internals.onCellMutation((mutation) => seen.push(mutation));
    workbook.setCell(data, parseA1("D4"), err("#N/A"));
    expect(seen[0]?.after.value).toEqual(err("#N/A"));
  });

  it("bounds the number of listeners", () => {
    const internals = getWorkbookInternals(createXlsx());
    const stops = Array.from({ length: 16 }, () => internals.onCellMutation(() => undefined));
    expect(codeOf(() => internals.onCellMutation(() => undefined))).toBe("limit_exceeded");
    stops[0]?.();
    internals.onCellMutation(() => undefined);
  });

  it("gives access to the parts it holds, with pending edits written in", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    const internals = getWorkbookInternals(workbook);
    const data = sheetId(workbook, "Data");
    expect(internals.package).toBe(workbook.package);
    expect(internals.workbook).toBe(workbook);
    expect(internals.workbookPartName).toBe("/xl/workbook.xml");
    expect(internals.sheetPartName(data)).toBe("/xl/worksheets/sheet1.xml");
    expect(internals.hasSheet(data)).toBe(true);
    expect(internals.hasSheet("99")).toBe(false);
    expect(codeOf(() => internals.sheetPartName("99"))).toBe("not_found");
    workbook.setCell(data, parseA1("C2"), 99);
    const sheetXml = internals.getPartXml("xl/worksheets/sheet1.xml");
    expect(sheetXml).not.toBeNull();
    const cell = findAll(sheetXml!, "c").find((element) => getAttr(element, "r") === "C2");
    expect(cell && findAll(cell, "v")[0]?.children[0]).toMatchObject({ value: "99" });
    expect(internals.getPartXml("/xl/sharedStrings.xml")?.root.name).toBe("sst");
    expect(internals.getPartXml("/xl/styles.xml")?.root.name).toBe("styleSheet");
    expect(internals.getPartXml("/xl/theme/theme1.xml")).toBeNull();
    expect(internals.getPartXml("/nope.xml")).toBeNull();
    // A change made through the XML helpers is saved once the part is marked.
    const workbookXml = internals.getPartXml("/xl/workbook.xml")!;
    setAttr(workbookXml.root, "conformance", "transitional");
    internals.markPartDirty("/xl/workbook.xml");
    const reopened = await openXlsx(await workbook.save());
    expect(await reopened.package.getPartText("/xl/workbook.xml")).toContain('conformance="transitional"');
    expect(valueAt(reopened, "Data", "C2")).toBe(99);
    expect(await internals.readPartText("/docProps/app.xml")).toContain("Properties");
    expect(await internals.readPartText("/missing.xml")).toBeNull();
  });
});
