/**
 * The parsed parts of one document: the XML trees that ARE the document.
 *
 * A {@link PartSlot} holds one part as a lossless tree. A slot is written
 * back to the package only when its tree changed, so a document saved without
 * edits keeps every part byte for byte.
 *
 * Change tracking works on units. A unit is a child of the part's container
 * (`w:body` in the main part, the root element everywhere else): a top-level
 * paragraph or table, one footnote, one comment, one style. `markDirty` stamps
 * the unit that holds the changed element; cached paragraph scans and the
 * frozen copies kept for snapshots are valid while their unit's stamp is
 * unchanged.
 */

import type { OpcPackage, PartName } from "../../api/opc.js";
import type { XmlChildNode, XmlDocument, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { findPartByRelationshipType, partNameKey, relativeTargetFor } from "../../opc/index.js";
import { parseXml, serializeXml } from "../../xml/index.js";
import { DEFAULT_DOCX_LIMITS, type DocxLimits, countNodes, documentTooLarge, measureXml } from "./limits.js";
import { type DocxPartKind, type DocxSlotKind, PART_KINDS, firstChild, isWordMainContentType } from "./names.js";

/** Identity the index attaches to XML elements. Copied with the element into snapshots. */
export interface ElementTags {
  blockId?: string;
  revisionId?: string;
  fieldId?: string;
}

/** A frozen, detached copy of a part: the tree outside the container, and one copy per unit. */
export interface FrozenPart {
  readonly skeleton: XmlDocument;
  readonly units: readonly XmlChildNode[];
}

export interface PartSlot {
  readonly name: PartName;
  readonly kind: DocxSlotKind;
  doc: XmlDocument;
  /** Token of the current tree state. Changes on every `markDirty`; restored by `restore`. */
  version: number;
  /** The version the package holds, or -1 for a part that is not in the package yet. */
  packageVersion: number;
  /** Stamp of the last change that was not inside a unit. */
  wholeStamp: number;
  /** Set for a part the model created: how to register it in the package on save. */
  readonly created: { readonly relationshipType: string; readonly contentType: string } | null;
  frozen: { readonly version: number; readonly epoch: number; readonly part: FrozenPart } | null;
  skeleton: { readonly stamp: number; readonly doc: XmlDocument } | null;
}

export type PartChangeListener = (slot: PartSlot) => void;

/** Texts of the parts to parse, keyed by `partNameKey`. */
export type PartTexts = ReadonlyMap<string, string>;

function corrupt(message: string, partName: string): OfficeError {
  return new OfficeError("corrupt_package", message, { details: { part: partName } });
}

/** The container whose children are the units of a part. */
export function containerOf(doc: XmlDocument): XmlElement {
  const root = doc.root;
  if (root.name === "w:document") return firstChild(root, "w:body") ?? root;
  return root;
}

/** Names of the parts `openDocx` has to read before the model can be built, main part first. */
export function discoverParts(pkg: OpcPackage): Array<{ name: PartName; kind: DocxSlotKind }> {
  const main = findPartByRelationshipType(
    pkg,
    "/",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
  );
  if (main === null) {
    throw new OfficeError("unsupported_format", "the package has no main document part");
  }
  if (!isWordMainContentType(pkg.getContentType(main))) {
    throw new OfficeError("unsupported_format", "the package is not a word-processing document", {
      details: { contentType: pkg.getContentType(main) },
    });
  }
  const found: Array<{ name: PartName; kind: DocxSlotKind }> = [{ name: main, kind: "document" }];
  const seen = new Set<string>([partNameKey(main)]);
  const add = (name: PartName | null, kind: DocxSlotKind): void => {
    if (name === null || seen.has(partNameKey(name))) return;
    seen.add(partNameKey(name));
    found.push({ name, kind });
  };
  const singles: DocxPartKind[] = [
    "styles",
    "numbering",
    "settings",
    "comments",
    "commentsExtended",
    "footnotes",
    "endnotes",
    "theme",
  ];
  for (const kind of singles) {
    if (kind === "document" || kind === "coreProperties") continue;
    add(findPartByRelationshipType(pkg, main, ...PART_KINDS[kind].relationshipTypes), kind);
  }
  for (const kind of ["header", "footer"] as const) {
    for (const relationship of pkg.getRelationships(main)) {
      if (relationship.targetMode !== "Internal") continue;
      if (!PART_KINDS[kind].relationshipTypes.includes(relationship.type)) continue;
      const target = pkg.resolveTarget(main, relationship.target);
      if (pkg.hasPart(target)) add(target, kind);
    }
  }
  add(findPartByRelationshipType(pkg, "/", ...PART_KINDS.coreProperties.relationshipTypes), "coreProperties");
  return found;
}

/**
 * The bytes of a serialised part. Parts are written as UTF-8 unless their XML
 * declaration names UTF-16, which is then honoured so the declaration stays true.
 */
function encodePart(doc: XmlDocument): Uint8Array | string {
  const text = serializeXml(doc);
  const first = doc.children[0];
  const encoding = first !== undefined && first.kind === "declaration" ? first.encoding : null;
  if (encoding === null || !/^utf-?16/i.test(encoding)) return text;
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    bytes[2 + index * 2] = unit & 0xff;
    bytes[3 + index * 2] = unit >> 8;
  }
  return bytes;
}

