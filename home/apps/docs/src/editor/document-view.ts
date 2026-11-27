/**
 * Owns the DOM of the document: a page-width sheet with the body, the notes
 * and a read-only header and footer. It renders the engine's view model and
 * keeps the DOM in step with it by re-rendering only blocks whose view
 * changed (each block element remembers a signature of what it shows).
 *
 * In the `final` and `original` views a paragraph whose mark the view drops
 * runs on into the next paragraph: the following paragraph's element is
 * placed inside the first one that shows content, and CSS lays it out inline.
 * A paragraph with nothing to show that has nowhere to run on to is left out,
 * as resolving the revision would remove it.
 */

import type { BlockId, DocxBlock, DocxStory, DocxView, ParagraphBlock, ResolvedParagraphStyle, RunFormat, SectionBreakBlock, TableBlock } from "../../../_shared/office-engine/index";
import { BLOCK_ID, BLOCK_TYPE, type HighlightSpan, TAIL, renderParagraph } from "./render-paragraph";
import type { ViewMode } from "./types";
import { hasVisibleContent, markRemoved, rowVisible, tableVisible } from "./visibility";

const NO_SPANS: readonly HighlightSpan[] = Object.freeze([]);

interface PlanItem {
  block: DocxBlock;
  /** Paragraphs that run on into `block` in this view, in order. */
  merged: ParagraphBlock[];
}

export interface DocumentViewOptions {
  ariaLabel: string;
  /** Run formatting before a formatting revision, for the `original` view. */
  formatBefore(revisionId: string): Partial<RunFormat> | null;
  /** Paragraph style before the paragraph's pending format change, for the `original` view. */
  styleBefore(blockId: BlockId): ResolvedParagraphStyle | null;
}

export class DocumentView {
  /** The sheet: page width and margins. */
  readonly page: HTMLElement;
  /** The single editing surface: body and notes. */
  readonly content: HTMLElement;
  private readonly header: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly body: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly doc: Document;
  private readonly options: DocumentViewOptions;
  private readonly elements = new Map<BlockId, HTMLElement>();
  private readonly signatures = new Map<BlockId, string>();
  private readonly structure = new Map<BlockId, string>();
  private readonly noteStories = new Map<string, HTMLElement>();
  private spans = new Map<BlockId, HighlightSpan[]>();
  private viewMode: ViewMode = "markup";
  /** Part of every signature in the `original` view, whose rendering also depends on the revision list. */
  private generation = 0;

  constructor(host: HTMLElement, options: DocumentViewOptions) {
    this.doc = host.ownerDocument;
    this.options = options;
    const make = (className: string, parent: HTMLElement): HTMLElement => {
      const element = this.doc.createElement("div");
      element.className = className;
      parent.append(element);
      return element;
    };
    this.page = make("doc-page", host);
    this.header = make("doc-header", this.page);
    this.content = make("doc-content", this.page);
    this.footer = make("doc-footer", this.page);
    this.body = make("doc-story doc-story-body", this.content);
    this.notes = make("doc-notes", this.content);
    this.header.setAttribute("contenteditable", "false");
    this.footer.setAttribute("contenteditable", "false");
    this.content.setAttribute("role", "textbox");
    this.content.setAttribute("aria-multiline", "true");
    this.content.setAttribute("aria-label", options.ariaLabel);
    this.content.setAttribute("spellcheck", "true");
    this.content.tabIndex = 0;
  }

  get mode(): ViewMode {
    return this.viewMode;
  }

