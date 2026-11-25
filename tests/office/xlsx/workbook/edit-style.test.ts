import { describe, expect, it } from "vitest";
import { createXlsx, openXlsx, parseA1, parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { MAX_CELL_FORMATS, MAX_STYLE_RECORDS } from "../../../../packages/office/src/xlsx/workbook/style-write.js";
import { at, buildXlsx, codeOf, loadFixture, num, sheetId, storedRecords, valueAt } from "./helpers.js";

describe("setStyle", () => {
  it("adds the fewest records that describe the new style and keeps existing ids", async () => {
    const source = loadFixture("formats.xlsx");
    const workbook = await openXlsx(source);
    const id = sheetId(workbook, "Formats");
    const before = await workbook.package.getPartText("/xl/styles.xml");
    const count = (xml: string, tag: string) => Number(new RegExp(`<${tag} count="(\\d+)"`).exec(xml)?.[1]);
    workbook.setStyle(id, parseA1Range("A3:A5"), { font: { bold: true } });
    const bold = at(workbook, "Formats", "A3").styleId;
    expect(bold).toBe(21);
    expect(at(workbook, "Formats", "A4").styleId).toBe(bold);
    expect(at(workbook, "Formats", "A5").styleId).toBe(bold);
    // The same patch on the same base style gives the same id again.
    workbook.setStyle(id, parseA1Range("A6:A6"), { font: { bold: true } });
    expect(at(workbook, "Formats", "A6").styleId).toBe(bold);
    // A patch that changes nothing keeps the id.
    workbook.setStyle(id, parseA1Range("A2:A2"), { font: { bold: true } });
    expect(at(workbook, "Formats", "A2").styleId).toBe(2);
    await workbook.save();
    const after = await workbook.package.getPartText("/xl/styles.xml");
    expect(count(after, "cellXfs")).toBe(count(before, "cellXfs") + 1);
    // Font 2 of the file is already "bold, nothing else"; the patched default font keeps its name and size, so it is new.
    expect(count(after, "fonts")).toBe(count(before, "fonts") + 1);
    expect(count(after, "fills")).toBe(count(before, "fills"));
    expect(count(after, "borders")).toBe(count(before, "borders"));
    expect(after.startsWith(before.slice(0, before.indexOf("<fonts")))).toBe(true);
    expect(after).toContain('<xf numFmtId="0" fontId="4" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0" applyFont="1"/>');
    // Every other part of the package is unchanged.
    const stored = storedRecords(await workbook.save());
    const original = storedRecords(source);
    const changed = [...original.keys()].filter((entry) => JSON.stringify(stored.get(entry)) !== JSON.stringify(original.get(entry)));
    expect(changed.sort()).toEqual(["xl/styles.xml", "xl/worksheets/sheet1.xml"]);
  });

  it("patches every part of a style and resolves it back", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const id = sheetId(workbook, "Formats");
    workbook.setStyle(id, parseA1Range("B3:B3"), {
      font: { name: "Verdana", sizePt: 14, italic: true, underline: true, strike: true, color: "#336699" },
      fill: { color: "#FFEEAA" },
      border: { top: { style: "double", color: "#112233" }, left: { style: "none", color: null } },
      alignment: { horizontal: "right", vertical: "middle", wrapText: true, indent: 3 },
      numberFormat: "0.000",
    });
    const reopened = await openXlsx(await workbook.save());
    const cell = at(reopened, "Formats", "B3");
    expect(cell).toMatchObject({ value: 1234.5, display: "1234.500" });
    expect(reopened.getStyle(cell.styleId)).toEqual({
      font: { name: "Verdana", sizePt: 14, bold: false, italic: true, underline: true, strike: true, color: "#336699" },
      fill: { color: "#ffeeaa" },
      border: {
        top: { style: "double", color: "#112233" },
        right: { style: "thin", color: "#999999" },
        bottom: { style: "thin", color: "#999999" },
        left: { style: "none", color: null },
      },
      alignment: { horizontal: "right", vertical: "middle", wrapText: true, indent: 3 },
      numberFormat: "0.000",
    });
    // Removing things again.
    reopened.setStyle(sheetId(reopened, "Formats"), parseA1Range("B3:B3"), {
      font: { underline: false, strike: false, color: null },
      fill: { color: null },
      alignment: { horizontal: "general", vertical: "bottom", wrapText: false, indent: 0 },
      numberFormat: "General",
    });
    const plain = reopened.getStyle(at(reopened, "Formats", "B3").styleId);
    expect(plain.font).toMatchObject({ underline: false, strike: false, color: null, italic: true });
    expect(plain.fill).toEqual({ color: null });
    expect(plain.alignment).toEqual({ horizontal: "general", vertical: "bottom", wrapText: false, indent: 0 });
    expect(plain.numberFormat).toBe("General");
  });

  it("uses built-in number format ids and shares custom ones", async () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]!.id;
    workbook.setRange(id, parseA1("A1"), [[0.5, 0.5, 1234.5, 1234.5]]);
    workbook.setStyle(id, parseA1Range("A1:A1"), { numberFormat: "0%" });
    workbook.setStyle(id, parseA1Range("B1:B1"), { numberFormat: "0.0%" });
    workbook.setStyle(id, parseA1Range("C1:C1"), { numberFormat: '#,##0.00" kg"' });
    workbook.setStyle(id, parseA1Range("D1:D1"), { numberFormat: '#,##0.00" kg"' });
    await workbook.save();
    const styles = await workbook.package.getPartText("/xl/styles.xml");
    expect(styles).toContain('<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.00&quot; kg&quot;"/></numFmts><fonts');
    expect(styles).toContain('<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');
    expect(workbook.getRange(id, parseA1Range("A1:D1"))[0]!.map((cell) => cell.display)).toEqual(["50%", "50.0%", "1,234.50 kg", "1,234.50 kg"]);
    expect(at(workbook, "Sheet1", "C1").styleId).toBe(at(workbook, "Sheet1", "D1").styleId);
  });

  it("styles empty cells and clears formats and contents separately", async () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]!.id;
    workbook.setRange(id, parseA1("A1"), [[1, 2], [3, 4]]);
    workbook.setFormula(id, parseA1("C1"), "A1+B1");
    workbook.setStyle(id, parseA1Range("A1:C3"), { fill: { color: "#00ff00" } });
    const styled = at(workbook, "Sheet1", "C3");
    expect(styled).toMatchObject({ value: null, display: "" });
    expect(styled.styleId).toBeGreaterThan(0);
    expect(workbook.getSheet(id).dimensions).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
    workbook.clearRange(id, parseA1Range("A1:A2"));
    expect(at(workbook, "Sheet1", "A1")).toMatchObject({ value: null, styleId: styled.styleId });
    workbook.clearRange(id, parseA1Range("B1:B2"), "formats");
    expect(at(workbook, "Sheet1", "B1")).toMatchObject({ value: 2, styleId: 0 });
    workbook.clearRange(id, parseA1Range("C1:C3"), "all");
    expect(at(workbook, "Sheet1", "C1")).toMatchObject({ value: null, formula: null, styleId: 0 });
    // Clearing a whole column touches only the cells that exist.
    workbook.clearRange(id, parseA1Range("A:XFD"), "all");
    expect(workbook.getSheet(id).dimensions).toBeNull();
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.listSheets()[0]!.dimensions).toBeNull();
  });

  it("rejects malformed patches before changing any cell", async () => {
    const workbook = createXlsx();
    const id = workbook.listSheets()[0]!.id;
    const range = parseA1Range("A1:B2");
    expect(codeOf(() => workbook.setStyle(id, range, { font: { color: "red" } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { font: { sizePt: 0 } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { font: { name: "" } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { fill: { color: "#12345" } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { border: { top: { style: "wavy" as never, color: null } } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { alignment: { horizontal: "middle" as never } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { alignment: { indent: -1 } }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, range, { numberFormat: "" }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setStyle(id, parseA1Range("A:XFD"), { font: { bold: true } }))).toBe("limit_exceeded");
    expect(workbook.getSheet(id).dimensions).toBeNull();
  });

  describe("record limits", () => {
    const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const records = (xml: string, tag: string) => (xml.match(new RegExp(`<${tag}[ >/]`, "g")) ?? []).length;
    const styles = (parts: { numFmts?: string; fonts: string; xfs: string }) =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${MAIN}">${parts.numFmts ?? ""}` +
      `<fonts count="0">${parts.fonts}</fonts>` +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      `<cellXfs count="0">${parts.xfs}</cellXfs></styleSheet>`;
    const open = async (styleXml: string) => {
      const workbook = await openXlsx(
        await buildXlsx({ sheets: [{ name: "S", rows: `<row r="1">${num("A1", 1)}</row>` }], styles: styleXml }),
      );
      return { workbook, id: sheetId(workbook, "S") };
    };
    const xf = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>';

    it("refuses a new cell format at the limit without adding its font, fill, border or number format", async () => {
      const { workbook, id } = await open(styles({ fonts: "<font><sz val=\"11\"/></font>", xfs: xf.repeat(MAX_CELL_FORMATS) }));
      const patch = { font: { bold: true }, fill: { color: "#ff0000" }, border: { top: { style: "thin", color: null } }, numberFormat: "0.000" } as const;
      expect(codeOf(() => workbook.setStyle(id, parseA1Range("A1"), patch))).toBe("limit_exceeded");
      expect(at(workbook, "S", "A1").styleId).toBe(0);
      const saved = await openXlsx(await workbook.save());
      const xml = (await saved.package.getPartText("/xl/styles.xml")) as string;
      expect(xml).not.toContain("<numFmts");
      expect([records(xml, "font"), records(xml, "fill"), records(xml, "border"), records(xml, "xf")]).toEqual([1, 2, 1, MAX_CELL_FORMATS]);
      // A patch that lands on an existing format still works.
      workbook.setStyle(id, parseA1Range("A1"), { font: { bold: false } });
      expect(at(workbook, "S", "A1").styleId).toBe(0);
    });

    it("refuses a new font, fill, border or number format past the record limit, before adding a cell format", async () => {
      const fonts = Array.from({ length: MAX_STYLE_RECORDS }, (_, i) => `<font><name val="F${i}"/></font>`).join("");
      const numFmts = `<numFmts count="${MAX_STYLE_RECORDS}">${Array.from({ length: MAX_STYLE_RECORDS }, (_, i) => `<numFmt numFmtId="${164 + i}" formatCode="0.${"0".repeat(1 + (i % 9))}&quot;u${i}&quot;"/>`).join("")}</numFmts>`;
      const { workbook, id } = await open(styles({ numFmts, fonts, xfs: xf }));
      expect(codeOf(() => workbook.setStyle(id, parseA1Range("A1"), { font: { bold: true }, fill: { color: "#00ff00" } }))).toBe("limit_exceeded");
      expect(codeOf(() => workbook.setStyle(id, parseA1Range("A1"), { numberFormat: "0.0000000000" }))).toBe("limit_exceeded");
      const xml = (await (await openXlsx(await workbook.save())).package.getPartText("/xl/styles.xml")) as string;
      expect([records(xml, "font"), records(xml, "fill"), records(xml, "numFmt"), records(xml, "xf")]).toEqual([MAX_STYLE_RECORDS, 2, MAX_STYLE_RECORDS, 1]);
      // Records that exist already can still be combined into a new cell format.
      workbook.setStyle(id, parseA1Range("A1"), { numberFormat: '0.0"u0"' });
      expect(at(workbook, "S", "A1").styleId).toBe(1);
    });
  });
});

describe("sizes, merges and panes", () => {
  it("sets and clears column widths, splitting runs of columns", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const id = sheetId(workbook, "Formats");
    workbook.setColumnWidth(id, 2, 40);
    workbook.setColumnWidth(id, 9, 5.5);
    workbook.setColumnWidth(id, 0, null);
    workbook.setColumnWidth(id, 20, null);
    const widths = (wb: typeof workbook) => Object.fromEntries(wb.getSheet(sheetId(wb, "Formats")).columns.map((column) => [column.index, column.width]));
    expect(widths(workbook)).toEqual({ 1: 18, 2: 40, 3: 30, 4: 12, 5: 12, 9: 5.5 });
    const reopened = await openXlsx(await workbook.save());
    expect(widths(reopened)).toEqual({ 1: 18, 2: 40, 3: 30, 4: 12, 5: 12, 9: 5.5 });
    expect(codeOf(() => workbook.setColumnWidth(id, -1, 10))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setColumnWidth(id, 0, 300))).toBe("invalid_argument");
  });

  it("sets and clears row heights", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const id = sheetId(workbook, "Formats");
    workbook.setRowHeight(id, 4, 33.5);
    workbook.setRowHeight(id, 99, 20);
    workbook.setRowHeight(id, 0, null);
    workbook.setRowHeight(id, 500, null);
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.getSheet(sheetId(reopened, "Formats")).rows).toEqual([
      { index: 4, heightPt: 33.5, hidden: false },
      { index: 99, heightPt: 20, hidden: false },
    ]);
    expect(valueAt(reopened, "Formats", "A1")).toBe("Formatted values");
    expect(codeOf(() => workbook.setRowHeight(id, 0, 500))).toBe("invalid_argument");
    // A height on an empty row and its removal leave no row behind.
    reopened.setRowHeight(sheetId(reopened, "Formats"), 99, null);
    await reopened.save();
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).not.toContain('<row r="100"');
  });

  it("merges and unmerges", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const id = sheetId(workbook, "Formats");
    expect(codeOf(() => workbook.mergeCells(id, parseA1Range("F5:G6")))).toBe("invalid_operation");
    workbook.mergeCells(id, parseA1Range("A3:A4"));
    // The top-left cell keeps its content; the others lose theirs but keep their format.
    expect(valueAt(workbook, "Formats", "A3")).toBe("Currency (USD)");
    expect(valueAt(workbook, "Formats", "A4")).toBeNull();
    workbook.mergeCells(id, parseA1Range("H1:H1"));
    workbook.unmergeCells(id, parseA1Range("A1:A1"));
    workbook.unmergeCells(id, parseA1Range("Z1:Z9"));
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.getSheet(sheetId(reopened, "Formats")).mergedRanges).toEqual([
      { start: { row: 2, col: 4 }, end: { row: 4, col: 5 } },
      { start: { row: 2, col: 0 }, end: { row: 3, col: 0 } },
    ]);
    const xml = await reopened.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(xml).toContain('<mergeCells count="2"><mergeCell ref="E3:F5"/><mergeCell ref="A3:A4"/></mergeCells><pageMargins');
    reopened.unmergeCells(sheetId(reopened, "Formats"), parseA1Range("A1:XFD1048576"));
    await reopened.save();
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).not.toContain("mergeCell");
  });

  it("freezes and unfreezes panes", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const id = sheetId(workbook, "Basics");
    expect(workbook.getSheet(id).frozen).toEqual({ rows: 0, cols: 0 });
    workbook.setFrozenPanes(id, { rows: 1, cols: 2 });
    let reopened = await openXlsx(await workbook.save());
    expect(reopened.getSheet(sheetId(reopened, "Basics")).frozen).toEqual({ rows: 1, cols: 2 });
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).toContain(
      '<sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight"/></sheetView>',
    );
    reopened.setFrozenPanes(sheetId(reopened, "Basics"), { rows: 3, cols: 0 });
    reopened = await openXlsx(await reopened.save());
    expect(reopened.getSheet(sheetId(reopened, "Basics")).frozen).toEqual({ rows: 3, cols: 0 });
    reopened.setFrozenPanes(sheetId(reopened, "Basics"), { rows: 0, cols: 0 });
    reopened = await openXlsx(await reopened.save());
    expect(reopened.getSheet(sheetId(reopened, "Basics")).frozen).toEqual({ rows: 0, cols: 0 });
    const unfrozen = await reopened.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(unfrozen).not.toContain("<pane");
    expect(unfrozen).not.toContain("<selection");
    expect(codeOf(() => workbook.setFrozenPanes(id, { rows: -1, cols: 0 }))).toBe("invalid_argument");
  });
});
