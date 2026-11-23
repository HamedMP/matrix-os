/**
 * Rows for bulk drafts: a table pasted as text (tab-, comma- or
 * semicolon-separated, first line is the header) or a sheet range handed in
 * as rows. Every cell is untrusted text; nothing here interprets it beyond
 * finding the column with email addresses.
 */
import { isValidMailAddress, normalizeMailAddress } from "../../../_shared/office-accounts/types/mail";
import { MAX_BULK_CELL_CHARS, MAX_BULK_COLUMNS, MAX_BULK_ROWS } from "./limits";
import { stripControlChars } from "./untrusted";

export interface BulkTable {
  columns: string[];
  rows: Array<Record<string, string>>;
  /** True when more than `MAX_BULK_ROWS` data rows were given; only the first ones are kept. */
  overLimit: boolean;
}

const MAX_TEXT_CHARS = 2_000_000;

function cell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return stripControlChars(text).replace(/\s+/g, " ").trim().slice(0, MAX_BULK_CELL_CHARS);
}

function delimiterOf(header: string): string {
  if (header.includes("\t")) return "\t";
  const commas = (header.match(/,/g) ?? []).length;
  const semicolons = (header.match(/;/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

/** Splits delimited text into records, honouring double-quoted fields with doubled quotes. */
function splitRecords(text: string, delimiter: string, maxRecords: number): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      if (record.some((value) => value.trim())) records.push(record);
      if (records.length >= maxRecords) return records;
      record = [];
      field = "";
    } else field += char;
  }
  record.push(field);
  if (record.some((value) => value.trim())) records.push(record);
  return records.slice(0, maxRecords);
}

/** Unique, non-empty header names; blanks become "Column N". */
function headerNames(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  return raw.slice(0, MAX_BULK_COLUMNS).map((value, i) => {
    let name = cell(value).slice(0, 80) || `Column ${i + 1}`;
    let n = 2;
    while (seen.has(name.toLowerCase())) name = `${cell(value).slice(0, 76) || `Column ${i + 1}`} ${n++}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/** A sheet range as rows of cell values; the first row is the header. */
export function tableFromRows(rows: readonly (readonly unknown[])[]): BulkTable {
  if (!rows.length) return { columns: [], rows: [], overLimit: false };
  const columns = headerNames(rows[0]);
  const data = rows.slice(1).filter((row) => row.some((value) => cell(value)));
  return {
    columns,
    rows: data.slice(0, MAX_BULK_ROWS).map((row) => Object.fromEntries(columns.map((column, i) => [column, cell(row[i])]))),
    overLimit: data.length > MAX_BULK_ROWS,
  };
}

/** A pasted table. */
export function parseTable(text: string): BulkTable {
  const source = text.slice(0, MAX_TEXT_CHARS).replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/).find((line) => line.trim()) ?? "";
  if (!firstLine) return { columns: [], rows: [], overLimit: false };
  return tableFromRows(splitRecords(source, delimiterOf(firstLine), MAX_BULK_ROWS + 2));
}

const EMAIL_HEADER = /^(e-?mail|email address|mail|address|recipient|to)$/i;

/** The column holding recipients: a named email column, else the first column that is mostly addresses. */
export function recipientColumn(table: BulkTable): string | null {
  const share = (column: string) => {
    const values = table.rows.map((row) => row[column]).filter(Boolean);
    return values.length ? values.filter((value) => isValidMailAddress(normalizeMailAddress(value))).length / values.length : 0;
  };
  const named = table.columns.find((column) => EMAIL_HEADER.test(column.trim()) && share(column) > 0);
  if (named) return named;
  return table.columns.find((column) => share(column) >= 0.5) ?? null;
}

/** The recipient address of a row, or null when the cell is not one valid address. */
export function rowRecipient(row: Record<string, string>, column: string | null): string | null {
  if (!column) return null;
  const value = normalizeMailAddress(row[column] ?? "");
  return isValidMailAddress(value) ? value : null;
}
