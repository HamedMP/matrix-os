/**
 * The block structure of a document view, indexed for the editor: paragraphs
 * in document order, the container each one is in (a story or a table cell)
 * and its neighbours there. Built from the engine's view for one view mode;
 * rebuilt whenever blocks are created or removed and when the mode changes.
 *
 * Only what the mode shows is indexed: the paragraphs of a table row the mode
 * hides (a pending row deletion in `final`, a pending row insertion in
 * `original`) and of a cell covered by a vertical merge are left out, so no
 * selection, edit or formatting range reaches them.
 */

import type { BlockId, DocxBlock, DocxStory, DocxView, StoryId, StoryKind, TableBlock, TextPosition, TextRange } from "../../../_shared/office-engine/index";
import type { ViewMode } from "./types";
import { markRemoved, rowVisible, runVisible } from "./visibility";

export interface BlockRef {
  id: BlockId;
  type: DocxBlock["type"];
}

export interface ParagraphEntry {
  id: BlockId;
  /** Position among all paragraphs, in the order the editor shows them. */
  order: number;
  /** The story, or the table cell, whose direct child the paragraph is. */
  containerKey: string;
  indexInContainer: number;
  storyId: StoryId;
  storyKind: StoryKind;
  /** The innermost table around the paragraph, or null. */
  tableId: BlockId | null;
}

/** Stories in the order the editor shows them: body, notes, then headers and footers. */
export function storiesInOrder(view: DocxView): DocxStory[] {
  return [view.body, ...view.footnotes, ...view.endnotes, ...view.headers, ...view.footers];
}

export class ModelIndex {
  readonly paragraphs: ParagraphEntry[] = [];
  private readonly byId = new Map<BlockId, ParagraphEntry>();
  private readonly containers = new Map<string, BlockRef[]>();
  private readonly tables = new Set<BlockId>();
  /** Tables that hold something the mode hides: deleting or formatting one whole would reach it. */
  private readonly hidingTables = new Set<BlockId>();
  /** What the mode shows of each table's rows and cells, to tell when an edit changed it. */
  private readonly tableLayouts = new Map<BlockId, string>();
  private mode: ViewMode = "markup";

  /** `mode` is the view the index is for; the default, `markup`, shows every row. */
  static build(view: DocxView, mode: ViewMode = "markup"): ModelIndex {
    const index = new ModelIndex();
    index.mode = mode;
    for (const story of storiesInOrder(view)) index.addContainer(story.id, story.blocks, story, null);
    return index;
  }

  static empty(): ModelIndex {
    return new ModelIndex();
  }

  private addContainer(key: string, blocks: readonly DocxBlock[], story: DocxStory, tableId: BlockId | null): void {
    const refs: BlockRef[] = [];
    this.containers.set(key, refs);
    blocks.forEach((block, at) => {
      refs.push({ id: block.id, type: block.type });
      if (block.type === "paragraph") {
        const entry: ParagraphEntry = {
          id: block.id,
          order: this.paragraphs.length,
          containerKey: key,
          indexInContainer: at,
          storyId: story.id,
          storyKind: story.kind,
          tableId,
        };
        this.paragraphs.push(entry);
        this.byId.set(block.id, entry);
      } else if (block.type === "table") {
        this.tables.add(block.id);
        if (this.hidesContent(block)) this.hidingTables.add(block.id);
        this.tableLayouts.set(block.id, this.layoutOf(block));
        block.rows.forEach((row, rowAt) => {
          if (!rowVisible(row, this.mode)) return;
          row.cells.forEach((cell, cellAt) => {
            if (!cell.mergedAbove) this.addContainer(`${block.id}/${rowAt}/${cellAt}`, cell.blocks, story, block.id);
          });
        });
      }
    });
  }

  /** True when the mode hides a row of the table, a covered cell's text, or text or a paragraph mark in it. */
  private hidesContent(table: TableBlock): boolean {
    const hides = (blocks: readonly DocxBlock[]): boolean =>
      blocks.some((block) => {
        if (block.type === "table") return this.hidesContent(block);
        if (block.type !== "paragraph") return false;
        return markRemoved(block, this.mode) || block.runs.some((run) => !runVisible(run, this.mode));
      });
    return table.rows.some(
      (row) =>
        !rowVisible(row, this.mode) ||
        row.cells.some((cell) => (cell.mergedAbove ? cell.blocks.some((block) => block.type !== "paragraph" || block.text !== "") : hides(cell.blocks))),
    );
  }

  private layoutOf(table: TableBlock): string {
    const rows = table.rows.map((row) => {
      if (!rowVisible(row, this.mode)) return "-";
      return row.cells.map((cell) => (cell.mergedAbove ? "m" : cell.blocks.map((block) => (block.type === "table" ? `[${this.layoutOf(block)}]` : block.id)).join(" "))).join(",");
    });
    return `${this.hidesContent(table) ? "h" : ""}${rows.join("|")}`;
  }

