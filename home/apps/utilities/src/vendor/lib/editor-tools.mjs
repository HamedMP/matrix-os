import Papa from "papaparse";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MAX_ROWS = 1001;
const MAX_COLUMNS = 100;
const MAX_CELL = 10_000;

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) throw new Error("CSV is limited to a header and 1,000 rows.");
  const count = rows[0]?.length;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COLUMNS) throw new Error("CSV is limited to 1 to 100 columns.");
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== count) throw new Error("Each CSV row must have the same number of columns.");
    if (row.some((cell) => typeof cell !== "string" || cell.length > MAX_CELL)) throw new Error("Each CSV cell must be 10,000 characters or fewer.");
  }
  return rows;
}

export function parseEditableCsv(input) {
  if (typeof input !== "string" || input.length > 200_000) throw new Error("CSV input must be 200,000 characters or fewer.");
  const result = Papa.parse(input, { delimiter: ",", skipEmptyLines: "greedy", dynamicTyping: false });
  if (result.data.length > MAX_ROWS) throw new Error("CSV is limited to a header and 1,000 rows.");
  if (result.errors.length) throw new Error(`CSV could not be parsed${Number.isInteger(result.errors[0].row) ? ` at row ${result.errors[0].row + 1}` : ""}.`);
  return validateRows(result.data);
}

export function serializeEditableCsv(rows) {
  validateRows(rows);
  // Spreadsheet applications can execute cells beginning with these characters.
  const safe = rows.map((row) => row.map((cell) => /^[\s]*[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell));
  return Papa.unparse(safe, { newline: "\n", quotes: true, escapeFormulae: true });
}

export function textStats(value) {
  const words = value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  return { characters: [...value].length, words: words.length, lines: value.split(/\r\n|\n|\r/).length };
}

const safePdfText = (value) => String(value).replace(/[^\x20-\x7E]/g, "?");

export async function exportCsvPdf(rows) {
  validateRows(rows);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const columnsPerPage = 8, rowsPerPage = 34;
  const columnGroups = Math.ceil(rows[0].length / columnsPerPage);
  const rowGroups = Math.ceil(Math.max(1, rows.length - 1) / rowsPerPage);
  if (columnGroups * rowGroups > 200) throw new Error("This CSV would need more than 200 PDF pages. Use a smaller table.");
  for (let cg = 0; cg < columnGroups; cg++) for (let rg = 0; rg < rowGroups; rg++) {
    const page = pdf.addPage([842, 595]);
    const left = 30, top = 555, cellWidth = 97, rowHeight = 15;
    page.drawText(`CSV table - rows ${rg * rowsPerPage + 1}-${Math.min((rg + 1) * rowsPerPage, rows.length - 1)} - columns ${cg * columnsPerPage + 1}-${Math.min((cg + 1) * columnsPerPage, rows[0].length)}`, { x: left, y: top + 18, size: 9, font, color: rgb(.2, .3, .25) });
    const body = [rows[0], ...rows.slice(1 + rg * rowsPerPage, 1 + (rg + 1) * rowsPerPage)];
    body.forEach((row, ri) => row.slice(cg * columnsPerPage, (cg + 1) * columnsPerPage).forEach((cell, ci) => {
      const x = left + ci * cellWidth, y = top - ri * rowHeight;
      if (ri === 0) page.drawRectangle({ x, y: y - 3, width: cellWidth - 2, height: rowHeight, color: rgb(.9, .94, .9) });
      page.drawText(safePdfText(cell).slice(0, 22), { x: x + 3, y, size: 7, font: ri === 0 ? bold : font, color: rgb(.1, .2, .15) });
    }));
  }
  const bytes = new Uint8Array(await pdf.save());
  if (bytes.length > 50 * 1024 * 1024) throw new Error("PDF result is larger than 50 MB.");
  return { bytes, mime: "application/pdf", filename: "csv-table.pdf", notice: "Wide tables are split across pages. Cell text is shortened to fit, and non-Latin characters may display as question marks." };
}
