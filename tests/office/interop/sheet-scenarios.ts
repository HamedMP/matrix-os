/**
 * Workbook edit batches for the interoperability tests: values of every
 * type, formulas, typed input, clearing, rows and columns inserted and
 * deleted, styles, sizes, merges, panes, sheets, defined names, and the same
 * as proposals in the change journal. Each batch works on any workbook.
 */

import type { CellRange, SheetInfo, Workbook } from "../../../packages/office/src/index.js";
import { formatA1, parseA1, parseA1Range } from "../../../packages/office/src/index.js";

export const XLSX_FIXTURES = ["basic", "formulas", "formats", "multi-sheet", "model"];
export const PROPOSAL = { author: "Matrix Agent", date: "2026-11-23T10:00:00Z", label: "Agent review" };

/** The names of the steps a batch ran. */
type Log = string[];

/** Runs one step; a step that throws fails the test with its name. */
function attempt(log: Log, name: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    throw new Error(`step ${name} failed: ${(error as Error).message}`);
  }
  log.push(name);
}

export function firstSheet(wb: Workbook): SheetInfo {
  const sheet = wb.listSheets().find((s) => s.state === "visible");
  if (!sheet) throw new Error("no visible sheet");
  return sheet;
}
function lastRow(sheet: SheetInfo): number {
  return sheet.dimensions === null ? 0 : sheet.dimensions.end.row;
}

export function valueEdits(wb: Workbook, log: Log): void {
  const sheet = firstSheet(wb);
  const s = sheet.id;
  const base = lastRow(sheet) + 2;
  const at = (r: number, c: number) => ({ row: base + r, col: c });
  attempt(log, "setCell.number", () => wb.setCell(s, at(0, 0), 42.5));
  attempt(log, "setCell.padded", () => wb.setCell(s, at(0, 1), "  padded text  "));
  attempt(log, "setCell.bool", () => wb.setCell(s, at(0, 2), true));
  attempt(log, "setCell.equalsText", () => wb.setCell(s, at(0, 3), "=not a formula"));
  attempt(log, "setCell.multiline", () => wb.setCell(s, at(1, 0), "multi\nline\r\nand tab\there"));
  attempt(log, "setCell.xml", () => wb.setCell(s, at(1, 1), "<xml> & \"quotes\" 'apos' ]]>"));
  attempt(log, "setCell.small", () => wb.setCell(s, at(1, 2), 1e-7));
  attempt(log, "setCell.big", () => wb.setCell(s, at(1, 3), 12345678901234));
  attempt(log, "setCell.negative", () => wb.setCell(s, at(1, 4), -0.1));
  attempt(log, "setCell.unicode", () => wb.setCell(s, at(1, 5), "שלום 日本語 👩‍💻 é"));
  attempt(log, "setCell.emptyString", () => wb.setCell(s, at(1, 6), ""));
  attempt(log, "setCell.error", () => wb.setCell(s, at(1, 7), { kind: "error", code: "#N/A" }));
  attempt(log, "setCell.escapeLike", () => wb.setCell(s, at(1, 8), "literal _x000D_ text"));
  attempt(log, "setCell.large", () => wb.setCell(s, at(1, 9), 1.7976931348623157e308));
  attempt(log, "setCell.precise", () => wb.setCell(s, at(1, 10), 0.1 + 0.2));
  attempt(log, "setFormula.sum", () => wb.setFormula(s, at(2, 0), `SUM(A1:A${base - 1})`));
  attempt(log, "setFormula.if", () => wb.setFormula(s, at(2, 1), `=IF(${formatA1(at(0, 0))}>0,"yes","no & <more>")`));
  attempt(log, "setFormula.concat", () => wb.setFormula(s, at(2, 2), `${formatA1(at(0, 1))}&" text"`));
  attempt(log, "setFormula.error", () => wb.setFormula(s, at(2, 3), "1/0"));
  attempt(log, "setFormula.bool", () => wb.setFormula(s, at(2, 4), `${formatA1(at(0, 0))}>1`));
  attempt(log, "setFormula.na", () => wb.setFormula(s, at(2, 5), "NA()"));
  attempt(log, "setFormula.emptyResult", () => wb.setFormula(s, at(2, 6), '""'));
  attempt(log, "setFormula.blankRef", () => wb.setFormula(s, at(2, 7), "ZZ999"));
  attempt(log, "setFormula.text", () => wb.setFormula(s, at(2, 8), 'TEXT(1234.5,"#,##0.00")'));
  attempt(log, "setCellInput.date", () => wb.setCellInput(s, at(3, 0), "2026-11-23"));
  attempt(log, "setCellInput.percent", () => wb.setCellInput(s, at(3, 1), "45%"));
  attempt(log, "setCellInput.bool", () => wb.setCellInput(s, at(3, 2), "TRUE"));
  attempt(log, "setCellInput.forcedText", () => wb.setCellInput(s, at(3, 3), "'0123"));
  attempt(log, "setCellInput.formula", () => wb.setCellInput(s, at(3, 4), `=${formatA1(at(0, 0))}*2`));
  attempt(log, "setCellInput.number", () => wb.setCellInput(s, at(3, 5), "1234.5"));
  attempt(log, "setCellInput.text", () => wb.setCellInput(s, at(3, 6), "plain words"));
  attempt(log, "setRange", () => wb.setRange(s, at(5, 0), [[1, "two", true], [null, 4.25], ["", "x", null, "end"]]));
  attempt(log, "overwrite.first", () => wb.setCell(s, { row: 1, col: 0 }, "overwritten"));
  attempt(log, "overwrite.second", () => wb.setCell(s, { row: 2, col: 1 }, 777));
  attempt(log, "clear.contents", () => wb.clearRange(s, { start: { row: 3, col: 0 }, end: { row: 3, col: 1 } }));
  attempt(log, "clear.formats", () => wb.clearRange(s, { start: { row: 0, col: 0 }, end: { row: 0, col: 2 } }, "formats"));
  attempt(log, "clear.all", () => wb.clearRange(s, { start: { row: 4, col: 0 }, end: { row: 4, col: 0 } }, "all"));
  // Formula cells of every sheet: one turned into its value, one replaced.
  let frozenOne = false;
  for (const info of wb.listSheets()) {
    if (info.dimensions === null) continue;
    const rows = wb.getRange(info.id, info.dimensions);
    for (let r = 0; r < rows.length && !frozenOne; r++) {
      const row = rows[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell && cell.formula !== null && cell.arrayRange === null) {
          const address = { row: info.dimensions.start.row + r, col: info.dimensions.start.col + c };
          attempt(log, `setFormula.null ${info.name}!${formatA1(address)}`, () => wb.setFormula(info.id, address, null));
          frozenOne = true;
          break;
        }
      }
    }
  }
  attempt(log, "recalc", () => { wb.recalc(); });
}

