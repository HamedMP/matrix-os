/**
 * Cell notes and threaded comments of a worksheet.
 *
 * A note lives in three places besides its cell: the comments part names
 * the cell (`ref`), the drawing part that shows the note box names its row
 * and column, and a threaded comment names the cell again. All three move
 * with inserted and deleted rows and columns, and go with a deleted cell.
 *
 * The parts are kept as text until rows or columns first move, so opening a
 * workbook does not pay for them. A sheet whose note parts cannot be read
 * refuses structural edits rather than leave its notes on the wrong cells.
 */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type { XmlDocument, XmlElement } from "../../api/xml.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { getAttr, parseXml, remove, serializeXml, setAttr, setTextContent, textContent } from "../../xml/index.js";
import { formatA1, tryParseA1Range } from "./a1.js";
import type { SheetModel } from "./model.js";
import { type StructuralOp, movePoint } from "./refs-rewrite.js";
import { isNamed, kid, kids } from "./xml-util.js";

export type NoteKind = "comments" | "drawing" | "threaded";

/** A part that holds notes: its text as opened, or the parsed tree once rows or columns moved. */
export interface NotePart {
  kind: NoteKind;
  name: PartName;
  text: string | null;
  doc: XmlDocument | null;
  /** The tree is newer than the part in the package. */
  dirty: boolean;
}

export interface SheetNotes {
  /** At most {@link MAX_NOTE_PARTS}. */
  parts: NotePart[];
  /** True when a part is missing, is not XML, or there are more parts than are read. */
  unreadable: boolean;
}

/** Note parts read per sheet; a sheet relates to one of each kind in practice. */
export const MAX_NOTE_PARTS = 16;

const KIND_BY_SUFFIX: ReadonlyArray<readonly [string, NoteKind]> = [
  ["/comments", "comments"],
  ["/vmlDrawing", "drawing"],
  ["/threadedComment", "threaded"],
];

/** The parts a worksheet relates to as comments, note drawings and threaded comments. */
export function notePartNames(pkg: OpcPackage, sheetPart: PartName): Array<{ kind: NoteKind; name: PartName }> {
  const found: Array<{ kind: NoteKind; name: PartName }> = [];
  for (const relationship of pkg.getRelationships(sheetPart)) {
    if (relationship.targetMode !== "Internal") continue;
    const kind = KIND_BY_SUFFIX.find(([suffix]) => relationship.type.endsWith(suffix))?.[1];
    if (kind === undefined) continue;
    const name = pkg.resolveTarget(sheetPart, relationship.target);
    if (pkg.hasPart(name)) found.push({ kind, name });
  }
  return found;
}

/** Builds the notes of a sheet from the texts read at open; null for a sheet without note parts. */
export function readNotes(names: ReadonlyArray<{ kind: NoteKind; name: PartName }>, textOf: (name: PartName) => string | undefined): SheetNotes | null {
  if (names.length === 0) return null;
  const notes: SheetNotes = { parts: [], unreadable: names.length > MAX_NOTE_PARTS };
  for (const { kind, name } of names.slice(0, MAX_NOTE_PARTS)) {
    const text = textOf(name);
    if (text === undefined) notes.unreadable = true;
    else notes.parts.push({ kind, name, text, doc: null, dirty: false });
  }
  return notes;
}

/** Parses the parts that are still text. Sets `unreadable` when one is not XML. */
function parseParts(notes: SheetNotes): void {
  for (const part of notes.parts) {
    if (part.doc !== null || part.text === null) continue;
    try {
      part.doc = parseXml(part.text);
      part.text = null;
    } catch (error) {
      // Drawing parts written by old software are not always XML; such a sheet keeps its notes where they are.
      if (!isOfficeError(error, "malformed_xml", "limit_exceeded")) throw error;
      notes.unreadable = true;
    }
  }
}

/** Throws when the notes of the sheet could not follow rows or columns that move. Changes nothing in the sheet. */
export function checkNotesForStructure(sheet: SheetModel): void {
  const notes = sheet.notes;
  if (notes === null) return;
  if (!notes.unreadable) parseParts(notes);
  if (notes.unreadable) {
    throw new OfficeError("invalid_operation", "the notes of this sheet cannot be moved, so its rows and columns cannot be inserted or deleted");
  }
}

/** Where a cell goes; null when it was deleted or pushed off the sheet. */
function moveCell(row: number, col: number, op: StructuralOp): { row: number; col: number } | null {
  const moved = movePoint(op.axis === "row" ? row : col, op);
  if (moved < 0) return null;
  return op.axis === "row" ? { row: moved, col } : { row, col: moved };
}

