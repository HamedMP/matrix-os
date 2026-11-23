/**
 * One pass over a story that collects its revision elements into drafts of
 * logical revisions. The grouping rules are described in `revisions.ts`.
 */

import type { BlockId, Revision, RevisionId, RevisionKind, RevisionScope, TextPosition } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { Flow } from "./flow.js";
import type { ParagraphScan } from "./inline.js";
import { attr, firstChild } from "./names.js";
import { type FormatResolver, tableStyleIdOf } from "./resolve.js";
import { type BlockRecord, type StoryRecord, type Structure, rowCells, tableRows } from "./structure.js";

export type RevisionMemberRole =
  /** A `w:ins`, `w:del`, `w:moveFrom` or `w:moveTo` around runs. */
  | "content"
  /** The same element inside `w:pPr/w:rPr`: the paragraph mark is inserted, deleted or moved. */
  | "paragraphMark"
  /** A `w:ins` or `w:del` inside `w:trPr`: the whole row. */
  | "tableRow"
  /** A `w:rPrChange` (of a run, or of a paragraph mark). */
  | "runFormat"
  /** A `w:pPrChange`. */
  | "paragraphFormat"
  /** Any other property change: table, row, cell and section properties, cell insertion, deletion and merge. */
  | "otherFormat";

/** One XML revision element of a logical revision. */
export interface RevisionMember {
  readonly element: XmlElement;
  readonly role: RevisionMemberRole;
  /** What the element changes: the paragraph (content, marks, paragraph format), the `w:r`, the `w:tr`, or the element whose properties changed. */
  readonly owner: XmlElement;
  /** The paragraph that holds the element, or the table for row and table property changes. */
  readonly blockId: BlockId;
}

export interface RevisionInfo {
  readonly kind: RevisionKind;
  readonly author: string;
  readonly date: string | null;
  readonly key: string;
}

export interface Draft {
  readonly info: RevisionInfo;
  readonly scope: RevisionScope;
  readonly storyId: string;
  readonly members: RevisionMember[];
  readonly blockIds: BlockId[];
  /** Story offset where the revision starts; orders the revisions of a story. */
  readonly sort: number;
  readonly sequence: number;
  /** Adjacency coordinate: the next element of the same stream joins when it starts at or before this. */
  end: number;
  text: string;
  start: TextPosition | null;
  endPosition: TextPosition | null;
  moveName: string | null;
  formatChange: Revision["formatChange"];
  pairedWith: Draft | null;
  id: RevisionId;
}

const ROW_PROPERTY_CHANGES: ReadonlySet<string> = new Set(["w:trPrChange"]);
const CELL_PROPERTY_CHANGES: ReadonlySet<string> = new Set(["w:tcPrChange", "w:cellIns", "w:cellDel", "w:cellMerge"]);

function kindOf(name: string): RevisionKind {
  switch (name) {
    case "w:ins":
      return "insert";
    case "w:del":
      return "delete";
    case "w:moveFrom":
      return "moveFrom";
    case "w:moveTo":
      return "moveTo";
    default:
      return "format";
  }
}

function infoOf(element: XmlElement): RevisionInfo {
  const kind = kindOf(element.name);
  const author = attr(element, "w:author") ?? "";
  const date = attr(element, "w:date");
  return { kind, author, date, key: `${kind}\u0000${author}\u0000${date ?? ""}` };
}

/** The `w:ins` or `w:del` in the `w:trPr` of a row, or null. */
export function rowRevisionElement(row: XmlElement): XmlElement | null {
  const trPr = firstChild(row, "w:trPr");
  if (trPr === null) return null;
  for (const node of trPr.children) {
    if (node.kind === "element" && (node.name === "w:ins" || node.name === "w:del")) return node;
  }
  return null;
}

