/**
 * Workbooks the engine writes must be valid for other software: every
 * fixture goes through values of every type, formulas, structural edits,
 * styles, sheet changes and journal proposals (pending, accepted, rejected,
 * partly resolved), and each saved file is held to the SpreadsheetML rules
 * of `./sml-rules.ts`. A saved file must also read back as the workbook
 * that was saved.
 */

import { describe, expect, it } from "vitest";
import type { Workbook } from "../../../packages/office/src/index.js";
import { createXlsx, formatA1, openXlsx, parseA1, parseCsv, toCsv } from "../../../packages/office/src/index.js";
import { loadFixture, readPackage } from "./package.js";
import { XLSX_FIXTURES, firstSheet, proposalEdits, resolvePartially, sheetEdits, structureEdits, styleEdits, valueEdits } from "./sheet-scenarios.js";
import { fontsOutOfOrder, sheetProblems } from "./sml-rules.js";

/** Every cell of a workbook with its value, formula and number format, by sheet name and address. */
function contents(workbook: Workbook): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sheet of workbook.listSheets()) {
    out[`${sheet.name}!`] = { state: sheet.state, merged: sheet.mergedRanges, frozen: sheet.frozen, columns: sheet.columns, rows: sheet.rows };
    if (sheet.dimensions === null) continue;
    const { start } = sheet.dimensions;
    workbook.getRange(sheet.id, sheet.dimensions).forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell.value === null && cell.formula === null && cell.styleId === 0) return;
        const style = workbook.getStyle(cell.styleId);
        const value = typeof cell.value === "number" ? Number(cell.value.toPrecision(12)) : cell.value !== null && typeof cell.value === "object" ? cell.value.code : cell.value;
        out[`${sheet.name}!${formatA1({ row: start.row + r, col: start.col + c })}`] = [value, cell.formula, style.numberFormat, style.font.bold, style.fill.color, cell.display];
      });
    });
  }
  out.names = workbook.listDefinedNames().map((name) => [name.name, name.refersTo]);
  return out;
}

/** Saves, checks the file, and checks that it reads back as the workbook that was saved. */
async function expectValid(workbook: Workbook): Promise<Uint8Array> {
  const bytes = await workbook.save();
  expect(await sheetProblems(bytes)).toEqual([]);
  expect(contents(await openXlsx(bytes))).toEqual(contents(workbook));
  return bytes;
}

const BATCHES: Array<[string, (workbook: Workbook, log: string[]) => void]> = [
  ["values, formulas and typed input", valueEdits],
  ["inserted and deleted rows and columns", structureEdits],
  ["styles, sizes, merges and panes", styleEdits],
  ["sheets and defined names", sheetEdits],
  [
    "all of them together",
    (workbook, log) => {
      valueEdits(workbook, log);
      styleEdits(workbook, log);
      structureEdits(workbook, log);
      sheetEdits(workbook, log);
    },
  ],
];

describe.each(XLSX_FIXTURES)("%s.xlsx stays valid", (fixture) => {
  it("unedited, with every part as it was", async () => {
    const source = loadFixture(`${fixture}.xlsx`);
    const before = await readPackage(source);
    const after = await readPackage(await (await openXlsx(source)).save());
    expect([...after.parts.keys()].sort()).toEqual([...before.parts.keys()].sort());
  });

  it.each(BATCHES)("with %s, and when the saved file is edited and saved again", async (_label, batch) => {
    const workbook = await openXlsx(loadFixture(`${fixture}.xlsx`));
    const log: string[] = [];
    batch(workbook, log);
    expect(log.length).toBeGreaterThan(4);
    const again = await openXlsx(await expectValid(workbook));
    again.setCell(firstSheet(again).id, parseA1("Z1"), "saved again");
    await expectValid(again);
  });

  it.each([
    ["cell", false],
    ["structural", true],
  ] as const)("with %s proposals: pending, accepted, rejected and partly resolved", async (_label, structural) => {
    const source = loadFixture(`${fixture}.xlsx`);
    const untouched = contents(await openXlsx(source));
    const workbook = await openXlsx(source);
    proposalEdits(workbook, [], structural);
    expect(workbook.listChanges().length).toBeGreaterThan(0);
    const pending = await expectValid(workbook);

    const accepted = await openXlsx(pending);
    expect(accepted.listChanges().length).toBe(workbook.listChanges().length);
    accepted.acceptChanges("all");
    accepted.recalc();
    expect(accepted.listChanges()).toEqual([]);
    await expectValid(accepted);

    const rejected = await openXlsx(pending);
    expect(rejected.rejectChanges("all").stale).toEqual([]);
    rejected.recalc();
    expect(rejected.listChanges()).toEqual([]);
    const restored = await openXlsx(await expectValid(rejected));
    expect(contents(restored)).toEqual(untouched);

    const partly = await openXlsx(pending);
    resolvePartially(partly, []);
    await expectValid(partly);
  });

  it("as CSV and back", async () => {
    const workbook = await openXlsx(loadFixture(`${fixture}.xlsx`));
    for (const sheet of workbook.listSheets()) {
      const csv = toCsv(workbook, sheet.id);
      await expectValid(parseCsv(csv, { sheetName: sheet.name }));
      // Read as text, every field comes back as it was written (empty fields at the end of a row aside).
      const back = parseCsv(csv, { sheetName: sheet.name, inferTypes: false });
      const trimmed = (text: string): string => text.replace(/,+(?=\r\n|$)/g, "").replace(/(\r\n)+$/, "");
      expect(trimmed(toCsv(back, firstSheet(back).id))).toBe(trimmed(csv));
    }
  });
});

