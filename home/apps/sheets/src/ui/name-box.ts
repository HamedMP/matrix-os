/**
 * What the name box goes to: a cell or range (`B7`, `A1:C10`, `Data!A1`,
 * `C:C`, `3:5`) or a defined name. A name local to the active sheet wins
 * over a workbook name of the same spelling.
 */
import { isOfficeError, parseSheetRange } from "../session/engine";
import type { CellRange, DefinedName, SheetId, Workbook } from "../session/engine";

export type GoToResult = { ok: true; sheet: SheetId; range: CellRange } | { ok: false; message: string };

const MAX_INPUT = 300;

function parseRange(text: string): { sheetName: string | null; range: CellRange } | null {
  try {
    return parseSheetRange(text.replace(/\$/g, ""));
  } catch (error: unknown) {
    if (isOfficeError(error)) return null;
    throw error;
  }
}

/** Names someone can go to from `sheet`: workbook names and names local to it, without the file's internal ones. */
export function goToNames(workbook: Pick<Workbook, "listDefinedNames">, sheet: SheetId): DefinedName[] {
  return workbook
    .listDefinedNames()
    .filter((name) => (name.scope === null || name.scope === sheet) && !name.name.startsWith("_xlnm.") && parseRange(name.refersTo) !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findName(workbook: Pick<Workbook, "listDefinedNames">, sheet: SheetId, text: string): DefinedName | null {
  const wanted = text.toLowerCase();
  const all = workbook.listDefinedNames().filter((name) => name.name.toLowerCase() === wanted);
  return all.find((name) => name.scope === sheet) ?? all.find((name) => name.scope === null) ?? null;
}

function sheetOf(workbook: Pick<Workbook, "getSheetByName">, name: string | null, fallback: SheetId): SheetId | null {
  if (name === null) return fallback;
  return workbook.getSheetByName(name)?.id ?? null;
}

export function resolveGoTo(workbook: Pick<Workbook, "listDefinedNames" | "getSheetByName">, activeSheet: SheetId, input: string): GoToResult {
  const text = input.trim();
  if (text === "" || text.length > MAX_INPUT) return { ok: false, message: "Type a cell such as B7, a range such as A1:C10 or a name." };
  const direct = parseRange(text);
  if (direct !== null) {
    const sheet = sheetOf(workbook, direct.sheetName, activeSheet);
    if (sheet === null) return { ok: false, message: "There is no sheet with that name." };
    return { ok: true, sheet, range: direct.range };
  }
  const name = findName(workbook, activeSheet, text);
  if (name === null) return { ok: false, message: "There is no cell, range or name called that." };
  const target = parseRange(name.refersTo);
  if (target === null) return { ok: false, message: "That name does not stand for a range of cells." };
  const sheet = sheetOf(workbook, target.sheetName, name.scope ?? activeSheet);
  if (sheet === null) return { ok: false, message: "That name points to a sheet that no longer exists." };
  return { ok: true, sheet, range: target.range };
}