export class PartStore {
  readonly package: OpcPackage;
  readonly mainPartName: PartName;
  /** Identity attached to elements; see {@link ElementTags}. */
  readonly tags = new WeakMap<XmlElement, ElementTags>();
  /**
   * Counts the times an id that an element already carried was replaced
   * (revisions regrouped by an edit elsewhere). Frozen copies made before
   * such a change no longer describe the live elements.
   */
  retagEpoch = 0;

  private readonly slots = new Map<string, PartSlot>();
  private readonly slotByDoc = new WeakMap<XmlDocument, PartSlot>();
  private readonly unitStamps = new WeakMap<XmlChildNode, number>();
  private readonly listeners: PartChangeListener[] = [];
  /** The size of each slot's tree at a version, so a part that did not change is not walked again. */
  private readonly sizes = new WeakMap<PartSlot, { readonly version: number; readonly doc: XmlDocument; readonly nodes: number; readonly chars: number }>();
  /** Parts the model added to the package in an earlier save, with the relationship that points at them. */
  private readonly registered = new Map<string, { name: PartName; relationshipId: string | null }>();
  private clock = 0;

  /**
   * Parses the parts named by `discoverParts`. `texts` must hold the text of
   * each of them. Throws `corrupt_package` when the main part is not a
   * document with a body, `malformed_xml` when a part is not well formed and
   * `limit_exceeded` when the parts together hold more XML than `limits` allows.
   */
  constructor(pkg: OpcPackage, texts: PartTexts, limits: DocxLimits = DEFAULT_DOCX_LIMITS) {
    this.package = pkg;
    const parts = discoverParts(pkg);
    this.mainPartName = (parts[0] as { name: PartName }).name;
    let chars = 0;
    let nodes = 0;
    for (const part of parts) {
      const text = texts.get(partNameKey(part.name));
      if (text === undefined) {
        throw new OfficeError("invalid_argument", "the text of a document part was not supplied", {
          details: { part: part.name },
        });
      }
      chars += text.length;
      if (chars > limits.maxXmlChars) throw documentTooLarge("maxXmlChars", limits.maxXmlChars);
      // Each part is parsed with what the parts before it left of the node budget.
      const budget = limits.maxNodes - nodes;
      if (budget < 1) throw documentTooLarge("maxNodes", limits.maxNodes);
      let doc: XmlDocument;
      try {
        doc = parseXml(text, { maxNodes: budget });
      } catch (error) {
        // The theme only supplies font names; a broken one must not make the document unreadable.
        if (part.kind === "theme" && error instanceof OfficeError && error.code === "malformed_xml") continue;
        if (error instanceof OfficeError && error.code === "limit_exceeded" && error.details.limit === "maxNodes") {
          throw documentTooLarge("maxNodes", limits.maxNodes);
        }
        throw error;
      }
      nodes += countNodes(doc);
      this.addSlot({
        name: part.name,
        kind: part.kind,
        doc,
        version: 0,
        packageVersion: 0,
        wholeStamp: 0,
        created: null,
        frozen: null,
        skeleton: null,
      });
    }
    const main = this.main();
    if (main.doc.root.name !== "w:document" || firstChild(main.doc.root, "w:body") === null) {
      throw corrupt("the main part is not a word-processing document with a body", main.name);
    }
  }

