/** Building the workbook state from a package, and creating a new workbook. */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type { OpenXlsxOptions } from "../../api/xlsx.js";
import type { XmlDocument, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { createPackage, findMainDocumentPart, openPackage, partNameKey } from "../../opc/index.js";
import { getAttr, parseXml } from "../../xml/index.js";
import { readThemeColors } from "./colors.js";
import type { FormulaDeps, SheetModel, WorkbookState } from "./model.js";
import { readNames } from "./names.js";
import { MAX_NOTE_PARTS, notePartNames, readNotes } from "./notes.js";
import { type ReadContext, readSheet } from "./sheet-read.js";
import { SharedStrings, utf8Bytes } from "./shared-strings.js";
import { readTables, tablePartNames } from "./tables.js";
import { CONTENT_TYPE_STYLES, CONTENT_TYPE_WORKBOOK, CONTENT_TYPE_WORKSHEET, REL_STYLES, REL_WORKSHEET } from "./state.js";
import { StyleTable } from "./styles.js";
import { NS_MAIN, NS_RELATIONSHIPS, boolAttr, isNamed, kid, kids } from "./xml-util.js";

export const DEFAULT_MAX_CELLS = 2_000_000;
const REL_OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The style sheet of a new workbook: one font, the two reserved fills, one border, one cell format. */
export const DEFAULT_STYLES =
  `${XML_HEADER}<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

export interface WorkbookDeps {
  /** The formula engine, or null for a workbook that keeps stored values and never calculates. */
  formula: FormulaDeps | null;
}

/** Part names and texts read from the package before the model is built. */
interface Sources {
  workbookPart: PartName;
  /** Text of each part by {@link partNameKey}. One entry per part the model reads. */
  texts: Map<string, string>;
}

function relatedPart(pkg: OpcPackage, source: PartName, suffix: string): PartName | null {
  for (const relationship of pkg.getRelationships(source)) {
    if (relationship.targetMode !== "Internal" || !relationship.type.endsWith(`/${suffix}`)) continue;
    const part = pkg.resolveTarget(source, relationship.target);
    if (pkg.hasPart(part)) return part;
  }
  return null;
}

function parsePart(sources: Sources, name: PartName | null): XmlDocument | null {
  const text = name === null ? undefined : sources.texts.get(partNameKey(name));
  return text === undefined ? null : parseXml(text);
}

function relationshipIdOf(entry: { attrs: ReadonlyArray<{ name: string; value: string }> }): string | null {
  for (const attr of entry.attrs) if (attr.name === "r:id" || attr.name.endsWith(":id")) return attr.value;
  return null;
}

/** True when the workbook part asks for every formula to be calculated when the file is loaded. */
function asksFullCalc(root: XmlElement): boolean {
  const properties = kid(root, "calcPr");
  return properties !== null && boolAttr(getAttr(properties, "fullCalcOnLoad"), false);
}

/** Builds the state from parts that were already read. Synchronous, so a new workbook needs no await. */
export function buildState(pkg: OpcPackage, sources: Sources, deps: WorkbookDeps, maxCells: number): WorkbookState {
  const workbookDoc = parsePart(sources, sources.workbookPart);
  if (workbookDoc === null) throw new OfficeError("corrupt_package", "the workbook part is missing");
  const root = workbookDoc.root;
  if (!isNamed(root.name, "workbook")) throw new OfficeError("unsupported_format", "the package is not a spreadsheet");
  const properties = kid(root, "workbookPr");
  const date1904 = properties !== null && boolAttr(getAttr(properties, "date1904"), false);
  const source = sources.workbookPart;
  const stringsPartName = relatedPart(pkg, source, "sharedStrings");
  const stringsText = stringsPartName === null ? undefined : sources.texts.get(partNameKey(stringsPartName));
  const strings = new SharedStrings(parsePart(sources, stringsPartName), stringsText === undefined ? 0 : utf8Bytes(stringsText));
  const themeColors = readThemeColors(parsePart(sources, relatedPart(pkg, source, "theme")));
  const stylesPartName = relatedPart(pkg, source, "styles");
  const stylesDoc = parsePart(sources, stylesPartName) ?? parseXml(DEFAULT_STYLES);
  const styles = new StyleTable(stylesDoc, themeColors);

  const list = kid(root, "sheets");
  const entries = list === null ? [] : kids(list, "sheet");
  if (entries.length === 0) throw new OfficeError("corrupt_package", "the workbook lists no sheets");
  const context: ReadContext = { strings, date1904, cellCount: 0, maxCells, uncalculated: false };
  const sheets: SheetModel[] = [];
  const sheetsById = new Map<string, SheetModel>();
  const sheetsByKey = new Map<string, SheetModel>();
  for (const entry of entries) {
    const name = getAttr(entry, "name");
    const id = getAttr(entry, "sheetId");
    const relId = relationshipIdOf(entry);
    const relationship = relId === null ? null : pkg.getRelationship(source, relId);
    if (name === null || id === null || relId === null || relationship === null || relationship.targetMode !== "Internal") {
      throw new OfficeError("corrupt_package", "a sheet entry of the workbook is incomplete");
    }
    const partName = pkg.resolveTarget(source, relationship.target);
    const text = sources.texts.get(partNameKey(partName));
    if (text === undefined) throw new OfficeError("corrupt_package", "a sheet part is missing");
    const doc = parseXml(text);
    if (sheetsById.has(id) || sheetsByKey.has(name.toLowerCase())) {
      throw new OfficeError("corrupt_package", "two sheets share an id or a name");
    }
    const visibility = getAttr(entry, "state");
    const sheet = readSheet(
      { id, name, state: visibility === "hidden" || visibility === "veryHidden" ? visibility : "visible", partName, relId, entry },
      doc,
      context,
      text,
    );
    const tableNames = tablePartNames(pkg, partName);
    sheet.tables = readTables(tableNames, (name) => sources.texts.get(partNameKey(name)));
    for (const name of tableNames) sources.texts.delete(partNameKey(name));
    const noteNames = notePartNames(pkg, partName);
    sheet.notes = readNotes(noteNames, (name) => sources.texts.get(partNameKey(name)));
    for (const { name } of noteNames) sources.texts.delete(partNameKey(name));
    // The model has what it needs; the texts of other parts are not kept either.
    sources.texts.delete(partNameKey(partName));
    sheets.push(sheet);
    sheetsById.set(id, sheet);
    sheetsByKey.set(name.toLowerCase(), sheet);
  }
  return {
    pkg,
    workbookPart: { name: source, doc: workbookDoc, dirty: false },
    sheets,
    sheetsById,
    sheetsByKey,
    strings,
    stringsPartName,
    styles,
    stylesPart: { name: stylesPartName ?? "/xl/styles.xml", doc: stylesDoc, dirty: false },
    stylesInPackage: stylesPartName !== null,
    names: readNames(root, sheets),
    namesDirty: false,
    date1904,
    formula: deps.formula,
    functions: null,
    // A file whose formulas come without values (written by a library, not a spreadsheet program), or one that
    // asks for it, is calculated in full by the first run.
    calc: {
      edited: new Map(),
      folded: new Map(),
      pending: new Map(),
      all: false,
      onLoad: context.uncalculated === true || asksFullCalc(root),
      graph: null,
      lastNow: null,
    },
    listeners: [],
    journal: null,
    cellCount: context.cellCount,
    maxCells,
    calcChainDropped: relatedPart(pkg, source, "calcChain") === null,
    parseCache: new Map(),
  };
}

/** Reads the parts of a spreadsheet package and builds the state. */
export async function openState(bytes: Uint8Array, options: OpenXlsxOptions | undefined, deps: WorkbookDeps): Promise<WorkbookState> {
  const pkg = await openPackage(bytes, options?.limits);
  const workbookPart = findMainDocumentPart(pkg);
  if (workbookPart === null) throw new OfficeError("unsupported_format", "the package has no main document part");
  const contentType = pkg.getContentType(workbookPart) ?? "";
  if (!contentType.includes("spreadsheetml") && !contentType.includes("ms-excel")) {
    throw new OfficeError("unsupported_format", "the package is not a spreadsheet");
  }
  const wanted: PartName[] = [workbookPart];
  for (const relationship of pkg.getRelationships(workbookPart)) {
    if (relationship.targetMode !== "Internal") continue;
    if (!/\/(worksheet|sharedStrings|styles|theme)$/.test(relationship.type)) continue;
    const part = pkg.resolveTarget(workbookPart, relationship.target);
    if (!pkg.hasPart(part)) continue;
    wanted.push(part);
    // The tables of a sheet move with its rows and columns, so their parts are read too.
    if (relationship.type.endsWith("/worksheet")) {
      wanted.push(...tablePartNames(pkg, part));
      // So do its notes; a sheet relates to a handful of such parts at most.
      wanted.push(...notePartNames(pkg, part).slice(0, MAX_NOTE_PARTS).map((entry) => entry.name));
    }
  }
  const texts = new Map<string, string>();
  for (const part of wanted) texts.set(partNameKey(part), await pkg.getPartText(part));
  const maxCells = options?.maxCells;
  const limit = typeof maxCells === "number" && Number.isInteger(maxCells) && maxCells >= 0 ? maxCells : DEFAULT_MAX_CELLS;
  return buildState(pkg, { workbookPart, texts }, deps, limit);
}

/** Builds a new workbook package with empty sheets of the given names. */
export function createState(sheetNames: readonly string[], deps: WorkbookDeps): WorkbookState {
  const pkg = createPackage();
  const workbookPart = "/xl/workbook.xml";
  const texts = new Map<string, string>();
  const put = (name: PartName, text: string, contentType: string): void => {
    pkg.setPart(name, text, contentType);
    texts.set(partNameKey(name), text);
  };
  const sheetXml = `${XML_HEADER}<worksheet xmlns="${NS_MAIN}"><sheetData/></worksheet>`;
  let entries = "";
  // The workbook part must exist before relationships can leave it.
  put(workbookPart, "<workbook/>", CONTENT_TYPE_WORKBOOK);
  pkg.addRelationship("/", { type: REL_OFFICE_DOCUMENT, target: "xl/workbook.xml" });
  sheetNames.forEach((name, index) => {
    const partName = `/xl/worksheets/sheet${index + 1}.xml`;
    put(partName, sheetXml, CONTENT_TYPE_WORKSHEET);
    const relationship = pkg.addRelationship(workbookPart, { type: REL_WORKSHEET, target: `worksheets/sheet${index + 1}.xml` });
    const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    entries += `<sheet name="${escaped}" sheetId="${index + 1}" r:id="${relationship.id}"/>`;
  });
  put("/xl/styles.xml", DEFAULT_STYLES, CONTENT_TYPE_STYLES);
  pkg.addRelationship(workbookPart, { type: REL_STYLES, target: "styles.xml" });
  put(
    workbookPart,
    `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_RELATIONSHIPS}"><bookViews><workbookView/></bookViews><sheets>${entries}</sheets></workbook>`,
    CONTENT_TYPE_WORKBOOK,
  );
  return buildState(pkg, { workbookPart, texts }, deps, DEFAULT_MAX_CELLS);
}
