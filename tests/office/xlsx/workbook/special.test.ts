import { describe, expect, it } from "vitest";
import { createPackage } from "../../../../packages/office/src/opc/index.js";
import { createXlsx, openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import { asyncCodeOf, at, buildXlsx, fx, loadFixture, num, sheetId, valueAt } from "./helpers.js";

describe("shared formulas", () => {
  const source = () =>
    buildXlsx({
      sheets: [
        {
          name: "Calc",
          rows:
            `<row r="1">${num("A1", 1)}${num("B1", 10)}<c r="C1"><f t="shared" ref="C1:C4" si="0">A1*$B$1+B1</f><v>20</v></c></row>` +
            `<row r="2">${num("A2", 2)}${num("B2", 20)}<c r="C2"><f t="shared" si="0"/><v>40</v></c></row>` +
            `<row r="3">${num("A3", 3)}${num("B3", 30)}<c r="C3"><f t="shared" si="0"/><v>60</v></c></row>` +
            `<row r="4">${num("A4", 4)}${num("B4", 40)}<c r="C4"><f t="shared" si="0"/><v>80</v></c>` +
            `<c r="E4"><f t="shared" ref="E4:F4" si="1">SUM($A$1:A4)</f><v>10</v></c><c r="F4"><f t="shared" si="1"/><v>110</v></c></row>`,
        },
      ],
    });

  it("expands every member to its own formula", async () => {
    const workbook = await openXlsx(await source());
    expect(at(workbook, "Calc", "C1")).toMatchObject({ formula: "A1*$B$1+B1", value: 20 });
    expect(at(workbook, "Calc", "C2")).toMatchObject({ formula: "A2*$B$1+B2", value: 40 });
    expect(at(workbook, "Calc", "C4")).toMatchObject({ formula: "A4*$B$1+B4", value: 80 });
    expect(at(workbook, "Calc", "E4").formula).toBe("SUM($A$1:A4)");
    expect(at(workbook, "Calc", "F4").formula).toBe("SUM($A$1:B4)");
  });

  it("leaves the shared markup alone while nothing on the sheet changes its formulas", async () => {
    const bytes = await source();
    const workbook = await openXlsx(bytes);
    const before = await workbook.package.getPartText("/xl/worksheets/sheet1.xml");
    workbook.setCell(sheetId(workbook, "Calc"), parseA1("H1"), "note");
    await workbook.save();
    const after = await workbook.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(after).toContain('<c r="C1"><f t="shared" ref="C1:C4" si="0">A1*$B$1+B1</f><v>20</v></c>');
    expect(after).toContain('<c r="C3"><f t="shared" si="0"/><v>60</v></c>');
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("recalculates members and writes them out one by one once a member changes", async () => {
    const workbook = await openXlsx(await source());
    const id = sheetId(workbook, "Calc");
    workbook.setCell(id, parseA1("B1"), 100);
    workbook.recalc();
    expect(valueAt(workbook, "Calc", "C1")).toBe(200);
    expect(valueAt(workbook, "Calc", "C3")).toBe(330);
    await workbook.save();
    const xml = await workbook.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(xml).not.toContain('t="shared"');
    expect(xml).toContain('<c r="C3"><f>A3*$B$1+B3</f><v>330</v></c>');
    expect(xml).toContain('<c r="F4"><f>SUM($A$1:B4)</f><v>200</v></c>');
    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "Calc", "C4")).toMatchObject({ formula: "A4*$B$1+B4", value: 440 });
  });

  it("unshares when the master is overwritten or rows move", async () => {
    const first = await openXlsx(await source());
    first.setCell(sheetId(first, "Calc"), parseA1("C1"), 5);
    const afterOverwrite = await openXlsx(await first.save());
    expect(at(afterOverwrite, "Calc", "C1")).toMatchObject({ formula: null, value: 5 });
    expect(at(afterOverwrite, "Calc", "C2")).toMatchObject({ formula: "A2*$B$1+B2", value: 40 });

    const second = await openXlsx(await source());
    second.insertRows(sheetId(second, "Calc"), 1, 1);
    const afterInsert = await openXlsx(await second.save());
    expect(at(afterInsert, "Calc", "C1").formula).toBe("A1*$B$1+B1");
    expect(at(afterInsert, "Calc", "C3").formula).toBe("A3*$B$1+B3");
    expect(at(afterInsert, "Calc", "F5").formula).toBe("SUM($A$1:B5)");
    expect(await afterInsert.package.getPartText("/xl/worksheets/sheet1.xml")).not.toContain("shared");
  });
});

describe("text in all its forms", () => {
  it("flattens rich text and phonetic runs for the value and keeps the markup of untouched cells", async () => {
    const bytes = await buildXlsx({
      sheets: [
        {
          name: "Text",
          rows:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
            '<row r="2"><c r="A2" t="inlineStr"><is><r><t>in</t></r><r><rPr><b/></rPr><t>line</t></r></is></c>' +
            '<c r="B2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="C2" t="s"><v>3</v></c><c r="D2" t="d"><v>2026-03-14</v></c></row>',
        },
      ],
      sharedStrings:
        '<si><r><t xml:space="preserve">Rich </t></r><r><rPr><b/><sz val="12"/></rPr><t>text</t></r></si>' +
        "<si><t>東京</t><rPh sb=\"0\" eb=\"2\"><t>トウキョウ</t></rPh><phoneticPr fontId=\"1\"/></si>" +
        "<si><t>line_x000D_break _x005F_x0041_</t></si>" +
        "<si><t>plain</t></si>",
    });
    const workbook = await openXlsx(bytes);
    expect(valueAt(workbook, "Text", "A1")).toBe("Rich text");
    expect(valueAt(workbook, "Text", "B1")).toBe("東京");
    expect(valueAt(workbook, "Text", "C1")).toBe("line\rbreak _x0041_");
    expect(valueAt(workbook, "Text", "A2")).toBe("inline");
    expect(at(workbook, "Text", "B2")).toMatchObject({ value: "ab", formula: '"a"&"b"' });
    expect(at(workbook, "Text", "D2")).toMatchObject({ value: 46095 });
    const id = sheetId(workbook, "Text");
    // "Rich text" as plain text must not reuse the rich entry; "plain" reuses the plain one.
    workbook.setCell(id, parseA1("E1"), "Rich text");
    workbook.setCell(id, parseA1("E2"), "plain");
    const reopened = await openXlsx(await workbook.save());
    const strings = await reopened.package.getPartText("/xl/sharedStrings.xml");
    expect(strings).toContain('<si><r><t xml:space="preserve">Rich </t></r><r><rPr><b/><sz val="12"/></rPr><t>text</t></r></si>');
    expect(strings).toContain("<si><t>plain</t></si><si><t>Rich text</t></si></sst>");
    const sheet = await reopened.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="A1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<c r="E1" t="s"><v>4</v></c>');
    expect(sheet).toContain('<c r="E2" t="s"><v>3</v></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><r><t>in</t></r><r><rPr><b/></rPr><t>line</t></r></is></c>');
    expect(valueAt(reopened, "Text", "A1")).toBe("Rich text");
    expect(valueAt(reopened, "Text", "E1")).toBe("Rich text");
  });

  it("creates the shared string part when a workbook has none", async () => {
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "S", rows: `<row r="1">${num("A1", 1)}</row>` }] }));
    expect(workbook.package.hasPart("/xl/sharedStrings.xml")).toBe(false);
    workbook.setCell(sheetId(workbook, "S"), parseA1("B1"), "first text");
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "S", "B1")).toBe("first text");
    expect(reopened.package.getContentType("/xl/sharedStrings.xml")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml");
    expect(reopened.package.getRelationships("/xl/workbook.xml").filter((entry) => entry.type.endsWith("/sharedStrings")).length).toBe(1);
  });
});

