/**
 * Paragraph-level comparison of two documents.
 *
 * 1. Identical paragraphs are aligned with the sequence diff.
 * 2. Between them, paragraphs are paired in order by token overlap; one
 *    paragraph may pair with several neighbours (a split) or several with one
 *    (a merge).
 * 3. What is still unpaired on both sides is searched for moved paragraphs:
 *    identical first, then the most similar; neighbours of a moved paragraph
 *    join its block.
 *
 * The result maps every paragraph of `a` and of `b` exactly once, in order.
 * A caller compares the text inside `modify`, `split`, `merge` and moved
 * paragraphs with `diffWords`.
 */

import { OfficeError } from "../errors.js";
import { matchKeys } from "./diff.js";
import { Bags } from "./paragraph-bags.js";

export type ParagraphOpType = "equal" | "modify" | "insert" | "delete" | "split" | "merge" | "moveFrom" | "moveTo";

/**
 * One step of a paragraph diff. Ranges are index ranges, end exclusive, and
 * are contiguous over both documents in the order of the returned array.
 *
 * | type       | `a` range              | `b` range              |
 * | ---------- | ---------------------- | ---------------------- |
 * | `equal`    | k identical paragraphs | the same k paragraphs  |
 * | `modify`   | 1 paragraph            | its edited version     |
 * | `split`    | 1 paragraph            | the 2–4 it became      |
 * | `merge`    | 2–4 paragraphs         | the 1 they became      |
 * | `delete`   | k paragraphs           | empty                  |
 * | `insert`   | empty                  | k paragraphs           |
 * | `moveFrom` | k paragraphs           | empty                  |
 * | `moveTo`   | empty                  | the same k, in order   |
 */
export interface ParagraphDiffOp {
  type: ParagraphOpType;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  /** Pairs a `moveFrom` with its `moveTo`; null for the other types. */
  moveId: string | null;
  /** 1 for identical text, lower for edited text, 0 for `insert` and `delete`. For a moved block, the lowest of its paragraphs. */
  similarity: number;
  /** For a move, the range of the other half on the other side (paragraph `i` of one pairs with paragraph `i` of the other). */
  peer: { start: number; end: number } | null;
}

export interface ParagraphDiffOptions {
  /** Report relocated paragraphs as moves. Default true. */
  detectMoves?: boolean;
  /** Smallest number of non-whitespace tokens in a paragraph that can start a move. Default 3. */
  minMoveTokens?: number;
  /** Smallest similarity (0–1) at which two paragraphs count as versions of each other. Default 0.5. */
  similarity?: number;
  /** Above this many paragraphs on either side only identical paragraphs are aligned. Default 20 000. */
  maxParagraphs?: number;
}

/** Largest gap, in cells, aligned with the full dynamic programme. */
const DP_CELLS = 40000;
/** Paragraphs looked ahead when a gap is too large for it. */
const GREEDY_WINDOW = 24;
/** Bag elements the similarity search may compare in one diff. */
const WORK_LIMIT = 6e7;
/** Most paragraphs a split or a merge spans. */
const MAX_SPAN = 4;
/** Share of a part that must be found in the whole for a split or merge. */
const PART_CONTAINMENT = 0.6;
/** Most unpaired-by-unpaired pairs searched for edited moves. */
const MOVE_PAIRS = 40000;

interface Group {
  a0: number;
  aLen: number;
  b0: number;
  bLen: number;
  sim: number;
}

interface Context {
  a: readonly string[];
  b: readonly string[];
  bags: Bags;
  threshold: number;
  groups: Group[];
}

