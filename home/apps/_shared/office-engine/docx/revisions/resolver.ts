/** Resolves the XML elements of tracked changes, one by one, where they stand. */

import type { XmlElement } from "../../api/xml.js";
import { createElement, insertBefore, remove } from "../../xml/index.js";
import {
  clearMarkRevisions,
  mergeParagraphs,
  nextContentBlock,
  previousContentBlock,
  pruneParagraphProps,
  removeBlock,
  sectionBreakOf,
} from "../edit/marks.js";
import { setContentDeleted } from "../edit/text.js";
import { fieldNodesToKeep, hoistAnchorsBefore, rescueAnchors } from "../edit/anchors.js";
import { elementParent, hasElementChildren, isAttached, removeEmptyWrappers } from "../edit/xml-util.js";
import type { DocxIndex, RevisionGroup } from "../internal.js";
import { REVISION_CONTAINERS, attr, closest, rowCells, tableRows } from "../internal.js";
import { isCellMark, isPropertyChange, resolveCellMark, resolvePropertyChange } from "./properties.js";

const MOVE_MARKERS: ReadonlySet<string> = new Set([
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  "w:moveToRangeStart",
  "w:moveToRangeEnd",
]);

type Place = "content" | "mark" | "row" | "property" | "cell" | "record";

/** What a revision element is, read from where it sits. */
function placeOf(element: XmlElement): Place | null {
  const parent = elementParent(element);
  if (parent === null) return null;
  if (REVISION_CONTAINERS.has(element.name)) {
    if (parent.name === "w:trPr") return "row";
    if (parent.name === "w:rPr" && elementParent(parent)?.name === "w:pPr") return "mark";
    return "content";
  }
  if (isPropertyChange(element.name)) return "property";
  if (isCellMark(element.name)) return "cell";
  return element.name.endsWith("Change") ? "record" : null;
}

export class Resolver {
  private readonly content: XmlElement[] = [];
  private readonly marks: XmlElement[] = [];
  private readonly rows: XmlElement[] = [];
  private readonly properties: XmlElement[] = [];
  private readonly cells: XmlElement[] = [];
  private readonly records: XmlElement[] = [];
  private readonly moveNames = new Set<string>();
  /** Field characters that stay when the dropped content goes; see `fieldNodesToKeep`. */
  private fieldKeep: ReadonlySet<XmlElement> = new Set();

  constructor(
    private readonly index: DocxIndex,
    private readonly accept: boolean,
    private readonly touched: Set<XmlElement>,
  ) {}

  add(group: RevisionGroup): void {
    if (group.moveName !== null) this.moveNames.add(group.moveName);
    for (const member of group.members) {
      switch (placeOf(member.element)) {
        case "content":
          this.content.push(member.element);
          break;
        case "mark":
          this.marks.push(member.element);
          break;
        case "row":
          this.rows.push(member.element);
          break;
        case "property":
          this.properties.push(member.element);
          break;
        case "cell":
          this.cells.push(member.element);
          break;
        case "record":
          this.records.push(member.element);
          break;
        default:
          break;
      }
    }
  }

  /** True when the content of a revision element stays in the document. */
  private keeps(element: XmlElement): boolean {
    return this.accept === (element.name === "w:ins" || element.name === "w:moveTo");
  }

  private dirty(element: XmlElement | null): void {
    if (element === null || !isAttached(this.index, element)) return;
    const block = element.name === "w:tbl" ? element : (closest(element, "w:p") ?? closest(element, "w:tbl"));
    if (block !== null) this.touched.add(block);
    this.index.markDirty(element);
  }

  private resolveContent(element: XmlElement): void {
    const parent = elementParent(element);
    if (parent === null) return;
    const scope = closest(parent, "w:p") ?? parent;
    if (this.keeps(element)) {
      for (const node of [...element.children]) {
        insertBefore(element, node);
        // Text of a restored deletion is ordinary text again.
        if (node.kind === "element" && element.name === "w:del") setContentDeleted(node, false);
      }
      remove(element);
    } else {
      // Bookmarks, comment anchors and the characters of fields that reach outside the removed text stay.
      hoistAnchorsBefore(element, element, { fields: this.fieldKeep });
      remove(element);
      removeEmptyWrappers(parent);
    }
    this.dirty(scope);
  }

  private resolveRow(mark: XmlElement): void {
    const properties = elementParent(mark);
    const row = properties === null ? null : elementParent(properties);
    if (properties === null || row === null) return;
    if (this.keeps(mark)) {
      remove(mark);
      if (!hasElementChildren(properties)) remove(properties);
      this.dirty(row);
      return;
    }
    this.removeRow(row);
  }

  /** Takes a row out of its table, and the table with it when it was the last row. */
  private removeRow(row: XmlElement): void {
    const table = closest(row, "w:tbl");
    if (table === null || tableRows(table).length > 1) {
      const parent = elementParent(row);
      this.dirty(rescueAnchors(row));
      remove(row);
      this.dirty(parent);
      if (table !== null) this.touched.add(table);
      return;
    }
    // The last row takes the table with it.
    const record = this.index.blockOf(table);
    if (record === null) {
      const parent = elementParent(table);
      remove(table);
      this.dirty(parent);
      return;
    }
    const alone = !this.index.blocksIn(record.container).some((entry) => entry.type === "paragraph");
    if (alone) {
      // A story or cell must keep a paragraph.
      const placeholder = createElement("w:p");
      insertBefore(table, placeholder);
      this.index.markDirty(placeholder);
    }
    removeBlock(this.index, this.index.blockOf(table) ?? record);
  }

