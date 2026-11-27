/**
 * The logical text of one paragraph.
 *
 * `scanParagraph` walks a `w:p` and lists its atoms: the pieces of XML that
 * each stand for one or more characters of the paragraph's markup text (the
 * coordinate space of `TextPosition`). Field codes are not text; the content
 * of tracked insertions and deletions both is.
 *
 * The scan never changes the tree and holds direct references to its
 * elements, so editing code can go from an offset to the node to change.
 */

import type { DocxTextView } from "../../api/docx-model.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { textContent } from "../../xml/index.js";
import { REVISION_CONTAINERS, TRANSPARENT_INLINE, attr, firstChild } from "./names.js";

export type AtomKind = "text" | "tab" | "lineBreak" | "noBreakHyphen" | "softHyphen" | "object";

/** U+FFFC, the one character an inline object takes in the markup text. */
export const OBJECT_CHAR = "￼";

/** A field that is open at some point of the text. Immutable: a state change makes a new frame. */
export interface FieldFrame {
  /** The element that identifies the field: the `w:fldChar` that begins it, or the `w:fldSimple`. */
  readonly key: XmlElement;
  /** The field code collected so far, untrimmed. Complete once `state` is `result`. */
  readonly instruction: string;
  /** `code` between the begin and separate characters, `result` after the separator. */
  readonly state: "code" | "result";
}

/** What surrounds a stretch of atoms. Atoms next to each other in the same wrappers share one object. */
export interface InlineContext {
  /** Enclosing `w:ins`, `w:del`, `w:moveFrom` and `w:moveTo` elements, outermost first. */
  readonly revisions: readonly XmlElement[];
  /** The enclosing `w:hyperlink`, or null. */
  readonly hyperlink: XmlElement | null;
  /** Fields whose result the atoms belong to, outermost first. */
  readonly fields: readonly FieldFrame[];
  /** Inside a deletion or the source of a move: absent from the `final` view. */
  readonly deleted: boolean;
  /** Inside an insertion or the destination of a move: absent from the `original` view. */
  readonly inserted: boolean;
}

export interface InlineAtom {
  /** Offset of the first character in the paragraph's markup text. */
  readonly start: number;
  /** One or more characters. Only a `text` atom can be longer than one. */
  readonly text: string;
  readonly kind: AtomKind;
  /**
   * The element the characters come from: `w:t` or `w:delText` for `text`,
   * `w:tab`, `w:br`, `w:noBreakHyphen`, … otherwise. For an `object` it is
   * the element the U+FFFC stands for (`w:drawing`, `w:footnoteReference`,
   * `m:oMath`, …).
   */
  readonly node: XmlElement;
  /** The `w:r` that holds `node`, or null for an object that sits directly in the paragraph. */
  readonly run: XmlElement | null;
  readonly context: InlineContext;
}

/** A zero-width element at an offset: bookmark, comment range and move range markers, comment references. */
export interface InlineMarker {
  readonly offset: number;
  readonly node: XmlElement;
}

/** The stretch of markup text a revision element covers. `end` is exclusive and can equal `start`. */
export interface RevisionSpan {
  /** `w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`, or a `w:rPrChange`. */
  readonly element: XmlElement;
  readonly start: number;
  readonly end: number;
  /** For a `w:rPrChange`: the run whose formatting changed. */
  readonly run: XmlElement | null;
}

