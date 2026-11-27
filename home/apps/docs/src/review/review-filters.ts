/**
 * Grouping, filtering, stepping and selection matching of review items.
 * Pure functions over the lists `listReviewItems` returns.
 */

import type { RevisionKind, TextRange } from "../../../_shared/office-engine/index";
import type { ModelIndex } from "../editor/model-index";
import { type PositionKey, type ReviewItem, compareKeys, positionKey } from "./revision-items";

export type CategoryFilter = "all" | "formatting" | "substantive";

/** Empty `authors` or `kinds` means every author or kind. */
export interface ReviewFilter {
  authors: readonly string[];
  kinds: readonly RevisionKind[];
  category: CategoryFilter;
}

export const EMPTY_FILTER: ReviewFilter = Object.freeze({ authors: Object.freeze([]) as readonly string[], kinds: Object.freeze([]) as readonly RevisionKind[], category: "all" as const });

export function isFilterActive(filter: ReviewFilter): boolean {
  return filter.authors.length > 0 || filter.kinds.length > 0 || filter.category !== "all";
}

export function matchesFilter(item: ReviewItem, filter: ReviewFilter): boolean {
  if (filter.authors.length > 0 && !filter.authors.includes(item.author)) return false;
  if (filter.kinds.length > 0 && !filter.kinds.includes(item.kind)) return false;
  return filter.category === "all" || filter.category === item.category;
}

/** The items the filter lets through, in their original order. Returns the same array when the filter is empty. */
export function filterItems(items: readonly ReviewItem[], filter: ReviewFilter): readonly ReviewItem[] {
  if (!isFilterActive(filter)) return items;
  return items.filter((item) => matchesFilter(item, filter));
}

export interface AuthorGroup {
  author: string;
  colorSlot: number;
  items: ReviewItem[];
  formattingCount: number;
  substantiveCount: number;
}

/** Items by author, authors in the order of their first change in the document. */
export function groupByAuthor(items: readonly ReviewItem[]): AuthorGroup[] {
  const groups = new Map<string, AuthorGroup>();
  for (const item of items) {
    let group = groups.get(item.author);
    if (group === undefined) {
      group = { author: item.author, colorSlot: item.colorSlot, items: [], formattingCount: 0, substantiveCount: 0 };
      groups.set(item.author, group);
    }
    group.items.push(item);
    if (item.category === "formatting") group.formattingCount++;
    else group.substantiveCount++;
  }
  return [...groups.values()];
}

/** Distinct authors in order of first appearance. */
export function authorsOf(items: readonly ReviewItem[]): string[] {
  return [...new Set(items.map((item) => item.author))];
}

export type StepDirection = "next" | "previous";

export interface StepFrom {
  /** The item that is current, or null. */
  currentId: string | null;
  /** Where the caret is, used when no listed item is current. */
  caret?: PositionKey | null;
}

/**
 * The item after (or before) the current one in document order. Without a
 * current item: the first item at or after the caret (or the last one before
 * it), else the first (or last) item. Null at either end.
 */
export function stepItem(items: readonly ReviewItem[], from: StepFrom, direction: StepDirection): ReviewItem | null {
  if (items.length === 0) return null;
  const at = from.currentId === null ? -1 : items.findIndex((item) => item.id === from.currentId);
  if (at >= 0) return items[direction === "next" ? at + 1 : at - 1] ?? null;
  const caret = from.caret ?? null;
  if (caret === null) return direction === "next" ? items[0]! : items[items.length - 1]!;
  if (direction === "next") return items.find((item) => compareKeys(item.position, caret) >= 0) ?? null;
  for (let index = items.length - 1; index >= 0; index--) {
    if (compareKeys(items[index]!.position, caret) < 0) return items[index]!;
  }
  return null;
}

/**
 * The items a selection touches. A collapsed selection touches the change
 * it is inside or at the edge of; revisions without a text range (paragraph
 * formatting, table rows) are touched when one of their paragraphs is.
 */
export function itemsInRange(items: readonly ReviewItem[], index: ModelIndex, range: TextRange): ReviewItem[] {
  const start = positionKey(index, range.start);
  const end = positionKey(index, range.end);
  const collapsed = compareKeys(start, end) === 0;
  return items.filter((item) => {
    if (item.range !== null) {
      const from = positionKey(index, item.range.start);
      const to = positionKey(index, item.range.end);
      if (collapsed) return compareKeys(from, start) <= 0 && compareKeys(start, to) <= 0;
      return compareKeys(from, end) < 0 && compareKeys(start, to) < 0;
    }
    return item.blockIds.some((blockId) => {
      const entry = index.entry(blockId);
      return entry !== null && entry.order >= start.paragraph && entry.order <= end.paragraph;
    });
  });
}
