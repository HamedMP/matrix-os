/**
 * Writes the plan of one container into the result: paragraphs through
 * `./inline.ts`, tables row by row and cell by cell, each cell being a
 * container of its own.
 */

import type { PartName } from "../../api/opc.js";
import type { XmlElement } from "../../api/xml.js";
import { appendChild, insertAfter, insertBefore } from "../../xml/index.js";
import { tableRows } from "../internal.js";
import type { ImportContext } from "./importer.js";
import { type BuildContext, addParagraph, mergeParagraphs, removeParagraph, replaceParagraph } from "./inline.js";
import { markRow } from "./markup.js";
import { type Entry, planBlocks, planRows } from "./plan.js";
import type { BlockNode, TableNode } from "./types.js";

/** The two parts a container pair belongs to. */
export interface Parts {
  /** Part of the revised document. */
  readonly sourcePart: PartName;
  /** Part of the result. */
  readonly targetPart: PartName;
}

const BLOCK_ELEMENTS: ReadonlySet<string> = new Set(["w:p", "w:tbl", "w:sdt", "w:customXml"]);

/** Puts `element` in front of the blocks of a container. */
function placeFirst(container: XmlElement, element: XmlElement): void {
  for (const node of container.children) {
    if (node.kind === "element" && (BLOCK_ELEMENTS.has(node.name) || node.name === "w:sectPr")) {
      insertBefore(node, element);
      return;
    }
  }
  appendChild(container, element);
}

function mergeTable(a: TableNode, b: TableNode, context: BuildContext, parts: Parts): void {
  const scope: ImportContext = { ...parts, targetScope: a.element };
  let last: XmlElement | null = null;
  for (const pair of planRows(a.rows, b.rows)) {
    if (pair.a !== null && pair.b !== null) {
      pair.a.cells.forEach((cell, position) => {
        const other = pair.b?.cells[position];
        if (other !== undefined) mergeContainer(cell.element, cell.blocks, other.blocks, context, parts);
      });
      last = pair.a.element;
    } else if (pair.a !== null) {
      context.counters.deletedRows += markRow(pair.a.element, "del", context.stamp);
      last = pair.a.element;
    } else if (pair.b !== null) {
      const copy = context.importer.block(pair.b.element, scope);
      context.counters.insertedRows += markRow(copy, "ins", context.stamp);
      const first = tableRows(a.element)[0];
      if (last !== null) insertAfter(last, copy);
      else if (first !== undefined) insertBefore(first, copy);
      else appendChild(a.element, copy);
      last = copy;
    }
  }
}

/**
 * Compares the blocks of a container of the original (`a`, attached under
 * `container`) with those of its counterpart in the revised version and
 * writes every difference into `container` as tracked revisions.
 */
export function mergeContainer(
  container: XmlElement,
  a: readonly BlockNode[],
  b: readonly BlockNode[],
  context: BuildContext,
  parts: Parts,
): void {
  const scope: ImportContext = { ...parts, targetScope: container };
  const entries: Entry[] = planBlocks(a, b, context.detectMoves, () => context.moveName());
  let last: XmlElement | null = null;
  const place = (element: XmlElement): void => {
    if (last !== null) insertAfter(last, element);
    else placeFirst(container, element);
    last = element;
  };
  for (const entry of entries) {
    if (entry.type === "table") {
      if (entry.a !== null && entry.b !== null) {
        mergeTable(entry.a, entry.b, context, parts);
        last = entry.a.element;
      } else if (entry.a !== null) {
        for (const row of entry.a.rows) context.counters.deletedRows += markRow(row.element, "del", context.stamp);
        last = entry.a.element;
      } else if (entry.b !== null) {
        const copy = context.importer.block(entry.b.element, scope);
        for (const row of tableRows(copy)) context.counters.insertedRows += markRow(row, "ins", context.stamp);
        place(copy);
      }
      continue;
    }
    const lastOriginal = entry.a[entry.a.length - 1];
    if (lastOriginal === undefined) {
      place(addParagraph(entry, context, scope));
    } else if (entry.b.length === 0) {
      removeParagraph(entry, context);
      last = lastOriginal.element;
    } else if (entry.mode === "replace") {
      replaceParagraph(entry, context, scope);
      last = lastOriginal.element;
    } else {
      mergeParagraphs(entry, context, scope);
      last = lastOriginal.element;
    }
  }
}
