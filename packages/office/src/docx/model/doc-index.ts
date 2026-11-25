/**
 * `DocxIndex`: the thin index over the XML trees of one open document.
 *
 * It owns the part store and derives everything else from the trees on
 * demand: block structure, paragraph scans, resolved styles, numbering
 * labels and revisions. Nothing derived is ever written back; after a change
 * to a tree, `markDirty` drops what the change can have affected and the
 * next read rebuilds it.
 */

import type { DocxSnapshot } from "../../api/docx.js";
import type { BlockId, NumberingLabel, StoryId } from "../../api/docx-model.js";
import type { OpcPackage } from "../../api/opc.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { type Flow, type FlowState, buildFlow } from "./flow.js";
import { type ParagraphScan, scanParagraph } from "./inline.js";
import { DEFAULT_DOCX_LIMITS, type DocxLimits } from "./limits.js";
import { type DocxPartKind, WORD_NAMESPACES, attr } from "./names.js";
import { type NumberedParagraph, NumberingDefinitions, computeNumberingLabels } from "./numbering.js";
import { type PartSlot, PartStore, type PartTexts } from "./parts.js";
import { FormatResolver, tableStyleIdOf } from "./resolve.js";
import { type RevisionIdState, type RevisionIndex, buildRevisionIndex } from "./revisions.js";
import { SnapshotManager } from "./snapshot.js";
import { type BlockRecord, type IdState, type StoryRecord, type Structure, buildStructure } from "./structure.js";
import { StyleSheet, readThemeFonts } from "./styles.js";

/** Parts `ensurePart` can create. */
export type CreatablePartKind = "styles" | "numbering" | "settings" | "comments" | "commentsExtended" | "footnotes" | "endnotes";

const NAMESPACE_ATTRIBUTES = WORD_NAMESPACES.map(([name, value]) => `${name}="${value}"`).join(" ");

function separatorNotes(name: string): string {
  return (
    `<w:${name} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${name}>` +
    `<w:${name} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${name}>`
  );
}

const NEW_PART_XML: Readonly<Record<CreatablePartKind, string>> = {
  styles: `<w:styles ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15"/>`,
  numbering: `<w:numbering ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15"/>`,
  settings: `<w:settings ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15"/>`,
  comments: `<w:comments ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15"/>`,
  commentsExtended: `<w15:commentsEx ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15"/>`,
  footnotes: `<w:footnotes ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15">${separatorNotes("footnote")}</w:footnotes>`,
  endnotes: `<w:endnotes ${NAMESPACE_ATTRIBUTES} mc:Ignorable="w14 w15">${separatorNotes("endnote")}</w:endnotes>`,
};

const COMMENT_ID_ELEMENTS: ReadonlySet<string> = new Set([
  "w:comment",
  "w:commentRangeStart",
  "w:commentRangeEnd",
  "w:commentReference",
]);

interface IdCounters {
  nextAnnotation: number;
  nextComment: number;
  nextParaId: number;
  readonly paraIds: Set<string>;
}

export class DocxIndex {
  readonly store: PartStore;
  readonly package: OpcPackage;

  private readonly snapshots: SnapshotManager;
  private readonly blockIds: IdState = { nextBlock: 0, initial: true, used: new Set() };
  private readonly flowState: FlowState = { scanCache: new WeakMap(), nextFieldId: 0 };
  private readonly revisionIds: RevisionIdState = { nextRevision: 0 };
  private counters: IdCounters | null = null;

  private structureCache: Structure | null = null;
  private flowCache: Flow | null = null;
  private resolverCache: FormatResolver | null = null;
  private labelCache: Map<XmlElement, NumberingLabel> | null = null;
  private revisionCache: RevisionIndex | null = null;

  /**
   * `limits` bound the size of the document for as long as the handle lives:
   * the parts as they are parsed, and the structure every time it is built.
   */
  constructor(
    pkg: OpcPackage,
    texts: PartTexts,
    readonly limits: DocxLimits = DEFAULT_DOCX_LIMITS,
  ) {
    this.store = new PartStore(pkg, texts, limits);
    this.package = pkg;
    this.snapshots = new SnapshotManager(this.store);
    this.store.onChange((slot) => this.invalidate(slot));
    // Building the structure now fixes the block ids to the document as it was opened.
    void this.structure;
  }

  private invalidate(slot: PartSlot): void {
    this.structureCache = null;
    this.flowCache = null;
    this.labelCache = null;
    this.revisionCache = null;
    if (slot.kind === "styles" || slot.kind === "numbering" || slot.kind === "theme") this.resolverCache = null;
  }

