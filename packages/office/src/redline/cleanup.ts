/**
 * Passes that make a minimal diff read naturally.
 *
 * - {@link shiftBoundaries}: an edit that could sit in several places (the
 *   same token before and after it) is slid to the best boundary: a
 *   paragraph break, then a sentence end, then whitespace.
 * - {@link absorbEqualities}: a short equality squeezed between two larger
 *   edits is turned into part of them, so a rewritten phrase is one deletion
 *   and one insertion instead of a word-by-word patchwork.
 */

import {
  CLS_BLANK_LINE,
  CLS_NEWLINE,
  CLS_SENTENCE_END,
  CLS_SPACE,
  CLS_WORD,
  type Alignment,
  type TokenTable,
} from "./alignment.js";

/** How good a place between two tokens is for an edit to begin or end. -1 stands for the edge of the text. */
function boundaryScore(table: TokenTable, left: number, right: number): number {
  if (left < 0 || right < 0) return 6;
  const l = table.cls[left] as number;
  const r = table.cls[right] as number;
  const either = l | r;
  if (either & CLS_BLANK_LINE) return 5;
  if (either & CLS_NEWLINE) return 4;
  if (l & CLS_SENTENCE_END && r & CLS_SPACE) return 3;
  if (either & CLS_SPACE) return 2;
  if (!(l & CLS_WORD) || !(r & CLS_WORD)) return 1;
  return 0;
}

/**
 * Slides the one-sided gap `x[p, q)` (unmatched in `x`, at position `r` of
 * `y`) to its best position and returns the offset it moved by.
 */
function slide(
  table: TokenTable,
  xTok: Int32Array,
  xMatch: Int32Array,
  yMatch: Int32Array,
  p: number,
  q: number,
  r: number,
): number {
  const n = xTok.length;
  let left = 0;
  while (p - left - 1 >= 0 && xMatch[p - left - 1] === r - left - 1 && xTok[p - left - 1] === xTok[q - left - 1]) left += 1;
  let right = 0;
  while (q + right < n && xMatch[q + right] === r + right && xTok[p + right] === xTok[q + right]) right += 1;
  if (left === 0 && right === 0) return 0;
  let best = 0;
  let bestScore = -1;
  for (let t = -left; t <= right; t += 1) {
    const start = p + t;
    const end = q + t;
    const score =
      boundaryScore(table, start > 0 ? (xTok[start - 1] as number) : -1, xTok[start] as number) +
      boundaryScore(table, xTok[end - 1] as number, end < n ? (xTok[end] as number) : -1);
    if (score >= bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (best > 0) {
    for (let i = 0; i < best; i += 1) {
      xMatch[p + i] = r + i;
      yMatch[r + i] = p + i;
    }
    for (let i = p + best; i < q + best; i += 1) xMatch[i] = -1;
  } else if (best < 0) {
    const u = -best;
    for (let i = 0; i < u; i += 1) {
      xMatch[q - u + i] = r - u + i;
      yMatch[r - u + i] = q - u + i;
    }
    for (let i = p - u; i < q - u; i += 1) xMatch[i] = -1;
  }
  return best;
}

function hasMove(move: Int32Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) if (move[i] !== 0) return true;
  return false;
}

/** Slides every pure insertion and pure deletion to its best boundary. Linear in the number of tokens. */
export function shiftBoundaries(al: Alignment, table: TokenTable): void {
  const { aTok, bTok, aMatch, bMatch, aMove, bMove } = al;
  const n = aTok.length;
  const m = bTok.length;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && aMatch[i] === j) {
      i += 1;
      j += 1;
      continue;
    }
    const p = i;
    while (i < n && (aMatch[i] as number) < 0) i += 1;
    const r = j;
    while (j < m && (bMatch[j] as number) < 0) j += 1;
    if (i === p && j === r) break;
    if (i > p && j === r && !hasMove(aMove, p, i)) {
      const moved = slide(table, aTok, aMatch, bMatch, p, i, r);
      i += moved;
      j += moved;
    } else if (j > r && i === p && !hasMove(bMove, r, j)) {
      const moved = slide(table, bTok, bMatch, aMatch, r, j, p);
      i += moved;
      j += moved;
    }
    // After a slide to the left, `i` and `j` sit just after the gap, on a matched pair.
  }
}

/**
 * Turns small equalities between two edits into edits. An equality goes
 * when it is no longer (in characters) than the larger edit on each side,
 * has at most `maxWords` non-whitespace tokens and holds no line break: an
 * unchanged paragraph boundary always stays, so two rewritten paragraphs
 * remain two changes. Moved tokens do not count as edits here. Returns true
 * when anything changed.
 */
export function absorbEqualities(al: Alignment, table: TokenTable, maxWords: number): boolean {
  let changedAny = false;
  for (let pass = 0; pass < 8; pass += 1) {
    if (!absorbPass(al, table, maxWords)) break;
    changedAny = true;
  }
  return changedAny;
}

function absorbPass(al: Alignment, table: TokenTable, maxWords: number): boolean {
  const { aTok, bTok, aMatch, bMatch, aMove, bMove } = al;
  const n = aTok.length;
  const m = bTok.length;
  let changed = false;
  let i = 0;
  let j = 0;
  // Character sizes of the plain edits in the gap that starts at (i, j); advances past the gap.
  let del = 0;
  let ins = 0;
  const measureGap = (): void => {
    del = 0;
    ins = 0;
    while (i < n && (aMatch[i] as number) < 0) {
      if (aMove[i] === 0) del += table.length[aTok[i] as number] as number;
      i += 1;
    }
    while (j < m && (bMatch[j] as number) < 0) {
      if (bMove[j] === 0) ins += table.length[bTok[j] as number] as number;
      j += 1;
    }
  };
  measureGap();
  let leftDel = del;
  let leftIns = ins;
  while (i < n && j < m && aMatch[i] === j) {
    const eqStartA = i;
    const eqStartB = j;
    let chars = 0;
    let words = 0;
    let lineBreak = false;
    while (i < n && j < m && aMatch[i] === j) {
      const id = aTok[i] as number;
      chars += table.length[id] as number;
      if (table.space[id] === 0) words += 1;
      if ((table.cls[id] as number) & CLS_NEWLINE) lineBreak = true;
      i += 1;
      j += 1;
    }
    const eqEndA = i;
    measureGap();
    const leftSize = Math.max(leftDel, leftIns);
    const rightSize = Math.max(del, ins);
    if (!lineBreak && leftSize > 0 && rightSize > 0 && chars <= leftSize && chars <= rightSize && words <= maxWords) {
      for (let x = eqStartA, y = eqStartB; x < eqEndA; x += 1, y += 1) {
        aMatch[x] = -1;
        bMatch[y] = -1;
      }
      changed = true;
      leftDel += chars + del;
      leftIns += chars + ins;
    } else {
      leftDel = del;
      leftIns = ins;
    }
  }
  return changed;
}
