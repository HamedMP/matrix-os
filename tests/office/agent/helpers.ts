import { readFileSync } from "node:fs";
import path from "node:path";
import type { ApplyOptions, DocxDocument, ParagraphBlock, ProposalOptions, Workbook } from "../../../packages/office/src/index.js";
import { openDocx, openXlsx } from "../../../packages/office/src/index.js";

export const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

export const AGENT = "Matrix Agent";
export const DATE = "2026-11-23T10:00:00Z";
export const TRACKED: ApplyOptions = { track: true, author: AGENT, date: DATE };
export const PROPOSAL: ProposalOptions = { author: AGENT, date: DATE, label: "Agent edits" };

export function openDocxFixture(name: string): Promise<DocxDocument> {
  return openDocx(loadFixture(name));
}

export function openXlsxFixture(name: string): Promise<Workbook> {
  return openXlsx(loadFixture(name));
}

/** Top-level body paragraphs. */
export function bodyParagraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");
}

/** The body paragraph whose markup text starts with `prefix`. */
export function paragraphStarting(doc: DocxDocument, prefix: string): ParagraphBlock {
  const found = bodyParagraphs(doc).find((block) => block.text.startsWith(prefix));
  if (found === undefined) throw new Error(`no paragraph starts with ${JSON.stringify(prefix)}`);
  return found;
}

export function sheetId(workbook: Workbook, name: string): string {
  const sheet = workbook.getSheetByName(name);
  if (sheet === null) throw new Error(`no sheet ${name}`);
  return sheet.id;
}