export function structureEdits(wb: Workbook, log: Log): void {
  for (const sheet of wb.listSheets()) {
    const s = sheet.id;
    attempt(log, `insertRows ${sheet.name}`, () => wb.insertRows(s, 1, 2));
    attempt(log, `deleteRows ${sheet.name}`, () => wb.deleteRows(s, 6, 1));
    attempt(log, `insertColumns ${sheet.name}`, () => wb.insertColumns(s, 1, 1));
    attempt(log, `deleteColumns ${sheet.name}`, () => wb.deleteColumns(s, 4, 1));
  }
  attempt(log, "recalc", () => { wb.recalc(); });
}

export function styleEdits(wb: Workbook, log: Log): void {
  const sheet = firstSheet(wb);
  const s = sheet.id;
  const range = (a1: string): CellRange => parseA1Range(a1);
  const base = lastRow(sheet) + 2;
  wb.setRange(s, { row: base, col: 0 }, [[1234.5678, -9876.5, 0.256, 46349, "text", 12], [1, 2, 3, 4, 5, 6]]);
  const row = (c: number) => ({ start: { row: base, col: c }, end: { row: base, col: c } });
  attempt(log, "font.bold", () => wb.setStyle(s, range("A1:B2"), { font: { bold: true } }));
  attempt(log, "font.all", () => wb.setStyle(s, range("B2:C3"), { font: { italic: true, underline: true, strike: true, color: "#c00000", sizePt: 14, name: "Courier New" } }));
  attempt(log, "fill", () => wb.setStyle(s, range("A3:C3"), { fill: { color: "#ffe699" } }));
  attempt(log, "fill.none", () => wb.setStyle(s, range("A3:A3"), { fill: { color: null } }));
  attempt(log, "border", () => wb.setStyle(s, range("A1:C4"), { border: { top: { style: "thin", color: "#000000" }, bottom: { style: "double", color: "#ff0000" }, left: { style: "dashed", color: null }, right: { style: "thick", color: "#00b050" } } }));
  attempt(log, "border.kinds", () => wb.setStyle(s, range("D1:D1"), { border: { top: { style: "medium", color: null }, bottom: { style: "dotted", color: null }, left: { style: "hair", color: null }, right: { style: "none", color: null } } }));
  attempt(log, "alignment", () => wb.setStyle(s, range("A2:B2"), { alignment: { horizontal: "center", vertical: "middle", wrapText: true, indent: 0 } }));
  attempt(log, "alignment.indent", () => wb.setStyle(s, range("C2:C2"), { alignment: { horizontal: "left", vertical: "top", indent: 2 } }));
  attempt(log, "alignment.justify", () => wb.setStyle(s, range("D2:D2"), { alignment: { horizontal: "justify", vertical: "bottom" } }));
  const formats = ["0.00", "#,##0;[Red]-#,##0", "0.0%", "yyyy-mm-dd", "@", '[$€-407] #,##0.00', '"Total: "0', "0.00E+00", "# ?/?", "General", "d mmm yyyy hh:mm", "$#,##0.00_);[Red]($#,##0.00)"];
  formats.forEach((numberFormat, index) => {
    attempt(log, `numberFormat ${numberFormat}`, () => wb.setStyle(s, row(index % 6), { numberFormat }));
    if (index % 6 === 5) wb.setRange(s, { row: base + 2 + Math.floor(index / 6), col: 0 }, [[1234.5678, -9876.5, 0.256, 46349, "text", 12]]);
  });
  formats.slice(6).forEach((numberFormat, index) => {
    attempt(log, `numberFormat2 ${numberFormat}`, () => wb.setStyle(s, { start: { row: base + 2, col: index }, end: { row: base + 2, col: index } }, { numberFormat }));
  });
  attempt(log, "columnWidth", () => wb.setColumnWidth(s, 0, 24.5));
  attempt(log, "columnWidth.far", () => wb.setColumnWidth(s, 9, 6));
  attempt(log, "columnWidth.reset", () => wb.setColumnWidth(s, 1, null));
  attempt(log, "rowHeight", () => wb.setRowHeight(s, 1, 31.5));
  attempt(log, "rowHeight.empty", () => wb.setRowHeight(s, base + 6, 40));
  attempt(log, "unmerge", () => wb.unmergeCells(s, range("A1:Z50")));
  attempt(log, "merge", () => wb.mergeCells(s, { start: { row: base + 8, col: 0 }, end: { row: base + 9, col: 2 } }));
  attempt(log, "merge.second", () => wb.mergeCells(s, { start: { row: base + 8, col: 4 }, end: { row: base + 8, col: 5 } }));
  attempt(log, "frozen", () => wb.setFrozenPanes(s, { rows: 2, cols: 1 }));
  const others = wb.listSheets().filter((x) => x.id !== s);
  if (others[0]) attempt(log, "frozen.rowsOnly", () => wb.setFrozenPanes((others[0] as SheetInfo).id, { rows: 1, cols: 0 }));
  if (others[1]) attempt(log, "frozen.colsOnly", () => wb.setFrozenPanes((others[1] as SheetInfo).id, { rows: 0, cols: 2 }));
  if (others[2]) attempt(log, "frozen.none", () => wb.setFrozenPanes((others[2] as SheetInfo).id, { rows: 0, cols: 0 }));
}

