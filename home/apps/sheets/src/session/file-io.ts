/**
 * Turning file bytes into a workbook and back, and the path helpers around it.
 *
 * `.xlsx` goes through the engine's package reader. `.csv` and `.tsv` are
 * decoded as UTF-8 and parsed into a one-sheet workbook; the delimiter, the
 * byte-order mark and the line ending of the file are remembered so that the
 * file is written back in the shape it had.
 */

import { type Workbook, isOfficeError, openXlsx, parseCsv, scanCsv, sniffDelimiter, toCsv } from "./engine";
import type { SessionErrorCode, SheetFileFormat } from "./types";

/** Most characters a cell holds. */
export const MAX_CELL_CHARS = 32_767;
/** Most cells with a value read from a CSV or TSV file: the engine's own bound for `parseCsv`. */
const MAX_OPEN_CSV_CELLS = 2_000_000;

const MESSAGES: Record<SessionErrorCode, string> = {
  not_found: "This file no longer exists.",
  forbidden: "Sheets may not open or change this file.",
  too_large: "This file is too large to open here.",
  unsupported: "This file is not a spreadsheet Sheets can open.",
  corrupt: "This file is damaged and could not be read.",
  unavailable: "The file service is not responding. Try again.",
  invalid_path: "Choose a file name that ends in .xlsx, .csv or .tsv.",
  exists: "A file with this name already exists.",
  formula: "This formula could not be read. Check brackets, quotes and separators.",
  not_allowed: "This change is not possible here.",
  too_many_cells: "This change touches too many cells for one step.",
  review_pending: "A CSV or TSV file cannot keep the assistant's suggested changes. Accept or reject them to save, or save as .xlsx to keep reviewing later.",
  field_too_long: "A field in this file is longer than a cell holds (32,767 characters). It was not opened, so none of its text is cut.",
  edited_meanwhile: "New edits were made while the file was read again, so it was not reloaded. Your edits are still here.",
  failed: "Something went wrong. Your edits are still here.",
};

/** The one error the session throws. `message` is safe to show. */
export class SheetSessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SheetSessionError";
    this.code = code;
  }
}

export function sessionMessage(code: SessionErrorCode): string {
  return MESSAGES[code];
}

const BRIDGE_CODES: Record<string, SessionErrorCode> = {
  not_found: "not_found",
  forbidden: "forbidden",
  too_large: "too_large",
  invalid_request: "invalid_path",
  unavailable: "unavailable",
};

/** True for the bridge's `version_conflict` rejection. */
export function isVersionConflict(error: unknown): boolean {
  const shape = error as { name?: unknown; code?: unknown } | null;
  return typeof shape === "object" && shape !== null && shape.name === "BridgeFileError" && shape.code === "version_conflict";
}

/** Maps anything thrown by the bridge or the engine to a client-safe error. */
export function toSessionError(error: unknown): SheetSessionError {
  if (error instanceof SheetSessionError) return error;
  const shape = error as { name?: unknown; code?: unknown } | null;
  if (typeof shape === "object" && shape !== null && shape.name === "BridgeFileError" && typeof shape.code === "string") {
    return new SheetSessionError(BRIDGE_CODES[shape.code] ?? "unavailable", { cause: error });
  }
  if (isOfficeError(error)) {
    switch (error.code) {
      case "not_a_zip":
      case "unsupported_format":
        return new SheetSessionError("unsupported", { cause: error });
      case "corrupt_package":
      case "malformed_xml":
        return new SheetSessionError("corrupt", { cause: error });
      case "zip_limit_exceeded":
        return new SheetSessionError("too_large", { cause: error });
      case "limit_exceeded":
        return new SheetSessionError("too_many_cells", { cause: error });
      case "formula_error":
        return new SheetSessionError("formula", { cause: error });
      case "invalid_operation":
      case "invalid_argument":
      case "stale_reference":
        return new SheetSessionError("not_allowed", { cause: error });
      default:
        return new SheetSessionError("failed", { cause: error });
    }
  }
  return new SheetSessionError("failed", { cause: error });
}