function childrenNamed(parent: XmlElement | null, names: ReadonlySet<string>): XmlElement[] {
  const found: XmlElement[] = [];
  if (parent === null) return found;
  for (const node of parent.children) if (node.kind === "element" && names.has(node.name)) found.push(node);
  return found;
}

export class StoryPass {
  readonly drafts: Draft[] = [];
  private base = 0;
  private ordinal = 0;
  private sequence = 0;
  private readonly open = new Map<string, Draft>();
  private readonly rowStack: Draft[] = [];
  private moveFrom: string | null = null;
  private moveTo: string | null = null;
  private readonly moveRanges = new Map<string, "from" | "to">();

  constructor(
    private readonly story: StoryRecord,
    private readonly structure: Structure,
    private readonly flow: Flow,
    private readonly resolver: FormatResolver,
  ) {}

  private draft(info: RevisionInfo, scope: RevisionScope, sort: number): Draft {
    this.sequence += 1;
    const draft: Draft = {
      info,
      scope,
      storyId: this.story.id,
      members: [],
      blockIds: [],
      sort,
      sequence: this.sequence,
      end: sort,
      text: "",
      start: null,
      endPosition: null,
      moveName: null,
      formatChange: null,
      pairedWith: null,
      id: "",
    };
    this.drafts.push(draft);
    return draft;
  }

  private addMember(draft: Draft, member: RevisionMember): void {
    draft.members.push(member);
    if (draft.blockIds[draft.blockIds.length - 1] !== member.blockId && !draft.blockIds.includes(member.blockId)) {
      draft.blockIds.push(member.blockId);
    }
  }

  /** Adds an element to the revision of its stream that it touches, or starts a new revision. */
  private join(
    stream: RevisionScope,
    member: RevisionMember,
    info: RevisionInfo,
    start: number,
    end: number,
    text: string,
    from: TextPosition | null,
    to: TextPosition | null,
  ): Draft {
    const mapKey = `${stream}\u0000${info.key}`;
    let draft = this.open.get(mapKey);
    if (draft === undefined || start > draft.end) {
      draft = this.draft(info, stream, stream === "paragraphFormat" ? this.base : start);
      draft.end = start;
      draft.start = from;
      draft.endPosition = from;
      this.open.set(mapKey, draft);
    }
    if (end > draft.end || draft.members.length === 0) {
      // An element nested in one of the same revision repeats text that is already counted.
      draft.text += text.slice(Math.max(0, Math.min(text.length, draft.end - start)));
      draft.end = Math.max(draft.end, end);
      draft.endPosition = to;
    }
    this.addMember(draft, member);
    return draft;
  }

  private content(
    member: RevisionMember,
    info: RevisionInfo,
    start: number,
    end: number,
    text: string,
    from: TextPosition,
    to: TextPosition,
  ): void {
    const row = this.rowStack[this.rowStack.length - 1];
    if (row !== undefined && row.info.key === info.key) {
      this.addMember(row, member);
      return;
    }
    const draft = this.join("text", member, info, start, end, text, from, to);
    if (draft.moveName === null) {
      draft.moveName = info.kind === "moveFrom" ? this.moveFrom : info.kind === "moveTo" ? this.moveTo : null;
    }
  }

  private moveMarker(node: XmlElement): void {
    const id = attr(node, "w:id") ?? "";
    switch (node.name) {
      case "w:moveFromRangeStart":
        this.moveFrom = attr(node, "w:name");
        this.moveRanges.set(id, "from");
        break;
      case "w:moveToRangeStart":
        this.moveTo = attr(node, "w:name");
        this.moveRanges.set(id, "to");
        break;
      case "w:moveFromRangeEnd":
        if (this.moveRanges.get(id) === "from") this.moveFrom = null;
        this.moveRanges.delete(id);
        break;
      case "w:moveToRangeEnd":
        if (this.moveRanges.get(id) === "to") this.moveTo = null;
        this.moveRanges.delete(id);
        break;
      default:
        break;
    }
  }

