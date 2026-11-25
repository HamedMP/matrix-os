/**
 * Clipboard formats: tab-separated text and HTML tables, both ways.
 *
 * Copy writes both. The HTML carries each cell's formula in a
 * `data-sheets-formula` attribute, its stored value and type in
 * `data-sheets-value` and `data-sheets-type`, the position of the block in
 * `data-sheets-origin` and the sheet row of each table row in
 * `data-sheets-row` (rows a filter hid are left out of a copy), so that a paste into another Sheets window keeps
 * formulas, full precision and text that looks like a number; other programs
 * see an ordinary table. Paste prefers the HTML table and falls back to the
 * text.
 *
 * Pasted HTML is untrusted. It is parsed into an inert document and only the
 * text and the data attributes are read; nothing of it is put on the page.
 */

/** A stored value that can travel on the clipboard. */
export type ClipboardValue = number | string | boolean;

export interface ClipboardCell {
  /** What a reader sees: the display text. */
  text: string;
  /** Formula text without the leading `=`, or null. */
  formula?: string | null;
  /** The stored value, when it is a number, text or logical value. */
  value?: ClipboardValue | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** `#rrggbb` or null. */
  color?: string | null;
  background?: string | null;
  align?: "left" | "center" | "right" | null;
}

export interface ClipboardOrigin {
  /** Zero-based position of the first copied cell. */
  row: number;
  col: number;
}

export interface ParsedTable {
  /** Rows of typed text; a cell with a formula holds `=formula`. */
  rows: string[][];
  /** For each cell with a formula, its text without `=`; otherwise null. */
  formulas: Array<Array<string | null>>;
  /** Where the cells were copied from, when the HTML came from Sheets. */
  origin: ClipboardOrigin | null;
  /** The sheet row each table row was copied from, when the HTML gives it; null for a row that does not say. */
  sourceRows?: Array<number | null>;
  /** For each cell copied from Sheets without a formula, its stored value; otherwise undefined. */
  values?: Array<Array<ClipboardValue | undefined>>;
}

/** Most rows and columns read from a pasted table. */
export const MAX_PASTE_ROWS = 100_000;
export const MAX_PASTE_COLS = 2_000;
/** Most characters of clipboard text or HTML that are parsed. */
export const MAX_PASTE_CHARS = 20_000_000;

function tsvField(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as tab-separated text. Fields with tabs, line breaks or quotes are quoted. */
export function serializeTsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((row) => row.map(tsvField).join("\t")).join("\n");
}

/**
 * Reads tab-separated text as spreadsheets write it: quoted fields may hold
 * tabs and line breaks, `""` is a quote, any line ending is accepted and one
 * trailing line break is ignored.
 */
