/**
 * Writes the revisions of one plan entry into the paragraphs of the result:
 * word-level insertions and deletions, paragraph marks that came or went
 * (splits and merges), formatting changes of unchanged text, and whole
 * paragraphs that were inserted, deleted or relocated.
 */

import type { DiffOp } from "../../api/redline.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { diffWords } from "../../redline/index.js";
import { appendChild, createElement, insertAfter } from "../../xml/index.js";
import { atomIndexAt, attr, firstChild } from "../internal.js";
import { PARAGRAPH_MARK } from "./extract.js";
import { applyParagraphFormat, applyRunFormat, canonicalParagraphProperties, canonicalRunProperties } from "./format.js";
import type { ImportContext, Importer } from "./importer.js";
import { addMoveRange, setParagraphMark, wrapParagraphContent, wrapRange } from "./markup.js";
import type { MoveLink, ParagraphEntry } from "./plan.js";
import { type Para, insertAtPoint, pointAt, scanOf, splitParagraphInto } from "./runs.js";
import type { BuildCounters, ParaNode, Stamp } from "./types.js";

export interface BuildContext {
  readonly stamp: Stamp;
  readonly importer: Importer;
  readonly compareFormatting: boolean;
  readonly detectMoves: boolean;
  readonly counters: BuildCounters;
  /** Notes both versions refer to at the same place: `footnote:<id in the result>` to the id in the revised document. */
  readonly notePairs: Map<string, string>;
  /** A fresh name for the two halves of a relocated paragraph. */
  moveName(): string;
}

interface Piece {
  /** Index of the paragraph in its list. */
  readonly index: number;
  readonly start: number;
  readonly end: number;
  /** True for the paragraph mark after paragraph `index`. */
  readonly mark: boolean;
}

const NOTE_REFERENCES: ReadonlySet<string> = new Set(["w:footnoteReference", "w:endnoteReference"]);
const NO_MOVES = { detectMoves: false } as const;

function paraOf(node: ParaNode): Para {
  return { element: node.element, fieldsIn: node.fieldsIn };
}

function offsetsOf(paragraphs: readonly ParaNode[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const paragraph of paragraphs) {
    starts.push(offset);
    offset += paragraph.text.length + 1;
  }
  return starts;
}

/** The parts of the joined text `[from, to)`: stretches of paragraph text and the marks between paragraphs. */
function piecesOf(paragraphs: readonly ParaNode[], starts: readonly number[], from: number, to: number): Piece[] {
  const pieces: Piece[] = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const start = starts[index] as number;
    const length = (paragraphs[index] as ParaNode).text.length;
    const end = start + length;
    if (start >= to) break;
    const low = Math.max(from, start);
    const high = Math.min(to, end);
    if (low < high) pieces.push({ index, start: low - start, end: high - start, mark: false });
    if (index < paragraphs.length - 1 && from <= end && end < to) pieces.push({ index, start: length, end: length, mark: true });
  }
  return pieces;
}

/** The paragraph and local offset of a position in the joined text. */
function locate(paragraphs: readonly ParaNode[], starts: readonly number[], offset: number): { index: number; offset: number } {
  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const start = starts[index] as number;
    if (offset >= start) return { index, offset: Math.min(offset - start, (paragraphs[index] as ParaNode).text.length) };
  }
  return { index: 0, offset: 0 };
}

function comparePropertiesOfParagraph(element: XmlElement, revised: ParaNode, context: BuildContext, scope: ImportContext): void {
  if (!context.compareFormatting) return;
  const own = firstChild(element, "w:pPr");
  const properties = context.importer.paragraphProperties(revised.element, scope, own);
  if (canonicalParagraphProperties(own) === canonicalParagraphProperties(properties)) return;
  applyParagraphFormat(element, properties, context.stamp);
}

/**
 * Unchanged text: records the notes both versions refer to and the run
 * formatting that differs between `[start, end)` of `target` and the same
 * text at `revisedStart` of `revised`.
 */
