/**
 * Carries content of the revised document over into the result, which is
 * built on the package of the original: copies of paragraphs, rows, tables
 * and runs are detached from everything that only exists in the revised
 * package (relationships, images, notes, styles, numbering, bookmarks,
 * comments) and attached to its counterpart in the result.
 */

import type { PartName } from "../../api/opc.js";
import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { partNameKey, relativeTargetFor } from "../../opc/index.js";
import {
  appendChild,
  cloneNode,
  createElement,
  insertBefore,
  lookupNamespace,
  prefixOf,
  prependChild,
  remove,
  removeAttr,
  setAttr,
} from "../../xml/index.js";
import { type DocxIndex, attr, childVal, firstChild } from "../internal.js";
import { revisionElement, wrapParagraphContent } from "./markup.js";
import { type MediaTable, mediaKey } from "./media.js";
import { type Para, nodesInRange } from "./runs.js";
import type { ContentKind, Stamp } from "./types.js";

/** Where a copy comes from and where it goes. */
export interface ImportContext {
  /** The part of the revised document the content is in. */
  readonly sourcePart: PartName;
  /** The part of the result it goes into. */
  readonly targetPart: PartName;
  /** An attached element of the result near the place of insertion, for namespace lookups. */
  readonly targetScope: XmlElement;
}

const DROPPED: ReadonlySet<string> = new Set([
  "w:commentRangeStart",
  "w:commentRangeEnd",
  "w:commentReference",
  "w:permStart",
  "w:permEnd",
  "w:proofErr",
  "w:sectPr",
  "w:pPrChange",
  "w:rPrChange",
]);
const STYLE_REFERENCES: ReadonlySet<string> = new Set(["w:pStyle", "w:rStyle", "w:tblStyle"]);
const OBJECT_ROOTS: ReadonlySet<string> = new Set(["w:drawing", "w:pict", "w:object", "mc:AlternateContent"]);
const FIELD_PARTS: ReadonlySet<string> = new Set(["w:fldChar", "w:instrText"]);
const LOCAL_IDS: ReadonlySet<string> = new Set(["w14:paraId", "w14:textId"]);
/** Children of `w:pPr` that come before `w:numPr` in the schema order. */
const BEFORE_NUMBERING: ReadonlySet<string> = new Set(["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl"]);

function collectValues(root: XmlElement | null, element: string, attribute: string): Set<string> {
  const found = new Set<string>();
  if (root === null) return found;
  for (const node of root.children) {
    if (node.kind !== "element" || node.name !== element) continue;
    const value = attr(node, attribute);
    if (value !== null) found.add(value);
  }
  return found;
}

function walk(root: XmlElement, visit: (element: XmlElement) => void): void {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    visit(element);
    for (let position = element.children.length - 1; position >= 0; position--) {
      const node = element.children[position] as XmlChildNode;
      if (node.kind === "element") stack.push(node);
    }
  }
}

function isAttached(root: XmlElement, element: XmlElement): boolean {
  let scope: XmlElement["parent"] = element;
  while (scope !== null && scope.kind === "element") {
    if (scope === root) return true;
    scope = scope.parent;
  }
  return false;
}

export class Importer {
  private readonly styleIds: Set<string>;
  private readonly numIds: Set<string>;
  private readonly bookmarkNames = new Set<string>();
  private readonly links = new Map<string, string>();
  private readonly images = new Map<string, string>();
  private readonly notes = new Map<string, string | null>();
  private readonly nextNoteId = { footnote: 0, endnote: 0 };
  private readonly propertyCache = new WeakMap<XmlElement, XmlElement>();
  private mediaCount = 0;
  /** Notes created in the result, as `footnote:<id>` / `endnote:<id>`. */
  readonly createdNotes: string[] = [];

  constructor(
    private readonly target: DocxIndex,
    private readonly source: DocxIndex,
    private readonly sourceMedia: MediaTable,
    private readonly stamp: Stamp,
  ) {
    this.styleIds = collectValues(target.partRoot("styles"), "w:style", "w:styleId");
    this.numIds = collectValues(target.partRoot("numbering"), "w:num", "w:numId");
    for (const slot of target.store.list()) {
      if (slot.kind !== "document" && slot.kind !== "header" && slot.kind !== "footer" && slot.kind !== "footnotes" && slot.kind !== "endnotes") {
        continue;
      }
      walk(slot.doc.root, (element) => {
        if (element.name !== "w:bookmarkStart") return;
        const name = attr(element, "w:name");
        if (name !== null) this.bookmarkNames.add(name);
      });
    }
  }