export interface ParagraphScan {
  readonly paragraph: XmlElement;
  /** The markup text: all atom texts in order. */
  readonly text: string;
  readonly atoms: readonly InlineAtom[];
  readonly markers: readonly InlineMarker[];
  /** Content revision containers in the order they open, nested ones after their parent. */
  readonly contentSpans: readonly RevisionSpan[];
  /** Run formatting changes (`w:rPrChange`), in order. */
  readonly formatSpans: readonly RevisionSpan[];
  /**
   * The tracked change of the paragraph mark a reader is shown: the `w:ins`, `w:del`, `w:moveFrom` or `w:moveTo`
   * in `w:pPr/w:rPr`, a deletion before an insertion when the mark carries both.
   */
  readonly mark: XmlElement | null;
  /** Every tracked change of the paragraph mark, in file order. */
  readonly marks: readonly XmlElement[];
  /** `w:pPr/w:pPrChange`, or null. */
  readonly propertiesChange: XmlElement | null;
  /** `w:pPr/w:rPr/w:rPrChange`: a formatting change of the paragraph mark, or null. */
  readonly markFormatChange: XmlElement | null;
  /** Fields open at the start and at the end of the paragraph. */
  readonly fieldsIn: readonly FieldFrame[];
  readonly fieldsOut: readonly FieldFrame[];
  /** Change stamp of the paragraph's unit when it was scanned (see `PartStore.stampFor`). */
  readonly stamp: number;
}

const NO_FIELDS: readonly FieldFrame[] = Object.freeze([]);
const NO_REVISIONS: readonly XmlElement[] = Object.freeze([]);

/** Children of a paragraph or inline wrapper that carry no text and are not recorded. */
const SKIPPED: ReadonlySet<string> = new Set([
  "w:pPr",
  "w:rPr",
  "w:sdtPr",
  "w:sdtEndPr",
  "w:smartTagPr",
  "w:customXmlPr",
  "w:proofErr",
  "w:permStart",
  "w:permEnd",
]);

/** Children of a run that take no space in the text. */
const ZERO_WIDTH_IN_RUN: ReadonlySet<string> = new Set(["w:rPr", "w:lastRenderedPageBreak", "w:annotationRef"]);

function isRangeMarker(name: string): boolean {
  return name === "w:bookmarkStart" || name === "w:bookmarkEnd" || name.endsWith("RangeStart") || name.endsWith("RangeEnd");
}

function isDeletion(name: string): boolean {
  return name === "w:del" || name === "w:moveFrom";
}

/** Whether an atom is part of the text in a view. */
export function atomInView(atom: InlineAtom, view: DocxTextView): boolean {
  if (view === "final") return !atom.context.deleted;
  if (view === "original") return !atom.context.inserted;
  return true;
}

/**
 * The tracked changes a paragraph carries in its `w:pPr`: of the mark, of
 * the mark's formatting, of the properties.
 *
 * A mark can carry two revisions: the paragraph break one author inserted
 * and another deleted has a `w:ins` and a `w:del`. `marks` has them all in
 * file order; `mark` is the one a reader is shown, a deletion before an
 * insertion, as for text deleted inside an insertion.
 */
export function paragraphMarkRevision(paragraph: XmlElement): {
  mark: XmlElement | null;
  marks: readonly XmlElement[];
  propertiesChange: XmlElement | null;
  markFormatChange: XmlElement | null;
} {
  const pPr = firstChild(paragraph, "w:pPr");
  if (pPr === null) return { mark: null, marks: NO_REVISIONS, propertiesChange: null, markFormatChange: null };
  let marks: XmlElement[] | null = null;
  let markFormatChange: XmlElement | null = null;
  const rPr = firstChild(pPr, "w:rPr");
  if (rPr !== null) {
    for (const node of rPr.children) {
      if (node.kind !== "element") continue;
      if (REVISION_CONTAINERS.has(node.name)) (marks ??= []).push(node);
      else if (markFormatChange === null && node.name === "w:rPrChange") markFormatChange = node;
    }
  }
  return { mark: shownRevision(marks ?? NO_REVISIONS), marks: marks ?? NO_REVISIONS, propertiesChange: firstChild(pPr, "w:pPrChange"), markFormatChange };
}

/** Of the revisions on one paragraph mark or table row, the one a reader is shown: a deletion, else the first. */
export function shownRevision(revisions: readonly XmlElement[]): XmlElement | null {
  for (const revision of revisions) if (isDeletion(revision.name)) return revision;
  return revisions[0] ?? null;
}

/**
 * Whether a paragraph mark or table row with these revisions is gone in a
 * view: a deletion removes it from `final`, an insertion from `original`,
 * and one that carries both is in neither.
 */
