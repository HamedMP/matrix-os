import { describe, expect, it } from "vitest";
import type { Workbook } from "../../../../packages/office/src/api/xlsx.js";
import { openXlsx, parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { buildXlsx } from "../workbook/helpers.js";
import { AGENT, OWNER, a1, changes, codeOf, err, resolved, sheetId, smallBook, valueAt } from "./helpers.js";

describe("recording proposed cell edits", () => {
  it("applies the edit at once and records old and new content", () => {
    const { workbook, sheet } = smallBook();
    const proposalId = workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.endProposal();
    expect(valueAt(workbook, "Data", "A1")).toBe(10);
    workbook.recalc();
    expect(valueAt(workbook, "Data", "A4")).toBe(15);
    const [change, ...rest] = changes(workbook);
    expect(rest).toEqual([]);
    expect(change).toMatchObject({
      kind: "cell",
      proposalId,
      author: AGENT.author,
      date: AGENT.date,
      label: AGENT.label,
      sheet,
      row: 0,
      col: 0,
      oldValue: 1,
      newValue: 10,
      oldFormula: null,
      newFormula: null,
      oldDisplay: "1",
      newDisplay: "10",
      stale: false,
    });
    expect(workbook.getCell(sheet, a1("A1")).pendingChangeId).toBe(change!.id);
    expect(workbook.getSheet(sheet).pendingChangeCount).toBe(1);
    expect(workbook.listProposals()).toEqual([{ id: proposalId, ...AGENT, pendingCount: 1 }]);
  });

  it("records formulas with their calculated value", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setFormula(sheet, a1("A4"), "SUM(A1:A3)*2");
    workbook.setFormula(sheet, a1("B1"), "A1+100");
    workbook.endProposal();
    workbook.recalc();
    const [b1, sum] = changes(workbook);
    expect(sum).toMatchObject({ row: 3, col: 0, oldValue: 6, newValue: 12, oldFormula: "SUM(A1:A3)", newFormula: "SUM(A1:A3)*2", newDisplay: "12" });
    expect(b1).toMatchObject({ row: 0, col: 1, oldValue: null, newValue: 101, oldFormula: null, newFormula: "A1+100", oldDisplay: "" });
  });

  it("records style changes and shows display text with the number format", () => {
    const { workbook, sheet } = smallBook();
    workbook.setCell(sheet, a1("C1"), 0.25);
    workbook.beginProposal(AGENT);
    workbook.setStyle(sheet, parseA1Range("C1"), { numberFormat: "0%" });
    workbook.endProposal();
    const [change] = changes(workbook);
    expect(change).toMatchObject({ oldValue: 0.25, newValue: 0.25, oldStyleId: 0, oldDisplay: "0.25", newDisplay: "25%" });
    expect(change!.newStyleId).not.toBe(0);
  });

  it("keeps one change per cell with the first old and the latest new content", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.endProposal();
    workbook.beginProposal(OWNER);
    workbook.setCell(sheet, a1("A1"), 20);
    workbook.endProposal();
    const list = changes(workbook);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ oldValue: 1, newValue: 20, author: AGENT.author });
    expect(workbook.listProposals().map((proposal) => proposal.label)).toEqual([AGENT.label]);
  });

  it("drops a change whose new content equals the old", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.setCell(sheet, a1("A1"), 1);
    workbook.endProposal();
    expect(changes(workbook)).toEqual([]);
    expect(workbook.listProposals()).toEqual([]);
  });

  it("accepts a pending change when its cell is edited outside a proposal", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.setCell(sheet, a1("A2"), 20);
    workbook.endProposal();
    workbook.setCell(sheet, a1("A1"), 99);
    expect(changes(workbook).map((change) => change.row)).toEqual([1]);
    expect(valueAt(workbook, "Data", "A1")).toBe(99);
  });

  it("refuses a second open proposal and bad options", () => {
    const { workbook } = smallBook();
    expect(codeOf(() => workbook.beginProposal({ author: "", date: AGENT.date, label: "x" }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.beginProposal({ author: "a", date: 5 as never, label: "x" }))).toBe("invalid_argument");
    workbook.beginProposal(AGENT);
    expect(codeOf(() => workbook.beginProposal(OWNER))).toBe("invalid_operation");
    workbook.endProposal();
    workbook.endProposal();
  });

  it("lists changes by sheet, row and column with stable ids", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("B2"), "b2");
    workbook.setCell(sheet, a1("A2"), "a2");
    workbook.setCell(sheet, a1("A1"), "a1");
    workbook.endProposal();
    const first = changes(workbook);
    expect(first.map((change) => [change.row, change.col])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(new Set(first.map((change) => change.id)).size).toBe(3);
    workbook.acceptChanges([first[0]!.id]);
    expect(changes(workbook).map((change) => change.id)).toEqual([first[1]!.id, first[2]!.id]);
  });
});