/** Moves the `ref` of each element, or removes the element when its cell is gone. True when something changed. */
function moveRefs(elements: readonly XmlElement[], op: StructuralOp): boolean {
  let changed = false;
  for (const element of elements) {
    const ref = getAttr(element, "ref");
    const range = ref === null ? null : tryParseA1Range(ref);
    if (ref === null || range === null) continue;
    const moved = moveCell(range.start.row, range.start.col, op);
    if (moved === null) {
      remove(element);
      changed = true;
      continue;
    }
    const text = formatA1(moved);
    if (text === ref) continue;
    setAttr(element, "ref", text);
    changed = true;
  }
  return changed;
}

function wholeNumber(element: XmlElement | null): number | null {
  if (element === null) return null;
  const value = Number(textContent(element).trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Shifts the box of a note by as many rows or columns as its cell moved. */
function shiftAnchor(anchor: XmlElement | null, op: StructuralOp, delta: number): void {
  if (anchor === null || delta === 0) return;
  const numbers = textContent(anchor).split(",").map((piece) => Number(piece.trim()));
  // Left column, offset, top row, offset, right column, offset, bottom row, offset.
  if (numbers.length !== 8 || numbers.some((value) => !Number.isInteger(value))) return;
  for (const at of op.axis === "row" ? [2, 6] : [0, 4]) numbers[at] = Math.max(0, (numbers[at] as number) + delta);
  setTextContent(anchor, numbers.join(", "));
}

/** The note shapes of a drawing: shapes whose client data says `Note`, with that client data. */
function noteShapes(root: XmlElement): Array<{ shape: XmlElement; data: XmlElement }> {
  const found: Array<{ shape: XmlElement; data: XmlElement }> = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    for (const node of element.children) {
      if (node.kind !== "element") continue;
      const data = isNamed(node.name, "shape") ? kid(node, "ClientData") : null;
      if (data !== null && getAttr(data, "ObjectType") === "Note") found.push({ shape: node, data });
      else if (data === null) stack.push(node);
    }
  }
  return found;
}

function moveDrawing(root: XmlElement, op: StructuralOp): boolean {
  let changed = false;
  for (const { shape, data } of noteShapes(root)) {
    const rowElement = kid(data, "Row");
    const colElement = kid(data, "Column");
    const row = wholeNumber(rowElement);
    const col = wholeNumber(colElement);
    if (rowElement === null || colElement === null || row === null || col === null) continue;
    const moved = moveCell(row, col, op);
    if (moved === null) {
      remove(shape);
      changed = true;
      continue;
    }
    if (moved.row === row && moved.col === col) continue;
    if (moved.row !== row) setTextContent(rowElement, String(moved.row));
    if (moved.col !== col) setTextContent(colElement, String(moved.col));
    shiftAnchor(kid(data, "Anchor"), op, op.axis === "row" ? moved.row - row : moved.col - col);
    changed = true;
  }
  return changed;
}

/** Moves the notes of a sheet with its rows and columns. Call after {@link checkNotesForStructure}. */
export function moveNotes(sheet: SheetModel, op: StructuralOp): void {
  const notes = sheet.notes;
  if (notes === null) return;
  for (const part of notes.parts) {
    const root = part.doc?.root;
    if (root === undefined) continue;
    let changed = false;
    if (part.kind === "comments") {
      const list = kid(root, "commentList");
      changed = list !== null && moveRefs(kids(list, "comment"), op);
    } else if (part.kind === "threaded") {
      changed = moveRefs(kids(root, "threadedComment"), op);
    } else {
      changed = moveDrawing(root, op);
    }
    if (changed) part.dirty = true;
  }
}

/** The note parts of a sheet as text, for a snapshot. Parts that were never parsed give the text they came with. */
export function noteTexts(sheet: SheetModel): Array<{ name: PartName; text: string }> {
  const notes = sheet.notes;
  if (notes === null) return [];
  return notes.parts.map((part) => ({ name: part.name, text: part.doc !== null ? serializeXml(part.doc) : (part.text ?? "") }));
}

/** Puts back note parts from texts taken with {@link noteTexts}. A part the sheet no longer has is skipped. */
export function restoreNoteTexts(sheet: SheetModel, texts: ReadonlyArray<{ name: string; text: string }>): void {
  const notes = sheet.notes;
  if (notes === null) return;
  for (const part of notes.parts) {
    const saved = texts.find((entry) => entry.name === part.name);
    if (saved === undefined) continue;
    const current = part.doc !== null ? serializeXml(part.doc) : part.text;
    if (current === saved.text) continue;
    part.doc = parseXml(saved.text);
    part.text = null;
    part.dirty = true;
  }
}

/** Writes the note parts that changed back into the package. */
export function flushNotes(pkg: OpcPackage, sheets: readonly SheetModel[]): void {
  for (const sheet of sheets) {
    for (const part of sheet.notes?.parts ?? []) {
      if (!part.dirty || part.doc === null) continue;
      pkg.setPart(part.name, serializeXml(part.doc));
      part.dirty = false;
    }
  }
}