  /** A relationship of the result that points at the same external target. */
  private externalRelationship(type: string, targetAddress: string, context: ImportContext): string | null {
    const pkg = this.target.package;
    if (!pkg.hasPart(context.targetPart)) return null;
    const key = `${partNameKey(context.targetPart)}\n${type}\n${targetAddress}`;
    let id = this.links.get(key);
    if (id === undefined) {
      const existing = pkg
        .getRelationshipsByType(context.targetPart, type)
        .find((entry) => entry.targetMode === "External" && entry.target === targetAddress);
      id = (existing ?? pkg.addRelationship(context.targetPart, { type, target: targetAddress, targetMode: "External" })).id;
      this.links.set(key, id);
    }
    return id;
  }

  /** Copies an image of the revised document into the result and returns the relationship id for it. */
  private imageRelationship(relationshipId: string, context: ImportContext): string | null {
    const item = this.sourceMedia.get(mediaKey(context.sourcePart, relationshipId));
    const pkg = this.target.package;
    if (item === undefined || !pkg.hasPart(context.targetPart)) return null;
    const key = `${partNameKey(context.targetPart)}\n${item.signature}\n${item.extension}`;
    let id = this.images.get(key);
    if (id === undefined) {
      let name: PartName;
      do {
        this.mediaCount += 1;
        name = `/word/media/compared${this.mediaCount}.${item.extension}`;
      } while (pkg.hasPart(name));
      pkg.setPart(name, item.bytes, item.contentType ?? "application/octet-stream");
      id = pkg.addRelationship(context.targetPart, {
        type: item.relationshipType,
        target: relativeTargetFor(context.targetPart, name),
      }).id;
      this.images.set(key, id);
    }
    return id;
  }

  /**
   * Rewrites a relationship reference of a copy. Returns false when the thing
   * it refers to cannot be carried over.
   */
  private relationship(element: XmlElement, name: string, value: string, context: ImportContext): boolean {
    const relationship = this.source.package.getRelationship(context.sourcePart, value);
    let id: string | null = null;
    if (relationship !== null && relationship.targetMode === "External") {
      id = this.externalRelationship(relationship.type, relationship.target, context);
    } else if (relationship !== null) {
      id = this.imageRelationship(value, context);
    }
    if (id === null) return false;
    setAttr(element, name, id);
    return true;
  }

  /** Copies a note of the revised document into the result, all of it inserted, and returns its new id. */
  private note(kind: "footnote" | "endnote", sourceId: string): string | null {
    const key = `${kind}:${sourceId}`;
    const known = this.notes.get(key);
    if (known !== undefined) return known;
    this.notes.set(key, null);
    const story = this.source.story(key);
    if (story === null) return null;
    const root = this.target.ensurePart(kind === "footnote" ? "footnotes" : "endnotes");
    const slot = this.target.store.single(kind === "footnote" ? "footnotes" : "endnotes");
    if (slot === null) return null;
    if (this.nextNoteId[kind] === 0) {
      let highest = 0;
      for (const node of root.children) {
        if (node.kind !== "element") continue;
        const id = Number(attr(node, "w:id") ?? "");
        if (Number.isInteger(id) && id > highest) highest = id;
      }
      this.nextNoteId[kind] = highest + 1;
    }
    const id = String(this.nextNoteId[kind]);
    this.nextNoteId[kind] += 1;
    const copy = cloneNode(story.container);
    setAttr(copy, "w:id", id);
    removeAttr(copy, "w:type");
    this.adopt(copy, story.container, { sourcePart: story.partName, targetPart: slot.name, targetScope: root });
    walk(copy, (element) => {
      if (element.name === "w:p") wrapParagraphContent(element, "ins", this.stamp);
    });
    appendChild(root, copy);
    this.target.markDirty(root);
    this.notes.set(key, id);
    this.createdNotes.push(`${kind}:${id}`);
    return id;
  }

  /** Removes field characters and codes when a copy holds only part of a field. */
  private balanceFields(copy: XmlElement, always: boolean): void {
    let depth = 0;
    let broken = always;
    const parts: XmlElement[] = [];
    walk(copy, (element) => {
      if (!FIELD_PARTS.has(element.name)) return;
      parts.push(element);
      if (element.name !== "w:fldChar") return;
      const type = attr(element, "w:fldCharType");
      if (type === "begin") depth += 1;
      else if (type === "end") depth -= 1;
      if (depth < 0) broken = true;
    });
    if (depth !== 0) broken = true;
    if (broken) for (const element of parts) remove(element);
  }

