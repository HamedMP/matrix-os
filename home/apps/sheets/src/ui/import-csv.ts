/**
 * Turns pasted delimited text into typed cell inputs.
 *
 * Fields are read with the engine's CSV reader (quotes, any line ending,
 * delimiter detection), then given to the session as typed text so numbers,
 * dates and booleans become values. A field starting with `=` stays text:
 * pasted data never becomes a formula. Text beyond a limit (characters,
 * cells, the area the rows span, a field longer than a cell holds) is
 * refused whole; nothing is imported cut short. The fields and the area are
 * counted before the reader builds any field ({@link csvExtent}), so text
 * that is too large is refused without being read into memory.
 */
import { isOfficeError, scanCsv, sniffDelimiter } from "../session/engine";
import { MAX_CELL_CHARS } from "../session/file-io";

/** Largest paste accepted, in characters. */
export const MAX_IMPORT_CHARS = 5_000_000;
export const MAX_IMPORT_CELLS = 500_000;
/**
 * Most positions of the pasted table read back, empty ones included. A few
 * long rows among short ones make the table much larger than its cells.
 */
export const MAX_IMPORT_AREA = 4 * MAX_IMPORT_CELLS;

const TOO_MANY_CELLS = "The pasted text has more cells than Sheets imports at once.";
const FIELD_TOO_LONG = "A pasted field is longer than a cell holds (32,767 characters).";

export type ImportResult = { ok: true; rows: string[][] } | { ok: false; message: string };

export function parsePastedTable(text: string): ImportResult {
  if (text.trim() === "") return { ok: false, message: "Paste some rows first." };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, message: "That is more text than Sheets imports at once (5 million characters)." };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = sniffDelimiter(body);
  if (csvExtent(body, delimiter, MAX_IMPORT_AREA) === null) return { ok: false, message: TOO_MANY_CELLS };
  let records: ReturnType<typeof scanCsv>;
  try {
    records = scanCsv(body, { delimiter, maxCells: MAX_IMPORT_CELLS });
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
      if (field.text.length > MAX_CELL_CHARS) return { ok: false, message: FIELD_TOO_LONG };
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

/**
 * How many fields the engine's CSV reader (`scanCsv`) would build from
 * `text`, and the area its rows span once empty trailing fields and rows are
 * dropped (rows up to the last with a value, times the widest such row).
 * Counted without building anything, reading the text as `scanCsv` does.
 * Null as soon as either count passes `limit`.
 */
export function csvExtent(text: string, delimiter: string, limit: number): { fields: number; area: number } | null {
  const delimiterCode = delimiter.charCodeAt(0);
  const length = text.length;
  let fields = 0;
  /** Records ended so far. */
  let records = 0;
  /** Records up to the last one with a value, and the widest of them. */
  let used = 0;
  let width = 0;
  /** Fields of the record being read, and how many up to its last value. */
  let recordFields = 0;
  let recordWidth = 0;
  let i = 0;
  /** True when a delimiter was just read, so that a field must follow even at the end of the text. */
  let pending = false;
  /** Counts one field; false when the fields or the area pass the limit. */
  const field = (empty: boolean): boolean => {
    fields++;
    recordFields++;
    if (!empty) recordWidth = recordFields;
    if (fields > limit) return false;
    return empty || (records + 1) * Math.max(width, recordWidth) <= limit;
  };
  const endRecord = (): void => {
    records++;
    if (recordWidth > 0) {
      used = records;
      width = Math.max(width, recordWidth);
    }
    recordFields = 0;
    recordWidth = 0;
  };
  /** Moves past an unquoted run up to the next delimiter or line break. */
  const skipText = (): void => {
    while (i < length) {
      const code = text.charCodeAt(i);
      if (code === delimiterCode || code === 10 || code === 13) break;
      i++;
    }
  };
  while (i < length) {
    let size: number;
    if (text.charCodeAt(i) === 34) {
      // Quoted: to the closing quote, `""` being one quote, then any text up to the separator.
      size = 0;
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote < 0) {
          size += length - from;
          i = length;
          break;
        }
        size += quote - from;
        if (text.charCodeAt(quote + 1) === 34) {
          size += 1;
          from = quote + 2;
        } else {
          i = quote + 1;
          break;
        }
      }
      const start = i;
      skipText();
      size += i - start;
    } else {
      const start = i;
      skipText();
      size = i - start;
    }
    if (!field(size === 0)) return null;
    pending = false;
    if (i >= length) break;
    const code = text.charCodeAt(i);
    if (code === delimiterCode) {
      i++;
      pending = true;
      continue;
    }
    i += code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    endRecord();
    // An empty line in the middle is a record with one empty field.
    while (i < length && (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13)) {
      const lineBreak = text.charCodeAt(i);
      if (!field(true)) return null;
      i += lineBreak === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      endRecord();
    }
  }
  if (pending && !field(true)) return null;
  if (recordFields > 0) endRecord();
  return { fields, area: used * width };
}
