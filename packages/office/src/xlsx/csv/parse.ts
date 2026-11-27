/**
 * Delimiter-separated text to rows of fields: RFC 4180 quoting, any line
 * ending, embedded line breaks inside quotes, an optional byte-order mark.
 */

import { OfficeError } from "../../errors.js";
import { MAX_COLS, MAX_ROWS } from "../workbook/a1.js";

export interface CsvField {
  text: string;
  /** True when the field was written in quotes. */
  quoted: boolean;
}

export interface CsvScanOptions {
  delimiter: string;
  /**
   * Stop after this many records, for a sample of the text. Without it every
   * record is read, and text with more records than a sheet has rows throws
   * `limit_exceeded`.
   */
  maxRecords?: number;
  /** Throw `limit_exceeded` when more non-empty fields than this are read. */
  maxCells?: number;
}

const CANDIDATES = [",", ";", "\t"];
/** Records looked at when guessing the delimiter. */
const SNIFF_RECORDS = 20;
/** Characters looked at when guessing the delimiter. */
const SNIFF_CHARS = 65_536;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits text into records of fields. A line break at the very end does not start another record. */
export function scanCsv(text: string, options: CsvScanOptions): CsvField[][] {
  const delimiter = options.delimiter;
  const delimiterCode = delimiter.charCodeAt(0);
  const sample = options.maxRecords !== undefined;
  const maxRecords = Math.min(options.maxRecords ?? MAX_ROWS, MAX_ROWS);
  const maxCells = options.maxCells ?? Number.POSITIVE_INFINITY;
  const records: CsvField[][] = [];
  let record: CsvField[] = [];
  let cells = 0;
  const length = text.length;
  let i = 0;
  const pushField = (field: CsvField): void => {
    if (record.length >= MAX_COLS) throw new OfficeError("limit_exceeded", "a line has more fields than a sheet has columns");
    if (field.text !== "" && ++cells > maxCells) {
      throw new OfficeError("limit_exceeded", "the text has more cells than the limit allows", { details: { maxCells } });
    }
    record.push(field);
  };
  const tooManyRows = (): OfficeError => new OfficeError("limit_exceeded", "the text has more lines than a sheet has rows");
  /** Ends the record; true when no more are read. A full read throws when records remain beyond the last row. */
  const endRecord = (): boolean => {
    records.push(record);
    record = [];
    if (records.length < maxRecords) return false;
    if (!sample && i < length) throw tooManyRows();
    return true;
  };
  // True when a delimiter was just read, so that a field must follow even at the end of the text.
  let pending = false;
  while (i < length) {
    let field: CsvField;
    if (text.charCodeAt(i) === 34) {
      // Quoted field: runs to the closing quote; `""` is a quote.
      let value = "";
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote < 0) {
          value += text.slice(from);
          i = length;
          break;
        }
        value += text.slice(from, quote);
        if (text.charCodeAt(quote + 1) === 34) {
          value += '"';
          from = quote + 2;
        } else {
          i = quote + 1;
          break;
        }
      }
      // Text between the closing quote and the next separator is kept.
      const start = i;
      while (i < length) {
        const code = text.charCodeAt(i);
        if (code === delimiterCode || code === 10 || code === 13) break;
        i++;
      }
      field = { text: value + text.slice(start, i), quoted: true };
    } else {
      const start = i;
      while (i < length) {
        const code = text.charCodeAt(i);
        if (code === delimiterCode || code === 10 || code === 13) break;
        i++;
      }
      field = { text: text.slice(start, i), quoted: false };
    }
    pushField(field);
    pending = false;
    if (i >= length) break;
    const code = text.charCodeAt(i);
    if (code === delimiterCode) {
      i++;
      pending = true;
      continue;
    }
    // A line break: \r\n counts as one.
    i += code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    if (endRecord()) return records;
    // An empty line in the middle is a record with one empty field.
    while (i < length && (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13)) {
      const lineBreak = text.charCodeAt(i);
      record.push({ text: "", quoted: false });
      i += lineBreak === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      if (endRecord()) return records;
    }
  }
  if (pending) pushField({ text: "", quoted: false });
  if (record.length > 0) {
    if (records.length >= MAX_ROWS) throw tooManyRows();
    records.push(record);
  }
  return records;
}

/**
 * Guesses the delimiter among comma, semicolon and tab: the one that splits
 * the first lines into the same number of fields, more than one, most often.
 * Comma when nothing stands out.
 */
export function sniffDelimiter(text: string): string {
  const sample = text.length > SNIFF_CHARS ? text.slice(0, SNIFF_CHARS) : text;
  let best = ",";
  let bestScore = 0;
  let bestFields = 0;
  for (const candidate of CANDIDATES) {
    const records = scanCsv(sample, { delimiter: candidate, maxRecords: SNIFF_RECORDS });
    // Field count to number of records with that count. At most twenty entries.
    const counts = new Map<number, number>();
    for (const record of records) counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
    let fields = 0;
    let score = 0;
    for (const [count, seen] of counts) {
      if (count > 1 && (seen > score || (seen === score && count > fields))) {
        fields = count;
        score = seen;
      }
    }
    if (score > bestScore || (score === bestScore && fields > bestFields)) {
      best = candidate;
      bestScore = score;
      bestFields = fields;
    }
  }
  return best;
}
