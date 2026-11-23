/**
 * Checks a saved `.xlsx` the way a strict consumer reads it: element order
 * in the workbook, worksheets and styles; rows and cells in ascending
 * order; cell types against their values; shared string indexes and
 * counts; style indexes within the tables they point into; merged ranges,
 * column ranges and frozen panes that are consistent.
 *
 * `sheetProblems` returns one line per problem; an empty list means the file
 * passed. The parts are expected in the default namespace, as spreadsheet
 * software writes them.
 */

import type { XmlElement } from "../../../packages/office/src/index.js";
import { type SavedPackage, attr, elementsOf, orderProblems, readPackage, related, sourceText, text, walk } from "./package.js";

const list = (names: string): string[] => names.split(/\s+/).filter((name) => name !== "");

const WORKSHEET = list(
  "sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing drawingHF legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst",
);
const WORKBOOK = list(
  "fileVersion fileSharing workbookPr workbookProtection bookViews sheets functionGroups externalReferences definedNames calcPr oleSize customWorkbookViews pivotCaches smartTagPr smartTagTypes webPublishing fileRecoveryPr webPublishObjects extLst",
);
const STYLESHEET = list("numFmts fonts fills borders cellStyleXfs cellXfs cellStyles dxfs tableStyles colors extLst");
/** The order of the schema sequence, which every reader accepts. */
export const FONT_ORDER = list("b i strike condense extend outline shadow u vertAlign sz color name family charset scheme");
const BORDER = list("start end left right top bottom diagonal vertical horizontal");
const REPEATABLE = new Set(list("conditionalFormatting selection pivotSelection r rPh sheetView"));
const ERRORS = new Set(["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#GETTING_DATA"]);
const A1 = /^([A-Z]{1,3})(\d+)$/;

type Box = [top: number, left: number, bottom: number, right: number];

function columnNumber(label: string): number {
  let value = 0;
  for (const letter of label) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value;
}

function parseRef(ref: string | null): Box | null {
  if (ref === null) return null;
  const corners = ref.split(":").map((part) => A1.exec(part.replace(/\$/g, "")));
  if (corners.length > 2 || corners.some((corner) => corner === null)) return null;
  const [a, b = a] = corners as RegExpExecArray[];
  if (a === undefined) return null;
  const box: Box = [Number(a[2]), columnNumber(a[1] as string), Number(b[2]), columnNumber(b[1] as string)];
  return box[0] > box[2] || box[1] > box[3] ? null : box;
}