  /** Declares on the copy the namespace prefixes it uses that the place of insertion binds differently. */
  private declareNamespaces(copy: XmlElement, source: XmlElement, context: ImportContext): void {
    const needed = new Set<string>();
    const visit = (element: XmlElement, declared: ReadonlySet<string>): void => {
      let scope = declared;
      for (const entry of element.attrs) {
        if (entry.name === "xmlns" || entry.name.startsWith("xmlns:")) {
          if (scope === declared) scope = new Set(declared);
          (scope as Set<string>).add(entry.name === "xmlns" ? "" : entry.name.slice(6));
        }
      }
      const use = (prefix: string): void => {
        if (prefix !== "xml" && prefix !== "xmlns" && !scope.has(prefix)) needed.add(prefix);
      };
      use(prefixOf(element.name));
      for (const entry of element.attrs) {
        const prefix = prefixOf(entry.name);
        if (prefix !== "" && !entry.name.startsWith("xmlns")) use(prefix);
      }
      for (const node of element.children) if (node.kind === "element") visit(node, scope);
    };
    visit(copy, new Set());
    for (const prefix of needed) {
      const uri = lookupNamespace(source, prefix);
      if (uri === null || uri === lookupNamespace(context.targetScope, prefix)) continue;
      setAttr(copy, prefix === "" ? "xmlns" : `xmlns:${prefix}`, uri);
    }
  }

  /**
   * Makes a detached copy of content of the revised document fit the
   * result. `source` is the element of the revised document it was copied from.
   */
  adopt(copy: XmlElement, source: XmlElement, context: ImportContext, stripFields = false): void {
    const elements: XmlElement[] = [];
    walk(copy, (element) => elements.push(element));
    const bookmarkIds = new Map<string, { id: string; start: XmlElement; closed: boolean }>();
    for (const element of elements) {
      if (element !== copy && !isAttached(copy, element)) continue;
      const name = element.name;
      if (DROPPED.has(name)) {
        if (element !== copy) remove(element);
        continue;
      }
      if (STYLE_REFERENCES.has(name)) {
        if (!this.styleIds.has(attr(element, "w:val") ?? "")) remove(element);
        continue;
      }
      if (name === "w:numPr") {
        const numId = childVal(element, "w:numId");
        if (numId !== null && numId !== "0" && !this.numIds.has(numId)) remove(element);
        continue;
      }
      if (name === "w:bookmarkStart") {
        const bookmark = attr(element, "w:name");
        const oldId = attr(element, "w:id");
        if (bookmark === null || oldId === null || this.bookmarkNames.has(bookmark)) {
          remove(element);
        } else {
          const id = this.stamp.nextId();
          setAttr(element, "w:id", id);
          bookmarkIds.set(oldId, { id, start: element, closed: false });
          this.bookmarkNames.add(bookmark);
        }
        continue;
      }
      if (name === "w:bookmarkEnd") {
        const entry = bookmarkIds.get(attr(element, "w:id") ?? "");
        if (entry === undefined || entry.closed) remove(element);
        else {
          setAttr(element, "w:id", entry.id);
          entry.closed = true;
        }
        continue;
      }
      if (name === "w:footnoteReference" || name === "w:endnoteReference") {
        const id = this.note(name === "w:footnoteReference" ? "footnote" : "endnote", attr(element, "w:id") ?? "");
        if (id === null) remove(element);
        else setAttr(element, "w:id", id);
        continue;
      }
      for (const entry of [...element.attrs]) {
        if (LOCAL_IDS.has(entry.name)) {
          removeAttr(element, entry.name);
        } else if (entry.name.startsWith("r:") && !this.relationship(element, entry.name, entry.value, context)) {
          if (name === "w:hyperlink") {
            removeAttr(element, entry.name);
            continue;
          }
          // The object cannot be carried over: it goes, with the drawing that holds it.
          let doomed: XmlElement = element;
          for (let scope: XmlElement["parent"] = element; scope !== null && scope.kind === "element" && scope !== copy; scope = scope.parent) {
            if (OBJECT_ROOTS.has(scope.name)) doomed = scope;
          }
          if (doomed !== copy) remove(doomed);
          break;
        }
      }
    }
    for (const entry of bookmarkIds.values()) {
      if (!entry.closed) remove(entry.start);
    }
    this.balanceFields(copy, stripFields);
    this.declareNamespaces(copy, source, context);
  }