  /** Resolves `w:cellIns`, `w:cellDel` or `w:cellMerge`. A row that loses its last cell goes with it. */
  private resolveCell(mark: XmlElement): void {
    const properties = elementParent(mark);
    const cell = properties === null ? null : elementParent(properties);
    const table = closest(mark, "w:tbl");
    const goes = cell !== null && mark.name !== "w:cellMerge" && (mark.name === "w:cellIns") !== this.accept;
    // Bookmarks, comment anchors and open fields in a cell that goes move to the nearest paragraph that stays.
    if (goes) this.dirty(rescueAnchors(cell));
    const changed = resolveCellMark(mark, this.accept);
    if (goes && changed !== null && changed.name === "w:tr" && rowCells(changed).length === 0) this.removeRow(changed);
    else this.dirty(changed);
    if (table !== null && isAttached(this.index, table)) this.touched.add(table);
  }

  private resolveMark(mark: XmlElement): void {
    const paragraph = closest(mark, "w:p");
    if (paragraph === null) return;
    if (this.keeps(mark)) {
      remove(mark);
      pruneParagraphProps(paragraph);
      this.dirty(paragraph);
      return;
    }
    // The mark goes, and with it every other pending change of the mark.
    const record = this.index.blockOf(paragraph);
    const next = record === null ? null : nextContentBlock(this.index, record);
    clearMarkRevisions(paragraph);
    if (record !== null && next !== null && next.type === "paragraph") {
      const survivor = mergeParagraphs(this.index, paragraph, next.element, { survivor: "auto" });
      this.touched.add(survivor);
      return;
    }
    this.dirty(paragraph);
    if (record === null || sectionBreakOf(paragraph) !== null || this.index.scan(paragraph).text.length > 0) return;
    // An empty paragraph whose mark went has nothing to join: it goes, unless its container needs it.
    const current = this.index.blockOf(paragraph);
    if (current === null) return;
    const previous = previousContentBlock(this.index, current);
    const following = nextContentBlock(this.index, current);
    if (following !== null || (previous !== null && previous.type === "paragraph")) removeBlock(this.index, current);
  }

  run(): void {
    const { index } = this;
    // The order of the paragraphs before anything moves: marks are resolved from the end of the document.
    const order = index.flow.order;
    const position = (mark: XmlElement): number => {
      const paragraph = closest(mark, "w:p");
      return paragraph === null ? -1 : (order.get(paragraph) ?? -1);
    };
    const marks = this.marks.map((mark) => ({ mark, at: position(mark) })).sort((a, b) => b.at - a.at);

    this.fieldKeep = fieldNodesToKeep(this.content.filter((element) => !this.keeps(element) && isAttached(index, element)));
    for (const element of this.content) if (isAttached(index, element)) this.resolveContent(element);
    for (const element of this.properties) {
      if (isAttached(index, element)) this.dirty(resolvePropertyChange(element, this.accept));
    }
    for (const element of this.records) {
      if (!isAttached(index, element)) continue;
      const parent = elementParent(element);
      remove(element);
      this.dirty(parent);
    }
    for (const element of this.cells) if (isAttached(index, element)) this.resolveCell(element);
    for (const element of this.rows) if (isAttached(index, element)) this.resolveRow(element);
    for (const { mark } of marks) if (isAttached(index, mark)) this.resolveMark(mark);
    if (this.moveNames.size > 0) this.removeMoveMarkers(this.moveNames);
  }

  /** Removes the range markers of the named moves, or of every move. */
  removeMoveMarkers(names?: ReadonlySet<string>): void {
    const found: XmlElement[] = [];
    for (const slot of this.index.store.list()) {
      if (slot.kind === "styles" || slot.kind === "numbering" || slot.kind === "theme" || slot.kind === "settings") continue;
      const stack: XmlElement[] = [slot.doc.root];
      for (let guard = 0; stack.length > 0 && guard < 5_000_000; guard++) {
        const element = stack.pop() as XmlElement;
        if (MOVE_MARKERS.has(element.name)) {
          found.push(element);
          continue;
        }
        // Markers sit between blocks and between runs, never inside a run.
        if (element.name === "w:r") continue;
        for (const node of element.children) if (node.kind === "element") stack.push(node);
      }
    }
    const ids = new Set<string>();
    if (names !== undefined) {
      for (const marker of found) {
        const name = attr(marker, "w:name");
        const id = attr(marker, "w:id");
        if (name !== null && id !== null && names.has(name)) ids.add(`${marker.name.includes("From") ? "from" : "to"}:${id}`);
      }
    }
    const parents = new Set<XmlElement>();
    for (const marker of found) {
      const key = `${marker.name.includes("From") ? "from" : "to"}:${attr(marker, "w:id") ?? ""}`;
      if (names !== undefined && !ids.has(key)) continue;
      const parent = elementParent(marker);
      remove(marker);
      if (parent !== null) parents.add(parent);
    }
    for (const parent of parents) this.dirty(parent);
  }
}