describe("a workbook without a style sheet", () => {
  it("has the default style and gets a styles part with the first format", async () => {
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "S", rows: `<row r="1">${num("A1", 0.5)}</row>` }] }));
    expect(workbook.package.hasPart("/xl/styles.xml")).toBe(false);
    expect(workbook.getStyle(0)).toMatchObject({ font: { name: "Calibri", sizePt: 11 }, numberFormat: "General" });
    await workbook.save();
    expect(workbook.package.hasPart("/xl/styles.xml")).toBe(false);
    workbook.setStyle(sheetId(workbook, "S"), { start: parseA1("A1"), end: parseA1("A1") }, { numberFormat: "0%", font: { bold: true } });
    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "S", "A1")).toMatchObject({ value: 0.5, display: "50%" });
    expect(reopened.getStyle(at(reopened, "S", "A1").styleId).font.bold).toBe(true);
    expect(reopened.package.getContentType("/xl/styles.xml")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml");
    expect(reopened.package.getRelationships("/xl/workbook.xml").filter((entry) => entry.type.endsWith("/styles")).length).toBe(1);
  });

  it("lists at most one entry per column however the file declares them", async () => {
    const cols = `<cols>${'<col min="1" max="16384" width="9" customWidth="1"/>'.repeat(50)}</cols>`;
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "S", before: cols }] }));
    expect(workbook.listSheets()[0]!.columns.length).toBe(16384);
  });
});

