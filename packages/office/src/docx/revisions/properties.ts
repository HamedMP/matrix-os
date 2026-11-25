/**
 * Formatting revisions: `w:rPrChange`, `w:pPrChange` and the property
 * changes of tables, rows, cells and sections. Each holds the properties as
 * they were. Accepting drops the record; rejecting puts the old properties
 * back in place of the current ones.
 */

import type { XmlElement } from "../../api/xml.js";
import { appendChild, createElement, remove, setAttr } from "../../xml/index.js";
import { elementParent, hasElementChildren, insertOrdered } from "../edit/xml-util.js";
import { attr, firstChild } from "../internal.js";

/** Children of the current properties that are not part of what a change record stores, by record name. */
const KEPT: Readonly<Record<string, ReadonlySet<string>>> = {
  // The tracked-change marks of a paragraph mark live next to its run properties.
  "w:rPrChange": new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]),
  "w:pPrChange": new Set(["w:rPr", "w:sectPr"]),
  "w:trPrChange": new Set(["w:ins", "w:del"]),
  "w:tcPrChange": new Set(["w:cellIns", "w:cellDel", "w:cellMerge"]),
  "w:sectPrChange": new Set(["w:headerReference", "w:footerReference"]),
  "w:tblPrChange": new Set(),
  "w:tblPrExChange": new Set(),
  "w:tblGridChange": new Set(),
};

/** True for a record that stores previous properties. */
export function isPropertyChange(name: string): boolean {
  return KEPT[name] !== undefined;
}

/** True for the cell-level structural marks. */
export function isCellMark(name: string): boolean {
  return name === "w:cellIns" || name === "w:cellDel" || name === "w:cellMerge";
}

/**
 * Resolves a property change record. Returns the element whose properties
 * it belongs to (to be marked dirty), or null when the record was detached.
 */
export function resolvePropertyChange(change: XmlElement, accept: boolean): XmlElement | null {
  const properties = elementParent(change);
  if (properties === null) return null;
  const owner = elementParent(properties) ?? properties;
  if (accept) {
    remove(change);
  } else {
    const kept = KEPT[change.name] ?? new Set<string>();
    const old = change.children.find((node): node is XmlElement => node.kind === "element") ?? null;
    remove(change);
    const survivors: XmlElement[] = [];
    for (const node of [...properties.children]) {
      if (node.kind === "element" && kept.has(node.name)) survivors.push(node);
      remove(node);
    }
    // Marks of a paragraph mark and header references come first in their parent; everything else kept comes last.
    const leading = change.name === "w:rPrChange" || change.name === "w:sectPrChange";
    if (leading) for (const node of survivors) appendChild(properties, node);
    if (old !== null) for (const node of [...old.children]) appendChild(properties, node);
    if (!leading) for (const node of survivors) appendChild(properties, node);
    if (change.name === "w:sectPrChange" && old !== null) {
      // Section properties keep part of their state in attributes.
      for (const entry of old.attrs) setAttr(properties, entry.name, entry.value);
    }
  }
  if (!hasElementChildren(properties) && properties.attrs.length === 0 && owner !== properties) {
    // A table keeps its (required) property elements even when they are empty.
    if (properties.name === "w:rPr" || properties.name === "w:pPr" || properties.name === "w:trPr" || properties.name === "w:tcPr") {
      remove(properties);
      if (owner.name === "w:pPr" && !hasElementChildren(owner)) {
        const paragraph = elementParent(owner);
        remove(owner);
        return paragraph;
      }
    }
  }
  return owner;
}

/**
 * Resolves `w:cellMerge`: accepting keeps the merge, rejecting restores the
 * vertical merge state the mark recorded. Cell insertions and deletions are
 * resolved with the cell (see `resolveCellMark`).
 */
function resolveCellMerge(mark: XmlElement, accept: boolean): void {
  const properties = elementParent(mark);
  remove(mark);
  if (accept || properties === null) return;
  const original = attr(mark, "w:vMergeOrig");
  const current = firstChild(properties, "w:vMerge");
  if (current !== null) remove(current);
  if (original !== null) {
    const merge = createElement("w:vMerge", original === "cont" ? [] : [["w:val", "restart"]]);
    insertOrdered(properties, merge, ["w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "*"]);
  }
}

/**
 * Resolves a cell-level mark. Returns the element to mark dirty, or null.
 * A cell that goes (rejected insertion, accepted deletion) is removed from
 * its row.
 */
export function resolveCellMark(mark: XmlElement, accept: boolean): XmlElement | null {
  const properties = elementParent(mark);
  const cell = properties === null ? null : elementParent(properties);
  if (properties === null || cell === null) return null;
  if (mark.name === "w:cellMerge") {
    resolveCellMerge(mark, accept);
    return cell;
  }
  const stays = (mark.name === "w:cellIns") === accept;
  if (stays) {
    remove(mark);
    return cell;
  }
  const row = elementParent(cell);
  remove(cell);
  return row;
}