  /** Stories and blocks. Rebuilt after any change; ids are kept. */
  get structure(): Structure {
    this.structureCache ??= buildStructure(this.store, this.blockIds, this.limits);
    return this.structureCache;
  }

  /** Paragraph scans of every story, with comment anchors and bookmarks. */
  get flow(): Flow {
    this.flowCache ??= buildFlow(this.store, this.flowState, this.structure);
    return this.flowCache;
  }

  get resolver(): FormatResolver {
    if (this.resolverCache === null) {
      const styles = new StyleSheet(this.partRoot("styles"), readThemeFonts(this.partRoot("theme")));
      const numbering = new NumberingDefinitions(this.partRoot("numbering"), (styleId) => {
        const numId = styles.get(styleId)?.paragraph.numId;
        return numId === undefined || numId === "0" ? null : numId;
      });
      this.resolverCache = new FormatResolver(styles, numbering);
    }
    return this.resolverCache;
  }

  /**
   * The numbering label of every numbered paragraph, keyed by its `w:p`, as
   * the markup view shows them: inserted and deleted paragraphs count too.
   * The `final` and `original` exports count only the paragraphs their view
   * keeps (`../export/visibility.ts`).
   */
  get labels(): Map<XmlElement, NumberingLabel> {
    if (this.labelCache === null) {
      const structure = this.structure;
      const resolver = this.resolver;
      const numbered: NumberedParagraph[] = [];
      for (const story of structure.stories) {
        for (const element of story.paragraphs) {
          const record = structure.blockByElement.get(element);
          const table = record?.parentTableId == null ? null : structure.blockById.get(record.parentTableId);
          const numbering = resolver.numberingOf(element, tableStyleIdOf(table?.element ?? null));
          if (numbering !== null) numbered.push({ element, numId: numbering.numId, level: numbering.level });
        }
      }
      this.labelCache = computeNumberingLabels(numbered, resolver.numbering);
    }
    return this.labelCache;
  }

  get revisions(): RevisionIndex {
    this.revisionCache ??= buildRevisionIndex(this.store, this.revisionIds, this.structure, this.flow, this.resolver);
    return this.revisionCache;
  }

  /** The parsed root element of a single-instance part, or null when the document has no such part. */
  partRoot(kind: DocxPartKind): XmlElement | null {
    return this.store.single(kind)?.doc.root ?? null;
  }

  /**
   * The root element of a part, created when the document has none. The new
   * part gets its relationship and content type when the document is saved.
   */
  ensurePart(kind: CreatablePartKind): XmlElement {
    return this.store.ensure(kind, NEW_PART_XML[kind]).doc.root;
  }

  story(id: StoryId): StoryRecord | null {
    return this.structure.storyById.get(id) ?? null;
  }

  block(id: BlockId): BlockRecord | null {
    return this.structure.blockById.get(id) ?? null;
  }

  /** The block record of a `w:p`, `w:tbl` or section `w:sectPr` element that is part of a story, or null. */
  blockOf(element: XmlElement): BlockRecord | null {
    return this.structure.blockByElement.get(element) ?? null;
  }

  /** Like `block`, but throws `stale_reference` for an unknown id and `invalid_operation` for the wrong type. */
  requireBlock(id: BlockId, type?: BlockRecord["type"]): BlockRecord {
    const record = typeof id === "string" ? this.structure.blockById.get(id) : undefined;
    if (record === undefined) {
      throw new OfficeError("stale_reference", "unknown block id", { details: { blockId: String(id) } });
    }
    if (type !== undefined && record.type !== type) {
      throw new OfficeError("invalid_operation", `block is not a ${type}`, {
        details: { blockId: record.id, type: record.type },
      });
    }
    return record;
  }

  /** The blocks of a logical container (`w:body`, a note, a header or a `w:tc`), in order. */
  blocksIn(container: XmlElement): readonly BlockRecord[] {
    return this.structure.blocksByContainer.get(container) ?? [];
  }

  /**
   * The scan of a paragraph of a story. A `w:p` that is not part of a story
   * (a comment paragraph, a detached element) is scanned on its own.
   */
  scan(paragraph: XmlElement | BlockId): ParagraphScan {
    const element = typeof paragraph === "string" ? this.requireBlock(paragraph, "paragraph").element : paragraph;
    return this.flow.scans.get(element) ?? scanParagraph(element, [], -1);
  }

