// Pure bounded transforms shared by the public website and Matrix Utilities.
const MAX = 100_000;
function boundedText(value) {
  if (typeof value !== "string" || value.length > MAX) throw new Error("Input must be a string of 100,000 characters or fewer.");
}

export function countText(input) {
  boundedText(input);
  const words = (input.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  return {
    words, characters: [...input].length,
    withoutWhitespace: [...input.replace(/\s/gu, "")].length,
    sentences: input.split(/[.!?]+/u).filter((part) => /[\p{L}\p{N}]/u.test(part)).length,
    lines: input.length ? input.split(/\r\n|\r|\n/u).length : 0,
    bytes: new TextEncoder().encode(input).length,
    readingMinutes: Math.ceil(words / 220),
  };
}

export function replaceText(input, search, replacement) {
  boundedText(input); boundedText(replacement);
  if (typeof search !== "string" || !search.length || search.length > MAX) throw new Error("Enter search text of 1 to 100,000 characters.");
  // Compute expansion before allocating; replacement tokens such as $& stay literal.
  let matches = 0, offset = 0;
  while ((offset = input.indexOf(search, offset)) !== -1) { matches++; offset += search.length; }
  if (input.length + matches * (replacement.length - search.length) > MAX) throw new Error("Result is too large to display.");
  return input.replaceAll(search, () => replacement);
}

export function jsonCsvTable(input) {
  boundedText(input);
  let value;
  try { value = JSON.parse(input); } catch { throw new Error("Enter valid JSON."); }
  if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Enter an array of 1 to 1,000 objects.");
  const keys = new Set();
  for (const row of value) for (const key of Object.keys(row)) {
    keys.add(key);
    if (keys.size > 100) throw new Error("Use 1 to 100 columns.");
  }
  if (!keys.size) throw new Error("Use 1 to 100 columns.");
  const headers = [...keys];
  const rows = value.map((row) => headers.map((key) => {
    const cell = Object.hasOwn(row, key) ? row[key] : null;
    return cell == null ? "" : typeof cell === "object" ? JSON.stringify(cell) : String(cell);
  }));
  return { headers, rows };
}

export function convertJsonCsv(input, options = {}) {
  const delimiter = options.delimiter ?? ",";
  if (![",", ";", "\t"].includes(delimiter)) throw new Error("Choose a supported CSV delimiter.");
  if (options.includeHeader !== undefined && typeof options.includeHeader !== "boolean") throw new Error("Choose whether to include headers.");
  const { headers, rows } = jsonCsvTable(input);
  const escape = (cell) => {
    // Prevent spreadsheet formula execution, including formulas in column headers.
    const text = /^[\s]*[=+\-@\t\r]/u.test(cell) ? `'${cell}` : cell;
    return text.includes(delimiter) || /["\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  let output = "", first = true;
  for (const row of options.includeHeader === false ? rows : [headers, ...rows]) {
    const line = row.map(escape).join(delimiter);
    if (output.length + (first ? 0 : 1) + line.length > MAX) throw new Error("Result is too large to display.");
    output += (first ? "" : "\n") + line;
    first = false;
  }
  return output;
}

/**
 * Render a fixed-size table window; exports retain the complete source table.
 * @param {string[][]} rows
 * @param {number} rowPage
 * @param {number} columnPage
 */
export function csvWindow(rows, rowPage = 0, columnPage = 0) {
  const rowPages = Math.max(1, Math.ceil(rows.length / 20));
  const columnCount = rows[0]?.length ?? 0;
  const columnPages = Math.max(1, Math.ceil(columnCount / 10));
  const clamp = (page, pages) => Number.isFinite(page) ? Math.max(0, Math.min(Math.floor(page), pages - 1)) : 0;
  rowPage = clamp(rowPage, rowPages);
  columnPage = clamp(columnPage, columnPages);
  const rowStart = rowPage * 20, columnStart = columnPage * 10;
  const rowEnd = Math.min(rowStart + 20, rows.length), columnEnd = Math.min(columnStart + 10, columnCount);
  const cells = rows.slice(rowStart, rowEnd).map((row, offset) => ({
    rowIndex: rowStart + offset,
    cells: row.slice(columnStart, columnEnd).map((value, columnOffset) => ({ columnIndex: columnStart + columnOffset, value })),
  }));
  return { cells, rowPage, columnPage, rowPages, columnPages, rowStart, rowEnd, columnStart, columnEnd, rowCount: rows.length, columnCount };
}
