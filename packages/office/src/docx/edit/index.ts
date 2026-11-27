/**
 * The engine behind `DocxDocument.applyOps`: every edit operation of
 * `../../api/docx-ops.ts`, applied directly or recorded as native tracked
 * revisions.
 *
 * All or nothing: the document is restored to its state before the call
 * when an operation throws.
 */

import type { BlockId, RevisionId, TextPosition } from "../../api/docx-model.js";
import type { ApplyOptions, ApplyResult, DocxOp, DocxOpResult } from "../../api/docx-ops.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { addComment, replyComment, requireCommentText, resolveComment } from "../comments/index.js";
import type { DocxEngines, DocxIndex } from "../internal.js";
import { beginChanges } from "./changes.js";
import { type EditContext, createContext, resolveAt, resolveRange } from "./context.js";
import { deleteRange } from "./delete.js";
import { setParagraphStyle, setRunFormat } from "./formatting.js";
import { insertTextAt } from "./insert.js";
import { firstPositionIn } from "./marks.js";
import { requireParagraphPatch } from "./paragraph-style.js";
import { deleteParagraph, insertParagraph, splitParagraph } from "./paragraphs.js";
import { replaceWhole, replaceWords } from "./replace.js";
import { requireRunFormat } from "./run-format.js";
import { deleteTableRow, insertTableRow, setCellText } from "./tables.js";
import { requireInsertableText } from "./text.js";
import { isAttached } from "./xml-util.js";

/** Most operations one call may carry. */
export const MAX_OPS_PER_CALL = 10_000;
/** Most positions one call may carry through. */
export const MAX_TRACKED_POSITIONS = 10_000;

interface Outcome {
  caret: TextPosition | null;
  commentId: string | null;
}

function invalid(message: string): OfficeError {
  return new OfficeError("invalid_argument", message);
}

function requireGranularity(value: unknown): asserts value is "whole" | "words" | undefined {
  if (value !== undefined && value !== "whole" && value !== "words") throw invalid("granularity must be whole or words");
}

function startOf(context: EditContext, element: XmlElement): TextPosition | null {
  const record = context.index.blockOf(element);
  return record === null ? null : firstPositionIn(context.index, record);
}

function applyOne(context: EditContext, op: DocxOp): Outcome {
  const { index, tracker } = context;
  const outcome: Outcome = { caret: null, commentId: null };
  switch (op.type) {
    case "insertText": {
      requireInsertableText(op.text);
      if (op.format !== undefined) requireRunFormat(op.format);
      outcome.caret = insertTextAt(context, resolveAt(context, op.at), op.text, { format: op.format });
      break;
    }
    case "deleteRange": {
      const range = resolveRange(context, op.range);
      const pin = tracker.pin({ blockId: range.start.record.id, offset: range.start.offset });
      deleteRange(context, range);
      outcome.caret = tracker.read(pin);
      tracker.truncate(pin);
      break;
    }
    case "replaceRange": {
      requireInsertableText(op.text);
      if (op.format !== undefined) requireRunFormat(op.format);
      requireGranularity(op.granularity);
      const range = resolveRange(context, op.range);
      outcome.caret =
        op.granularity === "words"
          ? replaceWords(context, range, op.text, op.format)
          : replaceWhole(context, range, op.text, op.format);
      break;
    }
    case "insertParagraphAfter":
    case "insertParagraphBefore": {
      const text = op.text ?? "";
      requireInsertableText(text);
      if (op.style !== undefined) requireParagraphPatch(op.style);
      const reference = index.requireBlock(op.blockId);
      const created = insertParagraph(context, reference, op.type === "insertParagraphAfter", text, op.style);
      outcome.caret = startOf(context, created);
      break;
    }
    case "splitParagraph": {
      const created = splitParagraph(context, resolveAt(context, op.at));
      outcome.caret = startOf(context, created);
      break;
    }
    case "deleteParagraph": {
      const record = index.requireBlock(op.blockId, "paragraph");
      const pin = tracker.pin({ blockId: record.id, offset: 0 });
      deleteParagraph(context, record);
      outcome.caret = tracker.read(pin);
      tracker.truncate(pin);
      break;
    }
    case "setRunFormat": {
      requireRunFormat(op.format);
      setRunFormat(context, resolveRange(context, op.range), op.format);
      break;
    }
    case "setParagraphStyle": {
      requireParagraphPatch(op.style);
      setParagraphStyle(context, index.requireBlock(op.blockId, "paragraph"), op.style);
      break;
    }
    case "insertTableRow": {
      const cells = op.cells ?? [];
      if (!Array.isArray(cells)) throw invalid("cells must be an array");
      cells.forEach((cell, at) => requireInsertableText(cell, `cells[${at}]`));
      const paragraphs = insertTableRow(context, index.requireBlock(op.tableId, "table"), op.rowIndex, cells);
      const first = paragraphs[0];
      outcome.caret = first === undefined ? null : startOf(context, first);
      break;
    }
    case "deleteTableRow": {
      outcome.caret = deleteTableRow(context, index.requireBlock(op.tableId, "table"), op.rowIndex);
      break;
    }
    case "setCellText": {
      requireInsertableText(op.text);
      requireGranularity(op.granularity);
      const table = index.requireBlock(op.tableId, "table");
      outcome.caret = setCellText(context, table, op.rowIndex, op.cellIndex, op.text, op.granularity ?? "words");
      break;
    }
    case "addComment": {
      requireCommentText(op.text);
      outcome.commentId = addComment(context, resolveRange(context, op.range), op.text);
      break;
    }
    case "replyComment": {
      requireCommentText(op.text);
      outcome.commentId = replyComment(context, op.commentId, op.text);
      break;
    }
    case "resolveComment": {
      if (op.resolved !== undefined && typeof op.resolved !== "boolean") throw invalid("resolved must be a boolean");
      resolveComment(context, op.commentId, op.resolved ?? true);
      break;
    }
    default:
      throw invalid("unknown operation type");
  }
  return outcome;
}