  /**
   * True when one of the given tables now shows other rows or cells in the
   * mode, or starts or stops hiding something, than when the index was built:
   * the index must then be built again, although no block came or went.
   */
  tableLayoutChanged(ids: readonly BlockId[], getBlock: (id: BlockId) => DocxBlock | null): boolean {
    return ids.some((id) => {
      const before = this.tableLayouts.get(id);
      if (before === undefined) return false;
      const block = getBlock(id);
      return block === null || block.type !== "table" || this.layoutOf(block) !== before;
    });
  }

  /** True when a table between two blocks of one container hides something from the mode. */
  private hidingTableBetween(containerKey: string, from: number, to: number): boolean {
    const refs = this.containers.get(containerKey) ?? [];
    return refs.slice(from + 1, to).some((ref) => ref.type === "table" && this.hidingTables.has(ref.id));
  }

  entry(id: BlockId): ParagraphEntry | null {
    return this.byId.get(id) ?? null;
  }

  isTable(id: BlockId): boolean {
    return this.tables.has(id);
  }

  /** The block before a paragraph in its container, or null for the first one. */
  siblingBefore(id: BlockId): BlockRef | null {
    const entry = this.byId.get(id);
    if (entry === undefined) return null;
    return this.containers.get(entry.containerKey)?.[entry.indexInContainer - 1] ?? null;
  }

  siblingAfter(id: BlockId): BlockRef | null {
    const entry = this.byId.get(id);
    if (entry === undefined) return null;
    return this.containers.get(entry.containerKey)?.[entry.indexInContainer + 1] ?? null;
  }

  /** Negative when `a` is before `b` in document order, 0 when equal. Unknown blocks sort last. */
  compare(a: TextPosition, b: TextPosition): number {
    const first = this.byId.get(a.blockId)?.order ?? Number.MAX_SAFE_INTEGER;
    const second = this.byId.get(b.blockId)?.order ?? Number.MAX_SAFE_INTEGER;
    return first !== second ? first - second : a.offset - b.offset;
  }

  /** Every paragraph from one to another in document order, both included. Empty when either is unknown. */
  between(startId: BlockId, endId: BlockId): ParagraphEntry[] {
    const start = this.byId.get(startId);
    const end = this.byId.get(endId);
    if (start === undefined || end === undefined || start.order > end.order) return [];
    return this.paragraphs.slice(start.order, end.order + 1);
  }

  /** The paragraphs of the innermost table around a paragraph, in order; empty outside a table. */
  tableParagraphs(id: BlockId): ParagraphEntry[] {
    const tableId = this.byId.get(id)?.tableId ?? null;
    if (tableId === null) return [];
    return this.paragraphs.filter((entry) => entry.tableId === tableId);
  }

  /**
   * Splits a range into the ranges the engine accepts: both ends in the same
   * paragraph or in sibling paragraphs. A range within one container is
   * returned whole (blocks between its ends, tables included, belong to it),
   * unless a table between its ends holds something the mode hides. Such a
   * range, and one that crosses containers (from the body into a table cell),
   * becomes one range per run of sibling paragraphs: the tables between keep
   * their structure, and only the cells the mode shows are covered.
   *
   * `lengthOf` gives the markup text length of a paragraph.
   */
  engineRanges(range: TextRange, lengthOf: (id: BlockId) => number): TextRange[] {
    const first = this.byId.get(range.start.blockId);
    const last = this.byId.get(range.end.blockId);
    if (first === undefined || last === undefined || this.compare(range.start, range.end) >= 0) return [];
    if (first.containerKey === last.containerKey && !this.hidingTableBetween(first.containerKey, first.indexInContainer, last.indexInContainer)) return [range];
    const ranges: TextRange[] = [];
    let group: ParagraphEntry[] = [];
    const flush = (): void => {
      const head = group[0];
      const tail = group[group.length - 1];
      group = [];
      if (head === undefined || tail === undefined) return;
      const start = head.id === first.id ? range.start : { blockId: head.id, offset: 0 };
      const end = tail.id === last.id ? range.end : { blockId: tail.id, offset: lengthOf(tail.id) };
      if (start.blockId !== end.blockId || start.offset < end.offset) ranges.push({ start, end });
    };
    for (const entry of this.paragraphs.slice(first.order, last.order + 1)) {
      const previous = group[group.length - 1];
      const adjacent = previous !== undefined && previous.containerKey === entry.containerKey && previous.indexInContainer + 1 === entry.indexInContainer;
      if (!adjacent) flush();
      group.push(entry);
    }
    flush();
    return ranges;
  }
}
