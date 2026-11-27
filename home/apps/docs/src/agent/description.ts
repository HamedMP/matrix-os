/**
 * The document as the agent sees it: the engine description (`describeDocx`)
 * cut into one line per paragraph, with each paragraph's heading level and
 * the clause it belongs to, so prompts can be assembled from any subset of
 * paragraphs within a budget.
 */

import { MAX_DESCRIPTION_CHARS, describeDocx, paragraphFinalText } from "./engine";
import type { BlockId, DocxDocument } from "./engine";

export interface DescribedBlock {
  id: BlockId;
  /** The description line: `[id] (style) label text`. */
  line: string;
  /** 1 to 9 for a heading, 0 otherwise. */
  headingLevel: number;
  /** Position among the described paragraphs. */
  order: number;
  /** Order of the heading that starts this paragraph's clause, or -1 before the first heading. */
  clause: number;
}

export interface DocumentText {
  /** Outline lines (`[id] label heading`), body headings only. */
  outline: string[];
  blocks: DescribedBlock[];
  byId: Map<BlockId, DescribedBlock>;
  /** Length of all paragraph lines joined by line breaks. */
  contentLength: number;
}

const LINE_ID = /^\[([^\]\s]{1,128})\](?: |$)/;

/** Reads the whole body. Ids that the engine did not report as described are ignored. */
export function readDocument(doc: DocxDocument): DocumentText {
  const description = describeDocx(doc, { maxChars: MAX_DESCRIPTION_CHARS, includeOutline: true });
  const described = new Set(description.blockIds);
  const outline: string[] = [];
  const blocks: DescribedBlock[] = [];
  const byId = new Map<BlockId, DescribedBlock>();
  let section: "none" | "outline" | "content" = "none";
  let clause = -1;
  for (const line of description.text.split("\n")) {
    if (line === "# Outline") {
      section = "outline";
      continue;
    }
    if (line === "# Content") {
      section = "content";
      continue;
    }
    if (section === "outline") {
      outline.push(line);
      continue;
    }
    if (section !== "content") continue;
    const id = LINE_ID.exec(line)?.[1];
    if (id === undefined || !described.has(id) || byId.has(id)) continue;
    const block = doc.getBlock(id);
    const headingLevel = block?.type === "paragraph" ? block.style.headingLevel : 0;
    const order = blocks.length;
    if (headingLevel > 0) clause = order;
    const entry: DescribedBlock = { id, line, headingLevel, order, clause };
    blocks.push(entry);
    byId.set(id, entry);
  }
  const contentLength = blocks.reduce((sum, block) => sum + block.line.length + 1, 0);
  return { outline, blocks, byId, contentLength };
}

/** The paragraphs of the clause `block` belongs to: its heading and everything up to the next heading. */
export function clauseOf(text: DocumentText, block: DescribedBlock): DescribedBlock[] {
  if (block.clause < 0) return text.blocks.filter((entry) => entry.clause < 0);
  return text.blocks.filter((entry) => entry.clause === block.clause);
}

/**
 * The outline within a character budget. Headings that do not fit are
 * counted in a last line, as the engine does.
 */
export function boundedOutline(text: DocumentText, maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < text.outline.length; i++) {
    const line = text.outline[i] as string;
    if (line.startsWith("…")) continue;
    const rest = text.outline.length - i;
    const tail = rest > 1 ? `… ${rest} more headings`.length + 1 : 0;
    if (used + line.length + 1 + tail > maxChars) {
      lines.push(`… ${rest} more headings`);
      return lines.join("\n");
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** A paragraph's text as a description shows it: the `final` view on one line, without inline objects. */
export function blockText(doc: DocxDocument, blockId: BlockId): string | null {
  const block = doc.getBlock(blockId);
  if (block === null || block.type !== "paragraph") return null;
  return paragraphFinalText(block).text;
}