describe("accepting and rejecting cell changes", () => {
  function proposed() {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCell(sheet, a1("A1"), 10);
    workbook.setFormula(sheet, a1("A4"), "SUM(A1:A3)*2");
    workbook.setStyle(sheet, parseA1Range("A2"), { font: { bold: true } });
    workbook.setCell(sheet, a1("C3"), err("#N/A"));
    workbook.endProposal();
    workbook.recalc();
    const [a, b, c, d] = changes(workbook);
    return { workbook, sheet, ids: [a!.id, b!.id, c!.id, d!.id] as const };
  }

  it("accepts one change and keeps the content", () => {
    const { workbook, ids } = proposed();
    const result = workbook.acceptChanges([ids[0]]);
    expect(result).toEqual({ resolvedIds: [ids[0]], restored: [], stale: [] });
    expect(valueAt(workbook, "Data", "A1")).toBe(10);
    expect(changes(workbook)).toHaveLength(3);
  });

  it("rejects one change and recalculates", () => {
    const { workbook, sheet, ids } = proposed();
    const result = workbook.rejectChanges([ids[0]]);
    expect(result.resolvedIds).toEqual([ids[0]]);
    expect(result.restored).toEqual([{ sheet, row: 0, col: 0 }]);
    expect(valueAt(workbook, "Data", "A1")).toBe(1);
    // A4 still holds the proposed formula, recalculated on the restored input.
    expect(valueAt(workbook, "Data", "A4")).toBe(12);
    expect(workbook.getCell(sheet, a1("A1")).pendingChangeId).toBeNull();
  });

  it("rejects several changes, restoring formula, style and error values", () => {
    const { workbook, sheet, ids } = proposed();
    workbook.rejectChanges([ids[1], ids[2], ids[3]]);
    expect(workbook.getCell(sheet, a1("A4"))).toMatchObject({ formula: "SUM(A1:A3)", value: 15 });
    expect(workbook.getCell(sheet, a1("A2")).styleId).toBe(0);
    expect(valueAt(workbook, "Data", "C3")).toBeNull();
    expect(changes(workbook).map((change) => change.id)).toEqual([ids[0]]);
  });

  it("rejects all changes and forgets empty proposals", () => {
    const { workbook, ids } = proposed();
    const result = workbook.rejectChanges("all");
    expect([...result.resolvedIds].sort()).toEqual([...ids].sort());
    expect(valueAt(workbook, "Data", "A1")).toBe(1);
    expect(valueAt(workbook, "Data", "A4")).toBe(6);
    expect(workbook.listProposals()).toEqual([]);
    expect(changes(workbook)).toEqual([]);
  });

  it("accepts all changes", () => {
    const { workbook, ids } = proposed();
    expect([...workbook.acceptChanges("all").resolvedIds].sort()).toEqual([...ids].sort());
    expect(valueAt(workbook, "Data", "A4")).toBe(30);
    expect(workbook.listProposals()).toEqual([]);
  });

  it("throws stale_reference for an unknown id and changes nothing", () => {
    const { workbook, ids } = proposed();
    expect(codeOf(() => workbook.rejectChanges([ids[0], "c999"]))).toBe("stale_reference");
    expect(codeOf(() => workbook.acceptChanges(["nope"]))).toBe("stale_reference");
    expect(codeOf(() => workbook.acceptChanges([5 as never]))).toBe("invalid_argument");
    expect(changes(workbook)).toHaveLength(4);
    expect(valueAt(workbook, "Data", "A1")).toBe(10);
  });

  it("restores the old value after several edits to the same cell", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.setCellInput(sheet, a1("A1"), "=A2*5");
    workbook.setCellInput(sheet, a1("A1"), "2027-01-31");
    workbook.endProposal();
    const [change] = changes(workbook);
    expect(change).toMatchObject({ oldValue: 1, oldFormula: null, newFormula: null, newDisplay: "2027-01-31" });
    workbook.rejectChanges("all");
    expect(workbook.getCell(sheet, a1("A1"))).toMatchObject({ value: 1, formula: null, styleId: 0, display: "1" });
  });

  it("records cleared ranges", () => {
    const { workbook, sheet } = smallBook();
    workbook.beginProposal(AGENT);
    workbook.clearRange(sheet, parseA1Range("A1:A4"));
    workbook.endProposal();
    expect(changes(workbook)).toHaveLength(4);
    workbook.recalc();
    resolved(workbook.rejectChanges("all"));
    expect(valueAt(workbook, "Data", "A4")).toBe(6);
  });
});