/** Pairs the paragraphs of one gap in order, with splits and merges, by dynamic programming over shared tokens. */
function alignGapExact(ctx: Context, a0: number, a1: number, b0: number, b1: number): void {
  const { bags, threshold } = ctx;
  const ga = a1 - a0;
  const gb = b1 - b0;
  const width = gb + 1;
  const shared = new Int32Array(ga * gb);
  for (let i = 0; i < ga; i += 1) {
    const x = bags.bag(0, a0 + i);
    for (let j = 0; j < gb; j += 1) shared[i * gb + j] = bags.common(x, bags.bag(1, b0 + j));
  }
  const score = new Float64Array((ga + 1) * width);
  // 0 skip a, 1 skip b, 2 pair, 2 + k split into k, 6 + k merge of k (k = 2 … MAX_SPAN).
  const choice = new Uint8Array((ga + 1) * width);
  const sims = new Float64Array((ga + 1) * width);
  for (let j = 1; j <= gb; j += 1) choice[j] = 1;
  for (let i = 1; i <= ga; i += 1) {
    const x = bags.bag(0, a0 + i - 1);
    for (let j = 1; j <= gb; j += 1) {
      const y = bags.bag(1, b0 + j - 1);
      const at = i * width + j;
      let best = score[at - width] as number;
      let pick = 0;
      let sim = 0;
      if ((score[at - 1] as number) > best) {
        best = score[at - 1] as number;
        pick = 1;
      }
      const c = shared[(i - 1) * gb + j - 1] as number;
      const pairSim = Bags.dice(c, x.length, y.length);
      if (pairSim >= threshold && (score[at - width - 1] as number) + c > best) {
        best = (score[at - width - 1] as number) + c;
        pick = 2;
        sim = pairSim;
      }
      for (let k = 2; k <= MAX_SPAN && k <= j; k += 1) {
        // a[i-1] became b[j-k … j): every part must lie mostly inside it.
        let parts = true;
        for (let t = j - k; t < j && parts; t += 1) {
          const size = bags.bag(1, b0 + t).length;
          parts = size > 0 && (shared[(i - 1) * gb + t] as number) >= PART_CONTAINMENT * size;
        }
        if (!parts) continue;
        const whole = bags.concat(1, b0 + j - k, b0 + j);
        const cc = bags.common(x, whole);
        const s = Bags.dice(cc, x.length, whole.length);
        const candidate = (score[at - width - k] as number) + cc - 0.25;
        if (s >= threshold && candidate > best) {
          best = candidate;
          pick = 2 + k;
          sim = s;
        }
      }
      for (let k = 2; k <= MAX_SPAN && k <= i; k += 1) {
        let parts = true;
        for (let t = i - k; t < i && parts; t += 1) {
          const size = bags.bag(0, a0 + t).length;
          parts = size > 0 && (shared[t * gb + j - 1] as number) >= PART_CONTAINMENT * size;
        }
        if (!parts) continue;
        const whole = bags.concat(0, a0 + i - k, a0 + i);
        const cc = bags.common(whole, y);
        const s = Bags.dice(cc, whole.length, y.length);
        const candidate = (score[at - k * width - 1] as number) + cc - 0.25;
        if (s >= threshold && candidate > best) {
          best = candidate;
          pick = 6 + k;
          sim = s;
        }
      }
      score[at] = best;
      choice[at] = pick;
      sims[at] = sim;
    }
  }
  const found: Group[] = [];
  let i = ga;
  let j = gb;
  while (i > 0 && j > 0) {
    const at = i * width + j;
    const pick = choice[at] as number;
    if (pick === 0) {
      i -= 1;
    } else if (pick === 1) {
      j -= 1;
    } else if (pick === 2) {
      i -= 1;
      j -= 1;
      found.push({ a0: a0 + i, aLen: 1, b0: b0 + j, bLen: 1, sim: sims[at] as number });
    } else if (pick <= 2 + MAX_SPAN) {
      const k = pick - 2;
      i -= 1;
      j -= k;
      found.push({ a0: a0 + i, aLen: 1, b0: b0 + j, bLen: k, sim: sims[at] as number });
    } else {
      const k = pick - 6;
      i -= k;
      j -= 1;
      found.push({ a0: a0 + i, aLen: k, b0: b0 + j, bLen: 1, sim: sims[at] as number });
    }
  }
  for (let k = found.length - 1; k >= 0; k -= 1) ctx.groups.push(found[k] as Group);
}

/** Pairs the paragraphs of a large gap in order, looking a fixed window ahead. */
function alignGapGreedy(ctx: Context, a0: number, a1: number, b0: number, b1: number): void {
  const { bags, threshold } = ctx;
  let next = b0;
  for (let i = a0; i < a1 && next < b1 && bags.work < WORK_LIMIT; i += 1) {
    const x = bags.bag(0, i);
    let best = -1;
    let bestSim = 0;
    for (let j = next; j < b1 && j < next + GREEDY_WINDOW; j += 1) {
      const sim = bags.similarity(x, bags.bag(1, j));
      if (sim >= threshold && sim > bestSim) {
        best = j;
        bestSim = sim;
      }
    }
    if (best < 0) continue;
    ctx.groups.push({ a0: i, aLen: 1, b0: best, bLen: 1, sim: bestSim });
    next = best + 1;
  }
}

interface Moves {
  /** For a moved paragraph of `a`, its index in `b`; else -1. */
  aTo: Int32Array;
  /** For a moved paragraph of `b`, its index in `a`; else -1. */
  bFrom: Int32Array;
  /** Similarity of each moved paragraph of `a` with its target. */
  sim: Float64Array;
}

