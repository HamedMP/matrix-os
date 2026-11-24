/**
 * Cell text other software reads back as written.
 *
 * - A carriage return written literally in XML reaches every other reader
 *   as a line feed. As the character reference `&#13;` it reaches all of
 *   them, also the readers that do not decode the `_x000D_` form.
 * - The shared string table states how many cells use it. The engine used
 *   to add one for every write and never take one away.
 */

import { describe, expect, it } from "vitest";
import type { Workbook } from "../../../packages/office/src/index.js";
import { createXlsx, openXlsx, opc, parseA1 } from "../../../packages/office/src/index.js";
import { attr, loadFixture, readPackage, walk } from "./package.js";
import { firstSheet } from "./sheet-scenarios.js";
import { sheetProblems } from "./sml-rules.js";

async function partText(bytes: Uint8Array, name: string): Promise<string> {
  return (await opc.openPackage(bytes)).getPartText(name);
}

/** The count the shared string table states, and the cells of all sheets that point into it. */
async function stringCounts(bytes: Uint8Array): Promise<{ stated: string | null; unique: string | null; cells: number; entries: number }> {
  const pkg = await readPackage(bytes);
  let cells = 0;
  for (const [name, doc] of pkg.parts) {
    if (!name.startsWith("/xl/worksheets/")) continue;
    for (const element of walk(doc.root)) if (element.name === "c" && attr(element, "t") === "s") cells++;
  }
  const table = pkg.parts.get("/xl/sharedStrings.xml")?.root;
  if (table === undefined) return { stated: null, unique: null, cells, entries: 0 };
  return { stated: attr(table, "count"), unique: attr(table, "uniqueCount"), cells, entries: table.children.filter((node) => node.kind === "element").length };
}

describe("carriage returns in cell text", () => {
  const TEXT = "first line\r\nsecond line\rthird";

  it("are written as a character reference and read back", async () => {
    const workbook = createXlsx();
    const sheet = firstSheet(workbook).id;
    workbook.setCell(sheet, parseA1("A1"), TEXT);
    workbook.setCell(sheet, parseA1("A2"), "literal _x000D_ stays text");
    workbook.setFormula(sheet, parseA1("A3"), 'A1&"!"');
    const bytes = await workbook.save();
    const strings = await partText(bytes, "/xl/sharedStrings.xml");
    expect(strings).not.toContain("\r");
    expect(strings).toContain("first line&#13;\nsecond line&#13;third");
    expect(strings).toContain("literal _x005F_x000D_ stays text");
    const sheetXml = await partText(bytes, "/xl/worksheets/sheet1.xml");
    expect(sheetXml).not.toContain("\r");
    expect(sheetXml).toContain("first line&#13;\nsecond line&#13;third!");

    const reopened = await openXlsx(bytes);
    const id = firstSheet(reopened).id;
    expect(reopened.getCell(id, parseA1("A1")).value).toBe(TEXT);
    expect(reopened.getCell(id, parseA1("A2")).value).toBe("literal _x000D_ stays text");
    expect(reopened.getCell(id, parseA1("A3")).value).toBe(`${TEXT}!`);
    expect(await sheetProblems(bytes)).toEqual([]);
  });

  it("are read from the _x000D_ form other spreadsheets write", async () => {
    const workbook = createXlsx();
    workbook.setCell(firstSheet(workbook).id, parseA1("A1"), "placeholder");
    const pkg = await opc.openPackage(await workbook.save());
    pkg.setPart("/xl/sharedStrings.xml", (await pkg.getPartText("/xl/sharedStrings.xml")).replace("placeholder", "one_x000D_\ntwo"));
    const reopened = await openXlsx(await pkg.save());
    expect(reopened.getCell(firstSheet(reopened).id, parseA1("A1")).value).toBe("one\r\ntwo");
  });
});

describe("the count of the shared string table", () => {
  async function expectTrueCount(workbook: Workbook): Promise<Uint8Array> {
    const bytes = await workbook.save();
    const counts = await stringCounts(bytes);
    expect(counts.stated).toBe(String(counts.cells));
    expect(counts.unique).toBe(String(counts.entries));
    return bytes;
  }

  it("is the number of cells that use the table after strings come and go", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const sheet = firstSheet(workbook).id;
    const before = await stringCounts(loadFixture("basic.xlsx"));
    expect(before.stated).toBe(String(before.cells));

    // New text, text that repeats an entry, and text written twice.
    workbook.setCell(sheet, parseA1("H1"), "new text");
    workbook.setCell(sheet, parseA1("H2"), "new text");
    workbook.setCell(sheet, parseA1("H3"), workbook.getCell(sheet, parseA1("A1")).value);
    expect((await stringCounts(await expectTrueCount(workbook))).cells).toBe(before.cells + 3);

    // A string replaced by a number, one cleared, and a row of strings deleted.
    workbook.setCell(sheet, parseA1("H1"), 5);
    workbook.clearRange(sheet, { start: parseA1("H2"), end: parseA1("H2") });
    workbook.deleteRows(sheet, 0, 1);
    const after = await stringCounts(await expectTrueCount(workbook));
    expect(after.cells).toBeLessThan(before.cells);

    // Saving again without a change states the same count.
    const again = await openXlsx(await workbook.save());
    again.setCell(firstSheet(again).id, parseA1("J9"), 1);
    expect((await stringCounts(await expectTrueCount(again))).cells).toBe(after.cells);
  });

  it("follows sheets that are added and removed", async () => {
    const workbook = await openXlsx(loadFixture("multi-sheet.xlsx"));
    const added = workbook.addSheet("Extra");
    workbook.setRange(added.id, parseA1("A1"), [["x", "y"], ["x", "z"]]);
    await expectTrueCount(workbook);
    const victim = workbook.listSheets().find((sheet) => sheet.name === "Q1 Sales");
    if (victim === undefined) throw new Error("no sheet");
    workbook.removeSheet(victim.id);
    await expectTrueCount(workbook);
  });

  it("leaves the table of an unedited workbook as it was", async () => {
    for (const fixture of ["basic", "formulas", "formats", "multi-sheet", "model"]) {
      const source = loadFixture(`${fixture}.xlsx`);
      const saved = await (await openXlsx(source)).save();
      expect(await partText(saved, "/xl/sharedStrings.xml")).toBe(await partText(source, "/xl/sharedStrings.xml"));
    }
  });
});