export function revisionsGoneInView(revisions: readonly XmlElement[], view: DocxTextView): boolean {
  if (view === "markup") return false;
  for (const revision of revisions) if (isDeletion(revision.name) === (view === "final")) return true;
  return false;
}

class Scanner {
  readonly atoms: InlineAtom[] = [];
  readonly markers: InlineMarker[] = [];
  readonly contentSpans: RevisionSpan[] = [];
  readonly formatSpans: RevisionSpan[] = [];
  fields: readonly FieldFrame[];
  private offset = 0;
  private context: InlineContext | null = null;
  private contextRevisions: readonly XmlElement[] = NO_REVISIONS;
  private contextHyperlink: XmlElement | null = null;
  private contextFields: readonly FieldFrame[] = NO_FIELDS;

  constructor(fieldsIn: readonly FieldFrame[]) {
    this.fields = fieldsIn;
  }

  get length(): number {
    return this.offset;
  }

  /** True inside a field code: nothing there is text. */
  private hidden(): boolean {
    for (const frame of this.fields) if (frame.state === "code") return true;
    return false;
  }

  private contextFor(revisions: readonly XmlElement[], hyperlink: XmlElement | null): InlineContext {
    if (
      this.context !== null &&
      this.contextRevisions === revisions &&
      this.contextHyperlink === hyperlink &&
      this.contextFields === this.fields
    ) {
      return this.context;
    }
    let deleted = false;
    let inserted = false;
    for (const element of revisions) {
      if (isDeletion(element.name)) deleted = true;
      else inserted = true;
    }
    this.context = { revisions, hyperlink, fields: this.fields, deleted, inserted };
    this.contextRevisions = revisions;
    this.contextHyperlink = hyperlink;
    this.contextFields = this.fields;
    return this.context;
  }

  private emit(
    kind: AtomKind,
    text: string,
    node: XmlElement,
    run: XmlElement | null,
    revisions: readonly XmlElement[],
    hyperlink: XmlElement | null,
  ): void {
    if (text.length === 0 || this.hidden()) return;
    this.atoms.push({ start: this.offset, text, kind, node, run, context: this.contextFor(revisions, hyperlink) });
    this.offset += text.length;
  }

  private fieldChar(element: XmlElement): void {
    const type = attr(element, "w:fldCharType");
    const top = this.fields[this.fields.length - 1];
    if (type === "begin") {
      // A bound on nesting keeps a hostile document from growing the stack without limit.
      if (this.fields.length < 64) this.fields = [...this.fields, { key: element, instruction: "", state: "code" }];
    } else if (type === "separate") {
      if (top !== undefined && top.state === "code") {
        this.fields = [...this.fields.slice(0, -1), { key: top.key, instruction: top.instruction, state: "result" }];
      }
    } else if (type === "end") {
      if (top !== undefined) this.fields = this.fields.slice(0, -1);
    }
  }

  private fieldCode(text: string): void {
    const top = this.fields[this.fields.length - 1];
    if (top === undefined || top.state !== "code" || top.instruction.length > 4096) return;
    this.fields = [...this.fields.slice(0, -1), { key: top.key, instruction: top.instruction + text, state: "code" }];
  }

