/**
 * A stable colour slot per revision author. The slot is an index into the
 * `--doc-author-N` custom properties of `editor.css`, so themes decide the
 * actual colours.
 */

export const AUTHOR_COLOR_COUNT = 8;

/** 1 to `AUTHOR_COLOR_COUNT`, the same for the same name everywhere. */
export function authorColorSlot(author: string): number {
  let hash = 2166136261;
  for (let at = 0; at < author.length; at++) {
    hash ^= author.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % AUTHOR_COLOR_COUNT) + 1;
}