export function sheetEdits(wb: Workbook, log: Log): void {
  const first = firstSheet(wb);
  attempt(log, "addSheet", () => { const added = wb.addSheet("New Sheet"); wb.setCell(added.id, parseA1("B2"), "on the new sheet"); wb.setFormula(added.id, parseA1("B3"), `'${first.name.replace(/'/g, "''")}'!A1`); });
  attempt(log, "addSheet.first", () => { wb.addSheet("O'Hara & <Co>", 0); });
  attempt(log, "renameSheet", () => wb.renameSheet(first.id, "Renamed sheet"));
  attempt(log, "definedName", () => wb.setDefinedName({ name: "InteropName", refersTo: "'Renamed sheet'!$A$1:$B$3", scope: null }));
  attempt(log, "definedName.local", () => wb.setDefinedName({ name: "LocalName", refersTo: "'Renamed sheet'!$A$1", scope: first.id }));
  const sheets = wb.listSheets();
  const victim = sheets.find((x) => x.state === "visible" && x.id !== first.id && x.name !== "New Sheet" && x.name !== "O'Hara & <Co>");
  if (victim) attempt(log, `removeSheet ${victim.name}`, () => wb.removeSheet(victim.id));
  attempt(log, "removeName", () => { wb.removeDefinedName("TaxRate"); });
  attempt(log, "recalc", () => { wb.recalc(); });
}

