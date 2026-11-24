/**
 * Hit testing and placement for the revision hover card. Reads the editor's
 * DOM contract (`data-revision-id`, `data-format-revision-id`); never writes
 * to it.
 */

export interface HoverTarget {
  /** The marked element the pointer is over. */
  element: Element;
  /** Content revision first, then the formatting revision, without duplicates. */
  revisionIds: string[];
}

/** The tracked change under `node` inside `container`, or null. */
export function hoverTargetOf(node: EventTarget | null, container: Element): HoverTarget | null {
  if (!(node instanceof Element)) return null;
  const element = node.closest("[data-revision-id], [data-format-revision-id]");
  if (element === null || !container.contains(element)) return null;
  const ids = [element.getAttribute("data-revision-id"), element.getAttribute("data-format-revision-id")].filter((id): id is string => id !== null && id !== "");
  return ids.length === 0 ? null : { element, revisionIds: [...new Set(ids)] };
}

export interface CardSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Space between the marked text and the card, and between the card and the window edge. */
const GAP = 6;

/**
 * Where the card goes, in viewport pixels: below the marked text, or above it
 * when there is no room below; always inside the window.
 */
export function placeCard(anchor: Pick<DOMRect, "left" | "top" | "bottom">, card: CardSize, viewport: Viewport): { left: number; top: number } {
  const maxLeft = Math.max(GAP, viewport.width - card.width - GAP);
  const left = Math.min(Math.max(GAP, anchor.left), maxLeft);
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - card.height;
  const top = below + card.height <= viewport.height - GAP || above < GAP ? below : above;
  return { left, top: Math.max(GAP, Math.min(top, viewport.height - card.height - GAP)) };
}
