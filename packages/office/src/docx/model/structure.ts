/**
 * The block structure of a document: its stories and, in each story, the
 * paragraphs, tables and section breaks in document order.
 *
 * This is an index over the XML trees, rebuilt from them whenever a part
 * changes. Block identity lives on the XML element (see `ElementTags`), so a
 * rebuild gives every surviving block the id it had before.
 */

import type { BlockId, HeaderFooterType, StoryId, StoryKind } from "../../api/docx-model.js";
import type { PartName } from "../../api/opc.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { partNameKey } from "../../opc/index.js";
import { findAll } from "../../xml/index.js";
import { DEFAULT_DOCX_LIMITS, type DocxLimits, documentTooLarge } from "./limits.js";
import { TRANSPARENT_BLOCK, attr, firstChild } from "./names.js";
import { toRoman } from "./number-format.js";
import { type PartSlot, type PartStore, containerOf } from "./parts.js";

export interface StoryRecord {
  readonly id: StoryId;
  readonly kind: StoryKind;
  readonly label: string;
  /** The element whose blocks are the story: `w:body`, `w:hdr`, `w:ftr`, `w:footnote` or `w:endnote`. */
  readonly container: XmlElement;
  readonly partName: PartName;
  /** `w:id` of a footnote or endnote, else null. */
  readonly noteId: string | null;
  /** The reference mark of a note as displayed (`3`, `iv`), else null. */
  readonly noteMark: string | null;
  /** Top-level blocks in order. */
  readonly blocks: BlockRecord[];
  /** Every paragraph of the story in document order, paragraphs in table cells included. */
  readonly paragraphs: XmlElement[];
}

export interface BlockRecord {
  readonly id: BlockId;
  readonly type: "paragraph" | "table" | "sectionBreak";
  /**
   * The `w:p` or `w:tbl` element. For a section break: the `w:sectPr` inside
   * the `w:pPr` of the last paragraph of the section.
   */
  readonly element: XmlElement;
  readonly storyId: StoryId;
  /** The logical container: the story container, or the `w:tc` of a table cell. */
  readonly container: XmlElement;
  /** The table that directly contains the block, or null at the top level of a story. */
  readonly parentTableId: BlockId | null;
  /** The top-level block of the story that holds this block (the block itself at the top level). */
  readonly topLevelId: BlockId;
  /** Position among the blocks of `container`. */
  readonly indexInContainer: number;
}

export interface SectionRecord {
  /** The `w:sectPr`, or null for a document that declares no section at all. */
  readonly element: XmlElement | null;
  readonly headers: Partial<Record<HeaderFooterType, StoryId>>;
  readonly footers: Partial<Record<HeaderFooterType, StoryId>>;
}

export interface Structure {
  readonly stories: StoryRecord[];
  readonly storyById: Map<StoryId, StoryRecord>;
  readonly blockById: Map<BlockId, BlockRecord>;
  readonly blockByElement: Map<XmlElement, BlockRecord>;
  /** Blocks of each logical container, in order. */
  readonly blocksByContainer: Map<XmlElement, BlockRecord[]>;
  readonly sections: SectionRecord[];
  /** Bookmarks that start between blocks, mapped to the paragraph that follows them. */
  readonly blockLevelBookmarks: Map<string, XmlElement>;
}

/** Counters that outlive a rebuild, so ids are never reused. */
export interface IdState {
  nextBlock: number;
  /** True until the first structure is built: only then are ids taken from `w14:paraId`. */
  initial: boolean;
  /** Ids ever handed out. Grows with the blocks ever created in this handle. */
  readonly used: Set<BlockId>;
}

/** Children of `parent` named in `wanted`, looking through content-control and custom-XML wrappers. */
export function expandChildren(parent: XmlElement, wanted: ReadonlySet<string>): XmlElement[] {
  const found: XmlElement[] = [];
  collectChildren(parent, wanted, found, 0);
  return found;
}

function collectChildren(parent: XmlElement, wanted: ReadonlySet<string>, found: XmlElement[], depth: number): void {
  const nodes = parent.children;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as XmlChildNode;
    if (node.kind !== "element") continue;
    if (wanted.has(node.name)) found.push(node);
    // Wrappers nest a few levels at most; the parser bounds the depth of the tree.
    else if (TRANSPARENT_BLOCK.has(node.name) && depth < 512) collectChildren(node, wanted, found, depth + 1);
  }
}

const BLOCK_NAMES: ReadonlySet<string> = new Set(["w:p", "w:tbl", "w:bookmarkStart"]);
const ROW_NAMES: ReadonlySet<string> = new Set(["w:tr"]);
const CELL_NAMES: ReadonlySet<string> = new Set(["w:tc"]);

export function tableRows(table: XmlElement): XmlElement[] {
  return expandChildren(table, ROW_NAMES);
}