  /** A copy of a paragraph, table or row of the revised document, ready to be inserted. */
  block(source: XmlElement, context: ImportContext): XmlElement {
    const copy = cloneNode(source);
    this.adopt(copy, source, context);
    return copy;
  }

  /**
   * The run properties of a run of the revised document as the result would
   * hold them, or null when the run has none. The returned element is shared:
   * clone it before attaching it.
   */
  runProperties(run: XmlElement | null): XmlElement | null {
    const rPr = run === null || run.name !== "w:r" ? null : firstChild(run, "w:rPr");
    if (rPr === null) return null;
    let copy = this.propertyCache.get(rPr);
    if (copy === undefined) {
      copy = cloneNode(rPr);
      for (const node of [...copy.children]) {
        if (node.kind !== "element") continue;
        if (node.name === "w:rPrChange" || (node.name === "w:rStyle" && !this.styleIds.has(attr(node, "w:val") ?? ""))) remove(node);
      }
      this.propertyCache.set(rPr, copy);
    }
    return copy;
  }

  /** True when the run uses a character style the result does not define. */
  hasForeignRunStyle(run: XmlElement | null): boolean {
    const rPr = run === null ? null : firstChild(run, "w:rPr");
    const style = rPr === null ? null : childVal(rPr, "w:rStyle");
    return style !== null && !this.styleIds.has(style);
  }

  /**
   * The paragraph properties of a paragraph of the revised document as the
   * result would hold them: a detached copy, or null. Where the revised
   * paragraph uses a style or a list the result does not define, the one of
   * `fallback` (the `w:pPr` of its counterpart in the original) is kept.
   */
  paragraphProperties(paragraph: XmlElement, context: ImportContext, fallback: XmlElement | null = null): XmlElement | null {
    const pPr = firstChild(paragraph, "w:pPr");
    if (pPr === null) return null;
    const copy = cloneNode(pPr);
    this.adopt(copy, pPr, context);
    if (fallback === null) return copy;
    const style = firstChild(fallback, "w:pStyle");
    if (style !== null && firstChild(pPr, "w:pStyle") !== null && firstChild(copy, "w:pStyle") === null) {
      prependChild(copy, cloneNode(style));
    }
    const numbering = firstChild(fallback, "w:numPr");
    if (numbering !== null && firstChild(pPr, "w:numPr") !== null && firstChild(copy, "w:numPr") === null) {
      const after = copy.children.find((node) => node.kind === "element" && !BEFORE_NUMBERING.has(node.name));
      if (after !== undefined) insertBefore(after, cloneNode(numbering));
      else appendChild(copy, cloneNode(numbering));
    }
    return copy;
  }

  /**
   * The text of `[start, end)` of a paragraph of the revised document as
   * nodes to insert: its runs in a revision element of the given kind, inside
   * a copy of the hyperlink they belong to.
   */
  inline(para: Para, start: number, end: number, kind: ContentKind, context: ImportContext): XmlChildNode[] {
    const result: XmlChildNode[] = [];
    let group: { link: XmlElement | null; wrapper: XmlElement } | null = null;
    const links: Array<{ copy: XmlElement; source: XmlElement }> = [];
    for (const node of nodesInRange(para, start, end, this.stamp)) {
      let link: XmlElement | null = null;
      for (let scope: XmlElement["parent"] = node.parent; scope !== null && scope.kind === "element" && scope !== para.element; scope = scope.parent) {
        if (scope.name === "w:hyperlink") link = scope;
      }
      if (group === null || group.link !== link) {
        const wrapper = revisionElement(kind, this.stamp);
        group = { link, wrapper };
        if (link === null) {
          result.push(wrapper);
        } else {
          const copy = createElement(
            link.name,
            link.attrs.map((entry) => [entry.name, entry.value] as const),
            [wrapper],
          );
          links.push({ copy, source: link });
          result.push(copy);
        }
      }
      const copy = cloneNode(node);
      this.adopt(copy, node, context, true);
      appendChild(group.wrapper, copy);
    }
    for (const { copy, source } of links) {
      for (const entry of [...copy.attrs]) {
        if (entry.name.startsWith("r:") && !this.relationship(copy, entry.name, entry.value, context)) removeAttr(copy, entry.name);
      }
      this.declareNamespaces(copy, source, context);
    }
    return result;
  }
}
