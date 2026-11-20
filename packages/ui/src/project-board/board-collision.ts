import { pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";

export const BOARD_COLUMN_DROP_PREFIX = "column:";

/**
 * Drop target under the pointer: a card when the pointer is over one, else the
 * column it is in (so an empty column takes the card). Only when the pointer is
 * outside every droppable does overlap decide. Corner distance alone would snap
 * a card dropped on an empty column to the nearest card in a neighbouring column.
 */
export const boardCollisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length === 0) return rectIntersection(args);
  const cards = hits.filter((hit) => !String(hit.id).startsWith(BOARD_COLUMN_DROP_PREFIX));
  return cards.length > 0 ? cards : hits;
};
