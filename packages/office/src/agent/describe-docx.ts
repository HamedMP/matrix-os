/**
 * A `.docx` document as bounded text for a prompt. The format is described
 * on `DocxDescription` in `../api/agent.ts`.
 */

import type { DescribeDocx } from "../api/agent.js";
import type { BlockId, DocxDocument, DocxStory, OutlineItem, ParagraphBlock, TableBlock } from "../api/docx.js";
import type { XmlElement } from "../api/xml.js";
import { cellGoneInView, getDocxIndex, rowCells, rowGoneInView, tableRows } from "../docx/internal.js";
import { OfficeError, isOfficeError } from "../errors.js";
import { ELLIPSIS, MAX_DESCRIPTION_CHARS, OUTLINE_SHARE } from "./limits.js";
import {
  type FlatBlock,
  type TablePlace,
  type TableVisibility,
  flattenStories,
  isRemovedParagraph,
  paragraphFinalText,
  singleLine,
} from "./text.js";

const OUTLINE_HEADER = "# Outline";
const CONTENT_HEADER = "# Content";

function checkBudget(maxChars: unknown): number {
  if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_DESCRIPTION_CHARS) {
    throw new OfficeError("invalid_argument", `maxChars must be a whole number from 1 to ${MAX_DESCRIPTION_CHARS}`);
  }
  return maxChars;
}

function storyOf(document: DocxDocument, storyId: string | undefined): DocxStory {
  if (storyId === undefined) return document.getView().body;
  const story = document.getStory(storyId);
  if (story === null) throw new OfficeError("stale_reference", "unknown story id");
  return story;
}

/**
 * The rows and cells the `final` view keeps, read from the document itself:
 * a tracked cell has no mark in the view model, and a row that one author
 * inserted and another deleted shows only one. A handle of another engine
 * falls back to the row mark of the view model.
 */
function finalTables(document: DocxDocument): TableVisibility {
  let index;
  try {
    index = getDocxIndex(document);
  } catch (error) {
    if (!isOfficeError(error) || error.code !== "invalid_argument") throw error;
    return {
      rowGone: (table, rowIndex) => {
        const kind = table.rows[rowIndex]?.revision?.kind;
        return kind === "delete" || kind === "moveFrom";
      },
      cellGone: () => false,
    };
  }
  // The rows of the table being walked and the cells of each row, listed once: a table is asked about
  // each of its rows and cells in turn. Only the current table is kept, so the cache is bounded by it.
  let listed: { id: string; rows: readonly XmlElement[]; cells: Array<readonly XmlElement[] | undefined> } | null = null;
  const tableOf = (table: TableBlock) => {
    if (listed === null || listed.id !== table.id) {
      const record = index.block(table.id);
      listed = { id: table.id, rows: record === null || record.type !== "table" ? [] : tableRows(record.element), cells: [] };
    }
    return listed;
  };
  return {
    rowGone: (table, rowIndex) => {
      const row = tableOf(table).rows[rowIndex];
      return row !== undefined && rowGoneInView(row, "final");
    },
    cellGone: (table, rowIndex, cellIndex) => {
      const current = tableOf(table);
      const row = current.rows[rowIndex];
      if (row === undefined) return false;
      let cells = current.cells[rowIndex];
      if (cells === undefined) {
        cells = rowCells(row);
        current.cells[rowIndex] = cells;
      }
      const cell = cells[cellIndex];
      return cell !== undefined && cellGoneInView(cell, "final");
    },
  };
}

function placeMarker(place: TablePlace | null): string {
  return place === null ? "" : `(table row ${place.row}, cell ${place.cell}) `;
}

/** The line of one paragraph, without a line break. */
export function paragraphLine(block: ParagraphBlock, place: TablePlace | null): string {
  const style = block.style;
  const heading = style.headingLevel > 0 ? `(${singleLine(style.styleName ?? `Heading ${style.headingLevel}`)}) ` : "";
  const label = block.numbering === null || block.numbering.text === "" ? "" : `${singleLine(block.numbering.text)} `;
  return `[${block.id}] ${heading}${placeMarker(place)}${label}${paragraphFinalText(block).text}`;
}