describe("workbook options and odd files", () => {
  it("reads and writes dates of the 1904 system", async () => {
    const styles =
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>';
    const bytes = await buildXlsx({ sheets: [{ name: "S", rows: '<row r="1"><c r="A1" s="1"><v>44633</v></c></row>' }], workbookPr: ' date1904="1"', styles });
    const workbook = await openXlsx(bytes);
    expect(at(workbook, "S", "A1")).toMatchObject({ value: 44633, display: "03-14-26" });
    workbook.setCellInput(sheetId(workbook, "S"), parseA1("B1"), "2026-03-15");
    expect(at(workbook, "S", "B1")).toMatchObject({ value: 44634, display: "2026-03-15" });
  });

  it("drops the calculation chain once formulas change, and not before", async () => {
    const bytes = await buildXlsx({ sheets: [{ name: "S", rows: `<row r="1">${num("A1", 1)}${fx("B1", "A1+1", 2)}</row>` }], calcChain: true });
    const untouched = await openXlsx(bytes);
    untouched.setCell(sheetId(untouched, "S"), parseA1("A1"), 5);
    await untouched.save();
    expect(untouched.package.hasPart("/xl/calcChain.xml")).toBe(true);
    expect(valueAt(untouched, "S", "B1")).toBe(6);

    const edited = await openXlsx(bytes);
    edited.setFormula(sheetId(edited, "S"), parseA1("C1"), "B1*2");
    const reopened = await openXlsx(await edited.save());
    expect(reopened.package.hasPart("/xl/calcChain.xml")).toBe(false);
    expect(reopened.package.getRelationships("/xl/workbook.xml").some((entry) => entry.type.endsWith("/calcChain"))).toBe(false);
    expect(reopened.package.getContentTypes().overrides.some((entry) => entry.partName.includes("calcChain"))).toBe(false);
    expect(valueAt(reopened, "S", "C1")).toBe(4);
  });

  it("reads and edits parts written with a namespace prefix, pretty printing and missing references", async () => {
    const xml =
      '<?xml version="1.0"?>\n<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n  <x:sheetData>\n' +
      "    <x:row>\n      <x:c><x:v>1</x:v></x:c>\n      <x:c><x:v>2</x:v></x:c>\n    </x:row>\n" +
      '    <x:row r="3">\n      <x:c r="B3" t="b"><x:v>1</x:v></x:c>\n    </x:row>\n  </x:sheetData>\n</x:worksheet>';
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "P", xml }] }));
    expect(valueAt(workbook, "P", "A1")).toBe(1);
    expect(valueAt(workbook, "P", "B1")).toBe(2);
    expect(valueAt(workbook, "P", "B3")).toBe(true);
    workbook.setCell(sheetId(workbook, "P"), parseA1("A2"), 9);
    workbook.mergeCells(sheetId(workbook, "P"), { start: parseA1("D1"), end: parseA1("E1") });
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "P", "A2")).toBe(9);
    expect(valueAt(reopened, "P", "B1")).toBe(2);
    const saved = await reopened.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(saved).toContain('<x:row r="2"><x:c r="A2"><x:v>9</x:v></x:c></x:row>');
    expect(saved).toContain('<x:mergeCells count="1"><x:mergeCell ref="D1:E1"/></x:mergeCells>');
    // The untouched rows keep their own formatting.
    expect(saved).toContain("<x:row>\n      <x:c><x:v>1</x:v></x:c>\n      <x:c><x:v>2</x:v></x:c>\n    </x:row>");
  });

  it("keeps parts it does not model byte for byte through an edit", async () => {
    const source = loadFixture("formats.xlsx");
    const workbook = await openXlsx(source);
    workbook.package.setPart("/xl/media/logo.bin", new Uint8Array([1, 2, 3, 250]), "application/octet-stream");
    workbook.package.setPart("/customXml/item1.xml", "<a><b/></a>");
    const stage = await openXlsx(await workbook.save());
    stage.setCell(sheetId(stage, "Formats"), parseA1("H9"), 1);
    const final = await openXlsx(await stage.save());
    expect([...(await final.package.getPartBytes("/xl/media/logo.bin"))]).toEqual([1, 2, 3, 250]);
    expect(await final.package.getPartText("/customXml/item1.xml")).toBe("<a><b/></a>");
    expect(await final.package.getPartText("/xl/theme/theme1.xml")).toBe(await workbook.package.getPartText("/xl/theme/theme1.xml"));
  });
});