  /** Where a range that includes the mark of `record` ends: the start of the next sibling paragraph when there is one. */
  private afterMark(record: BlockRecord, length: number): TextPosition {
    const next = this.structure.blocksByContainer.get(record.container)?.[record.indexInContainer + 1];
    if (next !== undefined && next.type === "paragraph") return { blockId: next.id, offset: 0 };
    return { blockId: record.id, offset: length };
  }

  private paragraph(record: BlockRecord): void {
    const paragraph = record.element;
    const scan = this.flow.scans.get(paragraph) as ParagraphScan;
    const length = scan.text.length;
    const base = this.base;
    const blockId = record.id;
    const markers = scan.markers;
    let markerIndex = 0;
    const advance = (offset: number): void => {
      while (markerIndex < markers.length && (markers[markerIndex] as { offset: number }).offset <= offset) {
        this.moveMarker((markers[markerIndex] as { node: XmlElement }).node);
        markerIndex += 1;
      }
    };
    for (const span of scan.contentSpans) {
      advance(span.start);
      this.content(
        { element: span.element, role: "content", owner: paragraph, blockId },
        infoOf(span.element),
        base + span.start,
        base + span.end,
        scan.text.slice(span.start, span.end),
        { blockId, offset: span.start },
        { blockId, offset: span.end },
      );
    }
    advance(length);
    if (scan.mark !== null) {
      this.content(
        { element: scan.mark, role: "paragraphMark", owner: paragraph, blockId },
        infoOf(scan.mark),
        base + length,
        base + length + 1,
        "\n",
        { blockId, offset: length },
        this.afterMark(record, length),
      );
    }
    for (const span of scan.formatSpans) {
      const draft = this.join(
        "runFormat",
        { element: span.element, role: "runFormat", owner: span.run ?? paragraph, blockId },
        infoOf(span.element),
        base + span.start,
        base + span.end,
        scan.text.slice(span.start, span.end),
        { blockId, offset: span.start },
        { blockId, offset: span.end },
      );
      if (draft.formatChange === null) {
        const rPr = span.element.parent;
        draft.formatChange = this.resolver.runFormatChange(
          firstChild(span.element, "w:rPr"),
          rPr !== null && rPr.kind === "element" ? rPr : null,
        );
      }
    }
    const pPr = firstChild(paragraph, "w:pPr");
    const markProps = pPr === null ? null : firstChild(pPr, "w:rPr");
    const markChange = markProps === null ? null : firstChild(markProps, "w:rPrChange");
    if (markChange !== null && pPr !== null) {
      const draft = this.join(
        "runFormat",
        { element: markChange, role: "runFormat", owner: pPr, blockId },
        infoOf(markChange),
        base + length,
        base + length + 1,
        "",
        { blockId, offset: length },
        { blockId, offset: length },
      );
      if (draft.formatChange === null) {
        draft.formatChange = this.resolver.runFormatChange(firstChild(markChange, "w:rPr"), markProps);
      }
    }
    if (scan.propertiesChange !== null) {
      const info = infoOf(scan.propertiesChange);
      // Paragraphs are one position apart in this stream; a revision over several joins their texts.
      const continues = this.open.get(`paragraphFormat\u0000${info.key}`)?.end === this.ordinal;
      const draft = this.join(
        "paragraphFormat",
        { element: scan.propertiesChange, role: "paragraphFormat", owner: paragraph, blockId },
        info,
        this.ordinal,
        this.ordinal + 1,
        (continues ? "\n" : "") + scan.text,
        null,
        null,
      );
      if (draft.formatChange === null) {
        const table = record.parentTableId === null ? null : this.structure.blockById.get(record.parentTableId);
        draft.formatChange = this.resolver.paragraphFormatChange(
          firstChild(scan.propertiesChange, "w:pPr"),
          pPr,
          tableStyleIdOf(table?.element ?? null),
        );
      }
    }
    this.base = base + length + 1;
    this.ordinal += 1;
  }