  private addSlot(slot: PartSlot): void {
    this.slots.set(partNameKey(slot.name), slot);
    this.slotByDoc.set(slot.doc, slot);
  }

  main(): PartSlot {
    return this.slots.get(partNameKey(this.mainPartName)) as PartSlot;
  }

  /** All slots in the order they were discovered or created. */
  list(): PartSlot[] {
    return [...this.slots.values()];
  }

  get(name: PartName): PartSlot | null {
    return this.slots.get(partNameKey(name)) ?? null;
  }

  /** The slot of a single-instance kind, or null when the document has no such part. */
  single(kind: DocxPartKind): PartSlot | null {
    for (const slot of this.slots.values()) if (slot.kind === kind) return slot;
    return null;
  }

  ofKind(kind: DocxSlotKind): PartSlot[] {
    return this.list().filter((slot) => slot.kind === kind);
  }

  onChange(listener: PartChangeListener): void {
    this.listeners.push(listener);
  }

  /** A fresh, never repeated number: stamps, versions and id counters all draw from it. */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  /** The slot whose tree holds `node`, or null for a detached node. */
  slotOf(node: XmlElement): PartSlot | null {
    let scope: XmlElement["parent"] = node;
    while (scope !== null && scope.kind === "element") scope = scope.parent;
    return scope === null ? null : (this.slotByDoc.get(scope) ?? null);
  }

  /** The unit that holds `node` (possibly `node` itself), or null when `node` is the container or above it. */
  unitOf(node: XmlElement, slot: PartSlot): XmlElement | null {
    const container = containerOf(slot.doc);
    let scope: XmlElement = node;
    for (;;) {
      const parent: XmlElement["parent"] = scope.parent;
      if (parent === null || parent.kind !== "element") return null;
      if (parent === container) return scope;
      scope = parent;
    }
  }

  /** Stamp of the last change to a unit. */
  unitStamp(unit: XmlChildNode, slot: PartSlot): number {
    return Math.max(this.unitStamps.get(unit) ?? 0, slot.wholeStamp);
  }

  /** Stamp of the last change that can have affected `node`, or -1 for a detached node. */
  stampFor(node: XmlElement): number {
    const slot = this.slotOf(node);
    if (slot === null) return -1;
    const unit = this.unitOf(node, slot);
    return unit === null ? slot.wholeStamp : this.unitStamp(unit, slot);
  }

  /**
   * Records that the subtree of `node` changed: the part will be written on
   * save and everything cached for the unit that holds `node` is dropped.
   * `node` must be attached; after removing an element, pass its former parent.
   */
  markDirty(node: XmlElement): void {
    const slot = this.slotOf(node);
    if (slot === null) {
      throw new OfficeError("invalid_operation", "markDirty needs an element that is attached to a document part");
    }
    const stamp = this.tick();
    const unit = this.unitOf(node, slot);
    if (unit === null) slot.wholeStamp = stamp;
    else this.unitStamps.set(unit, stamp);
    slot.version = stamp;
    for (const listener of this.listeners) listener(slot);
  }

