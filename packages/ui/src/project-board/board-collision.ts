import { pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";

export const BOARD_COLUMN_DROP_PREFIX = "column:";

/**
 * Drop target under the pointer: a card when the pointer is over one, else the
 * column it is in (so an empty column takes the card). Only when the pointer is
 * outside every droppable does overlap decide. Corner distance alone would snap
 * a card dropped on an empty column to the nearest card in a neighbouring column.
 */
/**
 * The card order after a drop: onto a card takes that card's place; onto a
 * column's blank space sends the card to the end of that column.
 */
export function orderAfterDrop(list: readonly string[], activeId: string, overId: string): string[] {
  const without = list.filter((id) => id !== activeId);
  if (overId.startsWith(BOARD_COLUMN_DROP_PREFIX)) return [...without, activeId];
  const from = list.indexOf(activeId);
  const to = list.indexOf(overId);
  if (from < 0 || to < 0) return [...list];
  const moved = [...without];
  moved.splice(to, 0, activeId);
  return moved;
}

export const boardCollisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length === 0) return rectIntersection(args);
  const cards = hits.filter((hit) => !String(hit.id).startsWith(BOARD_COLUMN_DROP_PREFIX));
  return cards.length > 0 ? cards : hits;
};