function compareEqualText(
  target: Para,
  start: number,
  end: number,
  revised: Para,
  revisedStart: number,
  context: BuildContext,
): void {
  const scanA = scanOf(target);
  const scanB = scanOf(revised);
  const changes: Array<{ start: number; end: number; properties: XmlElement | null }> = [];
  let positionB = atomIndexAt(scanB, revisedStart);
  let exhausted = false;
  for (let positionA = atomIndexAt(scanA, start); positionA < scanA.atoms.length && !exhausted; positionA++) {
    const atomA = scanA.atoms[positionA];
    if (atomA === undefined || atomA.start >= end) break;
    const high = Math.min(atomA.start + atomA.text.length, end);
    let at = Math.max(atomA.start, start);
    while (at < high) {
      const offsetB = at - start + revisedStart;
      let atomB = scanB.atoms[positionB];
      while (atomB !== undefined && atomB.start + atomB.text.length <= offsetB) {
        positionB += 1;
        atomB = scanB.atoms[positionB];
      }
      const next = atomB === undefined ? at : Math.min(high, at + (atomB.start + atomB.text.length - offsetB));
      if (atomB === undefined || next <= at) {
        // The revised paragraph has no more text here: nothing further can be compared.
        exhausted = true;
        break;
      }
      if (atomA.kind === "object" && NOTE_REFERENCES.has(atomA.node.name) && atomB.node.name === atomA.node.name) {
        const kind = atomA.node.name === "w:footnoteReference" ? "footnote" : "endnote";
        const key = `${kind}:${attr(atomA.node, "w:id") ?? ""}`;
        const other = attr(atomB.node, "w:id");
        if (other !== null && !context.notePairs.has(key)) context.notePairs.set(key, other);
      }
      const comparable = atomA.run !== null && atomB.run !== null && atomA.run.name === "w:r" && !context.importer.hasForeignRunStyle(atomB.run);
      if (context.compareFormatting && comparable && atomA.run !== null) {
        const properties = context.importer.runProperties(atomB.run);
        if (canonicalRunProperties(firstChild(atomA.run, "w:rPr")) !== canonicalRunProperties(properties)) {
          const last = changes[changes.length - 1];
          if (last !== undefined && last.end === at && last.properties === properties) last.end = next;
          else changes.push({ start: at, end: next, properties });
        }
      }
      at = next;
    }
  }
  for (let position = changes.length - 1; position >= 0; position--) {
    const change = changes[position] as { start: number; end: number; properties: XmlElement | null };
    applyRunFormat(target, change.start, change.end, change.properties, context.stamp);
  }
}

/** A new, empty paragraph with the properties of `revised` and an inserted mark, for the first part of a split of `split`. */
function newParagraphLike(revised: ParaNode, split: XmlElement, context: BuildContext, scope: ImportContext): XmlElement {
  const paragraph = createElement("w:p");
  const properties = context.importer.paragraphProperties(revised.element, scope, firstChild(split, "w:pPr"));
  if (properties !== null) appendChild(paragraph, properties);
  setParagraphMark(paragraph, "ins", context.stamp);
  return paragraph;
}

/**
 * Paragraphs both versions have: compares their text word by word. Several
 * paragraphs on one side are a split or a merge; the marks between them are
 * tracked like text.
 */