  /**
   * Tells the index that the subtree of `element` changed. Call it after
   * every change to a tree, on the deepest attached element that contains the
   * whole change (after removing a node: on its former parent). The part is
   * written on the next save, the paragraphs of the changed unit are scanned
   * again, and block structure, numbering labels and revisions are rebuilt
   * on the next read. Elements that were not touched keep their ids.
   */
  markDirty(element: XmlElement): void {
    this.store.markDirty(element);
  }

  /**
   * Throws `limit_exceeded` when the parts now hold more XML nodes or
   * characters than the limits of the handle allow. Every edit checks it
   * before it reports success, so a document never grows into one that the
   * same limits refuse to open.
   */
  checkXmlLimits(): void {
    this.store.checkLimits(this.limits);
  }

  /**
   * Gives `to` the identity of `from` (block id, revision id, field id), for
   * an edit that replaces an element with a rebuilt one. `from` should then
   * leave the tree: two attached elements must not share a block id.
   */
  adoptIdentity(from: XmlElement, to: XmlElement): void {
    const tags = this.store.tags.get(from);
    if (tags !== undefined) this.store.tags.set(to, { ...tags });
  }

  private idCounters(): IdCounters {
    if (this.counters !== null) return this.counters;
    let annotation = 0;
    let comment = -1;
    let paraId = 0;
    const paraIds = new Set<string>();
    for (const slot of this.store.list()) {
      if (slot.kind === "styles" || slot.kind === "numbering" || slot.kind === "theme" || slot.kind === "coreProperties") {
        continue;
      }
      const stack: XmlElement[] = [slot.doc.root];
      while (stack.length > 0) {
        const element = stack.pop() as XmlElement;
        const id = attr(element, "w:id");
        if (id !== null && /^-?\d{1,15}$/.test(id)) {
          const value = Number(id);
          if (value > annotation) annotation = value;
          if (COMMENT_ID_ELEMENTS.has(element.name) && value > comment) comment = value;
        }
        const para = attr(element, "w14:paraId") ?? attr(element, "w15:paraId");
        if (para !== null && /^[0-9A-Fa-f]{1,8}$/.test(para)) {
          paraIds.add(para.toUpperCase().padStart(8, "0"));
          const value = Number.parseInt(para, 16);
          if (value > paraId) paraId = value;
        }
        for (const node of element.children) if (node.kind === "element") stack.push(node);
      }
    }
    this.counters = { nextAnnotation: annotation + 1, nextComment: comment + 1, nextParaId: paraId + 1, paraIds };
    return this.counters;
  }

  /**
   * A `w:id` for a new revision, bookmark or range marker: a decimal number
   * no element of the document carries. Never repeats within the handle, not
   * even after `restore`.
   */
  allocateAnnotationId(): string {
    const counters = this.idCounters();
    const id = counters.nextAnnotation;
    counters.nextAnnotation += 1;
    return String(id);
  }

  /** A `w:id` for a new comment, unique among the comments of the document. */
  allocateCommentId(): string {
    const counters = this.idCounters();
    const id = counters.nextComment;
    counters.nextComment += 1;
    // Comment ids share the annotation space in some readers; keep the two apart.
    if (counters.nextAnnotation <= id) counters.nextAnnotation = id + 1;
    return String(id);
  }

  /** A `w14:paraId`: eight upper-case hex digits below 0x80000000 that no paragraph of the document uses. */
  allocateParaId(): string {
    const counters = this.idCounters();
    for (let attempt = 0; attempt < 0x7fffffff; attempt++) {
      if (counters.nextParaId >= 0x7fffffff || counters.nextParaId < 1) counters.nextParaId = 1;
      const id = counters.nextParaId.toString(16).toUpperCase().padStart(8, "0");
      counters.nextParaId += 1;
      if (!counters.paraIds.has(id)) {
        counters.paraIds.add(id);
        return id;
      }
    }
    throw new OfficeError("limit_exceeded", "no free paragraph id");
  }

  snapshot(): DocxSnapshot {
    // Ids are handed out when the derived data is built; do that first so the copies carry them.
    void this.structure;
    void this.flow;
    void this.revisions;
    return this.snapshots.take();
  }

  restore(snapshot: DocxSnapshot): void {
    this.snapshots.restore(snapshot);
    // A restore can drop or bring back whole parts, styles and numbering among them.
    this.structureCache = null;
    this.flowCache = null;
    this.labelCache = null;
    this.revisionCache = null;
    this.resolverCache = null;
  }

  save(): Promise<Uint8Array> {
    return this.store.save();
  }
}