describe("created workbooks stay valid", () => {
  it("blank, with every kind of edit, and with proposals", async () => {
    await expectValid(createXlsx());
    const workbook = createXlsx({ sheetNames: ["Inputs", "Calc & <Co>", "O'Brien"] });
    const [inputs, calc, notes] = workbook.listSheets();
    if (inputs === undefined || calc === undefined || notes === undefined) throw new Error("three sheets expected");
    workbook.setRange(inputs.id, parseA1("A1"), [["Item", "Qty", "Price"], ["Widget", 3, 9.99], ["Gadget", 12, 1.5], ["  spaced  ", 0, 0]]);
    workbook.setFormula(calc.id, parseA1("A1"), "SUMPRODUCT(Inputs!B2:B4,Inputs!C2:C4)");
    workbook.setFormula(notes.id, parseA1("A1"), "'Calc & <Co>'!A1&\" total\"");
    workbook.setDefinedName({ name: "Prices", refersTo: "Inputs!$C$2:$C$4", scope: null });
    styleEdits(workbook, []);
    await expectValid(workbook);

    const edited = createXlsx();
    valueEdits(edited, []);
    structureEdits(edited, []);
    sheetEdits(edited, []);
    await expectValid(edited);

    const proposed = createXlsx();
    proposed.setRange(firstSheet(proposed).id, parseA1("A1"), [["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
    proposalEdits(proposed, [], false);
    await expectValid(proposed);
  });

  it("from the CSV fixture, typed and as text", async () => {
    const csv = new TextDecoder().decode(loadFixture("data.csv"));
    for (const inferTypes of [true, false]) {
      const workbook = parseCsv(csv, { inferTypes });
      await expectValid(workbook);
      valueEdits(workbook, []);
      styleEdits(workbook, []);
      await expectValid(workbook);
    }
    // Without type inference the text comes back as it went in.
    const asText = parseCsv(csv, { inferTypes: false });
    expect(`${toCsv(asText, firstSheet(asText).id, { lineEnding: "\n" })}\n`).toBe(csv);
  });
});

describe("fonts the engine writes", () => {
  it.each(XLSX_FIXTURES)("have their children in schema order in %s.xlsx", async (fixture) => {
    const source = loadFixture(`${fixture}.xlsx`);
    const before = (await readPackage(source)).parts.get("/xl/styles.xml")?.root;
    const workbook = await openXlsx(source);
    styleEdits(workbook, []);
    const after = (await readPackage(await workbook.save())).parts.get("/xl/styles.xml")?.root;
    if (before === undefined || after === undefined) throw new Error("no styles part");
    // Fonts the file came with keep their order; the ones the edits added follow the schema.
    const inherited = new Set(fontsOutOfOrder(before).map((font) => font.replace(/^font \d+: /, "")));
    expect(fontsOutOfOrder(after).filter((font) => !inherited.has(font.replace(/^font \d+: /, "")))).toEqual([]);
  });
});
