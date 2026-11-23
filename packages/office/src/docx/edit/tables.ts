/** `insertTableRow`, `deleteTableRow` and `setCellText`. */

import type { TextPosition } from "../../api/docx-model.js";
import type { ReplaceGranularity } from "../../api/docx-ops.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, insertAfter, insertBefore } from "../../xml/index.js";
import type { BlockRecord } from "../internal.js";
import { resolvePosition, rowCells, rowRevisionElement, tableRows } from "../internal.js";
import { type EditContext, resolveRange, touch } from "./context.js";
import { deleteRange } from "./delete.js";
import { firstPositionIn, removeBlock } from "./marks.js";
import { replaceWhole, replaceWords } from "./replace.js";
import { buildRow, deleteRow, deleteRowsOf } from "./rows.js";

function requireIndex(value: unknown, what: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new OfficeError("invalid_argument", `${what} must be an integer`);
  }
}

function outOfRange(what: string, value: number, count: number): OfficeError {
  return new OfficeError("invalid_operation", `${what} is out of range`, { details: { index: value, count } });
}

/** Implements `insertTableRow`. Returns the paragraphs of the new cells. */
export function insertTableRow(
  context: EditContext,
  table: BlockRecord,
  rowIndex: unknown,
  cells: readonly string[],
): XmlElement[] {
  requireIndex(rowIndex, "rowIndex");
  const rows = tableRows(table.element);
  if (rowIndex < 0 || rowIndex > rows.length) throw outOfRange("rowIndex", rowIndex, rows.length);
  const template = rows[rowIndex - 1] ?? rows[0];
  if (template === undefined) throw new OfficeError("invalid_operation", "the table has no row to copy");
  if (cells.length > rowCells(template).length) {
    throw new OfficeError("invalid_operation", "more cell texts than the row has cells", {
      details: { given: cells.length, cells: rowCells(template).length },
    });
  }
  const below = rowIndex === 0 ? null : (rows[rowIndex] ?? null);
  const built = buildRow(context, template, below, cells);
  const following = rows[rowIndex];
  if (following !== undefined) insertBefore(following, built.row);
  else if (rows.length > 0) insertAfter(rows[rows.length - 1] as XmlElement, built.row);
  else appendChild(table.element, built.row);
  context.createdElements.push(...built.paragraphs);
  context.touched.add(table.element);
  context.index.markDirty(built.row);
  return built.paragraphs;
}

/** Implements `deleteTableRow`. Returns the row element when it is still in the table. */
export function deleteTableRow(context: EditContext, table: BlockRecord, rowIndex: unknown): TextPosition | null {
  requireIndex(rowIndex, "rowIndex");
  const { index } = context;
  const rows = tableRows(table.element);
  const row = rows[rowIndex];
  if (rowIndex < 0 || row === undefined) throw outOfRange("rowIndex", rowIndex, rows.length);
  // Rows that are already on their way out do not count: the table must keep a row either way.
  const staying = rows.filter((entry) => entry !== row && (!context.track || rowRevisionElement(entry)?.name !== "w:del"));
  if (staying.length === 0) {
    throw new OfficeError("invalid_operation", "the last row of a table cannot be deleted", {
      details: { tableId: table.id },
    });
  }
  let caret: TextPosition | null = null;
  for (const cell of rowCells(row)) {
    for (const block of index.blocksIn(cell)) caret ??= firstPositionIn(index, block);
  }
  const pin = context.tracker.pin(caret);
  deleteRow(context, table, row);
  const moved = context.tracker.read(pin);
  context.tracker.truncate(pin);
  return moved;
}

/** Implements `setCellText`. Returns the position after the new text. */
export function setCellText(
  context: EditContext,
  table: BlockRecord,
  rowIndex: unknown,
  cellIndex: unknown,
  text: string,
  granularity: ReplaceGranularity,
): TextPosition {
  requireIndex(rowIndex, "rowIndex");
  requireIndex(cellIndex, "cellIndex");
  const { index } = context;
  const rows = tableRows(table.element);
  const row = rows[rowIndex];
  if (rowIndex < 0 || row === undefined) throw outOfRange("rowIndex", rowIndex, rows.length);
  const cells = rowCells(row);
  const cell = cells[cellIndex];
  if (cellIndex < 0 || cell === undefined) throw outOfRange("cellIndex", cellIndex, cells.length);
  const blocks = index.blocksIn(cell).filter((record) => record.type !== "sectionBreak");
  const target = blocks.find((record) => record.type === "paragraph");
  if (target === undefined) throw new OfficeError("invalid_operation", "the cell has no paragraph");
  const paragraph = target.element;

  // Everything behind the first paragraph goes: one deletion to the end of the last paragraph of the cell.
  const last = blocks[blocks.length - 1] as BlockRecord;
  if (last.id !== target.id && last.type === "paragraph") {
    deleteRange(
      context,
      resolveRange(context, {
        start: { blockId: target.id, offset: index.scan(paragraph).text.length },
        end: { blockId: last.id, offset: index.scan(last.element).text.length },
      }),
    );
  }
  // Tables around it, where a deletion across paragraphs could not reach them.
  for (const element of blocks.filter((record) => record.type === "table").map((record) => record.element)) {
    const record = index.blockOf(element);
    if (record === null) continue;
    if (context.track) deleteRowsOf(context, record);
    else removeBlock(index, record, context.tracker);
  }
  // The first paragraph can have given way to the one behind it (an empty pending insertion of this author).
  const current = index.blockOf(paragraph) ?? index.blocksIn(cell).find((record) => record.type === "paragraph") ?? null;
  if (current === null) throw new OfficeError("invalid_operation", "the cell has no paragraph left");
  const whole = resolveRange(context, {
    start: { blockId: current.id, offset: 0 },
    end: { blockId: current.id, offset: resolvePosition(index, { blockId: current.id, offset: 0 }).scan.text.length },
  });
  touch(context, current.element);
  return granularity === "whole" ? replaceWhole(context, whole, text, undefined) : replaceWords(context, whole, text, undefined);
}