/** The format a path is saved as, or null when the extension is not one Sheets writes. */
export function formatOfPath(path: string): SheetFileFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".tsv")) return "tsv";
  return null;
}

export function fileName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

const PATH_MAX = 4096;

/** Syntax check of a home-relative path, as the bridge will apply it. */
export function isValidFilePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > PATH_MAX) return false;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A sibling path for a copy: `a/Budget.xlsx` gives `a/Budget (copy).xlsx`,
 * then `a/Budget (copy 2).xlsx` for attempt 2, and so on.
 */
export function copyPath(path: string, attempt = 1): string {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);
  const base = stem.replace(/ \(copy(?: \d+)?\)$/, "");
  const suffix = attempt <= 1 ? " (copy)" : ` (copy ${attempt})`;
  return `${dir}${base}${suffix}${ext}`;
}

/** How a delimited text file was written. */
export interface CsvShape {
  delimiter: string;
  bom: boolean;
  lineEnding: "\r\n" | "\n";
  /** True when the file ended with a line break. */
  finalNewline: boolean;
}

export function defaultCsvShape(format: SheetFileFormat): CsvShape {
  return { delimiter: format === "tsv" ? "\t" : ",", bom: false, lineEnding: "\r\n", finalNewline: true };
}

/**
 * How a delimited file was written. The delimiter is the engine's guess: the
 * candidate that splits the first lines into the same number of fields.
 */
export function sniffCsvShape(bytes: Uint8Array, text: string, format: SheetFileFormat): CsvShape {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const firstBreak = text.indexOf("\n");
  const lineEnding = firstBreak > 0 && text[firstBreak - 1] === "\r" ? "\r\n" : firstBreak >= 0 ? "\n" : "\r\n";
  return { delimiter: format === "tsv" ? "\t" : sniffDelimiter(text), bom, lineEnding, finalNewline: text.endsWith("\n") };
}

export interface LoadedWorkbook {
  workbook: Workbook;
  /** Null for `.xlsx`. */
  csv: CsvShape | null;
}

/**
 * True when a field of the delimited text is longer than a cell holds. The
 * engine's CSV reader would cut it to fit, and the next save would write
 * the shortened text over the file, so such a file is not opened.
 */
function hasOverlongField(text: string, delimiter: string): boolean {
  // No field can be longer than the text.
  if (text.length <= MAX_CELL_CHARS) return false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return scanCsv(body, { delimiter, maxCells: MAX_OPEN_CSV_CELLS }).some((record) => record.some((field) => field.text.length > MAX_CELL_CHARS));
}

/** Opens file bytes. Throws {@link SheetSessionError}; nothing is written. */
export async function loadWorkbook(bytes: Uint8Array, format: SheetFileFormat): Promise<LoadedWorkbook> {
  try {
    if (format === "xlsx") return { workbook: await openXlsx(bytes), csv: null };
    const text = new TextDecoder("utf-8").decode(bytes);
    const csv = sniffCsvShape(bytes, text, format);
    if (hasOverlongField(text, csv.delimiter)) throw new SheetSessionError("field_too_long");
    return { workbook: parseCsv(text, { delimiter: csv.delimiter, maxCells: MAX_OPEN_CSV_CELLS }), csv };
  } catch (error: unknown) {
    throw toSessionError(error);
  }
}

/** Writes the workbook in the given format. CSV and TSV hold the values of the first visible sheet. */
export async function serializeWorkbook(workbook: Workbook, format: SheetFileFormat, csv: CsvShape | null): Promise<Uint8Array> {
  if (format === "xlsx") return workbook.save();
  const shape = csv ?? defaultCsvShape(format);
  workbook.recalc();
  const sheets = workbook.listSheets();
  const sheet = sheets.find((entry) => entry.state === "visible") ?? sheets[0];
  if (sheet === undefined) throw new SheetSessionError("failed");
  let text = toCsv(workbook, sheet.id, { delimiter: shape.delimiter, lineEnding: shape.lineEnding });
  if (shape.finalNewline && text !== "" && !text.endsWith("\n")) text += shape.lineEnding;
  const body = new TextEncoder().encode(text);
  if (!shape.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}