describe("rejecting an edit of a cell with rich text", () => {
  const RICH = '<c r="A1" t="inlineStr" cm="1"><is><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> text</t></r></is></c>';
  const book = () =>
    buildXlsx({
      sheets: [{ name: "S", rows: `<row r="1">${RICH}<c r="B1" t="s" vm="2"><v>0</v></c><c r="C1" ph="1"><v>4</v></c></row>` }],
      sharedStrings: "<si><r><rPr><i/></rPr><t>Ital</t></r><r><t>ic</t></r></si>",
    });
  const row1 = async (workbook: Workbook): Promise<string> =>
    /<row r="1".*?<\/row>/.exec(await (await openXlsx(await workbook.save())).package.getPartText("/xl/worksheets/sheet1.xml"))?.[0] ?? "";
  const expectRestored = (row: string): void => {
    expect(row).toContain(RICH);
    expect(row).toContain('<c r="B1" t="inlineStr" vm="2"><is><r><rPr><i/></rPr><t>Ital</t></r><r><t>ic</t></r></is></c>');
    expect(row).toContain('<c r="C1" ph="1"><v>4</v></c>');
  };

  it("puts back its runs and metadata, also after the edit was saved", async () => {
    const workbook = await openXlsx(await book());
    const id = sheetId(workbook, "S");
    workbook.beginProposal(AGENT);
    workbook.setCell(id, a1("A1"), "plain");
    workbook.clearRange(id, parseA1Range("B1:C1"));
    workbook.endProposal();
    const during = await row1(workbook);
    expect(during).not.toContain("cm=");
    expect(during).not.toContain("<b/>");
    expect(workbook.rejectChanges("all").stale).toEqual([]);
    expect(valueAt(workbook, "S", "A1")).toBe("Bold text");
    expectRestored(await row1(workbook));

    const first = await openXlsx(await book());
    first.beginProposal(AGENT);
    first.setCell(sheetId(first, "S"), a1("A1"), "plain");
    first.setCell(sheetId(first, "S"), a1("B1"), "other");
    first.setCell(sheetId(first, "S"), a1("C1"), 5);
    first.endProposal();
    const second = await openXlsx(await first.save());
    expect(second.rejectChanges("all").stale).toEqual([]);
    expectRestored(await row1(second));
  });

  it("keeps an edit made outside a proposal plain", async () => {
    const workbook = await openXlsx(await book());
    workbook.setCell(sheetId(workbook, "S"), a1("A1"), "Other");
    const row = await row1(workbook);
    expect(row).not.toContain("cm=");
    expect(row).toContain('<c r="A1" t="s">');
  });
});
