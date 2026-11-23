/** Turning insertable text into run content, and the run properties new text starts from. */

import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, cloneNode, createElement, remove } from "../../xml/index.js";
import type { DocxIndex } from "../internal.js";
import { closest, firstChild } from "../internal.js";
import { renameElement } from "./xml-util.js";

/** Longest text one operation may insert: far above any real edit, and a bound on the work. */
export const MAX_INSERT_LENGTH = 4_000_000;

/**
 * Checks text given to an insert operation: a string in which the only
 * control characters are tab and line feed.
 */
export function requireInsertableText(value: unknown, what = "text"): asserts value is string {
  if (typeof value !== "string") throw new OfficeError("invalid_argument", `${what} must be a string`);
  if (value.length > MAX_INSERT_LENGTH) throw new OfficeError("limit_exceeded", `${what} is too long`);
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
      throw new OfficeError("invalid_argument", `${what} contains a control character`, { details: { offset: at } });
    }
  }
}

function needsPreserve(text: string): boolean {
  return /^\s|\s$|\s\s/.test(text);
}

/** The children of a run that show `text`: `w:t` stretches, `w:tab` for a tab, `w:br` for a line feed. */
export function textNodes(text: string): XmlElement[] {
  const nodes: XmlElement[] = [];
  let from = 0;
  const flush = (to: number): void => {
    if (to <= from) return;
    const piece = text.slice(from, to);
    const node = createElement("w:t", needsPreserve(piece) ? [["xml:space", "preserve"]] : [], [piece]);
    nodes.push(node);
  };
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code !== 0x09 && code !== 0x0a) continue;
    flush(at);
    nodes.push(createElement(code === 0x09 ? "w:tab" : "w:br"));
    from = at + 1;
  }
  flush(text.length);
  return nodes;
}

/** A new run with the given properties (used as they are, may be null) and text. */
export function makeRun(properties: XmlElement | null, text: string): XmlElement {
  const run = createElement("w:r");
  if (properties !== null && properties.children.length > 0) appendChild(run, properties);
  for (const node of textNodes(text)) appendChild(run, node);
  return run;
}

const MARK_ONLY: ReadonlySet<string> = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPrChange"]);

/**
 * A detached copy of run properties for new text: no tracked-change records,
 * and without the character style when `dropStyle` is set (text typed after
 * a link must not look like the link).
 */
export function copyRunProps(source: XmlElement | null, dropStyle = false): XmlElement | null {
  if (source === null) return null;
  const copy = cloneNode(source);
  for (const node of [...copy.children]) {
    if (node.kind !== "element") continue;
    if (MARK_ONLY.has(node.name) || (dropStyle && node.name === "w:rStyle")) remove(node);
  }
  return copy.children.some((node) => node.kind === "element") ? copy : null;
}

/** The properties of a run for new text elsewhere: without the character style when the run is part of a link. */
export function runPropsOf(run: XmlElement | null): XmlElement | null {
  if (run === null || run.name !== "w:r") return null;
  return copyRunProps(firstChild(run, "w:rPr"), closest(run, "w:hyperlink") !== null);
}

/** The properties of a paragraph mark as run properties for new text in that paragraph. */
export function markRunProps(paragraph: XmlElement): XmlElement | null {
  const pPr = firstChild(paragraph, "w:pPr");
  return copyRunProps(pPr === null ? null : firstChild(pPr, "w:rPr"));
}

/** Turns the text of a run into deleted text (`w:delText`, `w:delInstrText`), or back. */
export function setRunDeleted(run: XmlElement, deleted: boolean): void {
  if (run.name !== "w:r") return;
  for (const node of [...run.children]) {
    if (node.kind !== "element") continue;
    if (deleted) {
      if (node.name === "w:t") renameElement(node, "w:delText");
      else if (node.name === "w:instrText") renameElement(node, "w:delInstrText");
    } else if (node.name === "w:delText") renameElement(node, "w:t");
    else if (node.name === "w:delInstrText") renameElement(node, "w:instrText");
  }
}

/** Applies {@link setRunDeleted} to every run below `scope` that is not inside a nested deletion. */
export function setContentDeleted(scope: XmlElement, deleted: boolean): void {
  const stack: XmlElement[] = [scope];
  for (let guard = 0; stack.length > 0 && guard < 5_000_000; guard++) {
    const element = stack.pop() as XmlElement;
    if (element.name === "w:r") {
      setRunDeleted(element, deleted);
      continue;
    }
    for (const node of element.children) {
      if (node.kind !== "element") continue;
      if (!deleted && node !== scope && (node.name === "w:del" || node.name === "w:moveFrom")) continue;
      stack.push(node);
    }
  }
}

/** Fresh `w14:paraId` for a copy of a paragraph that had one; nothing otherwise. */
export function paragraphAttrs(index: DocxIndex, template: XmlElement | null): Array<readonly [string, string]> {
  if (template === null) return [];
  return template.attrs.some((entry) => entry.name === "w14:paraId") ? [["w14:paraId", index.allocateParaId()]] : [];
}