  /** Changes the view mode. The caller renders afterwards. */
  setMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.page.setAttribute("data-view-mode", mode);
  }

  setEditable(editable: boolean): void {
    this.content.setAttribute("contenteditable", editable ? "true" : "false");
    this.content.setAttribute("aria-readonly", editable ? "false" : "true");
  }

  /** Replaces the highlight spans of all blocks. The caller refreshes the affected blocks. */
  setSpans(spans: Map<BlockId, HighlightSpan[]>): void {
    this.spans = spans;
  }

  /** The element that shows a block, or null when the view does not show it. */
  element(id: BlockId): HTMLElement | null {
    const element = this.elements.get(id);
    return element !== undefined && element.isConnected ? element : null;
  }

  /** Makes the next render build these blocks again even when their view did not change. */
  invalidate(ids: Iterable<BlockId>): void {
    for (const id of ids) this.signatures.delete(id);
  }

  /** Brings the whole DOM in step with a view. Elements of unchanged blocks are kept. */
  render(view: DocxView | null): void {
    this.generation++;
    const placed = new Set<BlockId>();
    if (view === null) {
      for (const container of [this.header, this.body, this.notes, this.footer]) container.replaceChildren();
      this.noteStories.clear();
    } else {
      const section = view.sections[0];
      if (section !== undefined) {
        this.page.style.width = `${section.pageWidthPt}pt`;
        this.page.style.minHeight = `${section.pageHeightPt}pt`;
        this.page.style.padding = `${section.marginTopPt}pt ${section.marginRightPt}pt ${section.marginBottomPt}pt ${section.marginLeftPt}pt`;
      }
      const storyOf = (stories: readonly DocxStory[], id: string | undefined): DocxStory | null => stories.find((story) => story.id === id) ?? null;
      this.fill(this.header, storyOf(view.headers, section?.headers.default)?.blocks ?? [], placed);
      this.fill(this.footer, storyOf(view.footers, section?.footers.default)?.blocks ?? [], placed);
      this.fill(this.body, view.body.blocks, placed);
      this.renderNotes([...view.footnotes, ...view.endnotes], placed);
    }
    for (const [id, element] of this.elements) {
      if (placed.has(id)) continue;
      element.remove();
      this.elements.delete(id);
      this.signatures.delete(id);
      this.structure.delete(id);
    }
  }

  /**
   * Re-renders single blocks in place. Returns false when that is not enough
   * (a block appeared, vanished or changed how it joins its neighbours) and
   * the caller must `render` the whole view.
   */
  refresh(ids: readonly BlockId[], getBlock: (id: BlockId) => DocxBlock | null): boolean {
    if (this.viewMode === "original") this.generation++;
    for (const id of ids) {
      const block = getBlock(id);
      const current = this.elements.get(id);
      if (block === null || current === undefined || !current.isConnected) return false;
      if (block.type === "paragraph" && this.structureKey(block) !== this.structure.get(id)) return false;
      if (block.type === "table" && !tableVisible(block, this.viewMode)) return false;
      const next = this.elementFor(block, new Set());
      if (next !== current) current.replaceWith(next);
    }
    return true;
  }

  private renderNotes(stories: readonly DocxStory[], placed: Set<BlockId>): void {
    const wanted: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const story of stories) {
      let element = this.noteStories.get(story.id);
      if (element === undefined) {
        element = this.doc.createElement("div");
        element.className = `doc-story doc-note doc-note-${story.kind}`;
        element.setAttribute("data-story-id", story.id);
        this.noteStories.set(story.id, element);
      }
      seen.add(story.id);
      this.fill(element, story.blocks, placed);
      wanted.push(element);
    }
    for (const id of [...this.noteStories.keys()]) if (!seen.has(id)) this.noteStories.delete(id);
    this.place(this.notes, wanted);
  }

  /** Makes `wanted` the children of `container`, in order, moving as little as possible. */
  private place(container: HTMLElement, wanted: readonly HTMLElement[]): void {
    const keep = new Set<Node>(wanted);
    let cursor = container.firstChild;
    const drop = (node: ChildNode): ChildNode | null => {
      const next = node.nextSibling;
      node.remove();
      return next;
    };
    for (const element of wanted) {
      // A child that is no longer wanted goes first, so the ones after it need not move.
      while (cursor !== null && cursor !== element && !keep.has(cursor)) cursor = drop(cursor);
      if (cursor === element) cursor = cursor.nextSibling;
      else container.insertBefore(element, cursor);
    }
    while (cursor !== null) cursor = drop(cursor);
  }

  private fill(container: HTMLElement, blocks: readonly DocxBlock[], placed: Set<BlockId>): void {
    const wanted: HTMLElement[] = [];
    for (const item of this.plan(blocks)) {
      const element = this.elementFor(item.block, placed);
      placed.add(item.block.id);
      if (item.block.type === "paragraph") {
        const merged = item.merged.map((block) => {
          placed.add(block.id);
          return this.elementFor(block, placed);
        });
        this.syncMerged(element, merged);
      }
      wanted.push(element);
    }
    this.place(container, wanted);
  }

  /** What a container shows in this view: its blocks, with paragraphs that run on grouped under their host. */
  private plan(blocks: readonly DocxBlock[]): PlanItem[] {
    const items: PlanItem[] = [];
    for (let at = 0; at < blocks.length; at++) {
      const block = blocks[at] as DocxBlock;
      if (block.type === "table") {
        if (tableVisible(block, this.viewMode)) items.push({ block, merged: [] });
        continue;
      }
      if (block.type === "sectionBreak") {
        items.push({ block, merged: [] });
        continue;
      }
      const chain: ParagraphBlock[] = [block];
      while (markRemoved(chain[chain.length - 1] as ParagraphBlock, this.viewMode)) {
        const next = blocks[at + 1];
        if (next === undefined || next.type !== "paragraph") break;
        chain.push(next);
        at++;
      }
      const last = chain[chain.length - 1] as ParagraphBlock;
      let host = chain.findIndex((member) => hasVisibleContent(member, this.viewMode));
      // Nothing to show: the last paragraph stands as an empty line, unless its own mark is gone too.
      if (host < 0) host = markRemoved(last, this.viewMode) ? -1 : chain.length - 1;
      if (host >= 0) items.push({ block: chain[host] as ParagraphBlock, merged: chain.slice(host + 1) });
    }
    return items;
  }

  private syncMerged(host: HTMLElement, merged: readonly HTMLElement[]): void {
    const current = Array.from(host.children).filter((child) => child.getAttribute(BLOCK_TYPE) === "paragraph");
    if (current.length === merged.length && current.every((child, at) => child === merged[at])) return;
    const wanted = new Set<Element>(merged);
    for (const child of current) if (!wanted.has(child)) child.remove();
    const tail = Array.from(host.children).find((child) => child.hasAttribute(TAIL)) ?? null;
    for (const element of merged) host.insertBefore(element, tail);
  }

  private structureKey(block: ParagraphBlock): string {
    if (this.viewMode === "markup") return "markup";
    return `${markRemoved(block, this.viewMode) ? 1 : 0}${hasVisibleContent(block, this.viewMode) ? 1 : 0}`;
  }

  private spansKey(block: DocxBlock): string {
    if (this.spans.size === 0) return "";
    if (block.type === "paragraph") {
      const spans = this.spans.get(block.id);
      return spans === undefined ? "" : JSON.stringify(spans);
    }
    if (block.type !== "table") return "";
    let key = "";
    for (const row of block.rows) for (const cell of row.cells) for (const inner of cell.blocks) key += this.spansKey(inner);
    return key;
  }

  private signature(block: DocxBlock): string {
    const salt = this.viewMode === "original" ? this.generation : 0;
    return `${this.viewMode}|${salt}|${this.spansKey(block)}|${JSON.stringify(block)}`;
  }

  /** The element of a block: the cached one when its view did not change, else a new one. */
  private elementFor(block: DocxBlock, placed: Set<BlockId>): HTMLElement {
    const signature = this.signature(block);
    const cached = this.elements.get(block.id);
    if (cached !== undefined && this.signatures.get(block.id) === signature) {
      if (block.type === "table") this.markPlaced(block, placed);
      return cached;
    }
    let element: HTMLElement;
    if (block.type === "paragraph") {
      element = renderParagraph(this.doc, block, {
        mode: this.viewMode,
        highlights: this.spans.get(block.id) ?? NO_SPANS,
        formatBefore: this.options.formatBefore,
        styleBefore: this.options.styleBefore,
      });
      this.structure.set(block.id, this.structureKey(block));
      // Paragraphs that run on into the old element move to the new one.
      if (cached !== undefined) this.syncMerged(element, Array.from(cached.children).filter((child): child is HTMLElement => child.getAttribute(BLOCK_TYPE) === "paragraph"));
    } else if (block.type === "table") {
      element = this.renderTable(block, placed);
    } else {
      element = this.renderSectionBreak(block);
    }
    this.elements.set(block.id, element);
    this.signatures.set(block.id, signature);
    return element;
  }

  private markPlaced(table: TableBlock, placed: Set<BlockId>): void {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        for (const inner of cell.blocks) {
          placed.add(inner.id);
          if (inner.type === "table") this.markPlaced(inner, placed);
        }
      }
    }
  }

  private renderTable(block: TableBlock, placed: Set<BlockId>): HTMLElement {
    const table = this.doc.createElement("table");
    table.className = "doc-table";
    table.setAttribute(BLOCK_ID, block.id);
    table.setAttribute(BLOCK_TYPE, "table");
    if (block.columnWidthsPt.length > 0) {
      const group = this.doc.createElement("colgroup");
      for (const width of block.columnWidthsPt) {
        const column = this.doc.createElement("col");
        column.style.width = `${width}pt`;
        group.append(column);
      }
      table.append(group);
    }
    const body = this.doc.createElement("tbody");
    table.append(body);
    block.rows.forEach((row, rowAt) => {
      if (!rowVisible(row, this.viewMode)) return;
      const tr = this.doc.createElement("tr");
      tr.setAttribute("data-row", String(rowAt));
      if (row.isHeader) tr.classList.add("doc-row-header");
      if (this.viewMode === "markup" && row.revision !== null) {
        tr.classList.add("doc-row-rev", `doc-row-rev-${row.revision.kind}`);
        tr.setAttribute("data-revision-id", row.revision.revisionId);
      }
      row.cells.forEach((cell, cellAt) => {
        // A cell that continues a vertical merge is covered by the cell above it.
        if (cell.mergedAbove) return;
        const td = this.doc.createElement(row.isHeader ? "th" : "td");
        td.className = "doc-cell";
        td.setAttribute("data-cell", String(cellAt));
        if (cell.colSpan > 1) td.colSpan = cell.colSpan;
        if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
        if (cell.fill !== null) td.style.backgroundColor = cell.fill;
        this.fill(td, cell.blocks, placed);
        tr.append(td);
      });
      body.append(tr);
    });
    return table;
  }

  private renderSectionBreak(block: SectionBreakBlock): HTMLElement {
    const element = this.doc.createElement("div");
    element.className = "doc-section-break";
    element.setAttribute(BLOCK_ID, block.id);
    element.setAttribute(BLOCK_TYPE, "sectionBreak");
    element.setAttribute("data-break", block.breakType);
    element.setAttribute("contenteditable", "false");
    element.setAttribute("aria-label", "Section break");
    return element;
  }
}