function findMoves(ctx: Context, aFree: Uint8Array, bFree: Uint8Array, minTokens: number): Moves {
  const { a, b, bags } = ctx;
  const moves: Moves = { aTo: new Int32Array(a.length).fill(-1), bFrom: new Int32Array(b.length).fill(-1), sim: new Float64Array(a.length) };
  const link = (i: number, j: number, sim: number): void => {
    moves.aTo[i] = j;
    moves.bFrom[j] = i;
    moves.sim[i] = sim;
    aFree[i] = 0;
    bFree[j] = 0;
  };
  // Unpaired paragraphs of `b` by text, in order. Bounded by the number of paragraphs.
  const byText = new Map<string, number[]>();
  const freeA: number[] = [];
  const freeB: number[] = [];
  for (let j = 0; j < b.length; j += 1) {
    if (bFree[j] === 0 || bags.bag(1, j).length < minTokens) continue;
    freeB.push(j);
    const list = byText.get(b[j] as string);
    if (list) list.push(j);
    else byText.set(b[j] as string, [j]);
  }
  for (let i = 0; i < a.length; i += 1) {
    if (aFree[i] === 0 || bags.bag(0, i).length < minTokens) continue;
    const list = byText.get(a[i] as string);
    const j = list?.find((candidate) => bFree[candidate] === 1);
    if (j !== undefined) link(i, j, 1);
    else freeA.push(i);
  }
  const moveThreshold = Math.max(ctx.threshold, PART_CONTAINMENT);
  if (freeA.length > 0 && freeA.length * freeB.length <= MOVE_PAIRS) {
    const pairs: Array<[number, number, number]> = [];
    for (const i of freeA) {
      if (bags.work >= WORK_LIMIT) break;
      for (const j of freeB) {
        if (bFree[j] === 0) continue;
        const sim = bags.similarity(bags.bag(0, i), bags.bag(1, j));
        if (sim >= moveThreshold) pairs.push([sim, i, j]);
      }
    }
    pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    for (const [sim, i, j] of pairs) if (aFree[i] === 1 && bFree[j] === 1) link(i, j, sim);
  }
  // Unpaired neighbours of a moved paragraph that still correspond travel with it, however short.
  const follows = (i: number, j: number): number => {
    if (i < 0 || j < 0 || i >= a.length || j >= b.length || aFree[i] === 0 || bFree[j] === 0) return -1;
    if (a[i] === b[j]) return 1;
    const sim = bags.similarity(bags.bag(0, i), bags.bag(1, j));
    return sim >= moveThreshold ? sim : -1;
  };
  for (let i = 0; i < a.length; i += 1) {
    if ((moves.aTo[i] as number) < 0) continue;
    for (let step = 1, sim = follows(i - step, (moves.aTo[i] as number) - step); sim >= 0; step += 1, sim = follows(i - step, (moves.aTo[i] as number) - step)) {
      link(i - step, (moves.aTo[i] as number) - step, sim);
    }
    for (let step = 1, sim = follows(i + step, (moves.aTo[i] as number) + step); sim >= 0; step += 1, sim = follows(i + step, (moves.aTo[i] as number) + step)) {
      link(i + step, (moves.aTo[i] as number) + step, sim);
    }
  }
  return moves;
}

function resolveOptions(options: ParagraphDiffOptions | undefined): Required<ParagraphDiffOptions> {
  const resolved = {
    detectMoves: options?.detectMoves ?? true,
    minMoveTokens: options?.minMoveTokens ?? 3,
    similarity: options?.similarity ?? 0.5,
    maxParagraphs: options?.maxParagraphs ?? 20000,
  };
  if (!Number.isInteger(resolved.minMoveTokens) || resolved.minMoveTokens < 1) {
    throw new OfficeError("invalid_argument", "minMoveTokens must be an integer of at least 1");
  }
  if (!(resolved.similarity > 0 && resolved.similarity <= 1)) {
    throw new OfficeError("invalid_argument", "similarity must be above 0 and at most 1");
  }
  if (!(resolved.maxParagraphs >= 0)) throw new OfficeError("invalid_argument", "maxParagraphs must be at least 0");
  return resolved;
}