export function proposalEdits(wb: Workbook, log: Log, structural: boolean): void {
  const sheet = firstSheet(wb);
  const s = sheet.id;
  const base = lastRow(sheet) + 2;
  attempt(log, "beginProposal", () => { wb.beginProposal(PROPOSAL); });
  if (structural) {
    attempt(log, "p.insertRows", () => wb.insertRows(s, 2, 1));
    const second = wb.listSheets().find((x) => x.id !== s);
    if (second) attempt(log, "p.insertColumns", () => wb.insertColumns(second.id, 1, 1));
    attempt(log, "p.addSheet", () => { const added = wb.addSheet("Proposed"); wb.setCell(added.id, parseA1("A1"), "proposed sheet"); });
    attempt(log, "p.rename", () => { const other = wb.listSheets().filter((x) => x.id !== s && x.name !== "Proposed")[1]; if (other) wb.renameSheet(other.id, "Renamed in proposal"); });
  } else {
    attempt(log, "p.setCell.new", () => wb.setCell(s, { row: base, col: 0 }, "proposed text"));
    attempt(log, "p.setCell.number", () => wb.setCell(s, { row: base, col: 1 }, 99.5));
    attempt(log, "p.overwrite", () => wb.setCell(s, { row: 1, col: 0 }, "agent value"));
    attempt(log, "p.overwrite.number", () => wb.setCell(s, { row: 2, col: 1 }, 4321));
    attempt(log, "p.setFormula", () => wb.setFormula(s, { row: base, col: 2 }, `${formatA1({ row: base, col: 1 })}*2`));
    attempt(log, "p.setCellInput", () => wb.setCellInput(s, { row: base + 1, col: 0 }, "12.5%"));
    attempt(log, "p.setStyle", () => wb.setStyle(s, { start: { row: 0, col: 0 }, end: { row: 0, col: 1 } }, { font: { bold: true, color: "#0070c0" }, fill: { color: "#ddebf7" } }));
    attempt(log, "p.clear", () => wb.clearRange(s, { start: { row: 3, col: 0 }, end: { row: 3, col: 0 } }));
    for (const other of wb.listSheets()) {
      if (other.id === s || other.dimensions === null) continue;
      attempt(log, `p.other ${other.name}`, () => wb.setCell(other.id, { row: (other.dimensions?.end.row ?? 0) + 1, col: 0 }, 5));
    }
  }
  attempt(log, "endProposal", () => wb.endProposal());
  attempt(log, "recalc", () => { wb.recalc(); });
}

/** Accepts one change in three, rejects one in three and leaves the rest pending. */
export function resolvePartially(wb: Workbook, log: Log): void {
  const ids = wb.listChanges().map((c) => c.id);
  ids.forEach((id, i) => {
    if (i % 3 === 2 || !wb.listChanges().some((c) => c.id === id)) return;
    attempt(log, `partial ${i}`, () => { if (i % 3 === 0) wb.acceptChanges([id]); else wb.rejectChanges([id]); });
  });
  wb.recalc();
}