export function rowCells(row: XmlElement): XmlElement[] {
  return expandChildren(row, CELL_NAMES);
}

/** The `w:sectPr` that ends a section inside this paragraph, or null. */
export function paragraphSectPr(paragraph: XmlElement): XmlElement | null {
  const pPr = firstChild(paragraph, "w:pPr");
  return pPr === null ? null : firstChild(pPr, "w:sectPr");
}

const HEADER_LABELS: Record<HeaderFooterType, string> = {
  default: "",
  first: " (first page)",
  even: " (even pages)",
};

function referenceType(value: string | null): HeaderFooterType {
  return value === "first" || value === "even" ? value : "default";
}

class Builder {
  readonly structure: Structure = {
    stories: [],
    storyById: new Map(),
    blockById: new Map(),
    blockByElement: new Map(),
    blocksByContainer: new Map(),
    sections: [],
    blockLevelBookmarks: new Map(),
  };

  private blockCount = 0;
  private rowCount = 0;
  private cellCount = 0;

  constructor(
    private readonly store: PartStore,
    private readonly ids: IdState,
    private readonly limits: DocxLimits,
  ) {}

  private idFor(element: XmlElement): BlockId {
    const tags = this.store.tags.get(element);
    if (tags?.blockId !== undefined) return tags.blockId;
    this.ids.nextBlock += 1;
    let id: BlockId = `b${this.ids.nextBlock}`;
    if (this.ids.initial && element.name === "w:p") {
      const paraId = attr(element, "w14:paraId");
      if (paraId !== null && /^[0-9A-Fa-f]{1,8}$/.test(paraId) && !this.ids.used.has(`p_${paraId.toUpperCase()}`)) {
        id = `p_${paraId.toUpperCase()}`;
      }
    }
    this.ids.used.add(id);
    if (tags === undefined) this.store.tags.set(element, { blockId: id });
    else tags.blockId = id;
    return id;
  }

  private walk(
    container: XmlElement,
    story: StoryRecord,
    parentTableId: BlockId | null,
    topLevelId: BlockId | null,
    pendingBookmarks: string[],
  ): BlockRecord[] {
    const records: BlockRecord[] = [];
    const add = (type: BlockRecord["type"], element: XmlElement): BlockRecord => {
      this.blockCount += 1;
      if (this.blockCount > this.limits.maxBlocks) throw documentTooLarge("maxBlocks", this.limits.maxBlocks);
      const id = this.idFor(element);
      const record: BlockRecord = {
        id,
        type,
        element,
        storyId: story.id,
        container,
        parentTableId,
        topLevelId: topLevelId ?? id,
        indexInContainer: records.length,
      };
      records.push(record);
      this.structure.blockById.set(id, record);
      this.structure.blockByElement.set(element, record);
      return record;
    };
    for (const element of expandChildren(container, BLOCK_NAMES)) {
      if (element.name === "w:bookmarkStart") {
        const name = attr(element, "w:name");
        if (name !== null) pendingBookmarks.push(name);
      } else if (element.name === "w:p") {
        add("paragraph", element);
        story.paragraphs.push(element);
        for (const name of pendingBookmarks.splice(0)) {
          if (!this.structure.blockLevelBookmarks.has(name)) this.structure.blockLevelBookmarks.set(name, element);
        }
        const sectPr = story.kind === "body" && parentTableId === null ? paragraphSectPr(element) : null;
        if (sectPr !== null) add("sectionBreak", sectPr);
      } else {
        const table = add("table", element);
        const rows = tableRows(element);
        this.rowCount += rows.length;
        if (this.rowCount > this.limits.maxTableRows) throw documentTooLarge("maxTableRows", this.limits.maxTableRows);
        for (const row of rows) {
          const cells = rowCells(row);
          this.cellCount += cells.length;
          if (this.cellCount > this.limits.maxTableCells) throw documentTooLarge("maxTableCells", this.limits.maxTableCells);
          for (const cell of cells) this.walk(cell, story, table.id, table.topLevelId, pendingBookmarks);
        }
      }
    }
    this.structure.blocksByContainer.set(container, records);
    return records;
  }

  addStory(
    id: StoryId,
    kind: StoryKind,
    label: string,
    container: XmlElement,
    slot: PartSlot,
    noteId: string | null,
    mark: string | null,
  ): void {
    if (this.structure.storyById.has(id)) return;
    const story: StoryRecord = {
      id,
      kind,
      label,
      container,
      partName: slot.name,
      noteId,
      noteMark: mark,
      blocks: [],
      paragraphs: [],
    };
    this.structure.stories.push(story);
    this.structure.storyById.set(id, story);
    story.blocks.push(...this.walk(container, story, null, null, []));
  }
}

const SECTION_SOURCES: ReadonlySet<string> = new Set(["w:p", "w:sectPr"]);