  /**
   * Returns the slot of a single-instance part, creating the part with the
   * given root element when the document has none. The package itself is only
   * touched on save.
   */
  ensure(kind: Exclude<DocxPartKind, "document" | "theme" | "coreProperties">, rootXml: string): PartSlot {
    const existing = this.single(kind);
    if (existing !== null) return existing;
    const info = PART_KINDS[kind];
    let name = info.defaultName;
    const taken = (candidate: string): boolean => {
      const key = partNameKey(candidate);
      // A name the model registered itself and lost through `restore` is free again.
      return this.slots.has(key) || (this.package.hasPart(candidate) && !this.registered.has(key));
    };
    for (let attempt = 2; taken(name); attempt++) {
      if (attempt > 1000) throw new OfficeError("limit_exceeded", "no free part name", { details: { kind } });
      name = info.defaultName.replace(/\.xml$/, `${attempt}.xml`);
    }
    const stamp = this.tick();
    const slot: PartSlot = {
      name,
      kind,
      doc: parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${rootXml}`),
      version: stamp,
      packageVersion: -1,
      wholeStamp: stamp,
      created: { relationshipType: info.relationshipTypes[0] as string, contentType: info.contentType },
      frozen: null,
      skeleton: null,
    };
    this.addSlot(slot);
    for (const listener of this.listeners) listener(slot);
    return slot;
  }

  /** Replaces the tree of a slot (restore). The caller sets `version`. */
  replaceDoc(slot: PartSlot, doc: XmlDocument): void {
    slot.doc = doc;
    this.slotByDoc.set(doc, slot);
  }

  /** Puts back a slot that a snapshot holds and the store no longer has. */
  reinstate(slot: PartSlot): void {
    // The package may hold what another slot of the same name wrote since: write this one again.
    slot.packageVersion = -1;
    this.addSlot(slot);
  }

  /** Drops a slot (restore to a state before the part was created). */
  drop(slot: PartSlot): void {
    this.slots.delete(partNameKey(slot.name));
  }

  /** Tells every listener that the trees changed as a whole. */
  notifyAll(): void {
    for (const slot of this.slots.values()) for (const listener of this.listeners) listener(slot);
  }

  /**
   * Throws `limit_exceeded` when the parts together now hold more XML than
   * `limits` allows: a document that `openDocx` with the same limits would
   * refuse to open once saved. Edits call it before they report success.
   */
  checkLimits(limits: DocxLimits): void {
    let nodes = 0;
    let chars = 0;
    for (const slot of this.slots.values()) {
      let size = this.sizes.get(slot);
      if (size === undefined || size.version !== slot.version || size.doc !== slot.doc) {
        size = { version: slot.version, doc: slot.doc, ...measureXml(slot.doc) };
        this.sizes.set(slot, size);
      }
      nodes += size.nodes;
      chars += size.chars;
    }
    if (chars > limits.maxXmlChars) throw documentTooLarge("maxXmlChars", limits.maxXmlChars);
    if (nodes > limits.maxNodes) throw documentTooLarge("maxNodes", limits.maxNodes);
  }

  /** Writes changed parts into the package and serialises it. */
  async save(): Promise<Uint8Array> {
    const pkg = this.package;
    for (const [key, entry] of this.registered) {
      if (this.slots.has(key)) continue;
      // A part the model created, saved, and then lost through `restore`.
      pkg.removePart(entry.name);
      if (entry.relationshipId !== null) pkg.removeRelationship(this.mainPartName, entry.relationshipId);
      this.registered.delete(key);
    }
    for (const slot of this.slots.values()) {
      if (slot.version === slot.packageVersion) continue;
      if (!this.registerCreated(slot)) pkg.setPart(slot.name, encodePart(slot.doc));
      slot.packageVersion = slot.version;
    }
    return pkg.save();
  }

  /**
   * Puts a part the model created into the package now, with its content
   * type and its relationship from the main part, instead of on the next
   * save. Content that adds relationships of its own to the part (a link or
   * an image in a new note) needs the part to exist first. Returns false when
   * the slot is not a created part that the package lacks.
   */
  registerCreated(slot: PartSlot): boolean {
    const pkg = this.package;
    if (slot.created === null || pkg.hasPart(slot.name)) return false;
    const key = partNameKey(slot.name);
    pkg.setPart(slot.name, encodePart(slot.doc), slot.created.contentType);
    const existing = pkg
      .getRelationshipsByType(this.mainPartName, slot.created.relationshipType)
      .find((entry) => entry.targetMode === "Internal" && partNameKey(pkg.resolveTarget(this.mainPartName, entry.target)) === key);
    const relationship =
      existing ??
      pkg.addRelationship(this.mainPartName, {
        type: slot.created.relationshipType,
        target: relativeTargetFor(this.mainPartName, slot.name),
      });
    this.registered.set(key, { name: slot.name, relationshipId: existing ? null : relationship.id });
    return true;
  }
}