  private rowText(row: XmlElement): string {
    const cells: string[] = [];
    for (const cell of rowCells(row)) {
      const texts: string[] = [];
      for (const record of this.structure.blocksByContainer.get(cell) ?? []) {
        if (record.type === "paragraph") texts.push(this.flow.scans.get(record.element)?.text ?? "");
      }
      cells.push(texts.join("\n"));
    }
    return cells.join("\t");
  }

  private otherFormat(changes: XmlElement[], blockId: BlockId, sort: number): void {
    const byKey = new Map<string, Draft>();
    for (const element of changes) {
      const info = infoOf(element);
      let draft = byKey.get(info.key);
      if (draft === undefined) {
        draft = this.draft({ ...info, kind: "format" }, "paragraphFormat", sort);
        draft.formatChange = { before: {}, after: {} };
        byKey.set(info.key, draft);
      }
      const owner = element.parent;
      this.addMember(draft, {
        element,
        role: "otherFormat",
        owner: owner !== null && owner.kind === "element" ? owner : element,
        blockId,
      });
    }
  }

  private table(record: BlockRecord): void {
    const table = record.element;
    const sort = this.base;
    const changes: XmlElement[] = [];
    const tblPr = firstChild(table, "w:tblPr");
    const tblGrid = firstChild(table, "w:tblGrid");
    if (tblPr !== null) changes.push(...childrenNamed(tblPr, new Set(["w:tblPrChange"])));
    if (tblGrid !== null) changes.push(...childrenNamed(tblGrid, new Set(["w:tblGridChange"])));
    let previous: Draft | null = null;
    for (const row of tableRows(table)) {
      changes.push(...childrenNamed(firstChild(row, "w:trPr"), ROW_PROPERTY_CHANGES));
      changes.push(...childrenNamed(firstChild(row, "w:tblPrEx"), new Set(["w:tblPrExChange"])));
      const mark = rowRevisionElement(row);
      let draft: Draft | null = null;
      if (mark !== null) {
        const info = infoOf(mark);
        const outer = this.rowStack[this.rowStack.length - 1];
        if (outer !== undefined && outer.info.key === info.key) draft = outer;
        else if (previous !== null && previous.info.key === info.key) draft = previous;
        else draft = this.draft(info, "tableRow", this.base);
        this.addMember(draft, { element: mark, role: "tableRow", owner: row, blockId: record.id });
        this.rowStack.push(draft);
      }
      for (const cell of rowCells(row)) {
        changes.push(...childrenNamed(firstChild(cell, "w:tcPr"), CELL_PROPERTY_CHANGES));
        this.blocks(this.structure.blocksByContainer.get(cell) ?? []);
      }
      if (draft !== null) {
        this.rowStack.pop();
        draft.text += (draft.text === "" ? "" : "\n") + this.rowText(row);
      }
      previous = draft;
    }
    if (changes.length > 0) this.otherFormat(changes, record.id, sort);
  }

  private blocks(records: readonly BlockRecord[]): void {
    for (const record of records) {
      if (record.type === "paragraph") this.paragraph(record);
      else if (record.type === "table") this.table(record);
      else this.sectionChange(record.element, record.id);
    }
  }

  private sectionChange(sectPr: XmlElement, blockId: BlockId): void {
    const changes = childrenNamed(sectPr, new Set(["w:sectPrChange"]));
    if (changes.length > 0) this.otherFormat(changes, blockId, this.base);
  }

  run(): void {
    this.blocks(this.story.blocks);
    if (this.story.kind === "body") {
      const last = this.story.blocks[this.story.blocks.length - 1];
      const sectPr = firstChild(this.story.container, "w:sectPr");
      if (sectPr !== null && last !== undefined) this.sectionChange(sectPr, last.id);
    }
    this.drafts.sort((a, b) => a.sort - b.sort || a.sequence - b.sequence);
  }
}
