/**
 * Move detection: a run of deleted tokens that reappears among the inserted
 * tokens is relabelled as moved text.
 *
 * Candidates are found by indexing short seeds of the inserted tokens and
 * extending each hit to a maximal common run. The longest runs are claimed
 * first; a run that overlaps an earlier claim is trimmed to what is left.
 * All work is bounded: seed lists are capped and extension draws on a budget.
 */

import type { Alignment, TokenTable } from "./alignment.js";
import type { WorkBudget } from "./myers.js";

/** Most positions remembered for one seed. Common seeds (a frequent word pair) stay cheap. */
const SEED_CAP = 24;
/** Most candidate runs kept before claiming. */
const CANDIDATE_CAP = 20000;

export interface MoveSearch {
  /** Smallest number of non-whitespace tokens in a move. */
  minTokens: number;
  /**
   * The matching the diff started from, or null. A pair that was aligned
   * there and later absorbed into an edit did not move, so it is never
   * reported as one.
   */
  original: Int32Array | null;
  /**
   * False when the alignment may be incomplete (the work budget ran out).
   * Then a deleted run and an inserted run in the same gap may simply be
   * unaligned equal text, so only runs in different gaps count as moves.
   */
  sameGap: boolean;
  /** Token comparisons this search may still spend. */
  budget: WorkBudget;
  /** Last move number handed out; increased for each new move. */
  lastMove: number;
}

interface Candidate {
  a: number;
  b: number;
  length: number;
  weight: number;
}

/** Labels moved runs in `al.aMove` / `al.bMove`. Returns the last move number used. */
export function detectMoves(al: Alignment, table: TokenTable, search: MoveSearch): number {
  const { aTok, bTok, aMatch, bMatch, aMove, bMove } = al;
  const n = aTok.length;
  const m = bTok.length;
  const { minTokens, original, budget } = search;
  const seed = minTokens >= 2 ? 2 : 1;
  const base = table.count;
  const freeA = (i: number): boolean => i >= 0 && i < n && (aMatch[i] as number) < 0 && aMove[i] === 0;
  const freeB = (j: number): boolean => j >= 0 && j < m && (bMatch[j] as number) < 0 && bMove[j] === 0;

  // Seed index over the inserted tokens. Bounded by the number of tokens in `b`.
  const index = new Map<number, number[]>();
  let anyFreeB = false;
  for (let j = 0; j + seed <= m; j += 1) {
    if (!freeB(j) || (seed === 2 && !freeB(j + 1))) continue;
    anyFreeB = true;
    const key = seed === 2 ? (bTok[j] as number) * base + (bTok[j + 1] as number) : (bTok[j] as number);
    const list = index.get(key);
    if (!list) index.set(key, [j]);
    else if (list.length < SEED_CAP) list.push(j);
  }
  if (!anyFreeB) return search.lastMove;

  // Number of matched tokens before each position: equal ranks mean the same gap.
  let rankA: Int32Array | null = null;
  let rankB: Int32Array | null = null;
  if (!search.sameGap) {
    rankA = new Int32Array(n);
    rankB = new Int32Array(m);
    for (let i = 0, rank = 0; i < n; i += 1) {
      rankA[i] = rank;
      if ((aMatch[i] as number) >= 0) rank += 1;
    }
    for (let j = 0, rank = 0; j < m; j += 1) {
      rankB[j] = rank;
      if ((bMatch[j] as number) >= 0) rank += 1;
    }
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i + seed <= n && budget.left > 0 && candidates.length < CANDIDATE_CAP; i += 1) {
    if (!freeA(i) || (seed === 2 && !freeA(i + 1))) continue;
    const key = seed === 2 ? (aTok[i] as number) * base + (aTok[i + 1] as number) : (aTok[i] as number);
    const list = index.get(key);
    if (!list) continue;
    for (const j of list) {
      if (rankA && rankB && rankA[i] === rankB[j]) continue;
      // Not a maximal start: the run was already extended from the pair before this one.
      if (freeA(i - 1) && freeB(j - 1) && aTok[i - 1] === bTok[j - 1] && !(original && original[i - 1] === j - 1)) continue;
      let length = 0;
      let weight = 0;
      let aligned = false;
      while (freeA(i + length) && freeB(j + length) && aTok[i + length] === bTok[j + length]) {
        if (original && original[i + length] === j + length) {
          aligned = true;
          break;
        }
        if (table.space[aTok[i + length] as number] === 0) weight += 1;
        length += 1;
      }
      budget.left -= length + 1;
      if (!aligned && weight >= minTokens) candidates.push({ a: i, b: j, length, weight });
      if (budget.left <= 0) break;
    }
  }
  if (candidates.length === 0) return search.lastMove;

  candidates.sort((x, y) => y.weight - x.weight || y.length - x.length || x.a - y.a || x.b - y.b);
  let lastMove = search.lastMove;
  for (const candidate of candidates) {
    // Longest part of the run that no earlier claim has taken.
    let bestStart = 0;
    let bestLength = 0;
    let bestWeight = 0;
    let start = 0;
    let weight = 0;
    for (let k = 0; k <= candidate.length; k += 1) {
      const open = k < candidate.length && aMove[candidate.a + k] === 0 && bMove[candidate.b + k] === 0;
      if (open) {
        if (table.space[aTok[candidate.a + k] as number] === 0) weight += 1;
        continue;
      }
      if (weight > bestWeight || (weight === bestWeight && k - start > bestLength)) {
        bestStart = start;
        bestLength = k - start;
        bestWeight = weight;
      }
      start = k + 1;
      weight = 0;
    }
    if (bestWeight < minTokens) continue;
    lastMove += 1;
    for (let k = bestStart; k < bestStart + bestLength; k += 1) {
      aMove[candidate.a + k] = lastMove;
      bMove[candidate.b + k] = lastMove;
    }
  }
  return lastMove;
}