export function mergeParagraphs(entry: ParagraphEntry, context: BuildContext, scope: ImportContext): void {
  const { a, b } = entry;
  const aText = a.map((paragraph) => paragraph.text).join(PARAGRAPH_MARK);
  const bText = b.map((paragraph) => paragraph.text).join(PARAGRAPH_MARK);
  const ops: DiffOp[] =
    aText === bText
      ? [{ type: "equal", text: aText, aStart: 0, aEnd: aText.length, bStart: 0, bEnd: bText.length, moveId: null }]
      : diffWords(aText, bText, NO_MOVES);
  const aStarts = offsetsOf(a);
  const bStarts = offsetsOf(b);
  const targets: Para[] = a.map(paraOf);
  const inlineOf = (piece: Piece): XmlChildNode[] =>
    context.importer.inline(paraOf(b[piece.index] as ParaNode), piece.start, piece.end, "ins", scope);

  for (let position = ops.length - 1; position >= 0; position--) {
    const op = ops[position] as DiffOp;
    if (op.type === "equal") {
      const left = piecesOf(a, aStarts, op.aStart, op.aEnd).filter((piece) => !piece.mark);
      const right = piecesOf(b, bStarts, op.bStart, op.bEnd).filter((piece) => !piece.mark);
      for (let at = Math.min(left.length, right.length) - 1; at >= 0; at--) {
        const mine = left[at] as Piece;
        const other = right[at] as Piece;
        compareEqualText(targets[mine.index] as Para, mine.start, mine.end, paraOf(b[other.index] as ParaNode), other.start, context);
      }
    } else if (op.type === "delete" || op.type === "moveFrom") {
      const pieces = piecesOf(a, aStarts, op.aStart, op.aEnd);
      for (let at = pieces.length - 1; at >= 0; at--) {
        const piece = pieces[at] as Piece;
        if (piece.mark) setParagraphMark((a[piece.index] as ParaNode).element, "del", context.stamp);
        else wrapRange(targets[piece.index] as Para, piece.start, piece.end, "del", context.stamp);
      }
    } else {
      const where = locate(a, aStarts, op.aStart);
      const target = targets[where.index] as Para;
      const segments: Piece[][] = [[]];
      const marks: number[] = [];
      for (const piece of piecesOf(b, bStarts, op.bStart, op.bEnd)) {
        if (piece.mark) {
          marks.push(piece.index);
          segments.push([]);
        } else (segments[segments.length - 1] as Piece[]).push(piece);
      }
      const nodesOf = (segment: number): XmlChildNode[] => (segments[segment] as Piece[]).flatMap(inlineOf);
      if (marks.length === 0) {
        insertAtPoint(pointAt(target, where.offset, context.stamp), nodesOf(0));
        continue;
      }
      // The text before the insertion moves into a new paragraph whose mark is inserted.
      const head = newParagraphLike(b[marks[0] as number] as ParaNode, target.element, context, scope);
      splitParagraphInto(target, where.offset, head, context.stamp);
      insertAtPoint({ parent: head, before: null }, nodesOf(0));
      let previous = head;
      for (let at = 1; at < marks.length; at++) {
        const middle = newParagraphLike(b[marks[at] as number] as ParaNode, target.element, context, scope);
        insertAtPoint({ parent: middle, before: null }, nodesOf(at));
        insertAfter(previous, middle);
        previous = middle;
      }
      insertAtPoint(pointAt(target, 0, context.stamp), nodesOf(marks.length));
      targets[where.index] = { element: head, fieldsIn: target.fieldsIn };
    }
  }
  const lastElement = (a[a.length - 1] as ParaNode).element;
  comparePropertiesOfParagraph(lastElement, b[b.length - 1] as ParaNode, context, scope);
  if (entry.mark !== null) setParagraphMark(lastElement, entry.mark, context.stamp);
}

/** Marks the content of a paragraph of the original as deleted, or as the source of a move. */
function markRemoved(node: ParaNode, removal: "del" | "moveFrom", link: MoveLink | null, context: BuildContext): void {
  const para = paraOf(node);
  if (removal === "del" || link === null) {
    wrapParagraphContent(node.element, "del", context.stamp);
    context.counters.deletedParagraphs += 1;
    return;
  }
  const own = scanOf(para).text;
  const other = scanOf(paraOf(link.partner)).text;
  let wrappers: XmlElement[] = [];
  if (own === other) {
    wrappers = wrapParagraphContent(node.element, "moveFrom", context.stamp);
  } else {
    // Relocated and edited: what stayed is moved, what went is deleted where it was.
    const ops = diffWords(own, other, NO_MOVES);
    for (let position = ops.length - 1; position >= 0; position--) {
      const op = ops[position] as DiffOp;
      if (op.type === "equal") wrappers.unshift(...wrapRange(para, op.aStart, op.aEnd, "moveFrom", context.stamp));
      else if (op.aEnd > op.aStart) wrapRange(para, op.aStart, op.aEnd, "del", context.stamp);
    }
  }
  addMoveRange(node.element, wrappers, "moveFrom", link.name, context.stamp);
}