/** Compares two documents given as paragraph texts. Deterministic. */
export function diffParagraphs(a: readonly string[], b: readonly string[], options?: ParagraphDiffOptions): ParagraphDiffOp[] {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new OfficeError("invalid_argument", "diffParagraphs compares two arrays");
  const resolved = resolveOptions(options);
  const n = a.length;
  const m = b.length;
  const identical = matchKeys(a, b, Number.MAX_SAFE_INTEGER);
  const ctx: Context = { a, b, bags: new Bags(a, b), threshold: resolved.similarity, groups: [] };
  const fuzzy = n <= resolved.maxParagraphs && m <= resolved.maxParagraphs;
  let gapA = 0;
  let gapB = 0;
  const alignGap = (aEnd: number, bEnd: number): void => {
    if (!fuzzy || gapA === aEnd || gapB === bEnd || ctx.bags.work >= WORK_LIMIT) return;
    if ((aEnd - gapA) * (bEnd - gapB) <= DP_CELLS) alignGapExact(ctx, gapA, aEnd, gapB, bEnd);
    else alignGapGreedy(ctx, gapA, aEnd, gapB, bEnd);
  };
  for (let i = 0; i < n; i += 1) {
    const j = identical[i] as number;
    if (j < 0) continue;
    alignGap(i, j);
    ctx.groups.push({ a0: i, aLen: 1, b0: j, bLen: 1, sim: 1 });
    gapA = i + 1;
    gapB = j + 1;
  }
  alignGap(n, m);

  const aGroup = new Int32Array(n).fill(-1);
  const aFree = new Uint8Array(n).fill(1);
  const bFree = new Uint8Array(m).fill(1);
  ctx.groups.forEach((group, index) => {
    for (let k = 0; k < group.aLen; k += 1) {
      aGroup[group.a0 + k] = index;
      aFree[group.a0 + k] = 0;
    }
    for (let k = 0; k < group.bLen; k += 1) bFree[group.b0 + k] = 0;
  });
  const moves = resolved.detectMoves && fuzzy ? findMoves(ctx, aFree, bFree, resolved.minMoveTokens) : null;
  return emit(ctx, aGroup, moves);
}

function emit(ctx: Context, aGroup: Int32Array, moves: Moves | null): ParagraphDiffOp[] {
  const { a, b, groups } = ctx;
  const n = a.length;
  const m = b.length;
  // Block number of each moved paragraph of `a`: neighbours that stay neighbours share one.
  const block = new Int32Array(n);
  let blocks = 0;
  if (moves) {
    for (let i = 0; i < n; i += 1) {
      const to = moves.aTo[i] as number;
      if (to < 0) continue;
      const joins = i > 0 && (moves.aTo[i - 1] as number) >= 0 && (moves.aTo[i - 1] as number) + 1 === to;
      if (!joins) blocks += 1;
      block[i] = blocks;
    }
  }
  const movedA = (i: number): number => (moves && i < n ? (block[i] as number) : 0);
  const movedB = (j: number): number => (moves && j < m && (moves.bFrom[j] as number) >= 0 ? (block[moves.bFrom[j] as number] as number) : 0);
  const ops: ParagraphDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && aGroup[i] === -1) {
      const start = i;
      const id = movedA(i);
      i += 1;
      while (i < n && aGroup[i] === -1 && movedA(i) === id) i += 1;
      if (id === 0) {
        ops.push({ type: "delete", aStart: start, aEnd: i, bStart: j, bEnd: j, moveId: null, similarity: 0, peer: null });
      } else {
        const to = (moves as Moves).aTo[start] as number;
        let sim = 1;
        for (let k = start; k < i; k += 1) sim = Math.min(sim, (moves as Moves).sim[k] as number);
        ops.push({ type: "moveFrom", aStart: start, aEnd: i, bStart: j, bEnd: j, moveId: `m${id}`, similarity: sim, peer: { start: to, end: to + i - start } });
      }
      continue;
    }
    const group = i < n ? (groups[aGroup[i] as number] as Group) : null;
    if (j < m && (!group || group.b0 > j)) {
      const start = j;
      const id = movedB(j);
      const limit = group ? group.b0 : m;
      j += 1;
      while (j < limit && movedB(j) === id) j += 1;
      if (id === 0) {
        ops.push({ type: "insert", aStart: i, aEnd: i, bStart: start, bEnd: j, moveId: null, similarity: 0, peer: null });
      } else {
        const from = (moves as Moves).bFrom[start] as number;
        let sim = 1;
        for (let k = from; k < from + j - start; k += 1) sim = Math.min(sim, (moves as Moves).sim[k] as number);
        ops.push({ type: "moveTo", aStart: i, aEnd: i, bStart: start, bEnd: j, moveId: `m${id}`, similarity: sim, peer: { start: from, end: from + j - start } });
      }
      continue;
    }
    if (!group || group.b0 !== j || group.a0 !== i) throw new OfficeError("invalid_operation", "paragraph alignment is not monotone");
    const same = group.aLen === 1 && group.bLen === 1 && a[i] === b[j];
    const last = ops[ops.length - 1];
    if (same && last && last.type === "equal") {
      last.aEnd += 1;
      last.bEnd += 1;
    } else {
      const type: ParagraphOpType = same ? "equal" : group.bLen > 1 ? "split" : group.aLen > 1 ? "merge" : "modify";
      ops.push({ type, aStart: i, aEnd: i + group.aLen, bStart: j, bEnd: j + group.bLen, moveId: null, similarity: same ? 1 : group.sim, peer: null });
    }
    i += group.aLen;
    j += group.bLen;
  }
  return ops;
}
