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
export function storedRecords(bytes: Uint8Array): Map<string, ZipRecord & { compressed: unknown }> {
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
