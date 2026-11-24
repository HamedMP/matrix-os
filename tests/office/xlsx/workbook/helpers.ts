import { readFileSync } from "node:fs";
import path from "node:path";
import type { Cell, CellValue, Workbook } from "../../../../packages/office/src/api/xlsx.js";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
import { type ZipRecord, parseZip } from "../../../../packages/office/src/opc/index.js";
import { parseA1 } from "../../../../packages/office/src/xlsx/index.js";

export const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures");

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export function loadExpected<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, "expected", name), "utf8")) as T;
}

/** Stored ZIP records by entry name, with the compressed bytes as base64 for readable diffs. */
export function storedRecords(bytes: Uint8Array): Map<string, Omit<ZipRecord, "compressed"> & { compressed: string }> {
  return new Map(
    parseZip(bytes).records.map((record) => [
      record.name,
      { ...record, compressed: Buffer.from(record.compressed).toString("base64") },
    ]),
  );
}

/** The error code thrown by `run`, `"other"` for a foreign error, or null when nothing is thrown. */
export function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return null;
}

export async function asyncCodeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return null;
}

export function sheetId(workbook: Workbook, name: string): string {
  const sheet = workbook.getSheetByName(name);
  if (sheet === null) throw new Error(`no sheet ${name}`);
  return sheet.id;
}

/** A cell by sheet name and A1 address. */
export function at(workbook: Workbook, sheet: string, a1: string): Cell {
  return workbook.getCell(sheetId(workbook, sheet), parseA1(a1));
}

export function valueAt(workbook: Workbook, sheet: string, a1: string): CellValue {
  return at(workbook, sheet, a1).value;
}

export const err = (code: string): CellValue => ({ kind: "error", code }) as CellValue;

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export interface HandmadeSheet {
  name: string;
  /** Content of `<sheetData>`. */
  rows?: string;
  /** Markup placed after `<sheetData>` (merges, conditional formats, …). */
  after?: string;
  /** Markup placed before `<sheetData>` (columns, sheet views, …). */
  before?: string;
  /** The whole part, instead of the pieces above. */
  xml?: string;
  state?: "hidden" | "veryHidden";
}

export interface HandmadeWorkbook {
  sheets: HandmadeSheet[];
  /** Content of `<sst>`: a list of `<si>` elements. */
  sharedStrings?: string;
  /** Content of `<definedNames>`. */
  definedNames?: string;
  /** Attributes of `<workbookPr>`. */
  workbookPr?: string;
  /** The whole styles part. */
  styles?: string;
  /** A calculation chain part, to check that it is dropped. */
  calcChain?: boolean;
  /** Attributes of `<calcPr>`; the element is left out without them. */
  calcPr?: string;
}

/** Builds a small workbook from markup, for cases the generated fixtures do not cover. */
export async function buildXlsx(spec: HandmadeWorkbook): Promise<Uint8Array> {
  const { createPackage } = await import("../../../../packages/office/src/opc/index.js");
  const pkg = createPackage();
  const sheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
  pkg.setPart("/xl/workbook.xml", "<workbook/>", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml");
  pkg.addRelationship("/", { type: `${REL}/officeDocument`, target: "xl/workbook.xml" });
  let entries = "";
  spec.sheets.forEach((sheet, index) => {
    const xml =
      sheet.xml ??
      `${HEADER}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${sheet.before ?? ""}<sheetData>${sheet.rows ?? ""}</sheetData>${sheet.after ?? ""}</worksheet>`;
    pkg.setPart(`/xl/worksheets/sheet${index + 1}.xml`, xml, sheetType);
    const relationship = pkg.addRelationship("/xl/workbook.xml", { type: `${REL}/worksheet`, target: `worksheets/sheet${index + 1}.xml` });
    const state = sheet.state === undefined ? "" : ` state="${sheet.state}"`;
    entries += `<sheet name="${sheet.name}" sheetId="${index + 1}"${state} r:id="${relationship.id}"/>`;
  });
  if (spec.sharedStrings !== undefined) {
    pkg.setPart(
      "/xl/sharedStrings.xml",
      `${HEADER}<sst xmlns="${MAIN}">${spec.sharedStrings}</sst>`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    );
    pkg.addRelationship("/xl/workbook.xml", { type: `${REL}/sharedStrings`, target: "sharedStrings.xml" });
  }
  if (spec.styles !== undefined) {
    pkg.setPart("/xl/styles.xml", spec.styles, "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml");
    pkg.addRelationship("/xl/workbook.xml", { type: `${REL}/styles`, target: "styles.xml" });
  }
  if (spec.calcChain === true) {
    pkg.setPart(
      "/xl/calcChain.xml",
      `${HEADER}<calcChain xmlns="${MAIN}"><c r="A1" i="1"/></calcChain>`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml",
    );
    pkg.addRelationship("/xl/workbook.xml", { type: `${REL}/calcChain`, target: "calcChain.xml" });
  }
  const names = spec.definedNames === undefined ? "" : `<definedNames>${spec.definedNames}</definedNames>`;
  pkg.setPart(
    "/xl/workbook.xml",
    `${HEADER}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr${spec.workbookPr ?? ""}/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${entries}</sheets>${names}${spec.calcPr === undefined ? "" : `<calcPr${spec.calcPr}/>`}</workbook>`,
  );
  return pkg.save();
}

/** `<c>` markup for a number cell. */
export const num = (ref: string, value: number): string => `<c r="${ref}"><v>${value}</v></c>`;
/** `<c>` markup for a formula cell with a cached number. */
export const fx = (ref: string, formula: string, cached: number): string => `<c r="${ref}"><f>${formula}</f><v>${cached}</v></c>`;
