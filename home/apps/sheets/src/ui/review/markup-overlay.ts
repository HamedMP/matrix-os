/**
 * Struck-through old values on the grid.
 *
 * The grid marks every cell with a pending change with `data-change-id`.
 * While markup is on, this puts the old text on those cells as
 * `data-markup-old`; `review.css` draws it struck through before the new
 * text. The grid re-renders cells as it scrolls, so a MutationObserver puts
 * the attribute back on new cell elements.
 */

import { useEffect } from "react";

export const MARKUP_ATTRIBUTE = "data-markup-old";
export const MARKUP_ROOT_CLASS = "sheets-markup";
/** Longest old text drawn in a cell; the full text is in the review list. */
const MAX_MARKUP_TEXT = 60;

function clipped(text: string): string {
  return text.length > MAX_MARKUP_TEXT ? `${text.slice(0, MAX_MARKUP_TEXT - 1)}…` : text;
}

/** Sets or removes the old-text attribute on every changed cell under `root`. Returns how many cells carry it. */
export function applyMarkup(root: ParentNode, oldById: ReadonlyMap<string, string> | null): number {
  let marked = 0;
  for (const element of root.querySelectorAll<HTMLElement>(`[data-change-id], [${MARKUP_ATTRIBUTE}]`)) {
    const id = element.getAttribute("data-change-id");
    const old = oldById === null || id === null ? undefined : oldById.get(id);
    if (old === undefined) {
      if (element.hasAttribute(MARKUP_ATTRIBUTE)) element.removeAttribute(MARKUP_ATTRIBUTE);
      continue;
    }
    const text = clipped(old);
    if (element.getAttribute(MARKUP_ATTRIBUTE) !== text) element.setAttribute(MARKUP_ATTRIBUTE, text);
    marked += 1;
  }
  return marked;
}

/** Keeps the old-text attributes on the grid under `root` while `oldById` is given. */
export function useMarkupOverlay(root: HTMLElement | null, oldById: ReadonlyMap<string, string> | null): void {
  useEffect(() => {
    if (root === null) return undefined;
    const on = oldById !== null;
    root.classList.toggle(MARKUP_ROOT_CLASS, on);
    applyMarkup(root, oldById);
    if (!on || typeof MutationObserver === "undefined") return () => root.classList.remove(MARKUP_ROOT_CLASS);
    const observer = new MutationObserver(() => applyMarkup(root, oldById));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-change-id"] });
    return () => {
      observer.disconnect();
      root.classList.remove(MARKUP_ROOT_CLASS);
      applyMarkup(root, null);
    };
  }, [root, oldById]);
}
