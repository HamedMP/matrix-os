import type { ApplyOptions, DocxDocument, ParagraphBlock, TextPosition } from "../../../../packages/office/src/api/docx.js";
import { applyOps } from "../../../../packages/office/src/docx/edit/index.js";
import {
  documentFromPackage,
  getDocxIndex,
  openDocxWith,
  viewToMarkupOffset,
} from "../../../../packages/office/src/docx/internal.js";
import { acceptRevisions, rejectRevisions } from "../../../../packages/office/src/docx/revisions/index.js";
import { findAll, serializeXml } from "../../../../packages/office/src/xml/index.js";
import { type DocxParts, buildPackage } from "../model/build.js";
import { loadFixture } from "../model/helpers.js";

/** The engines under test, wired the way `docx/index.ts` wires them. */
export const ENGINES = { applyOps, acceptRevisions, rejectRevisions };

export const RAE = "Rae Okafor";
export const DATE = "2026-11-23T10:00:00Z";

export const TRACKED: ApplyOptions = { track: true, author: RAE, date: DATE };
export const DIRECT: ApplyOptions = { track: false, author: RAE, date: DATE };

export function build(parts: DocxParts): DocxDocument {
  const { pkg, texts } = buildPackage(parts);
  return documentFromPackage(pkg, texts, ENGINES);
}

export function open(bytes: Uint8Array): Promise<DocxDocument> {
  return openDocxWith(ENGINES, bytes);
}

export function openFixture(name: string): Promise<DocxDocument> {
  return open(loadFixture(name));
}

export async function reopen(doc: DocxDocument): Promise<DocxDocument> {
  return open(await doc.save());
}

/** Top-level body paragraphs. */
export function paragraphs(doc: DocxDocument): ParagraphBlock[] {
  return doc.getView().body.blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");
}

export function paragraphStarting(doc: DocxDocument, prefix: string): ParagraphBlock {
  const found = paragraphs(doc).find((block) => block.text.startsWith(prefix));
  if (found === undefined) throw new Error(`no paragraph starts with ${JSON.stringify(prefix)}`);
  return found;
}

/** The serialised children of `w:body`, one string per top-level node. */
export function bodyXml(doc: DocxDocument): string[] {
  const body = getDocxIndex(doc).store.main().doc.root.children.find((node) => node.kind === "element" && node.name === "w:body");
  if (body === undefined || body.kind !== "element") throw new Error("no body");
  return body.children.filter((node) => node.kind === "element").map((node) => (node.kind === "element" ? serializeXml(node) : ""));
}

/** The serialised main document part. */
export function documentXml(doc: DocxDocument): string {
  return serializeXml(getDocxIndex(doc).store.main().doc);
}

/** The XML of one block. */
export function blockXml(doc: DocxDocument, blockId: string): string {
  const record = getDocxIndex(doc).block(blockId);
  if (record === null) throw new Error(`no block ${blockId}`);
  return serializeXml(record.element);
}

/** Text of the body in a view. */
export function text(doc: DocxDocument, view: "final" | "original" | "markup" = "final"): string {
  return doc.getPlainText({ view });
}

/** A position given as an offset in the `final` text of a paragraph. */
export function finalPosition(doc: DocxDocument, blockId: string, offset: number, bias: "before" | "after" = "before"): TextPosition {
  const scan = getDocxIndex(doc).scan(blockId);
  return { blockId, offset: viewToMarkupOffset(scan, "final", offset, bias) };
}

/** Every `w:id` of a tracked-change element in the main part. */
export function revisionXmlIds(doc: DocxDocument): string[] {
  const root = getDocxIndex(doc).store.main().doc.root;
  const ids: string[] = [];
  for (const name of ["w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPrChange", "w:pPrChange", "w:trPrChange", "w:tcPrChange"]) {
    for (const element of findAll(root, name)) {
      const id = element.attrs.find((entry) => entry.name === "w:id")?.value;
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

/** A small deterministic generator (mulberry32). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
