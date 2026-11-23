/** Small XML helpers shared by the workbook parts. */

import type { XmlChildNode, XmlElement } from "../../api/xml.js";
import { appendChild, insertBefore, remove } from "../../xml/index.js";

export const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const NS_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** True when a qualified name has the given local name. */
export function isNamed(name: string, local: string): boolean {
  if (name === local) return true;
  const colon = name.length - local.length - 1;
  return colon > 0 && name.charCodeAt(colon) === 58 && name.endsWith(local);
}

/** First child element with a local name, whatever its prefix. */
export function kid(parent: XmlElement, local: string): XmlElement | null {
  const nodes = parent.children;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as XmlChildNode;
    if (node.kind === "element" && isNamed(node.name, local)) return node;
  }
  return null;
}

/** Child elements with a local name, whatever their prefix. */
export function kids(parent: XmlElement, local: string): XmlElement[] {
  const found: XmlElement[] = [];
  const nodes = parent.children;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as XmlChildNode;
    if (node.kind === "element" && isNamed(node.name, local)) found.push(node);
  }
  return found;
}

/** A local name with the prefix of `reference`, so new elements match the document. */
export function qualify(reference: XmlElement, local: string): string {
  const colon = reference.name.indexOf(":");
  return colon < 0 ? local : `${reference.name.slice(0, colon + 1)}${local}`;
}

/** The name of an element without its namespace prefix. */
export function localOf(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/**
 * Inserts `node` where the schema wants it: before the first child whose
 * local name comes later in `order`, or at the end.
 */
export function insertInOrder(parent: XmlElement, node: XmlElement, order: readonly string[]): void {
  const rank = order.indexOf(localOf(node.name));
  if (rank >= 0) {
    for (const sibling of parent.children) {
      if (sibling.kind !== "element") continue;
      const siblingRank = order.indexOf(localOf(sibling.name));
      if (siblingRank > rank) {
        insertBefore(sibling, node);
        return;
      }
    }
  }
  appendChild(parent, node);
}

/**
 * Replaces the children of an element with `nodes`, in order. Runs in time
 * linear in the number of children, old and new.
 */
export function setChildren(parent: XmlElement, nodes: readonly XmlChildNode[]): void {
  const current = parent.children;
  for (let i = current.length - 1; i >= 0; i--) remove(current[i] as XmlChildNode);
  for (const node of nodes) appendChild(parent, node);
}

const ESCAPED = /_x([0-9A-Fa-f]{4})_/g;

/** Decodes the `_xHHHH_` escapes that spreadsheet text uses for control characters. */
export function decodeCellText(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(ESCAPED, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Escapes characters XML 1.0 cannot carry, and text that would read as an
 * escape. A carriage return is left to the XML writer, which writes it as
 * the character reference `&#13;`: every reader gets it back, also those
 * that do not decode `_x000D_`.
 */
export function encodeCellText(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const control = code < 32 && code !== 9 && code !== 10 && code !== 13;
    const looksEscaped =
      code === 95 && text.charCodeAt(i + 1) === 120 && /^_x[0-9A-Fa-f]{4}_/.test(text.slice(i, i + 7));
    const invalid = code === 0xfffe || code === 0xffff;
    if (control || looksEscaped || invalid) {
      out += `${text.slice(from, i)}_x${code.toString(16).toUpperCase().padStart(4, "0")}_`;
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
}

/** True when the text needs `xml:space="preserve"` to survive a round trip. */
export function needsSpacePreserve(text: string): boolean {
  return text !== "" && /^\s|\s$|\s\s|[\t\n\r]/.test(text);
}

/** `1`, `true` and `on` are true; an absent attribute takes `fallback`. */
export function boolAttr(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value === "1" || value === "true" || value === "on";
}
