/**
 * Turns pasted delimited text into typed cell inputs.
 *
 * Fields are read with the engine's CSV parser (quotes, any line ending,
 * delimiter detection) without type inference, then given to the session as
 * typed text so numbers, dates and booleans become values. A field starting
 * with `=` stays text: pasted data never becomes a formula.
 */
import { isOfficeError, parseCsv } from "../session/engine";

/** Largest paste accepted, in characters. */
export const MAX_IMPORT_CHARS = 5_000_000;
export const MAX_IMPORT_CELLS = 500_000;

export type ImportResult = { ok: true; rows: string[][] } | { ok: false; message: string };

export function parsePastedTable(text: string): ImportResult {
  if (text.trim() === "") return { ok: false, message: "Paste some rows first." };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, message: "That is more text than Sheets imports at once (5 million characters)." };
  try {
    const workbook = parseCsv(text, { inferTypes: false, maxCells: MAX_IMPORT_CELLS });
    const sheet = workbook.listSheets()[0];
    const used = sheet?.dimensions ?? null;
    if (sheet === undefined || used === null) return { ok: false, message: "No rows were found in the pasted text." };
    const rows: string[][] = [];
    for (let row = 0; row <= used.end.row; row++) {
      const fields: string[] = [];
      for (let col = 0; col <= used.end.col; col++) {
        const value = workbook.getCell(sheet.id, { row, col }).value;
        const text = value === null ? "" : typeof value === "object" ? value.code : String(value);
        fields.push(text.startsWith("=") || text.startsWith("'") ? `'${text}` : text);
      }
      while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
      rows.push(fields);
    }
    return { ok: true, rows };
  } catch (error: unknown) {
    if (isOfficeError(error)) return { ok: false, message: "The pasted text has more cells than Sheets imports at once." };
    throw error;
  }
}