function overlap(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function child(parent: XmlElement, name: string): XmlElement | null {
  return elementsOf(parent).find((element) => element.name === name) ?? null;
}

function children(parent: XmlElement | null, name: string): XmlElement[] {
  return parent === null ? [] : elementsOf(parent).filter((element) => element.name === name);
}

function isIndexBelow(value: string | null, limit: number): boolean {
  return value === null || (/^\d+$/.test(value) && Number(value) < limit);
}

function countProblems(container: XmlElement | null, name: string): { count: number; problems: string[] } {
  if (container === null) return { count: 0, problems: [] };
  const count = children(container, name).length;
  const declared = attr(container, "count");
  return { count, problems: declared !== null && declared !== String(count) ? [`<${container.name} count="${declared}"> has ${count} <${name}> children`] : [] };
}

/** Problems of the styles part, and the number of cell formats it defines. */
export function styleProblems(root: XmlElement): { problems: string[]; cellFormats: number } {
  const problems = orderProblems(root, STYLESHEET, "styleSheet", "");
  const custom = new Set<string>();
  const numFmts = child(root, "numFmts");
  problems.push(...countProblems(numFmts, "numFmt").problems);
  for (const format of children(numFmts, "numFmt")) {
    const id = attr(format, "numFmtId") ?? "";
    if (custom.has(id)) problems.push(`numFmtId ${id} is defined twice`);
    custom.add(id);
    if (!/^\d+$/.test(id)) problems.push(`a numFmt has the bad id ${JSON.stringify(id)}`);
    else if (Number(id) < 164) problems.push(`custom numFmtId ${id} is in the built-in range (below 164)`);
    if ((attr(format, "formatCode") ?? "") === "") problems.push(`numFmt ${id} has no formatCode`);
  }
  const counts: Record<string, number> = {};
  for (const [container, entry] of [["fonts", "font"], ["fills", "fill"], ["borders", "border"], ["cellStyleXfs", "xf"], ["cellXfs", "xf"], ["cellStyles", "cellStyle"], ["dxfs", "dxf"]] as const) {
    const result = countProblems(child(root, container), entry);
    counts[container] = result.count;
    problems.push(...result.problems);
  }
  for (const required of ["fonts", "fills", "borders", "cellXfs"]) if ((counts[required] ?? 0) === 0) problems.push(`<${required}> is missing or empty`);
  const fills = children(child(root, "fills"), "fill");
  for (const [index, pattern] of [[0, "none"], [1, "gray125"]] as const) {
    const fill = fills[index];
    const patternFill = fill === undefined ? null : child(fill, "patternFill");
    if (patternFill === null || (attr(patternFill, "patternType") ?? "none") !== pattern) problems.push(`reserved fill ${index} is not patternType="${pattern}"`);
  }
  for (const fill of fills) {
    const patternFill = child(fill, "patternFill");
    if (patternFill === null) continue;
    problems.push(...orderProblems(patternFill, ["fgColor", "bgColor"], "patternFill", ""));
    if (attr(patternFill, "patternType") === "solid" && child(patternFill, "fgColor") === null) problems.push("a solid fill has no fgColor");
  }
  for (const border of children(child(root, "borders"), "border")) problems.push(...orderProblems(border, BORDER, "border", ""));
  for (const group of ["cellStyleXfs", "cellXfs"]) {
    children(child(root, group), "xf").forEach((xf, index) => {
      problems.push(...orderProblems(xf, ["alignment", "protection", "extLst"], "xf", ""));
      for (const [name, limit] of [["fontId", counts.fonts ?? 0], ["fillId", counts.fills ?? 0], ["borderId", counts.borders ?? 0]] as const) {
        if (!isIndexBelow(attr(xf, name), limit)) problems.push(`${group} xf ${index} ${name}=${attr(xf, name)} is out of range (0..${limit - 1})`);
      }
      const format = attr(xf, "numFmtId");
      if (format !== null && (!/^\d+$/.test(format) || (Number(format) >= 164 && !custom.has(format)))) problems.push(`${group} xf ${index} numFmtId=${format} is not defined`);
      if (group === "cellXfs" && !isIndexBelow(attr(xf, "xfId"), Math.max(counts.cellStyleXfs ?? 0, 1))) problems.push(`cellXfs xf ${index} xfId=${attr(xf, "xfId")} is out of range`);
    });
  }
  for (const style of children(child(root, "cellStyles"), "cellStyle")) {
    const id = attr(style, "xfId");
    if (id === null || !isIndexBelow(id, counts.cellStyleXfs ?? 0)) problems.push(`cellStyle ${JSON.stringify(attr(style, "name"))} xfId=${id} is out of range`);
  }
  for (const element of walk(root)) {
    const rgb = attr(element, "rgb");
    if (["color", "fgColor", "bgColor"].includes(element.name) && rgb !== null && !/^[0-9A-Fa-f]{8}$/.test(rgb)) problems.push(`colour rgb=${JSON.stringify(rgb)} is not AARRGGBB`);
  }
  return { problems, cellFormats: counts.cellXfs ?? 0 };
}

/** The fonts of the styles part whose children are not in the order of the schema sequence. */
export function fontsOutOfOrder(root: XmlElement): string[] {
  const out: string[] = [];
  children(child(root, "fonts"), "font").forEach((font, index) => {
    const problems = orderProblems(font, FONT_ORDER, "font", "");
    if (problems.length > 0) out.push(`font ${index}: ${elementsOf(font).map((element) => element.name).join(" ")}`);
  });
  return out;
}

function sharedStringProblems(root: XmlElement): { problems: string[]; count: number; texts: string[] } {
  const problems: string[] = [];
  const items = children(root, "si");
  const texts = items.map((item) => [...walk(item)].filter((element) => element.name === "t").map((element) => text(element)).join(""));
  const unique = attr(root, "uniqueCount");
  if (unique !== null && unique !== String(items.length)) problems.push(`uniqueCount="${unique}" but there are ${items.length} <si> items`);
  items.forEach((item, index) => {
    problems.push(...orderProblems(item, ["t", "r", "rPh", "phoneticPr"], "si", "", REPEATABLE));
    for (const element of walk(item)) {
      if (element.name !== "t") continue;
      const value = text(element);
      if (value !== value.trim() && attr(element, "xml:space") !== "preserve") problems.push(`string ${index} ${JSON.stringify(value.slice(0, 24))} has outer white space without xml:space="preserve"`);
      if (sourceText(element).includes("\r")) problems.push(`string ${index} holds a literal carriage return, which an XML reader turns into a line feed`);
    }
  });
  return { problems, count: items.length, texts };
}

/** The text a cell shows when it holds a string, else null. */
function cellString(cell: XmlElement, strings: readonly string[]): string | null {
  const type = attr(cell, "t");
  const value = child(cell, "v");
  if (type === "s") return value === null ? null : (strings[Number(text(value))] ?? null);
  if (type === "str") return value === null ? null : text(value);
  if (type === "inlineStr") return [...walk(cell)].filter((element) => element.name === "t").map((element) => text(element)).join("");
  return null;
}

/**
 * A table against the cells of its sheet: its range holds a header row and
 * at least one row of data, it has one column per column of the range, and
 * every column is named as its header cell reads. Spreadsheet software
 * repairs or refuses a workbook where they differ.
 */
export function tableProblems(table: XmlElement, sheet: XmlElement, strings: readonly string[]): string[] {
  const problems: string[] = [];
  const name = attr(table, "displayName") ?? attr(table, "name") ?? "?";
  const box = parseRef(attr(table, "ref"));
  if (box === null) return [`table ${name} has the malformed ref ${JSON.stringify(attr(table, "ref"))}`];
  const headerRows = Number(attr(table, "headerRowCount") ?? "1");
  const totalsRows = Number(attr(table, "totalsRowCount") ?? "0");
  if (box[2] - box[0] + 1 - headerRows - totalsRows < 1) problems.push(`table ${name} ${attr(table, "ref")} has no row of data`);
  const list = child(table, "tableColumns");
  const columns = children(list, "tableColumn");
  if (list !== null) problems.push(...countProblems(list, "tableColumn").problems.map((problem) => `table ${name}: ${problem}`));
  if (columns.length !== box[3] - box[1] + 1) problems.push(`table ${name} has ${columns.length} columns for the ${box[3] - box[1] + 1} columns of ${attr(table, "ref")}`);
  const names = columns.map((column) => (attr(column, "name") ?? "").toLowerCase());
  if (new Set(names).size !== names.length) problems.push(`table ${name} has two columns of one name`);
  const filter = child(table, "autoFilter");
  const filterBox = filter === null ? null : parseRef(attr(filter, "ref"));
  if (filter !== null && (filterBox === null || filterBox[0] !== box[0] || filterBox[1] !== box[1] || filterBox[3] !== box[3] || filterBox[2] !== box[2] - totalsRows)) {
    problems.push(`table ${name} autoFilter ${attr(filter, "ref")} does not match its range ${attr(table, "ref")}`);
  }
  if (headerRows !== 1) return problems;
  const headers = new Map<number, string | null>();
  const data = child(sheet, "sheetData");
  for (const row of children(data, "row")) {
    if (Number(attr(row, "r")) !== box[0]) continue;
    for (const cell of children(row, "c")) {
      const match = A1.exec(attr(cell, "r") ?? "");
      if (match !== null) headers.set(columnNumber(match[1] as string), cellString(cell, strings));
    }
  }
  columns.forEach((column, index) => {
    const shown = headers.get(box[1] + index) ?? null;
    if (shown !== attr(column, "name")) problems.push(`table ${name} column ${index + 1} is named ${JSON.stringify(attr(column, "name"))} but its header cell reads ${JSON.stringify(shown)}`);
  });
  return problems;
}

interface SheetFacts {
  problems: string[];
  sharedReferences: number;
  formulas: Set<string>;
}

function cellProblems(cell: XmlElement, row: number, cellFormats: number, strings: number, facts: SheetFacts): Box | null {
  const { problems } = facts;
  const ref = attr(cell, "r") ?? "";
  const match = A1.exec(ref);
  if (match === null) {
    problems.push(`cell reference ${JSON.stringify(ref)} is malformed`);
    return null;
  }
  if (Number(match[2]) !== row) problems.push(`cell ${ref} is in row ${row}`);
  problems.push(...orderProblems(cell, ["f", "v", "is", "extLst"], "c", ""));
  if (!isIndexBelow(attr(cell, "s"), cellFormats)) problems.push(`cell ${ref} style index ${attr(cell, "s")} is out of range (${cellFormats} cell formats)`);
  const type = attr(cell, "t") ?? "n";
  const valueElement = child(cell, "v");
  const value = valueElement === null ? null : text(valueElement);
  if (!["b", "n", "e", "s", "str", "inlineStr", "d"].includes(type)) problems.push(`cell ${ref} has the unknown type ${JSON.stringify(type)}`);
  if (type === "s") {
    facts.sharedReferences += 1;
    if (value === null || !isIndexBelow(value, strings)) problems.push(`cell ${ref} shared string index ${JSON.stringify(value)} is out of range (${strings} strings)`);
  } else if (type === "n" && value !== null) {
    if (value.trim() !== value || value === "" || !Number.isFinite(Number(value))) problems.push(`cell ${ref} is numeric but holds ${JSON.stringify(value)}`);
  } else if (type === "b" && value !== "0" && value !== "1") problems.push(`cell ${ref} is boolean but holds ${JSON.stringify(value)}`);
  else if (type === "e" && (value === null || !ERRORS.has(value))) problems.push(`cell ${ref} is an error but holds ${JSON.stringify(value)}`);
  else if (type === "inlineStr" && (child(cell, "is") === null || valueElement !== null)) problems.push(`cell ${ref} is inlineStr without <is> or with <v>`);
  else if (type === "str" && valueElement !== null && value !== null) {
    if (value !== value.trim() && attr(valueElement, "xml:space") !== "preserve") problems.push(`cell ${ref} string result has outer white space without xml:space="preserve"`);
    if (sourceText(valueElement).includes("\r")) problems.push(`cell ${ref} holds a literal carriage return`);
  }
  const formula = child(cell, "f");
  if (formula !== null) {
    facts.formulas.add(ref);
    const source = text(formula);
    const kind = attr(formula, "t") ?? "normal";
    if (source.startsWith("=")) problems.push(`cell ${ref} formula starts with "="`);
    if (kind === "normal" && source === "") problems.push(`cell ${ref} has an empty formula`);
    if (kind === "shared" && attr(formula, "si") === null) problems.push(`cell ${ref} shared formula has no si`);
    if (kind === "array") {
      const box = parseRef(attr(formula, "ref"));
      if (box === null || box[0] !== row || box[1] !== columnNumber(match[1] as string)) problems.push(`cell ${ref} array formula is not at the top left of its ref ${attr(formula, "ref")}`);
    }
    if (type === "s") problems.push(`cell ${ref} has a formula and a shared string value (must be t="str")`);
  }
  const column = columnNumber(match[1] as string);
  return [row, column, row, column];
}

function worksheetProblems(root: XmlElement, cellFormats: number, strings: number): SheetFacts {
  const facts: SheetFacts = { problems: orderProblems(root, WORKSHEET, "worksheet", "", REPEATABLE), sharedReferences: 0, formulas: new Set() };
  const { problems } = facts;
  const data = child(root, "sheetData");
  if (data === null) {
    problems.push("no <sheetData>");
    return facts;
  }
  let lastRow = 0;
  let used: Box | null = null;
  for (const row of elementsOf(data)) {
    if (row.name !== "row") {
      problems.push(`<${row.name}> is not allowed in <sheetData>`);
      continue;
    }
    const number = Number(attr(row, "r") ?? "NaN");
    if (!Number.isInteger(number) || number < 1 || number > 1048576) {
      problems.push(`a row has r=${JSON.stringify(attr(row, "r"))}`);
      continue;
    }
    if (number <= lastRow) problems.push(`row ${number} comes after row ${lastRow} (rows must ascend)`);
    lastRow = Math.max(lastRow, number);
    if (!isIndexBelow(attr(row, "s"), cellFormats)) problems.push(`row ${number} style ${attr(row, "s")} is out of range`);
    let lastColumn = 0;
    for (const cell of elementsOf(row)) {
      if (cell.name !== "c") {
        if (cell.name !== "extLst") problems.push(`<${cell.name}> is not allowed in <row>`);
        continue;
      }
      const box = cellProblems(cell, number, cellFormats, strings, facts);
      if (box === null) continue;
      if (box[1] <= lastColumn) problems.push(`cell ${attr(cell, "r")} comes after column ${lastColumn} (cells must ascend)`);
      if (box[1] > 16384) problems.push(`cell ${attr(cell, "r")} is outside the sheet`);
      lastColumn = Math.max(lastColumn, box[1]);
      used = used === null ? box : [Math.min(used[0], box[0]), Math.min(used[1], box[1]), Math.max(used[2], box[2]), Math.max(used[3], box[3])];
    }
  }
  const dimension = child(root, "dimension");
  if (dimension !== null) {
    const box = parseRef(attr(dimension, "ref"));
    const cells = used as Box | null;
    if (box === null) problems.push(`dimension ref ${JSON.stringify(attr(dimension, "ref"))} is malformed`);
    else if (cells !== null && !(box[0] <= cells[0] && box[1] <= cells[1] && box[2] >= cells[2] && box[3] >= cells[3])) problems.push(`dimension ${attr(dimension, "ref")} does not cover the cells`);
  }
  const columnGroups = children(root, "cols");
  if (columnGroups.length > 1) problems.push("more than one <cols>");
  for (const group of columnGroups) {
    let lastMax = 0;
    const entries = children(group, "col");
    if (entries.length === 0) problems.push("<cols> is empty");
    for (const entry of entries) {
      const min = Number(attr(entry, "min") ?? "NaN");
      const max = Number(attr(entry, "max") ?? "NaN");
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 16384 || min > max) problems.push(`<col min=${attr(entry, "min")} max=${attr(entry, "max")}> is out of range`);
      else if (min <= lastMax) problems.push(`<col min=${min}> overlaps or precedes the column range before it`);
      lastMax = Math.max(lastMax, Number.isInteger(max) ? max : lastMax);
      if (attr(entry, "width") !== null && attr(entry, "customWidth") !== "1" && attr(entry, "customWidth") !== "true") problems.push(`<col min=${min}> has a width without customWidth`);
      if (!isIndexBelow(attr(entry, "style"), cellFormats)) problems.push(`<col min=${min}> style ${attr(entry, "style")} is out of range`);
    }
  }
  const merges = child(root, "mergeCells");
  if (merges !== null) {
    const result = countProblems(merges, "mergeCell");
    problems.push(...result.problems);
    if (result.count === 0) problems.push("<mergeCells> is empty");
    const boxes: Box[] = [];
    for (const merge of children(merges, "mergeCell")) {
      const box = parseRef(attr(merge, "ref"));
      if (box === null) problems.push(`mergeCell ref ${JSON.stringify(attr(merge, "ref"))} is malformed`);
      else {
        if (box[0] === box[2] && box[1] === box[3]) problems.push(`mergeCell ${attr(merge, "ref")} is a single cell`);
        if (boxes.some((other) => overlap(box, other))) problems.push(`merged ranges overlap at ${attr(merge, "ref")}`);
        boxes.push(box);
      }
    }
  }
  for (const view of children(child(root, "sheetViews"), "sheetView")) {
    problems.push(...orderProblems(view, ["pane", "selection", "pivotSelection", "extLst"], "sheetView", "", REPEATABLE));
    if (attr(view, "workbookViewId") === null) problems.push("<sheetView> has no workbookViewId");
    const pane = child(view, "pane");
    const selections = children(view, "selection").map((selection) => attr(selection, "pane") ?? "topLeft");
    if (pane === null) {
      if (selections.some((name) => name !== "topLeft")) problems.push("<selection> names a pane but the view has none");
      continue;
    }
    const x = Number(attr(pane, "xSplit") ?? "0");
    const y = Number(attr(pane, "ySplit") ?? "0");
    if (x === 0 && y === 0) problems.push("<pane> splits nothing");
    const state = attr(pane, "state") ?? "split";
    if (state !== "frozen" && state !== "frozenSplit") continue;
    const corner = parseRef(attr(pane, "topLeftCell"));
    if (corner === null || corner[0] - 1 !== y || corner[1] - 1 !== x) problems.push(`frozen <pane> topLeftCell ${attr(pane, "topLeftCell")} does not match xSplit=${x} ySplit=${y}`);
    const active = x > 0 && y > 0 ? "bottomRight" : x > 0 ? "topRight" : "bottomLeft";
    if (attr(pane, "activePane") !== active) problems.push(`frozen <pane> activePane is ${attr(pane, "activePane")}, expected ${active}`);
    if (new Set(selections).size !== selections.length) problems.push("two <selection> elements for one pane");
  }
  return facts;
}

