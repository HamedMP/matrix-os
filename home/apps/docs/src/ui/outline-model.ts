/**
 * The outline pane's entries: headings (from the engine) and numbered
 * clauses (top-level paragraphs with a numbering label that is not a bullet).
 */

import type { BlockId, DocxBlock, DocxDocument, ParagraphBlock } from "../../../_shared/office-engine/index";
import { hiddenInView } from "./text-index";

export const MAX_OUTLINE_ENTRIES = 2_000;
const MAX_ENTRY_TEXT = 80;

export interface OutlineEntry {
  blockId: BlockId;
  /** 1 to 9. */
  level: number;
  /** Numbering label, for example `2.1`, or null. */
  label: string | null;
  text: string;
  kind: "heading" | "clause";
}

function finalText(block: ParagraphBlock): string {
  let text = "";
  for (const run of block.runs) {
    if (hiddenInView(run.revision?.kind, "final") || run.object !== null || run.footnoteRef !== null) continue;
    text += run.text;
  }
  return text.replace(/\s+/g, " ").trim();
}

function shorten(text: string): string {
  return text.length > MAX_ENTRY_TEXT ? `${text.slice(0, MAX_ENTRY_TEXT - 1)}…` : text;
}

function isClause(block: DocxBlock): block is ParagraphBlock {
  if (block.type !== "paragraph" || block.numbering === null) return false;
  const format = block.numbering.format;
  return format !== "bullet" && format !== "none" && block.numbering.text.trim() !== "";
}

export function buildOutline(doc: DocxDocument, limit = MAX_OUTLINE_ENTRIES): OutlineEntry[] {
  const headings = new Map(doc.getOutline().map((item) => [item.blockId, item]));
  const entries: OutlineEntry[] = [];
  for (const block of doc.getView().body.blocks) {
    if (entries.length === limit) break;
    const heading = headings.get(block.id);
    if (heading !== undefined) {
      entries.push({ blockId: block.id, level: heading.level, label: heading.numberingLabel, text: shorten(heading.text), kind: "heading" });
      continue;
    }
    if (!isClause(block)) continue;
    const text = finalText(block);
    if (text === "") continue;
    const level = Math.min(9, (block.numbering?.level ?? 0) + 1);
    entries.push({ blockId: block.id, level, label: block.numbering?.text ?? null, text: shorten(text), kind: "clause" });
  }
  return entries;
}

/** Each block id of the body (nested ones included) to the index of its top-level block. */
export function blockOrder(doc: DocxDocument): Map<BlockId, number> {
  const order = new Map<BlockId, number>();
  const visit = (block: DocxBlock, index: number): void => {
    order.set(block.id, index);
    if (block.type !== "table") return;
    for (const row of block.rows) for (const cell of row.cells) for (const inner of cell.blocks) visit(inner, index);
  };
  doc.getView().body.blocks.forEach((block, index) => visit(block, index));
  return order;
}

/** The block id of the last entry at or before a block, or null. */
export function currentOutlineEntry(entries: readonly OutlineEntry[], order: ReadonlyMap<BlockId, number>, blockId: BlockId | null): BlockId | null {
  if (blockId === null) return null;
  const at = order.get(blockId);
  if (at === undefined) return null;
  let current: BlockId | null = null;
  for (const entry of entries) {
    const index = order.get(entry.blockId);
    if (index === undefined) continue;
    if (index > at) break;
    current = entry.blockId;
  }
  return current;
}