/**
 * Tidies the labelled moves: grows each over neighbouring free tokens that
 * are equal on both sides, then joins moves that touch on both sides into
 * one. Without this a moved sentence can come out as two or three moves
 * with stray deleted punctuation between them.
 */
export function consolidateMoves(al: Alignment, lastMove: number, original: Int32Array | null): void {
  if (lastMove === 0) return;
  const { aTok, bTok, aMatch, bMatch, aMove, bMove } = al;
  const n = aTok.length;
  const m = bTok.length;
  const aStart = new Int32Array(lastMove + 1).fill(-1);
  const bStart = new Int32Array(lastMove + 1).fill(-1);
  const length = new Int32Array(lastMove + 1);
  for (let i = 0; i < n; i += 1) {
    const move = aMove[i] as number;
    if (move === 0) continue;
    if (aStart[move] === -1) aStart[move] = i;
    length[move] = (length[move] as number) + 1;
  }
  for (let j = 0; j < m; j += 1) {
    const move = bMove[j] as number;
    if (move !== 0 && bStart[move] === -1) bStart[move] = j;
  }
  const free = (i: number, j: number): boolean =>
    i >= 0 &&
    j >= 0 &&
    i < n &&
    j < m &&
    (aMatch[i] as number) < 0 &&
    (bMatch[j] as number) < 0 &&
    aMove[i] === 0 &&
    bMove[j] === 0 &&
    aTok[i] === bTok[j] &&
    !(original && original[i] === j);
  for (let move = 1; move <= lastMove; move += 1) {
    if (aStart[move] === -1 || bStart[move] === -1) continue;
    let a0 = aStart[move] as number;
    let b0 = bStart[move] as number;
    let len = length[move] as number;
    while (free(a0 + len, b0 + len)) {
      aMove[a0 + len] = move;
      bMove[b0 + len] = move;
      len += 1;
    }
    while (free(a0 - 1, b0 - 1)) {
      a0 -= 1;
      b0 -= 1;
      aMove[a0] = move;
      bMove[b0] = move;
      len += 1;
    }
    aStart[move] = a0;
    bStart[move] = b0;
    length[move] = len;
  }
  // Join a move to the one that follows it directly on both sides.
  for (let i = 1; i < n; i += 1) {
    const move = aMove[i] as number;
    const previous = aMove[i - 1] as number;
    if (move === 0 || previous === 0 || move === previous) continue;
    if ((bStart[previous] as number) + (length[previous] as number) !== bStart[move]) continue;
    const count = length[move] as number;
    for (let k = 0; k < count; k += 1) {
      aMove[i + k] = previous;
      bMove[(bStart[move] as number) + k] = previous;
    }
    length[previous] = (length[previous] as number) + count;
    length[move] = 0;
  }
}

/** Renumbers moves 1, 2, 3 … in the order their source appears in `a`. Returns the number of moves. */
export function renumberMoves(al: Alignment): number {
  const { aMove, bMove } = al;
  // Bounded by the number of moves, itself bounded by the number of tokens.
  const renamed = new Map<number, number>();
  for (let i = 0; i < aMove.length; i += 1) {
    const move = aMove[i] as number;
    if (move === 0) continue;
    let next = renamed.get(move);
    if (next === undefined) {
      next = renamed.size + 1;
      renamed.set(move, next);
    }
    aMove[i] = next;
  }
  for (let j = 0; j < bMove.length; j += 1) {
    const move = bMove[j] as number;
    if (move !== 0) bMove[j] = renamed.get(move) ?? 0;
  }
  return renamed.size;
}