/** A paragraph of the original that is gone: deleted, or relocated. */
export function removeParagraph(entry: ParagraphEntry, context: BuildContext): void {
  const node = entry.a[0] as ParaNode;
  markRemoved(node, entry.removal, entry.moveFrom, context);
  if (entry.mark !== null) setParagraphMark(node.element, entry.mark, context.stamp);
}

/** A paragraph of the revised version that is new, as a paragraph element of its own. */
export function addParagraph(entry: ParagraphEntry, context: BuildContext, scope: ImportContext): XmlElement {
  const node = entry.b[0] as ParaNode;
  const copy = context.importer.block(node.element, scope);
  const para: Para = { element: copy, fieldsIn: node.fieldsIn };
  const link = entry.moveTo;
  if (entry.addition === "ins" || link === null) {
    wrapParagraphContent(copy, "ins", context.stamp);
    context.counters.insertedParagraphs += 1;
  } else {
    const own = scanOf(para).text;
    const other = scanOf(paraOf(link.partner)).text;
    let wrappers: XmlElement[] = [];
    if (own === other) {
      wrappers = wrapParagraphContent(copy, "moveTo", context.stamp);
    } else {
      const ops = diffWords(other, own, NO_MOVES);
      for (let position = ops.length - 1; position >= 0; position--) {
        const op = ops[position] as DiffOp;
        if (op.type === "equal") wrappers.unshift(...wrapRange(para, op.bStart, op.bEnd, "moveTo", context.stamp));
        else if (op.bEnd > op.bStart) wrapRange(para, op.bStart, op.bEnd, "ins", context.stamp);
      }
    }
    addMoveRange(copy, wrappers, "moveTo", link.name, context.stamp);
    context.counters.movedParagraphs += 1;
  }
  if (entry.mark !== null) setParagraphMark(copy, entry.mark, context.stamp);
  return copy;
}

/** The content of a new paragraph as inline nodes, for a paragraph element that it shares with removed content. */
function addedInline(node: ParaNode, entry: ParagraphEntry, context: BuildContext, scope: ImportContext): XmlChildNode[] {
  const para = paraOf(node);
  const length = node.text.length;
  const link = entry.moveTo;
  if (entry.addition === "ins" || link === null) {
    context.counters.insertedParagraphs += 1;
    return context.importer.inline(para, 0, length, "ins", scope);
  }
  context.counters.movedParagraphs += 1;
  const own = scanOf(para).text;
  const other = scanOf(paraOf(link.partner)).text;
  if (own === other) return context.importer.inline(para, 0, length, "moveTo", scope);
  const nodes: XmlChildNode[] = [];
  for (const op of diffWords(other, own, NO_MOVES)) {
    if (op.bEnd <= op.bStart) continue;
    nodes.push(...context.importer.inline(para, op.bStart, op.bEnd, op.type === "equal" ? "moveTo" : "ins", scope));
  }
  return nodes;
}

/**
 * The last paragraph that goes and the last that comes at the end of a
 * stretch, in one paragraph element: all of the old content removed, all of
 * the new content added, and a mark both versions keep.
 */
export function replaceParagraph(entry: ParagraphEntry, context: BuildContext, scope: ImportContext): void {
  const old = entry.a[0] as ParaNode;
  const fresh = entry.b[0] as ParaNode;
  markRemoved(old, entry.removal, entry.moveFrom, context);
  const nodes = addedInline(fresh, entry, context, scope);
  insertAtPoint({ parent: old.element, before: null }, nodes);
  if (entry.moveTo !== null && entry.addition === "moveTo") {
    const elements = nodes.filter((node): node is XmlElement => node.kind === "element");
    addMoveRange(old.element, elements, "moveTo", entry.moveTo.name, context.stamp);
  }
  comparePropertiesOfParagraph(old.element, fresh, context, scope);
  if (entry.mark !== null) setParagraphMark(old.element, entry.mark, context.stamp);
}