export function parseTsv(text: string): string[][] {
  const source = text.length > MAX_PASTE_CHARS ? text.slice(0, MAX_PASTE_CHARS) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const length = source.length;
  const endRow = (): void => {
    if (row.length < MAX_PASTE_COLS) row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };
  while (i < length) {
    const ch = source[i] as string;
    if (ch === '"' && field === "") {
      // A quoted field: read to the closing quote.
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < length) {
        const c = source[j] as string;
        if (c === '"') {
          if (source[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      const next = source[j];
      if (closed && (next === undefined || next === "\t" || next === "\n" || next === "\r")) {
        field = value;
        i = j;
        continue;
      }
      // Not a well-formed quoted field: the quote is ordinary text.
      field += ch;
      i++;
      continue;
    }
    if (ch === "\t") {
      if (row.length < MAX_PASTE_COLS) row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (rows.length >= MAX_PASTE_ROWS) return rows;
      endRow();
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const COLOR = /^#[0-9a-f]{6}$/i;

function cellStyle(cell: ClipboardCell): string {
  const parts: string[] = [];
  if (cell.bold === true) parts.push("font-weight:bold");
  if (cell.italic === true) parts.push("font-style:italic");
  if (cell.underline === true) parts.push("text-decoration:underline");
  if (typeof cell.color === "string" && COLOR.test(cell.color)) parts.push(`color:${cell.color}`);
  if (typeof cell.background === "string" && COLOR.test(cell.background)) parts.push(`background-color:${cell.background}`);
  if (cell.align === "left" || cell.align === "center" || cell.align === "right") parts.push(`text-align:${cell.align}`);
  return parts.join(";");
}

/**
 * Cells as an HTML table that other programs paste as a table. `sourceRows`
 * gives the sheet row of each table row, for a copy that left rows out.
 */
export function serializeHtmlTable(rows: ReadonlyArray<ReadonlyArray<ClipboardCell>>, origin?: ClipboardOrigin, sourceRows?: readonly number[]): string {
  const attr = origin === undefined ? "" : ` data-sheets-origin="${origin.row},${origin.col}"`;
  let html = `<meta charset="utf-8"><table${attr}><tbody>`;
  rows.forEach((row, index) => {
    const source = sourceRows?.[index];
    html += source === undefined ? "<tr>" : `<tr data-sheets-row="${source}">`;
    for (const cell of row) {
      const style = cellStyle(cell);
      const formula = typeof cell.formula === "string" ? ` data-sheets-formula="${escapeHtml(cell.formula)}"` : "";
      html += `<td${style === "" ? "" : ` style="${style}"`}${formula}${valueAttributes(cell)}>${escapeHtml(cell.text).replace(/\r?\n/g, "<br>")}</td>`;
    }
    html += "</tr>";
  });
  return `${html}</tbody></table>`;
}

function valueAttributes(cell: ClipboardCell): string {
  if (typeof cell.formula === "string") return "";
  const value = cell.value;
  if (typeof value === "number" && Number.isFinite(value)) return ` data-sheets-type="n" data-sheets-value="${String(value)}"`;
  if (typeof value === "boolean") return ` data-sheets-type="b" data-sheets-value="${value ? "true" : "false"}"`;
  if (typeof value === "string") return ` data-sheets-type="s" data-sheets-value="${escapeHtml(value)}"`;
  return "";
}

/** The typed value a Sheets cell carried, or undefined when it carried none or it does not read back. */
function readValue(cell: Element): ClipboardValue | undefined {
  const type = cell.getAttribute("data-sheets-type");
  const raw = cell.getAttribute("data-sheets-value");
  if (raw === null) return undefined;
  if (type === "s") return raw;
  if (type === "b") return raw === "true" ? true : raw === "false" ? false : undefined;
  if (type === "n") {
    const number = raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function cellText(cell: Element): string {
  let text = "";
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) text += child.nodeValue ?? "";
      else if (child.nodeType === 1) {
        const tag = (child as Element).tagName.toLowerCase();
        if (tag === "br") text += "\n";
        else if (tag !== "script" && tag !== "style") walk(child);
      }
    }
  };
  walk(cell);
  return text.replace(/ /g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function span(cell: Element, name: string, max: number): number {
  const value = Number(cell.getAttribute(name));
  return Number.isInteger(value) && value > 1 ? Math.min(value, max) : 1;
}

/**
 * Reads the first table of an HTML clipboard fragment. Cells spanning rows or
 * columns put their text in the first cell and leave the others empty.
 * Returns null when there is no table or no HTML parser.
 */
export function parseHtmlTable(html: string): ParsedTable | null {
  if (typeof DOMParser === "undefined" || html.length > MAX_PASTE_CHARS) return null;
  let document: Document;
  try {
    document = new DOMParser().parseFromString(html, "text/html");
  } catch (error: unknown) {
    console.warn("clipboard HTML could not be parsed", error instanceof Error ? error.name : "error");
    return null;
  }
  const table = document.querySelector("table");
  if (table === null) return null;
  const rows: string[][] = [];
  const formulas: Array<Array<string | null>> = [];
  const values: Array<Array<ClipboardValue | undefined>> = [];
  const sourceRows: Array<number | null> = [];
  let typed = false;
  /** Cells taken by a row span from a row above: column -> rows left. */
  const held = new Map<number, number>();
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    if (tr.closest("table") !== table) continue;
    if (rows.length >= MAX_PASTE_ROWS) break;
    const row: string[] = [];
    const rowFormulas: Array<string | null> = [];
    const rowValues: Array<ClipboardValue | undefined> = [];
    let col = 0;
    const skipHeld = (): void => {
      for (let left = held.get(col); left !== undefined && left > 0; left = held.get(col)) {
        if (left === 1) held.delete(col);
        else held.set(col, left - 1);
        row[col] = "";
        rowFormulas[col] = null;
        col++;
      }
    };
    for (const cell of Array.from(tr.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      skipHeld();
      if (col >= MAX_PASTE_COLS) break;
      const formula = cell.getAttribute("data-sheets-formula");
      const text = cellText(cell);
      const value = formula === null || formula === "" ? readValue(cell) : undefined;
      if (value !== undefined) typed = true;
      const colSpan = span(cell, "colspan", MAX_PASTE_COLS - col);
      const rowSpan = span(cell, "rowspan", MAX_PASTE_ROWS);
      for (let k = 0; k < colSpan; k++) {
        const first = k === 0;
        row[col] = first ? (formula !== null && formula !== "" ? `=${formula}` : text) : "";
        rowFormulas[col] = first && formula !== null && formula !== "" ? formula : null;
        rowValues[col] = first ? value : undefined;
        if (rowSpan > 1) held.set(col, rowSpan - 1);
        col++;
      }
    }
    skipHeld();
    const source = /^\d{1,7}$/.exec(tr.getAttribute("data-sheets-row") ?? "");
    sourceRows.push(source === null ? null : Number(source[0]));
    rows.push(row);
    formulas.push(rowFormulas);
    values.push(rowValues);
  }
  if (rows.length === 0) return null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as string[];
    const rowFormulas = formulas[r] as Array<string | null>;
    for (let c = 0; c < width; c++) {
      if (row[c] === undefined) row[c] = "";
      if (rowFormulas[c] === undefined) rowFormulas[c] = null;
    }
  }
  const match = /^(\d{1,7}),(\d{1,5})$/.exec(table.getAttribute("data-sheets-origin") ?? "");
  const origin = match === null ? null : { row: Number(match[1]), col: Number(match[2]) };
  const parsed: ParsedTable = typed ? { rows, formulas, origin, values } : { rows, formulas, origin };
  if (sourceRows.some((source) => source !== null)) parsed.sourceRows = sourceRows;
  return parsed;
}

/** What a paste should write, from whichever clipboard formats are present. */
export function readClipboard(data: { html?: string | null; text?: string | null }): ParsedTable | null {
  if (typeof data.html === "string" && data.html !== "") {
    const table = parseHtmlTable(data.html);
    if (table !== null) return table;
  }
  if (typeof data.text === "string" && data.text !== "") {
    const rows = parseTsv(data.text);
    if (rows.length === 0) return null;
    return { rows, formulas: rows.map((row) => row.map(() => null)), origin: null };
  }
  return null;
}