function initialsOf(author: string): string {
  const letters = author
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => String.fromCodePoint(word.codePointAt(0) as number).toUpperCase());
  return letters.slice(0, 4).join("");
}

function readOptions(options: ApplyOptions): { track: boolean; author: string; date: string; initials: string } {
  if (options === null || typeof options !== "object") throw invalid("options must be an object");
  if (typeof options.track !== "boolean") throw invalid("options.track must be a boolean");
  if (typeof options.author !== "string" || options.author.length > 255 || /[\u0000-\u001f]/.test(options.author)) {
    throw invalid("options.author must be a name");
  }
  if (typeof options.date !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(options.date)) {
    throw invalid("options.date must be an ISO 8601 timestamp");
  }
  if (options.initials !== undefined && (typeof options.initials !== "string" || options.initials.length > 32)) {
    throw invalid("options.initials must be a short string");
  }
  if (options.positions !== undefined && (!Array.isArray(options.positions) || options.positions.length > MAX_TRACKED_POSITIONS)) {
    throw invalid("options.positions must be an array of positions");
  }
  return {
    track: options.track,
    author: options.author,
    date: options.date,
    initials: options.initials ?? initialsOf(options.author),
  };
}

/** A caller's position as the tracker follows it: null when it does not name a place in the document. */
function carried(index: DocxIndex, position: unknown): TextPosition | null {
  const value = position as Partial<TextPosition> | null;
  if (value === null || typeof value !== "object" || typeof value.blockId !== "string") return null;
  const record = index.block(value.blockId);
  if (record === null || record.type !== "paragraph" || typeof value.offset !== "number" || !Number.isInteger(value.offset)) {
    return null;
  }
  const length = index.scan(record.element).text.length;
  return { blockId: record.id, offset: Math.min(length, Math.max(0, value.offset)) };
}

export const applyOps: NonNullable<DocxEngines["applyOps"]> = (index, ops, options) => {
  if (!Array.isArray(ops)) throw invalid("ops must be an array");
  if (ops.length > MAX_OPS_PER_CALL) throw new OfficeError("limit_exceeded", "too many operations in one call");
  const context = createContext(index, readOptions(options));
  const snapshot = index.snapshot();
  const recorder = beginChanges(index);
  const callerPins = (options.positions ?? []).map((position) => context.tracker.pin(carried(index, position)));
  const perOp: Array<{ outcome: Outcome; revisions: XmlElement[]; created: XmlElement[] }> = [];
  try {
    for (const op of ops as readonly DocxOp[]) {
      if (op === null || typeof op !== "object") throw invalid("an operation must be an object");
      context.revisionElements = [];
      context.createdElements = [];
      const outcome = applyOne(context, op);
      perOp.push({ outcome, revisions: context.revisionElements, created: context.createdElements });
    }
    const changes = recorder.finish(context.touched);
    const order = recorder.order();
    const marks = index.revisions.marks;
    const revisionOrder = new Map(index.revisions.groups.map((group, at) => [group.revision.id, at] as const));
    const all = new Set<RevisionId>();
    const results: DocxOpResult[] = perOp.map((entry, at) => {
      const revisionIds: RevisionId[] = [];
      for (const element of entry.revisions) {
        const id = isAttached(index, element) ? marks.get(element)?.revisionId : undefined;
        if (id !== undefined && !revisionIds.includes(id)) revisionIds.push(id);
      }
      revisionIds.sort((a, b) => (revisionOrder.get(a) ?? 0) - (revisionOrder.get(b) ?? 0));
      for (const id of revisionIds) all.add(id);
      const createdBlockIds: BlockId[] = [];
      for (const element of entry.created) {
        const id = index.blockOf(element)?.id;
        if (id !== undefined && changes.createdBlockIds.includes(id)) createdBlockIds.push(id);
      }
      createdBlockIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      return {
        type: (ops[at] as DocxOp).type,
        revisionIds,
        createdBlockIds,
        commentId: entry.outcome.commentId,
        caret: entry.outcome.caret,
      };
    });
    const result: ApplyResult = {
      results,
      revisionIds: [...all].sort((a, b) => (revisionOrder.get(a) ?? 0) - (revisionOrder.get(b) ?? 0)),
      createdBlockIds: changes.createdBlockIds,
      removedBlockIds: changes.removedBlockIds,
      changedBlockIds: changes.changedBlockIds,
      changedStoryIds: changes.changedStoryIds,
      positions: callerPins.map((pin) => context.tracker.read(pin)),
    };
    return result;
  } catch (error) {
    index.restore(snapshot);
    throw error;
  }
};
