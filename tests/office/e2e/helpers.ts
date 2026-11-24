/**
 * Helpers of the end-to-end tests. Everything here goes through the public
 * API of the engine (`packages/office/src/index.ts`), as an app or the
 * gateway uses it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { ApplyOptions, CellValue, DocxDocument, ParagraphBlock, ProposalOptions, Workbook } from "../../../packages/office/src/index.js";
import { opc, parseA1 } from "../../../packages/office/src/index.js";

export const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");

export const OWNER = "Rae Okafor";
export const AGENT = "Matrix Agent";
export const DATE = "2026-11-23T10:00:00Z";
export const AGENT_TRACKED: ApplyOptions = { track: true, author: AGENT, date: DATE };
export const AGENT_PROPOSAL: ProposalOptions = { author: AGENT, date: DATE, label: "Agent review" };

export const DOCX_FIXTURES = [
  "basic.docx",
  "numbering.docx",
  "table.docx",
  "comments.docx",
  "footnotes-headers.docx",
  "tracked.docx",
  "links-fields.docx",
  "contract.docx",
  "contract-v2.docx",
  "unicode.docx",
];
export const XLSX_FIXTURES = ["basic.xlsx", "formulas.xlsx", "formats.xlsx", "multi-sheet.xlsx", "model.xlsx"];

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export function expectedText(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, "expected", name), "utf8");
}

export function expectedJson<T>(name: string): T {
  return JSON.parse(expectedText(name)) as T;
}

/**
 * Keeps a file a flow produced, for checking with independent readers
 * (`tests/office/tools`). Only when `OFFICE_E2E_OUT` names a directory: a
 * normal test run writes nothing.
 */
export function keepOutput(name: string, bytes: Uint8Array): void {
  const directory = process.env.OFFICE_E2E_OUT;
  if (directory === undefined || directory === "") return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), bytes);
}

/** Every part of a package by name, with its content type and bytes. */
export async function readParts(bytes: Uint8Array): Promise<Map<string, { contentType: string | null; bytes: Uint8Array }>> {
  const pkg = await opc.openPackage(bytes);
  const parts = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  for (const part of pkg.listParts({ includeRelationships: true })) {
    parts.set(part.name, { contentType: pkg.getContentType(part.name), bytes: await pkg.getPartBytes(part.name) });
  }
  return parts;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The names of the parts whose bytes or content type differ between two packages, added and removed parts included. */
export async function changedParts(before: Uint8Array, after: Uint8Array): Promise<string[]> {
  const a = await readParts(before);
  const b = await readParts(after);
  const changed: string[] = [];
  for (const [name, part] of a) {
    const other = b.get(name);
    if (other === undefined || other.contentType !== part.contentType || !sameBytes(part.bytes, other.bytes)) changed.push(name);
  }
  for (const name of b.keys()) if (!a.has(name)) changed.push(name);
  return changed.sort();
}

/** The body paragraph whose markup text starts with `prefix`. */
export function paragraphStarting(doc: DocxDocument, prefix: string): ParagraphBlock {
  for (const block of doc.getView().body.blocks) {
    if (block.type === "paragraph" && block.text.startsWith(prefix)) return block;
  }
  throw new Error(`no paragraph starts with ${JSON.stringify(prefix)}`);
}

export function sheetId(workbook: Workbook, name: string): string {
  const sheet = workbook.getSheetByName(name);
  if (sheet === null) throw new Error(`no sheet ${name}`);
  return sheet.id;
}

export function valueAt(workbook: Workbook, sheet: string, a1: string): CellValue {
  return workbook.getCell(sheetId(workbook, sheet), parseA1(a1)).value;
}

/** Asserts two cell values are the same, allowing the last bits of a number to differ. */
export function expectSameValue(actual: CellValue, expected: CellValue, where: string): void {
  if (typeof actual === "number" && typeof expected === "number") {
    expect(Math.abs(actual - expected), where).toBeLessThanOrEqual(Math.abs(expected) * 1e-9 + 1e-9);
  } else {
    expect(actual, where).toEqual(expected);
  }
}
