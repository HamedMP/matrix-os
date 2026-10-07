export const MAX_IMPORT_PREVIEW_BYTES = 512 * 1024;
const MAX_ROWS = 100;
const MAX_COLUMNS = 64;
const MAX_CELL_BYTES = 2048;
const encoder = new TextEncoder();

export type SelectedImportPreview =
  | { kind: "table"; columns: string[]; rows: string[][]; truncated: boolean }
  | { kind: "pgn"; tags: Record<string, string>; moves: string; result: "1-0" | "0-1" | "1/2-1/2" };

export class ImportPreviewError extends Error {
  constructor() { super("Import preview unavailable."); this.name = "ImportPreviewError"; }
}

function invalid(): never { throw new ImportPreviewError(); }

/** Preview only: no interpretation, model calls, scripts, spreadsheet formulas or chess engine. */
export function parseSelectedImportPreview(name: string, source: string): SelectedImportPreview {
  if (source.length > MAX_IMPORT_PREVIEW_BYTES || source.includes("\0")
    || encoder.encode(source).byteLength > MAX_IMPORT_PREVIEW_BYTES) invalid();
  const ext = name.split(".").at(-1)?.toLowerCase();
  if (ext === "csv" || ext === "tsv") return tablePreview(source.replace(/^\ufeff/, ""), ext === "tsv" ? "\t" : ",");
  if (ext === "pgn") return gamePreview(source.replace(/^\ufeff/, ""));
  return invalid();
}

function tablePreview(source: string, delimiter: string): SelectedImportPreview {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const finishCell = () => {
    if (row.length >= MAX_COLUMNS || encoder.encode(cell).byteLength > MAX_CELL_BYTES) invalid();
    row.push(cell);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    if (row.some(value => value !== "")) records.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === delimiter) finishCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      finishRow();
      if (records.length > MAX_ROWS + 1) break;
    } else if (char === '"') {
      if (cell.length > 0 || closed) invalid();
      quoted = true;
    } else {
      if (closed) {
        if (char === " " || char === "\t") continue;
        invalid();
      }
      cell += char;
    }
    if (cell.length > MAX_CELL_BYTES) invalid();
  }
  if (quoted) invalid();
  if (cell.length > 0 || row.length > 0 || closed) finishRow();
  const columns = records.shift();
  if (!columns || columns.length === 0) invalid();
  if (records.some(record => record.length !== columns.length)) invalid();
  return { kind: "table", columns, rows: records.slice(0, MAX_ROWS), truncated: records.length > MAX_ROWS };
}

function gamePreview(source: string): SelectedImportPreview {
  const entries: [string, string][] = [];
  const lines = source.trim().split(/\r?\n/u);
  let start = 0;
  for (; start < lines.length; start += 1) {
    const line = lines[start]!.trim();
    if (line === "") continue;
    if (!line.startsWith("[")) break;
    if (entries.length >= 32 || line.length > 4096) invalid();
    const tag = /^\[([A-Za-z][A-Za-z0-9_]{0,31})\s+"((?:\\["\\]|[^"\\]){0,512})"\]$/u.exec(line);
    if (!tag || entries.some(([key]) => key === tag[1])) invalid();
    entries.push([tag[1]!, tag[2]!.replace(/\\(["\\])/gu, "$1")]);
  }
  const moves = lines.slice(start).join("\n").trim();
  if (moves.length === 0 || moves.length > 32 * 1024 || /^\[/mu.test(moves)) invalid();
  const terminal = /(?:^|\s)(1-0|0-1|1\/2-1\/2)$/u.exec(moves)?.[1];
  if (terminal !== "1-0" && terminal !== "0-1" && terminal !== "1/2-1/2") invalid();
  const tags = Object.fromEntries(entries);
  if (tags.Result && tags.Result !== terminal) invalid();
  return { kind: "pgn", tags, moves, result: terminal };
}

/** Same read-only summary on every file surface; source files are never rewritten. */
export function selectedImportPreviewText(name: string, source: string): string | null {
  if (!/\.(csv|tsv|pgn)$/iu.test(name)) return null;
  try {
    const preview = parseSelectedImportPreview(name, source);
    if (preview.kind === "pgn") return [
      `Completed game · ${preview.result}`,
      ...Object.entries(preview.tags).map(([key, value]) => `${key}: ${value}`),
      "", preview.moves,
    ].join("\n");
    return [
      `Table preview · ${preview.rows.length} ${preview.rows.length === 1 ? "row" : "rows"}${preview.truncated ? " (first 100)" : ""}`,
      preview.columns.join(" | "),
      ...preview.rows.map(row => row.join(" | ")),
    ].join("\n");
  } catch (error) {
    if (!(error instanceof ImportPreviewError)) throw error;
    return "Import preview unavailable. The original file is unchanged.";
  }
}
