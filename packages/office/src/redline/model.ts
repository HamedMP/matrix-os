/**
 * The data model of a tracked-changes document.
 *
 * A document is a flat list of items: runs of text, line breaks and block
 * boundaries. Each item says how it looks on the original side (`a`) and on
 * the final side (`b`); a side that is null does not have the item. An item
 * on one side only is a pending change and carries the change id:
 *
 * | `a`  | `b`  | meaning                                   |
 * | ---- | ---- | ----------------------------------------- |
 * | set  | set  | unchanged text                            |
 * | set  | null | pending deletion (or the source of a move) |
 * | null | set  | pending insertion (or the target of a move)|
 *
 * Presentation strings:
 * - text and break: the inline elements around it, outermost first,
 *   separated by spaces, then `|` and the link target when there is one:
 *   `"b i"`, `"a|https://example.com"`, `""`.
 * - block boundary: the chain of block elements the following text sits in,
 *   outermost first, as `tag:id` joined by `/`: `"ul:3/li:7"`. The id tells
 *   two elements of the same kind apart, so two list items stay two items.
 *
 * Item 0 is always the boundary that opens the first block; it is never a
 * change and its text is empty. Every other boundary reads as a line break
 * in the plain text of the document.
 */

import type { RedlineChangeKind, RedlineFormat } from "../api/redline.js";

export const KIND_TEXT = 0;
export const KIND_BREAK = 1;
export const KIND_BLOCK = 2;
export type ItemKind = typeof KIND_TEXT | typeof KIND_BREAK | typeof KIND_BLOCK;

/**
 * Stands for a `<br>` in the text that is compared: U+2028 LINE SEPARATOR,
 * which the diff reads as a line break. Input text that contains it gets a
 * space instead.
 */
export const BREAK_CHAR = "\u2028";
/** Stands for a block boundary in the text that is compared. */
export const BLOCK_CHAR = "\n";

export interface Item {
  k: ItemKind;
  /** The text; `BREAK_CHAR` for a break, `BLOCK_CHAR` for a boundary (empty for item 0). */
  t: string;
  a: string | null;
  b: string | null;
  /** Change id when the item is on one side only. */
  c: string | null;
}

/** One side of a document as parsed: item 0 opens the first block. */
export interface SideItem {
  k: ItemKind;
  t: string;
  /** Presentation string. */
  p: string;
}

export interface ChangeRecord {
  id: string;
  kind: RedlineChangeKind;
  author: string;
  date: string;
  pairedWith: string | null;
}

/** Everything a document consists of. `toJSON` returns exactly this, plus the version. */
export interface DocData {
  format: RedlineFormat;
  items: Item[];
  changes: ChangeRecord[];
  /** Number of the next change id (`c1`, `c2`, …). */
  nextChange: number;
  /** Number of the next block element id. */
  nextBlock: number;
  /** True once a change has been accepted: the original side is no longer the text the document started from. */
  accepted: boolean;
}

export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p", "div", "ul", "ol", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
]);
export const INLINE_TAGS: ReadonlySet<string> = new Set(["b", "strong", "i", "em", "u", "s", "span", "a"]);

/** Longest text or markup a redline accepts on either side, in UTF-16 code units. */
export const MAX_REDLINE_LENGTH = 4 * 1024 * 1024;

const SAFE_HREF = /^(?:https?:|mailto:)/i;

/**
 * The link target if it is safe to emit, else null. Control characters are
 * removed first, as a browser does before reading the scheme, so
 * `java\tscript:` cannot pass as a relative link; spaces inside are
 * percent-encoded. The result is stable: `safeHref(safeHref(x)) === safeHref(x)`.
 */
export function safeHref(raw: string): string | null {
  const href = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, "")
    .trim()
    .replace(/ /g, "%20");
  return href.length > 0 && href.length <= 2048 && SAFE_HREF.test(href) ? href : null;
}

export function inlinePresentation(tags: readonly string[], href: string | null): string {
  const joined = tags.join(" ");
  return href === null ? joined : `${joined}|${href}`;
}

export function splitInline(pres: string): { tags: string[]; href: string | null } {
  const bar = pres.indexOf("|");
  const tags = bar === -1 ? pres : pres.slice(0, bar);
  return { tags: tags === "" ? [] : tags.split(" "), href: bar === -1 ? null : pres.slice(bar + 1) };
}

const CHAIN_ENTRY = /^([a-z][a-z0-9]*):([0-9a-z]+)$/;

/** True for a well-formed presentation string of the given kind that names only allowed elements and a safe link. */
export function validPresentation(kind: ItemKind, pres: string): boolean {
  if (kind === KIND_BLOCK) {
    if (pres === "") return true;
    return pres.split("/").every((entry) => {
      const match = CHAIN_ENTRY.exec(entry);
      return match !== null && BLOCK_TAGS.has(match[1] as string);
    });
  }
  const { tags, href } = splitInline(pres);
  if (!tags.every((tag) => INLINE_TAGS.has(tag))) return false;
  if (href === null) return true;
  return tags.includes("a") && safeHref(href) === href;
}

/** The plain text an item stands for: breaks and boundaries read as a line break. */
export function plainText(item: { k: ItemKind; t: string }): string {
  return item.k === KIND_TEXT ? item.t : item.t === "" ? "" : "\n";
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}
