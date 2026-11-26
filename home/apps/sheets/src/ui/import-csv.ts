/**
 * Turns pasted delimited text into typed cell inputs.
 *
 * Fields are read with the engine's CSV reader (quotes, any line ending,
 * delimiter detection), then given to the session as typed text so numbers,
 * dates and booleans become values. A field starting with `=` stays text:
 * pasted data never becomes a formula. Text beyond a limit (characters,
 * cells, the area the rows span, a field longer than a cell holds) is
 * refused whole; nothing is imported cut short.
 */
import { isOfficeError, scanCsv, sniffDelimiter } from "../session/engine";

/** Largest paste accepted, in characters. */
export const MAX_IMPORT_CHARS = 5_000_000;
export const MAX_IMPORT_CELLS = 500_000;
/**
 * Most positions of the pasted table read back, empty ones included. A few
 * long rows among short ones make the table much larger than its cells.
 */
export const MAX_IMPORT_AREA = 4 * MAX_IMPORT_CELLS;
/** Most characters a cell holds. */
const MAX_FIELD_CHARS = 32_767;

const TOO_MANY_CELLS = "The pasted text has more cells than Sheets imports at once.";
const FIELD_TOO_LONG = "A pasted field is longer than a cell holds (32,767 characters).";

export type ImportResult = { ok: true; rows: string[][] } | { ok: false; message: string };

export function parsePastedTable(text: string): ImportResult {
  if (text.trim() === "") return { ok: false, message: "Paste some rows first." };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, message: "That is more text than Sheets imports at once (5 million characters)." };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let records: ReturnType<typeof scanCsv>;
  try {
    records = scanCsv(body, { delimiter: sniffDelimiter(body), maxCells: MAX_IMPORT_CELLS });
  } catch (error: unknown) {
    if (isOfficeError(error)) return { ok: false, message: TOO_MANY_CELLS };
    throw error;
  }
  const rows: string[][] = [];
  let used = 0;
  let width = 0;
  for (const record of records) {
    const fields: string[] = [];
    for (const field of record) {
      if (field.text.length > MAX_FIELD_CHARS) return { ok: false, message: FIELD_TOO_LONG };
      fields.push(field.text.startsWith("=") || field.text.startsWith("'") ? `'${field.text}` : field.text);
    }
    while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
    rows.push(fields);
    if (fields.length > 0) used = rows.length;
    width = Math.max(width, fields.length);
  }
  rows.length = used;
  if (used === 0) return { ok: false, message: "No rows were found in the pasted text." };
  if (used * width > MAX_IMPORT_AREA) return { ok: false, message: TOO_MANY_CELLS };
  return { ok: true, rows };
}