function outlineLine(item: OutlineItem): string {
  const indent = "  ".repeat(Math.max(0, Math.min(8, item.level - 1)));
  const label = item.numberingLabel === null || item.numberingLabel === "" ? "" : `${singleLine(item.numberingLabel)} `;
  return `[${item.blockId}] ${indent}${label}${singleLine(item.text)}`;
}

/** The outline section within `budget` characters, or an empty string when not even its first heading fits. */
function outlineSection(items: readonly OutlineItem[], budget: number): string {
  let section = OUTLINE_HEADER;
  let listed = 0;
  for (const item of items) {
    const line = outlineLine(item);
    const rest = items.length - listed - 1;
    // Room is kept for the note that says how many headings were left out.
    const note = rest > 0 ? `\n${ELLIPSIS} ${rest} more headings` : "";
    if (section.length + 1 + line.length + note.length > budget) break;
    section += `\n${line}`;
    listed++;
  }
  if (listed === 0) return "";
  const left = items.length - listed;
  return left > 0 ? `${section}\n${ELLIPSIS} ${left} more headings` : section;
}

function paragraphsFrom(flat: readonly FlatBlock[], startBlockId: BlockId | undefined): FlatBlock[] {
  let from = 0;
  if (startBlockId !== undefined) {
    from = flat.findIndex((entry) => entry.block.id === startBlockId);
    if (from < 0) throw new OfficeError("stale_reference", "unknown block id");
  }
  const paragraphs: FlatBlock[] = [];
  for (let i = from; i < flat.length; i++) {
    const entry = flat[i] as FlatBlock;
    if (entry.block.type === "paragraph" && !isRemovedParagraph(entry.block)) paragraphs.push(entry);
  }
  return paragraphs;
}

export const describeDocx: DescribeDocx = (document, options) => {
  const maxChars = checkBudget(options?.maxChars);
  const story = storyOf(document, options.storyId);
  const paragraphs = paragraphsFrom(flattenStories([story], finalTables(document)), options.startBlockId);
  const wantOutline = options.includeOutline !== false && options.startBlockId === undefined && story.kind === "body";
  const outlineItems = wantOutline ? document.getOutline() : [];
  let text = outlineItems.length > 0 ? outlineSection(outlineItems, Math.floor(maxChars * OUTLINE_SHARE)) : "";
  const blockIds: BlockId[] = [];
  let nextBlockId: BlockId | null = null;

  const header = text === "" ? CONTENT_HEADER : `\n${CONTENT_HEADER}`;
  if (text.length + header.length > maxChars) {
    // No room for any content: only the outline, or nothing, is returned.
    const first = paragraphs[0];
    return { text: text.length <= maxChars ? text : "", truncated: first !== undefined, nextBlockId: first?.block.id ?? null, blockIds };
  }
  text += header;
  for (const entry of paragraphs) {
    const block = entry.block as ParagraphBlock;
    const line = paragraphLine(block, entry.place);
    if (text.length + 1 + line.length <= maxChars) {
      text += `\n${line}`;
      blockIds.push(block.id);
      continue;
    }
    if (blockIds.length === 0) {
      // A paragraph longer than the whole budget would stop every continuation: it alone is cut.
      const room = maxChars - text.length - 1 - ELLIPSIS.length;
      if (room > `[${block.id}] `.length) {
        text += `\n${cutLine(line, room)}${ELLIPSIS}`;
        blockIds.push(block.id);
        continue;
      }
    }
    nextBlockId = block.id;
    break;
  }
  return { text, truncated: nextBlockId !== null, nextBlockId, blockIds };
};

/** The first `length` characters of a line, without half of a surrogate pair at the end. */
function cutLine(line: string, length: number): string {
  const last = line.charCodeAt(length - 1);
  return line.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}
