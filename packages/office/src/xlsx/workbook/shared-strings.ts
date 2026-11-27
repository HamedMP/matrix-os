/**
 * The shared string table (`xl/sharedStrings.xml`).
 *
 * Existing entries are never changed, so cells that are not edited keep
 * their index and their rich text. New text is appended, reusing an existing
 * plain entry with the same text. An entry no cell uses any more stays. The
 * table states how many cells use it (`count`) and how many entries it has
 * (`uniqueCount`); both are kept true.
 *
 * The table only grows while the part stays within what opening a workbook
 * accepts (XML nodes and part size, {@link SHARED_STRING_LIMITS}). Past that
 * `add` returns null and the cell keeps its text inline instead, so the
 * table, its index and the saved part stay bounded and readable.
 */

import type { XmlChildNode, XmlDocument, XmlElement, XmlNode } from "../../api/xml.js";
import { DEFAULT_ZIP_LIMITS } from "../../opc/limits.js";
import { DEFAULT_XML_LIMITS, appendChild, createElement, getAttr, setAttr, textContent } from "../../xml/index.js";
import { decodeCellText, encodeCellText, isNamed, kid, needsSpacePreserve, qualify } from "./xml-util.js";

/** Text of a string item (`<si>` or `<is>`): its `<t>` and the `<t>` of each run, without phonetic text. */
export function stringItemText(item: XmlElement): string {
  let text = "";
  for (const entry of item.children as readonly XmlChildNode[]) {
    if (entry.kind !== "element") continue;
    if (isNamed(entry.name, "t")) text += textContent(entry);
    else if (isNamed(entry.name, "r")) {
      const run = kid(entry, "t");
      if (run !== null) text += textContent(run);
    }
  }
  return decodeCellText(text);
}

/** True when a string item (`<si>` or `<is>`) is one plain `<t>`: writing its text again gives the same item. */
export function isPlainItem(item: XmlElement): boolean {
  let texts = 0;
  for (const entry of item.children as readonly XmlChildNode[]) {
    if (entry.kind !== "element") continue;
    if (!isNamed(entry.name, "t")) return false;
    texts++;
  }
  return texts === 1;
}

/** How large the shared string part may grow: what opening a workbook accepts. */
export interface SharedStringLimits {
  /** Most XML nodes of the part, as the parser counts them. */
  maxNodes: number;
  /** Most bytes of the serialised part. */
  maxBytes: number;
}

/** The parser's node limit, and the size a package entry may have less room for what serialising adds. */
export const SHARED_STRING_LIMITS: Readonly<SharedStringLimits> = Object.freeze({
  maxNodes: DEFAULT_XML_LIMITS.maxNodes,
  maxBytes: DEFAULT_ZIP_LIMITS.maxEntryBytes - 1024 * 1024,
});

/** Nodes of an appended entry: `<si>`, `<t>` and its text. */
const ENTRY_NODES = 3;
/** Bytes of an appended entry besides its text: `<si><t xml:space="preserve"></t></si>`. */
const ENTRY_BYTES = 40;
/** Bytes of a new part before its first entry. */
const EMPTY_PART_BYTES = 256;

function countNodes(nodes: readonly XmlNode[]): number {
  let count = 0;
  const pending: Array<readonly XmlNode[]> = [nodes];
  while (pending.length > 0) {
    const list = pending.pop() as readonly XmlNode[];
    count += list.length;
    for (const node of list) if (node.kind === "element") pending.push(node.children);
  }
  return count;
}

/** Bytes of text in UTF-8. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 || (code >= 0xd800 && code <= 0xdfff) ? 2 : 3;
  }
  return bytes;
}

/** An upper bound of the bytes text takes in XML: UTF-8, with markup characters escaped. */
export function xmlTextBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x26 || code === 0x3c || code === 0x3e || code === 0x22 || code === 0x27) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

export class SharedStrings {
  /** Null until the workbook has a shared string part. */
  doc: XmlDocument | null;
  dirty = false;
  private readonly texts: string[] = [];
  private readonly plain: boolean[] = [];
  /** The `<si>` elements read from the part, by index; appended entries are plain and not listed. */
  private readonly items: XmlElement[] = [];
  /** Plain text to index, built on the first write. Never larger than the table, which the limits bound. */
  private lookup: Map<string, number> | null = null;
  private readonly limits: Readonly<SharedStringLimits>;
  /** Nodes and bytes of the part, counted when it was read and kept up to date as entries are appended. */
  private nodes = 0;
  private bytes = 0;

  /** `sourceBytes`: the size of the part as read, in bytes. */
  constructor(doc: XmlDocument | null, sourceBytes = 0, limits: Readonly<SharedStringLimits> = SHARED_STRING_LIMITS) {
    this.doc = doc;
    this.limits = limits;
    if (doc === null) return;
    this.nodes = countNodes(doc.children);
    this.bytes = sourceBytes;
    for (const entry of doc.root.children as readonly XmlChildNode[]) {
      if (entry.kind !== "element" || !isNamed(entry.name, "si")) continue;
      this.texts.push(stringItemText(entry));
      this.plain.push(isPlainItem(entry));
      this.items.push(entry);
    }
  }

  /** The `<si>` element at an index when it holds more than one plain text (runs, phonetic text), or null. */
  richItem(index: number): XmlElement | null {
    return this.plain[index] === false ? (this.items[index] ?? null) : null;
  }

  get count(): number {
    return this.texts.length;
  }

  /** Text at an index, or null when the index is out of range. */
  get(index: number): string | null {
    return this.texts[index] ?? null;
  }

  /**
   * Index of a plain entry with this text, appended when there is none.
   * `ensureDoc` creates the part the first time a workbook without one needs
   * it. Null when a new entry would take the part past its limits: the
   * caller then writes the text inline.
   */
  add(text: string, ensureDoc: () => XmlDocument): number | null {
    if (this.lookup === null) {
      this.lookup = new Map();
      for (let i = 0; i < this.texts.length; i++) {
        const existing = this.texts[i] as string;
        if (this.plain[i] === true && !this.lookup.has(existing)) this.lookup.set(existing, i);
      }
    }
    const found = this.lookup.get(text);
    if (found !== undefined) return found;
    const encoded = encodeCellText(text);
    const size = ENTRY_BYTES + xmlTextBytes(encoded);
    const fresh = this.doc === null;
    const nodes = (fresh ? 2 : this.nodes) + ENTRY_NODES;
    const bytes = (fresh ? EMPTY_PART_BYTES : this.bytes) + size;
    if (nodes > this.limits.maxNodes || bytes > this.limits.maxBytes) return null;
    const doc = this.doc ?? (this.doc = ensureDoc());
    const root = doc.root;
    this.nodes = nodes;
    this.bytes = bytes;
    const t = createElement(qualify(root, "t"), needsSpacePreserve(encoded) ? { "xml:space": "preserve" } : undefined, [
      encoded,
    ]);
    appendChild(root, createElement(qualify(root, "si"), undefined, [t]));
    const index = this.texts.length;
    this.texts.push(text);
    this.plain.push(true);
    this.lookup.set(text, index);
    if (getAttr(root, "uniqueCount") !== null) setAttr(root, "uniqueCount", String(index + 1));
    this.dirty = true;
    return index;
  }

  /**
   * Brings the `count` attribute (the number of cells that use the table)
   * up to date. A table that states no count keeps none.
   */
  setReferenceCount(total: number): void {
    const root = this.doc?.root;
    if (root === undefined) return;
    const stated = getAttr(root, "count");
    if (stated === null || stated === String(total)) return;
    setAttr(root, "count", String(total));
    this.dirty = true;
  }
}
