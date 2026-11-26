/**
 * A date formula that picks its cells at run time (OFFSET, INDIRECT) and has
 * not been calculated since its workbook was opened has no record of the
 * cells it read. A run without a time keeps its date only when what it would
 * read now did not change.
 */

import { describe, expect, it } from "vitest";
import { createXlsx, openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { err, valueAt } from "./helpers.js";

const NOW = "2026-11-23T10:00:00Z";
const DATE = 46349;

async function savedBook(formula: string, setup?: (book: ReturnType<typeof createXlsx>, s: string) => void): Promise<Uint8Array> {
  const workbook = createXlsx({ sheetNames: ["S", "T", "U"] });
  const [s, t] = workbook.listSheets().map((info) => info.id) as [string, string, string];
  workbook.setCell(s, parseA1("A5"), 5);
  setup?.(workbook, s);
  workbook.setFormula(t, parseA1("B1"), formula);
  workbook.recalc({ now: NOW });
  return workbook.save();
}

describe("a freshly opened date formula that picks its cells at run time", () => {
  // Fault detected: with no record of what it read, the run took such a formula as reading nothing but the cells its
  // text names, so an edit of the cell INDIRECT reads kept a date the formula no longer gives.
  it.each([
    ['IF(INDIRECT("S!A5")=5,TODAY(),42)', "S", 42],
    ["IF(OFFSET(S!A1,4,0)=5,TODAY(),42)", "S", 42],
    // An edit of a sheet it does not read keeps the date.
    ['IF(INDIRECT("S!A5")=5,TODAY(),42)', "U", DATE],
    // Where it reads depends on the clock, so it may read any cell: any edit counts.
    ['IF(INDIRECT("S!A"&IF(TODAY()>0,5,6))=5,TODAY(),42)', "U", err("#N/A")],
  ] as const)("judges %s after an edit on %s by the cells it reads now", async (formula, edited, expected) => {
    const workbook = await openXlsx(await savedBook(formula));
    const sheet = workbook.getSheetByName(edited)!.id;
    workbook.setCell(sheet, parseA1("A5"), 9);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "T", "B1")).toEqual(expected);
  });

  // Fault detected: the cell a name points INDIRECT at asks for its own row, so inserting rows changes its value, but
  // the run did not know INDIRECT reads it and kept the date.
  it("calculates again a date formula whose INDIRECT name points at a formula the move changes", async () => {
    const source = await savedBook('IF(INDIRECT("Picked")=5,TODAY(),42)', (book, s) => {
      book.setFormula(s, parseA1("A5"), "ROW()");
      book.setDefinedName({ name: "Picked", refersTo: "S!$A$5", scope: null });
    });
    const workbook = await openXlsx(source);
    workbook.insertRows(workbook.listSheets()[0]!.id, 0, 2);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "S", "A7")).toBe(7);
    expect(valueAt(reopened, "T", "B1")).toBe(42);
  });

  it("keeps the date of a date formula whose INDIRECT name points at a cell the move leaves alone", async () => {
    const source = await savedBook('IF(INDIRECT("Picked")=5,TODAY(),42)', (book) => {
      book.setDefinedName({ name: "Picked", refersTo: "S!$A$5", scope: null });
    });
    const workbook = await openXlsx(source);
    workbook.insertRows(workbook.listSheets()[0]!.id, 0, 2);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "T", "B1")).toBe(DATE);
  });
});