describe("files that cannot be opened", () => {
  const sheetXml = (rows: string) =>
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

  it("refuses what is not a spreadsheet", async () => {
    expect(await asyncCodeOf(() => openXlsx(new Uint8Array([1, 2, 3])))).toBe("not_a_zip");
    expect(await asyncCodeOf(() => openXlsx(loadFixture("basic.docx")))).toBe("unsupported_format");
    expect(await asyncCodeOf(async () => openXlsx(await createPackage().save()))).toBe("unsupported_format");
  });

  it("reports damaged workbooks with a typed error", async () => {
    const broken = async (rows: string, sharedStrings?: string) =>
      asyncCodeOf(async () => openXlsx(await buildXlsx({ sheets: [{ name: "S", xml: sheetXml(rows) }], sharedStrings })));
    expect(await broken('<row r="1"><c r="A1" t="s"><v>7</v></c></row>', "<si><t>only</t></si>")).toBe("corrupt_package");
    expect(await broken('<row r="1"><c r="A1"><v>abc</v></c></row>')).toBe("corrupt_package");
    expect(await broken('<row r="1"/><row r="1"/>')).toBe("corrupt_package");
    expect(await broken('<row r="1"><c r="A1"/><c r="A1"/></row>')).toBe("corrupt_package");
    expect(await broken('<row r="0"/>')).toBe("corrupt_package");
    expect(await broken('<row r="1048577"/>')).toBe("corrupt_package");
    expect(await asyncCodeOf(async () => openXlsx(await buildXlsx({ sheets: [{ name: "S", xml: "<worksheet><sheetData>" }] })))).toBe("malformed_xml");
    expect(await asyncCodeOf(async () => openXlsx(await buildXlsx({ sheets: [{ name: "S", xml: "<chartsheet/>" }] })))).toBe("unsupported_format");
    expect(await asyncCodeOf(async () => openXlsx(await buildXlsx({ sheets: [] })))).toBe("corrupt_package");
  });

  it("enforces the cell limit on open and on edit", async () => {
    expect(await asyncCodeOf(() => openXlsx(loadFixture("basic.xlsx"), { maxCells: 10 }))).toBe("limit_exceeded");
    const workbook = await openXlsx(loadFixture("basic.xlsx"), { maxCells: 48 });
    const id = sheetId(workbook, "Basics");
    workbook.setCell(id, parseA1("H1"), 1);
    workbook.setCell(id, parseA1("B2"), 2);
    let code: string | null = null;
    try {
      workbook.setCell(id, parseA1("H2"), 2);
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe("limit_exceeded");
    // Clearing a cell makes room again.
    workbook.setCell(id, parseA1("H1"), null);
    workbook.setCell(id, parseA1("H2"), 2);
    expect(await asyncCodeOf(() => openXlsx(loadFixture("basic.xlsx"), { limits: { maxEntries: 2 } }))).toBe("zip_limit_exceeded");
  });

  it("opens a sheet with out-of-order rows and writes them in order", async () => {
    const workbook = await openXlsx(
      await buildXlsx({ sheets: [{ name: "S", xml: sheetXml(`<row r="3">${num("A3", 3)}</row><row r="1">${num("A1", 1)}</row>`) }] }),
    );
    expect(valueAt(workbook, "S", "A1")).toBe(1);
    workbook.setCell(sheetId(workbook, "S"), parseA1("A2"), 2);
    await workbook.save();
    expect(await workbook.package.getPartText("/xl/worksheets/sheet1.xml")).toContain(
      '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData>',
    );
  });

  it("handles a large sheet within a reasonable time", async () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]!.id;
    const rows = Array.from({ length: 20000 }, (_, r) => [r, `row ${r % 100}`, r * 1.5, r % 2 === 0]);
    workbook.setRange(id, parseA1("A1"), rows);
    for (let r = 0; r < 2000; r++) workbook.setFormula(id, { row: r, col: 5 }, `SUM(A${r + 1}:C${r + 1})`);
    expect(workbook.recalc().changed.length).toBe(2000);
    const reopened = await openXlsx(await workbook.save());
    expect(valueAt(reopened, "Sheet1", "B20000")).toBe("row 99");
    expect(valueAt(reopened, "Sheet1", "F2000")).toBe(1999 + 1999 * 1.5);
    expect(reopened.getSheet(reopened.listSheets()[0]!.id).dimensions).toEqual({ start: { row: 0, col: 0 }, end: { row: 19999, col: 5 } });
  }, 20000);
});