function workbookProblems(pkg: SavedPackage, part: string, root: XmlElement, sheets: XmlElement[]): string[] {
  const problems = orderProblems(root, WORKBOOK, "workbook", "");
  if (sheets.length === 0) problems.push("no sheets");
  const names = sheets.map((sheet) => attr(sheet, "name") ?? "");
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) problems.push(`sheet names repeat: ${names.join(", ")}`);
  for (const name of names) if (name === "" || name.length > 31 || /[:\\/?*[\]]/.test(name)) problems.push(`sheet name ${JSON.stringify(name)} is not allowed`);
  const ids = sheets.map((sheet) => attr(sheet, "sheetId"));
  if (new Set(ids).size !== ids.length || ids.some((id) => id === null || !/^[1-9]\d*$/.test(id))) problems.push(`sheetId values are missing, not positive or duplicated: ${ids.join(", ")}`);
  const relationIds = sheets.map((sheet) => attr(sheet, "r:id"));
  if (new Set(relationIds).size !== relationIds.length) problems.push("two sheets share a relationship id");
  for (const id of relationIds) if (id === null || !pkg.relationships.get(part)?.has(id)) problems.push(`sheet relationship ${id} is missing`);
  if (sheets.every((sheet) => (attr(sheet, "state") ?? "visible") !== "visible")) problems.push("no visible sheet");
  const view = child(root, "bookViews") === null ? null : child(child(root, "bookViews") as XmlElement, "workbookView");
  if (view !== null) {
    const active = Number(attr(view, "activeTab") ?? "0");
    const sheet = sheets[active];
    if (sheet === undefined) problems.push(`activeTab=${active} but there are ${sheets.length} sheets`);
    else if ((attr(sheet, "state") ?? "visible") !== "visible") problems.push(`activeTab=${active} is a hidden sheet`);
    if (!isIndexBelow(attr(view, "firstSheet"), sheets.length)) problems.push(`firstSheet=${attr(view, "firstSheet")} is out of range`);
  }
  const seen = new Set<string>();
  for (const name of children(child(root, "definedNames"), "definedName")) {
    const scope = attr(name, "localSheetId");
    if (!isIndexBelow(scope, sheets.length)) problems.push(`definedName ${attr(name, "name")} localSheetId=${scope} is out of range`);
    const key = `${(attr(name, "name") ?? "").toLowerCase()}\u0000${scope ?? ""}`;
    if (seen.has(key)) problems.push(`definedName ${attr(name, "name")} is defined twice in one scope`);
    seen.add(key);
    const value = text(name);
    if (value.trim() === "" || value.startsWith("=")) problems.push(`definedName ${attr(name, "name")} is empty or starts with "="`);
  }
  return problems;
}

