/**
 * Longest-common-subsequence alignment of two integer sequences with the
 * Myers O(ND) algorithm.
 *
 * Small differences are solved with the greedy forward search and its saved
 * trace. Larger ones use the linear-space refinement: find the middle snake,
 * split, and solve both halves, on an explicit work list (no recursion).
 *
 * The work is bounded by a caller-supplied budget counted in diagonal steps,
 * not by a clock, so the result is the same on every machine. When the
 * budget runs out the unsolved parts are left unmatched: the alignment is
 * still valid, only less fine.
 */

/** Remaining diagonal steps. Shared across calls that belong to one diff. */
export interface WorkBudget {
  left: number;
}

/** Edit distance up to which the greedy search keeps its trace (about 1 MiB of integers). */
const GREEDY_MAX_D = 512;

const SOLVED = 0;
const TOO_FAR = 1;
const EXHAUSTED = 2;

/**
 * Aligns `a[a0, a1)` with `b[b0, b1)` and records each matched pair as
 * `match[i] = j`. Entries of unmatched `a` items are left untouched, so the
 * caller fills `match` with -1 first.
 */
export function alignRange(
  a: Int32Array,
  a0: number,
  a1: number,
  b: Int32Array,
  b0: number,
  b1: number,
  match: Int32Array,
  budget: WorkBudget,
): void {
  const work: number[] = [a0, a1, b0, b1];
  while (work.length > 0) {
    let bEnd = work.pop() as number;
    let bStart = work.pop() as number;
    let aEnd = work.pop() as number;
    let aStart = work.pop() as number;
    while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
      match[aStart] = bStart;
      aStart += 1;
      bStart += 1;
    }
    while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd -= 1;
      bEnd -= 1;
      match[aEnd] = bEnd;
    }
    if (aStart === aEnd || bStart === bEnd || budget.left <= 0) continue;
    const outcome = greedy(a, aStart, aEnd - aStart, b, bStart, bEnd - bStart, match, budget);
    if (outcome !== TOO_FAR) continue;
    bisect(a, aStart, aEnd - aStart, b, bStart, bEnd - bStart, budget, work);
  }
}

/** Aligns two whole sequences. Returns `match` with `match[i] = j` or -1. */
export function alignSequences(a: Int32Array, b: Int32Array, budget: WorkBudget): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  alignRange(a, 0, a.length, b, 0, b.length, match, budget);
  return match;
}

function greedy(
  a: Int32Array,
  a0: number,
  n: number,
  b: Int32Array,
  b0: number,
  m: number,
  match: Int32Array,
  budget: WorkBudget,
): number {
  const maxD = Math.min(n + m, GREEDY_MAX_D);
  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxD; d += 1) {
    budget.left -= d + 1;
    if (budget.left < 0) return EXHAUSTED;
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number));
      let x = down ? (v[off + k + 1] as number) : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        backtrack(trace, d, k, x, a0, b0, match);
        return SOLVED;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return TOO_FAR;
}

/** Walks the saved trace from the end point back to the origin, recording the snakes. */
function backtrack(trace: Int32Array[], dEnd: number, kEnd: number, xEnd: number, a0: number, b0: number, match: Int32Array): void {
  let k = kEnd;
  let x = xEnd;
  for (let d = dEnd; d > 0; d -= 1) {
    const prev = trace[d - 1] as Int32Array;
    const base = d - 1;
    const down = k === -d || (k !== d && (prev[base + k - 1] as number) < (prev[base + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[base + prevK] as number;
    const snakeStart = down ? prevX : prevX + 1;
    for (let i = snakeStart; i < x; i += 1) match[a0 + i] = b0 + i - k;
    x = prevX;
    k = prevK;
  }
  for (let i = 0; i < x; i += 1) match[a0 + i] = b0 + i;
}

/**
 * Finds the middle snake of `a[a0, a0 + n)` and `b[b0, b0 + m)` and pushes the
 * two halves onto `work`. Pushes nothing when the budget runs out, which
 * leaves the range unmatched.
 */
function bisect(a: Int32Array, a0: number, n: number, b: Int32Array, b0: number, m: number, budget: WorkBudget, work: number[]): void {
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const size = 2 * maxD + 2;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1Start = 0;
  let k1End = 0;
  let k2Start = 0;
  let k2End = 0;
  for (let d = 0; d < maxD; d += 1) {
    budget.left -= 2 * (d + 1);
    if (budget.left < 0) return;
    for (let k1 = -d + k1Start; k1 <= d - k1End; k1 += 2) {
      const at = off + k1;
      let x1 = k1 === -d || (k1 !== d && (v1[at - 1] as number) < (v1[at + 1] as number)) ? (v1[at + 1] as number) : (v1[at - 1] as number) + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[a0 + x1] === b[b0 + y1]) {
        x1 += 1;
        y1 += 1;
      }
      v1[at] = x1;
      if (x1 > n) {
        k1End += 2;
      } else if (y1 > m) {
        k1Start += 2;
      } else if (front) {
        const other = off + delta - k1;
        if (other >= 0 && other < size && v2[other] !== -1 && x1 >= n - (v2[other] as number)) {
          pushSplit(a0, n, b0, m, x1, y1, work);
          return;
        }
      }
    }
    for (let k2 = -d + k2Start; k2 <= d - k2End; k2 += 2) {
      const at = off + k2;
      let x2 = k2 === -d || (k2 !== d && (v2[at - 1] as number) < (v2[at + 1] as number)) ? (v2[at + 1] as number) : (v2[at - 1] as number) + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[a0 + n - x2 - 1] === b[b0 + m - y2 - 1]) {
        x2 += 1;
        y2 += 1;
      }
      v2[at] = x2;
      if (x2 > n) {
        k2End += 2;
      } else if (y2 > m) {
        k2Start += 2;
      } else if (!front) {
        const other = off + delta - k2;
        if (other >= 0 && other < size && v1[other] !== -1) {
          const x1 = v1[other] as number;
          const y1 = off + x1 - other;
          if (x1 >= n - x2) {
            pushSplit(a0, n, b0, m, x1, y1, work);
            return;
          }
        }
      }
    }
  }
}

function pushSplit(a0: number, n: number, b0: number, m: number, x: number, y: number, work: number[]): void {
  // A split at a corner would queue the same range again; leave it unmatched instead.
  if ((x === 0 && y === 0) || (x === n && y === m)) return;
  work.push(a0, a0 + x, b0, b0 + y);
  work.push(a0 + x, a0 + n, b0 + y, b0 + m);
}