  private run(run: XmlElement, revisions: readonly XmlElement[], hyperlink: XmlElement | null): void {
    const start = this.offset;
    const nodes = run.children;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index] as XmlChildNode;
      if (node.kind !== "element") continue;
      const name = node.name;
      if (name === "w:t" || name === "w:delText") {
        this.emit("text", textContent(node), node, run, revisions, hyperlink);
      } else if (ZERO_WIDTH_IN_RUN.has(name)) {
        continue;
      } else if (name === "w:tab" || name === "w:ptab") {
        this.emit("tab", "\t", node, run, revisions, hyperlink);
      } else if (name === "w:br") {
        const type = attr(node, "w:type");
        if (type === "page" || type === "column") this.emit("object", OBJECT_CHAR, node, run, revisions, hyperlink);
        else this.emit("lineBreak", "\n", node, run, revisions, hyperlink);
      } else if (name === "w:cr") {
        this.emit("lineBreak", "\n", node, run, revisions, hyperlink);
      } else if (name === "w:noBreakHyphen") {
        this.emit("noBreakHyphen", "‑", node, run, revisions, hyperlink);
      } else if (name === "w:softHyphen") {
        this.emit("softHyphen", "­", node, run, revisions, hyperlink);
      } else if (name === "w:fldChar") {
        this.fieldChar(node);
      } else if (name === "w:instrText" || name === "w:delInstrText") {
        this.fieldCode(textContent(node));
      } else if (name === "w:commentReference") {
        this.markers.push({ offset: this.offset, node });
      } else {
        this.emit("object", OBJECT_CHAR, node, run, revisions, hyperlink);
      }
    }
    const rPr = firstChild(run, "w:rPr");
    const change = rPr === null ? null : firstChild(rPr, "w:rPrChange");
    if (change !== null) this.formatSpans.push({ element: change, start, end: this.offset, run });
  }

  inline(parent: XmlElement, revisions: readonly XmlElement[], hyperlink: XmlElement | null): void {
    const nodes = parent.children;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index] as XmlChildNode;
      if (node.kind !== "element") continue;
      const name = node.name;
      if (name === "w:r") {
        this.run(node, revisions, hyperlink);
      } else if (REVISION_CONTAINERS.has(name)) {
        const spanIndex = this.contentSpans.length;
        const start = this.offset;
        this.contentSpans.push({ element: node, start, end: start, run: null });
        this.inline(node, [...revisions, node], hyperlink);
        this.contentSpans[spanIndex] = { element: node, start, end: this.offset, run: null };
      } else if (name === "w:hyperlink") {
        this.inline(node, revisions, node);
      } else if (name === "w:fldSimple") {
        const outer = this.fields;
        this.fields = [...outer, { key: node, instruction: attr(node, "w:instr") ?? "", state: "result" }];
        this.inline(node, revisions, hyperlink);
        this.fields = outer;
      } else if (TRANSPARENT_INLINE.has(name)) {
        this.inline(node, revisions, hyperlink);
      } else if (SKIPPED.has(name)) {
        continue;
      } else if (isRangeMarker(name)) {
        this.markers.push({ offset: this.offset, node });
      } else {
        this.emit("object", OBJECT_CHAR, node, null, revisions, hyperlink);
      }
    }
  }
}

/**
 * Scans one paragraph. `fieldsIn` are the complex fields left open by the
 * paragraphs before it in the story (a table of contents spans many).
 */
export function scanParagraph(paragraph: XmlElement, fieldsIn: readonly FieldFrame[], stamp: number): ParagraphScan {
  const scanner = new Scanner(fieldsIn.length === 0 ? NO_FIELDS : fieldsIn);
  scanner.inline(paragraph, NO_REVISIONS, null);
  let text = "";
  for (const atom of scanner.atoms) text += atom.text;
  const { mark, marks, propertiesChange, markFormatChange } = paragraphMarkRevision(paragraph);
  return {
    paragraph,
    text,
    atoms: scanner.atoms,
    markers: scanner.markers,
    contentSpans: scanner.contentSpans,
    formatSpans: scanner.formatSpans,
    mark,
    marks,
    propertiesChange,
    markFormatChange,
    fieldsIn,
    fieldsOut: scanner.fields.length === 0 ? NO_FIELDS : scanner.fields,
    stamp,
  };
}

/** True when two field stacks are the same frames in the same order. */
export function sameFields(a: readonly FieldFrame[], b: readonly FieldFrame[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** Index of the atom that contains `offset`, or of the first atom that starts at or after it. */
export function atomIndexAt(scan: ParagraphScan, offset: number): number {
  const atoms = scan.atoms;
  let low = 0;
  let high = atoms.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const atom = atoms[middle] as InlineAtom;
    if (atom.start + atom.text.length <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The text of a scanned paragraph in a view. */
export function scanText(scan: ParagraphScan, view: DocxTextView): string {
  if (view === "markup") return scan.text;
  let text = "";
  for (const atom of scan.atoms) if (atomInView(atom, view)) text += atom.text;
  return text;
}
