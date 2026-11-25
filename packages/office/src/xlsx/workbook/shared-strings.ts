/**
 * The shared string table (`xl/sharedStrings.xml`).
 *
 * Existing entries are never changed, so cells that are not edited keep
 * their index and their rich text. New text is appended, reusing an existing
 * plain entry with the same text. An entry no cell uses any more stays. The
 * table states how many cells use it (`count`) and how many entries it has
 * (`uniqueCount`); both are kept true.
 */

import type { XmlChildNode, XmlDocument, XmlElement } from "../../api/xml.js";
import { appendChild, createElement, getAttr, setAttr, textContent } from "../../xml/index.js";
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

function isPlainItem(item: XmlElement): boolean {
  let texts = 0;
  for (const entry of item.children as readonly XmlChildNode[]) {
    if (entry.kind !== "element") continue;
    if (!isNamed(entry.name, "t")) return false;
    texts++;
  }
  return texts === 1;
}

export class SharedStrings {
  /** Null until the workbook has a shared string part. */
  doc: XmlDocument | null;
  dirty = false;
  private readonly texts: string[] = [];
  private readonly plain: boolean[] = [];
  /** Plain text to index, built on the first write. Never larger than the table. */
  private lookup: Map<string, number> | null = null;

  constructor(doc: XmlDocument | null) {
    this.doc = doc;
    if (doc === null) return;
    for (const entry of doc.root.children as readonly XmlChildNode[]) {
      if (entry.kind !== "element" || !isNamed(entry.name, "si")) continue;
      this.texts.push(stringItemText(entry));
      this.plain.push(isPlainItem(entry));
    }
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
   * `ensureDoc` creates the part the first time a workbook without one needs it.
   */
  add(text: string, ensureDoc: () => XmlDocument): number {
    if (this.lookup === null) {
      this.lookup = new Map();
      for (let i = 0; i < this.texts.length; i++) {
        const existing = this.texts[i] as string;
        if (this.plain[i] === true && !this.lookup.has(existing)) this.lookup.set(existing, i);
      }
    }
    const doc = this.doc ?? (this.doc = ensureDoc());
    const root = doc.root;
    const found = this.lookup.get(text);
    if (found !== undefined) return found;
    const encoded = encodeCellText(text);
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
