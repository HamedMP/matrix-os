import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CellValue, Workbook } from "../../../../packages/office/src/api/xlsx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { inferField, scanCsv, sniffDelimiter } from "../../../../packages/office/src/xlsx/csv/index.js";
import { MAX_ROWS, openXlsx, parseA1, parseA1Range, parseCsv, toCsv } from "../../../../packages/office/src/xlsx/index.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures");

function grid(workbook: Workbook): CellValue[][] {
  const sheet = workbook.listSheets()[0]!;
  if (sheet.dimensions === null) return [];
  return workbook.getRange(sheet.id, sheet.dimensions).map((line) => line.map((cell) => cell.value));
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return null;
}

const fields = (text: string, delimiter = ",") => scanCsv(text, { delimiter }).map((record) => record.map((field) => field.text));

describe("splitting records and fields", () => {
  it.each<[string, string, string[][]]>([
    ["plain", "a,b,c\n1,2,3", [["a", "b", "c"], ["1", "2", "3"]]],
    ["trailing line break", "a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]],
    ["old Mac line endings", "a,b\r1,2\r", [["a", "b"], ["1", "2"]]],
    ["mixed line endings", "a\nb\r\nc\rd", [["a"], ["b"], ["c"], ["d"]]],
    ["quoted delimiter", 'a,"b,c",d', [["a", "b,c", "d"]]],
    ["doubled quotes", 'a,"say ""hi""",b', [["a", 'say "hi"', "b"]]],
    ["embedded line breaks", 'a,"line 1\nline 2\r\nline 3",b\nc,d,e', [["a", "line 1\nline 2\r\nline 3", "b"], ["c", "d", "e"]]],
    ["empty fields", "a,,c\n,,\n", [["a", "", "c"], ["", "", ""]]],
    ["trailing delimiter", "a,b,\n", [["a", "b", ""]]],
    ["trailing delimiter at the end of the text", "a,b,", [["a", "b", ""]]],
    ["empty quoted field", 'a,"",c', [["a", "", "c"]]],
    ["blank line in the middle", "a\n\nb", [["a"], [""], ["b"]]],
    ["text after a closing quote", 'a,"b"c,d', [["a", "bc", "d"]]],
    ["quote inside an unquoted field", 'a,b"c"d,e', [["a", 'b"c"d', "e"]]],
    ["unterminated quote", 'a,"b,c\nd', [["a", "b,c\nd"]]],
    ["spaces are kept", " a , b ", [[" a ", " b "]]],
    ["single field", "alone", [["alone"]]],
    ["only a line break", "\n", [[""]]],
    ["empty text", "", []],
  ])("%s", (_name, text, expected) => {
    expect(fields(text)).toEqual(expected);
  });

  it("splits on other delimiters", () => {
    expect(fields("a;b;c\n1;2,5;3", ";")).toEqual([["a", "b", "c"], ["1", "2,5", "3"]]);
    expect(fields("a\tb\n1\t2", "\t")).toEqual([["a", "b"], ["1", "2"]]);
    expect(fields("a|b", "|")).toEqual([["a", "b"]]);
  });

  it("marks quoted fields", () => {
    expect(scanCsv('"1",1', { delimiter: "," })[0]).toEqual([
      { text: "1", quoted: true },
      { text: "1", quoted: false },
    ]);
  });
});

describe("detecting the delimiter", () => {
  it.each<[string, string]>([
    ["a,b,c\n1,2,3\n4,5,6", ","],
    ["a;b;c\n1;2;3\n4;5;6", ";"],
    ["a\tb\tc\n1\t2\t3", "\t"],
    ["name;amount\nAna;1,5\nBen;2,25\nCy;3,75", ";"],
    ['id,note\n1,"a; b; c"\n2,"d; e"', ","],
    ["a\tb,c\n1\t2,3\n4\t5", "\t"],
    ["no delimiter at all\nreally none", ","],
    ["", ","],
    ["a,b;c", ","],
  ])("%j is split on %j", (text, expected) => {
    expect(sniffDelimiter(text)).toBe(expected);
  });
});

describe("type inference", () => {
  it.each<[string, CellValue, string | null]>([
    ["12", 12, null],
    ["-3.5", -3.5, null],
    ["0", 0, null],
    ["0.25", 0.25, null],
    ["49.00", 49, null],
    ["1e6", 1000000, null],
    ["1.5E-3", 0.0015, null],
    ["123456789012345", 123456789012345, null],
    ["TRUE", true, null],
    ["false", false, null],
    ["2026-03-14", 46095, "yyyy-mm-dd"],
    ["2026-03-14 06:00", 46095.25, "yyyy-mm-dd hh:mm:ss"],
    ["2026-03-14T06:00:00", 46095.25, "yyyy-mm-dd hh:mm:ss"],
    // Everything below stays text.
    ["007", "007", null],
    ["00123", "00123", null],
    ["+1", "+1", null],
    ["1,250.00", "1,250.00", null],
    ["1.", "1.", null],
    [".5", ".5", null],
    ["50%", "50%", null],
    ["$5", "$5", null],
    [" 12", " 12", null],
    ["12 ", "12 ", null],
    ["1234567890123456", "1234567890123456", null],
    ["4111111111111111", "4111111111111111", null],
    ["1-2", "1-2", null],
    ["2026-02-30", "2026-02-30", null],
    ["14/03/2026", "14/03/2026", null],
    ["2026-3-14", "2026-3-14", null],
    ["=1+1", "=1+1", null],
    ["-", "-", null],
    ["truthy", "truthy", null],
    ["NaN", "NaN", null],
    ["Infinity", "Infinity", null],
    ["0x10", "0x10", null],
    ["1e999", "1e999", null],
  ])("%j", (text, value, format) => {
    expect(inferField(text, false)).toEqual({ value, format });
  });
});

describe("parseCsv", () => {
  it("reads the fixture with typed values", () => {
    const workbook = parseCsv(readFileSync(path.join(FIXTURES, "data.csv"), "utf8"));
    expect(workbook.listSheets().map((sheet) => sheet.name)).toEqual(["Sheet1"]);
    const rows = grid(workbook);
    expect(rows.length).toBe(9);
    expect(rows[0]).toEqual(["id", "name", "email", "signup_date", "plan", "amount", "notes"]);
    expect(rows[1]).toEqual([1, "Ana Lima", "ana@example.com", 46026, "pro", 49, null]);
    expect(rows[2]?.[6]).toBe('Asked about "team" pricing');
    expect(rows[3]?.[6]).toBe("Paris, France");
    expect(rows[4]?.[6]).toBe("Multi-line\nnote");
    expect(rows[5]?.[1]).toBe("李华");
    expect(rows[6]).toEqual([6, "Eve Adams", null, 46096, "free", null, "Missing email and amount"]);
    expect(rows[7]?.[5]).toBe("1,250.00");
    expect(rows[8]?.[5]).toBe(-10);
    const id = workbook.listSheets()[0]!.id;
    expect(workbook.getCell(id, parseA1("D2"))).toMatchObject({ value: 46026, display: "2026-01-04" });
    expect(workbook.getStyle(workbook.getCell(id, parseA1("D2")).styleId).numberFormat).toBe("yyyy-mm-dd");
    expect(workbook.getCell(id, parseA1("F2")).display).toBe("49");
  });

  it("strips a byte-order mark and honours the options", () => {
    expect(grid(parseCsv("﻿a,b\n1,2"))).toEqual([["a", "b"], [1, 2]]);
    expect(grid(parseCsv("a;b\n1,5;2", { delimiter: ";" }))).toEqual([["a", "b"], ["1,5", 2]]);
    expect(grid(parseCsv("a|b\n1|2", { delimiter: "|" }))).toEqual([["a", "b"], [1, 2]]);
    expect(grid(parseCsv("1,TRUE,2026-03-14,007", { inferTypes: false }))).toEqual([["1", "TRUE", "2026-03-14", "007"]]);
    expect(parseCsv("a", { sheetName: "Import" }).listSheets()[0]?.name).toBe("Import");
    expect(grid(parseCsv(""))).toEqual([]);
    expect(grid(parseCsv("x\ty\n1\t2"))).toEqual([["x", "y"], [1, 2]]);
  });

  it("never treats a field as a formula", () => {
    const workbook = parseCsv('=1+1,"=SUM(A1)",@cmd,+1,-1');
    const id = workbook.listSheets()[0]!.id;
    const cells = workbook.getRange(id, parseA1Range("A1:E1"))[0]!;
    expect(cells.map((cell) => cell.value)).toEqual(["=1+1", "=SUM(A1)", "@cmd", "+1", -1]);
    expect(cells.every((cell) => cell.formula === null)).toBe(true);
    expect(workbook.recalc().changed).toEqual([]);
  });

  it("enforces limits and checks arguments", () => {
    expect(codeOf(() => parseCsv("a,b,c\n1,2,3", { maxCells: 5 }))).toBe("limit_exceeded");
    expect(grid(parseCsv("a,b,c\n1,2,", { maxCells: 5 })).length).toBe(2);
    expect(codeOf(() => parseCsv(`${",".repeat(16384)}x`))).toBe("limit_exceeded");
    expect(codeOf(() => parseCsv("a", { delimiter: "" }))).toBe("invalid_argument");
    expect(codeOf(() => parseCsv("a", { delimiter: '"' }))).toBe("invalid_argument");
    expect(codeOf(() => parseCsv("a", { delimiter: ",," }))).toBe("invalid_argument");
    expect(codeOf(() => parseCsv("a", { sheetName: "a/b" }))).toBe("invalid_argument");
    expect(codeOf(() => parseCsv(5 as never))).toBe("invalid_argument");
  });

  it("refuses text with more lines than a sheet has rows instead of cutting it short", () => {
    expect(codeOf(() => scanCsv(`${"x\n".repeat(MAX_ROWS)}last`, { delimiter: "," }))).toBe("limit_exceeded");
    // The last row that fits is an empty line, and a record follows it.
    expect(codeOf(() => scanCsv(`${"x\n".repeat(MAX_ROWS - 2)}x\n\nlast`, { delimiter: "," }))).toBe("limit_exceeded");
    expect(codeOf(() => parseCsv(`${"\n".repeat(MAX_ROWS)}last`))).toBe("limit_exceeded");
    // A sheet full of rows fits, with or without a final line break.
    expect(scanCsv("x\n".repeat(MAX_ROWS), { delimiter: "," })).toHaveLength(MAX_ROWS);
    expect(scanCsv(`${"x\n".repeat(MAX_ROWS - 1)}x`, { delimiter: "," })).toHaveLength(MAX_ROWS);
    // A sample asks for its first records only.
    expect(fields("a\nb\nc").length).toBe(3);
    expect(scanCsv("a\nb\nc", { delimiter: ",", maxRecords: 2 })).toHaveLength(2);
  });

  it("gives a workbook that saves as a valid file and reads back the same", async () => {
    const workbook = parseCsv(readFileSync(path.join(FIXTURES, "data.csv"), "utf8"));
    const reopened = await openXlsx(await workbook.save());
    expect(grid(reopened)).toEqual(grid(workbook));
    const id = reopened.listSheets()[0]!.id;
    expect(reopened.getCell(id, parseA1("D2")).display).toBe("2026-01-04");
  });
});

describe("toCsv", () => {
  it("writes values, quoting only where needed", () => {
    const workbook = parseCsv('name,note,n\nAna,"x, y",1.5\nBen,"say ""hi""",-2\nCy,"two\nlines",TRUE\n');
    const id = workbook.listSheets()[0]!.id;
    expect(toCsv(workbook, id)).toBe('name,note,n\r\nAna,"x, y",1.5\r\nBen,"say ""hi""",-2\r\nCy,"two\nlines",TRUE');
    expect(toCsv(workbook, id, { lineEnding: "\n", delimiter: ";" })).toBe('name;note;n\nAna;x, y;1.5\nBen;"say ""hi""";-2\nCy;"two\nlines";TRUE');
    expect(toCsv(workbook, id, { delimiter: "\t" }).split("\r\n")[1]).toBe("Ana\tx, y\t1.5");
  });

  it("writes trailing empty cells, errors as their code and formulas as their result", async () => {
    const workbook = await openXlsx(new Uint8Array(readFileSync(path.join(FIXTURES, "formulas.xlsx"))));
    const calc = workbook.getSheetByName("Calc")!.id;
    const lines = toCsv(workbook, calc, { lineEnding: "\n" }).split("\n");
    expect(lines.length).toBe(11);
    expect(lines[0]).toBe("Total qty,237,,Array of line totals");
    expect(lines[2]).toBe("Big order?,Yes,,206.25");
    expect(lines[8]).toBe("More than 50 items?,TRUE,,");
    expect(lines[9]).toBe("Missing SKU,#N/A,,");
    expect(toCsv(workbook, calc, { range: parseA1Range("A6:B7") })).toBe("Tax rate,0.2\r\nRevenue,1471.13");
    expect(toCsv(workbook, calc, { range: parseA1Range("F1:G2") })).toBe(",\r\n,");
  });

  it("writes raw or displayed values", async () => {
    const workbook = await openXlsx(new Uint8Array(readFileSync(path.join(FIXTURES, "formats.xlsx"))));
    const id = workbook.listSheets()[0]!.id;
    expect(toCsv(workbook, id, { range: parseA1Range("A3:B4") })).toBe("Currency (USD),1234.5\r\nCurrency (GBP),-987.65");
    expect(toCsv(workbook, id, { range: parseA1Range("A3:B4"), values: "display" })).toBe('Currency (USD),"$1,234.50 "\r\nCurrency (GBP),-£987.65');
    expect(toCsv(workbook, id, { range: parseA1Range("B7:B8"), values: "display" })).toBe("2026-07-04\r\n25 December 2026");
    expect(toCsv(workbook, id, { range: parseA1Range("B7:B8") })).toBe("46207\r\n46381");
  });

  it("round-trips through parseCsv", () => {
    const text = 'id,name,when,ok\r\n1,"Lima, Ana",2026-01-04,TRUE\r\n2,"O""Neil",2026-02-28,FALSE\r\n3,,,';
    const workbook = parseCsv(text);
    const id = workbook.listSheets()[0]!.id;
    expect(toCsv(workbook, id, { values: "display" })).toBe(text);
    expect(grid(parseCsv(toCsv(workbook, id)))).toEqual([
      ["id", "name", "when", "ok"],
      [1, "Lima, Ana", 46026, true],
      [2, 'O"Neil', 46081, false],
      [3, null, null, null],
    ]);
  });

  it("returns an empty text for an empty sheet and checks arguments", () => {
    const workbook = parseCsv("");
    const id = workbook.listSheets()[0]!.id;
    expect(toCsv(workbook, id)).toBe("");
    expect(codeOf(() => toCsv(workbook, "nope"))).toBe("not_found");
    expect(codeOf(() => toCsv(workbook, id, { delimiter: "ab" }))).toBe("invalid_argument");
    expect(codeOf(() => toCsv(workbook, id, { lineEnding: "\r" as never }))).toBe("invalid_argument");
    expect(codeOf(() => toCsv(workbook, id, { values: "pretty" as never }))).toBe("invalid_argument");
    expect(codeOf(() => toCsv(workbook, id, { range: { start: { row: -1, col: 0 }, end: { row: 0, col: 0 } } }))).toBe("invalid_argument");
  });
});