function sectionProperties(body: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  let last: XmlElement | null = null;
  for (const element of expandChildren(body, SECTION_SOURCES)) {
    if (element.name === "w:sectPr") last = element;
    else {
      const sectPr = paragraphSectPr(element);
      if (sectPr !== null) found.push(sectPr);
    }
  }
  if (last !== null) found.push(last);
  return found;
}

function noteElements(slot: PartSlot | null, name: string): XmlElement[] {
  if (slot === null) return [];
  const notes: XmlElement[] = [];
  for (const node of slot.doc.root.children) {
    if (node.kind !== "element" || node.name !== name) continue;
    const type = attr(node, "w:type");
    if (type === null || type === "normal") notes.push(node);
  }
  return notes;
}

/**
 * Builds the structure. Throws `limit_exceeded` when the stories together
 * hold more blocks, table rows or table cells than `limits` allows.
 */
export function buildStructure(store: PartStore, ids: IdState, limits: DocxLimits = DEFAULT_DOCX_LIMITS): Structure {
  const builder = new Builder(store, ids, limits);
  const pkg = store.package;
  const main = store.main();
  const body = containerOf(main.doc);
  builder.addStory("body", "body", "Body", body, main, null, null);

  // Headers and footers, in the order the sections reference them.
  const sectPrs = sectionProperties(body);
  const sections: SectionRecord[] = [];
  const pendingStories: Array<{ kind: "header" | "footer"; slot: PartSlot; type: HeaderFooterType }> = [];
  let inherited: Pick<SectionRecord, "headers" | "footers"> = { headers: {}, footers: {} };
  for (const sectPr of sectPrs) {
    const record: SectionRecord = {
      element: sectPr,
      headers: { ...inherited.headers },
      footers: { ...inherited.footers },
    };
    for (const node of sectPr.children) {
      if (node.kind !== "element") continue;
      const kind = node.name === "w:headerReference" ? "header" : node.name === "w:footerReference" ? "footer" : null;
      if (kind === null) continue;
      const relationshipId = attr(node, "r:id");
      const relationship = relationshipId === null ? null : pkg.getRelationship(main.name, relationshipId);
      if (relationship === null || relationship.targetMode !== "Internal") continue;
      const slot = store.get(pkg.resolveTarget(main.name, relationship.target));
      if (slot === null || slot.kind !== kind) continue;
      const type = referenceType(attr(node, "w:type"));
      (kind === "header" ? record.headers : record.footers)[type] = `${kind}:${slot.name}`;
      pendingStories.push({ kind, slot, type });
    }
    sections.push(record);
    inherited = record;
  }
  if (sections.length === 0) sections.push({ element: null, headers: {}, footers: {} });
  builder.structure.sections.push(...sections);
  for (const kind of ["header", "footer"] as const) {
    const referenced = pendingStories.filter((entry) => entry.kind === kind);
    const others = store
      .ofKind(kind)
      .filter((slot) => !referenced.some((entry) => partNameKey(entry.slot.name) === partNameKey(slot.name)))
      .map((slot) => ({ kind, slot, type: "default" as HeaderFooterType }));
    for (const entry of [...referenced, ...others]) {
      const title = kind === "header" ? "Header" : "Footer";
      builder.addStory(
        `${kind}:${entry.slot.name}`,
        kind,
        `${title}${HEADER_LABELS[entry.type]}`,
        entry.slot.doc.root,
        entry.slot,
        null,
        null,
      );
    }
  }

  // Notes, in the order the body refers to them; notes nothing refers to come last.
  for (const kind of ["footnote", "endnote"] as const) {
    const slot = store.single(kind === "footnote" ? "footnotes" : "endnotes");
    const notes = noteElements(slot, `w:${kind}`);
    if (slot === null || notes.length === 0) continue;
    const byId = new Map<string, XmlElement>();
    for (const note of notes) {
      const id = attr(note, "w:id");
      if (id !== null && !byId.has(id)) byId.set(id, note);
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const reference of findAll(body, `w:${kind}Reference`)) {
      const id = attr(reference, "w:id");
      if (id !== null && byId.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    for (const id of byId.keys()) if (!seen.has(id)) ordered.push(id);
    ordered.forEach((id, index) => {
      const mark = noteMark(kind, index + 1);
      const label = `${kind === "footnote" ? "Footnote" : "Endnote"} ${mark}`;
      builder.addStory(`${kind}:${id}`, kind, label, byId.get(id) as XmlElement, slot, id, mark);
    });
  }
  ids.initial = false;
  return builder.structure;
}

/** The reference mark of the nth note: `3` for a footnote, `iii` for an endnote. */
export function noteMark(kind: "footnote" | "endnote", ordinal: number): string {
  return kind === "footnote" ? String(ordinal) : toRoman(ordinal).toLowerCase();
}