/** Every problem of a saved `.xlsx`, each prefixed with its part name. */
export async function sheetProblems(bytes: Uint8Array): Promise<string[]> {
  const pkg = await readPackage(bytes);
  const workbookPart = related(pkg, "/", "/officeDocument")[0] ?? "/xl/workbook.xml";
  const workbook = pkg.parts.get(workbookPart)?.root;
  if (workbook === undefined) return ["the workbook part is missing"];
  const problems: string[] = [];
  const sheets = children(child(workbook, "sheets"), "sheet");
  for (const problem of workbookProblems(pkg, workbookPart, workbook, sheets)) problems.push(`${workbookPart}: ${problem}`);
  let cellFormats = 1;
  for (const part of related(pkg, workbookPart, "/styles")) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) continue;
    const result = styleProblems(root);
    cellFormats = result.cellFormats;
    for (const problem of result.problems) problems.push(`${part}: ${problem}`);
  }
  let strings = 0;
  let stringTexts: string[] = [];
  let stringsRoot: XmlElement | null = null;
  for (const part of related(pkg, workbookPart, "/sharedStrings")) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) continue;
    const result = sharedStringProblems(root);
    strings = result.count;
    stringTexts = result.texts;
    stringsRoot = root;
    for (const problem of result.problems) problems.push(`${part}: ${problem}`);
  }
  let references = 0;
  const tableNames: string[] = [];
  const formulasBySheet = new Map<string, Set<string>>();
  sheets.forEach((sheet, index) => {
    const target = pkg.relationships.get(workbookPart)?.get(attr(sheet, "r:id") ?? "")?.[1];
    const root = target === undefined ? undefined : pkg.parts.get(target)?.root;
    if (root === undefined || target === undefined) return;
    const facts = worksheetProblems(root, cellFormats, strings);
    references += facts.sharedReferences;
    // The calculation chain names a sheet by its sheetId.
    formulasBySheet.set(attr(sheet, "sheetId") ?? String(index + 1), facts.formulas);
    for (const problem of facts.problems) problems.push(`${target}: ${problem}`);
    for (const tablePart of related(pkg, target, "/table")) {
      const table = pkg.parts.get(tablePart)?.root;
      if (table === undefined) continue;
      tableNames.push((attr(table, "displayName") ?? "").toLowerCase());
      for (const problem of tableProblems(table, root, stringTexts)) problems.push(`${tablePart}: ${problem}`);
    }
  });
  if (new Set(tableNames).size !== tableNames.length) problems.push(`two tables share a name: ${tableNames.join(", ")}`);
  const declared = stringsRoot === null ? null : attr(stringsRoot, "count");
  if (declared !== null && declared !== String(references)) problems.push(`sharedStrings: count="${declared}" but the sheets hold ${references} shared string cells`);
  for (const part of related(pkg, workbookPart, "/calcChain")) {
    const root = pkg.parts.get(part)?.root;
    if (root === undefined) continue;
    let sheetIndex: string | null = null;
    for (const entry of children(root, "c")) {
      sheetIndex = attr(entry, "i") ?? sheetIndex;
      const ref = attr(entry, "r") ?? "";
      if (sheetIndex !== null && !(formulasBySheet.get(sheetIndex)?.has(ref) ?? false)) {
        problems.push(`calcChain: lists ${ref} on sheet ${sheetIndex}, which has no formula there`);
        break;
      }
    }
  }
  return problems;
}
