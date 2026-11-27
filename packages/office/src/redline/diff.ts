/**
 * `diffWords` and `diffSequences`: tokenise, align with Myers, clean the
 * result up so it reads naturally, detect moves, and report ops.
 *
 * Bounds: a text is at most {@link MAX_TEXT_LENGTH} code units. A middle
 * (what is left after the common prefix and suffix) above `maxTokens`
 * tokens, or one whose token alignment exhausts the work budget, is aligned
 * by whole lines first and token by token only inside the changed regions
 * that fit. What fits nowhere is one deletion and one insertion.
 */

import type { DiffOp, DiffOptions, DiffSequences, DiffWords, SequenceDiffOp } from "../api/redline.js";
import { OfficeError } from "../errors.js";
import {
  CLS_NEWLINE,
  classify,
  createAlignment,
  plainTable,
  readOps,
  type Alignment,
  type TokenOp,
  type TokenTable,
} from "./alignment.js";
import { absorbEqualities, shiftBoundaries } from "./cleanup.js";
import { consolidateMoves, detectMoves, renumberMoves } from "./moves.js";
import { alignRange, type WorkBudget } from "./myers.js";
import { tokenOffsets } from "./tokenize.js";

/** Longest text `diffWords` accepts, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 16 * 1024 * 1024;
/** Most items `diffSequences` accepts on either side. */
export const MAX_SEQUENCE_LENGTH = 2_000_000;
const DEFAULT_MAX_TOKENS = 20000;
/** Diagonal steps one alignment phase may spend: a fraction of a second on current hardware. */
const ALIGN_BUDGET = 1 << 25;
/** Token comparisons move detection may spend. */
const MOVE_BUDGET = 1 << 22;
/** Largest equality, in non-whitespace tokens, that a word diff folds into the edits around it. */
const MAX_ABSORBED_WORDS = 3;

interface Resolved {
  detectMoves: boolean;
  minMoveTokens: number;
  maxTokens: number;
}

function resolve(options: DiffOptions | undefined, defaultMinMove: number): Resolved {
  const minMoveTokens = options?.minMoveTokens ?? defaultMinMove;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(minMoveTokens) || minMoveTokens < 1) {
    throw new OfficeError("invalid_argument", "minMoveTokens must be an integer of at least 1");
  }
  if (typeof maxTokens !== "number" || Number.isNaN(maxTokens) || maxTokens < 0) {
    throw new OfficeError("invalid_argument", "maxTokens must be a number of at least 0");
  }
  const granularity = options?.granularity;
  if (granularity !== undefined && granularity !== "word" && granularity !== "char") {
    throw new OfficeError("invalid_argument", "granularity must be word or char");
  }
  return { detectMoves: options?.detectMoves ?? true, minMoveTokens, maxTokens };
}

interface Interned {
  aTok: Int32Array;
  bTok: Int32Array;
  table: TokenTable;
}

function internTokens(a: string, aOff: readonly number[], b: string, bOff: readonly number[]): Interned {
  // Bounded by the number of tokens in the two texts; dropped when the diff returns.
  const ids = new Map<string, number>();
  const space: number[] = [];
  const length: number[] = [];
  const cls: number[] = [];
  const intern = (text: string, off: readonly number[]): Int32Array => {
    const out = new Int32Array(off.length - 1);
    for (let i = 0; i + 1 < off.length; i += 1) {
      const token = text.slice(off[i], off[i + 1]);
      let id = ids.get(token);
      if (id === undefined) {
        id = ids.size;
        ids.set(token, id);
        const c = classify(token);
        cls.push(c);
        space.push(c & 1);
        length.push(token.length);
      }
      out[i] = id;
    }
    return out;
  };
  const aTok = intern(a, aOff);
  const bTok = intern(b, bOff);
  return {
    aTok,
    bTok,
    table: { count: ids.size, space: Uint8Array.from(space), length: Int32Array.from(length), cls: Uint8Array.from(cls) },
  };
}

function internKeys(a: readonly string[], b: readonly string[]): Interned {
  // Bounded by the number of items; dropped when the diff returns.
  const ids = new Map<string, number>();
  const intern = (keys: readonly string[]): Int32Array => {
    const out = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i]);
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  const aTok = intern(a);
  const bTok = intern(b);
  return { aTok, bTok, table: plainTable(ids.size) };
}

/** Token index where each line of `tok[from, to)` starts, plus `to`. A line ends after a token that holds a line break. */
function lineStarts(tok: Int32Array, table: TokenTable, from: number, to: number): number[] {
  const starts = [from];
  for (let i = from; i < to; i += 1) {
    if ((table.cls[tok[i] as number] as number) & CLS_NEWLINE && i + 1 < to) starts.push(i + 1);
  }
  starts.push(to);
  return starts;
}

/**
 * Aligns the middle by whole lines, then token by token inside each changed
 * region that fits the token budget. Returns false when some region was left
 * as one deletion and one insertion.
 */
function alignByLines(
  texts: { a: string; aOff: readonly number[]; b: string; bOff: readonly number[] },
  it: Interned,
  range: { a0: number; a1: number; b0: number; b1: number },
  match: Int32Array,
  maxTokens: number,
): boolean {
  const aLines = lineStarts(it.aTok, it.table, range.a0, range.a1);
  const bLines = lineStarts(it.bTok, it.table, range.b0, range.b1);
  const aCount = aLines.length - 1;
  const bCount = bLines.length - 1;
  if (aCount > maxTokens || bCount > maxTokens) return false;
  const lineKeys = internKeys(
    Array.from({ length: aCount }, (_, i) => texts.a.slice(texts.aOff[aLines[i] as number], texts.aOff[aLines[i + 1] as number])),
    Array.from({ length: bCount }, (_, i) => texts.b.slice(texts.bOff[bLines[i] as number], texts.bOff[bLines[i + 1] as number])),
  );
  const lineBudget: WorkBudget = { left: ALIGN_BUDGET };
  const lineMatch = new Int32Array(aCount).fill(-1);
  alignRange(lineKeys.aTok, 0, aCount, lineKeys.bTok, 0, bCount, lineMatch, lineBudget);
  let complete = lineBudget.left > 0;
  const tokenBudget: WorkBudget = { left: ALIGN_BUDGET };
  let gapA = range.a0;
  let gapB = range.b0;
  const refine = (aEnd: number, bEnd: number): void => {
    if (gapA === aEnd || gapB === bEnd) return;
    if (aEnd - gapA > maxTokens || bEnd - gapB > maxTokens || tokenBudget.left <= 0) {
      complete = false;
      return;
    }
    alignRange(it.aTok, gapA, aEnd, it.bTok, gapB, bEnd, match, tokenBudget);
  };
  for (let line = 0; line < aCount; line += 1) {
    const other = lineMatch[line] as number;
    if (other < 0) continue;
    const aStart = aLines[line] as number;
    const aEnd = aLines[line + 1] as number;
    const bStart = bLines[other] as number;
    const bEnd = bLines[other + 1] as number;
    if (aEnd - aStart !== bEnd - bStart) continue;
    let same = true;
    for (let k = 0; k < aEnd - aStart && same; k += 1) same = it.aTok[aStart + k] === it.bTok[bStart + k];
    if (!same) continue;
    refine(aStart, bStart);
    for (let k = 0; k < aEnd - aStart; k += 1) match[aStart + k] = bStart + k;
    gapA = aEnd;
    gapB = bEnd;
  }
  refine(range.a1, range.b1);
  return complete && tokenBudget.left > 0;
}

/** Builds the alignment of two interned token sequences. `complete` is false when a bound cut the work short. */
function align(
  it: Interned,
  maxTokens: number,
  texts: { a: string; aOff: readonly number[]; b: string; bOff: readonly number[] } | null,
): { al: Alignment; complete: boolean } {
  const { aTok, bTok } = it;
  const n = aTok.length;
  const m = bTok.length;
  let prefix = 0;
  while (prefix < n && prefix < m && aTok[prefix] === bTok[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aTok[n - 1 - suffix] === bTok[m - 1 - suffix]) suffix += 1;
  const match = new Int32Array(n).fill(-1);
  for (let i = 0; i < prefix; i += 1) match[i] = i;
  for (let k = 1; k <= suffix; k += 1) match[n - k] = m - k;
  const range = { a0: prefix, a1: n - suffix, b0: prefix, b1: m - suffix };
  const midA = range.a1 - range.a0;
  const midB = range.b1 - range.b0;
  let complete = true;
  if (midA > 0 && midB > 0) {
    let fine = false;
    if (midA <= maxTokens && midB <= maxTokens) {
      const attempt = match.slice();
      const budget: WorkBudget = { left: ALIGN_BUDGET };
      alignRange(aTok, range.a0, range.a1, bTok, range.b0, range.b1, attempt, budget);
      // Without texts there is no line fallback: a partial alignment is still the best there is.
      if (budget.left > 0 || !texts) {
        match.set(attempt);
        fine = budget.left > 0;
      }
    }
    if (!fine) complete = texts ? alignByLines(texts, it, range, match, maxTokens) : false;
  }
  return { al: createAlignment(aTok, bTok, match), complete };
}

function findMoves(al: Alignment, table: TokenTable, options: Resolved, complete: boolean, absorbWords: number): void {
  let lastMove = 0;
  let before: Int32Array | null = null;
  const budget: WorkBudget = { left: MOVE_BUDGET };
  const search = (original: Int32Array | null): number =>
    detectMoves(al, table, { minTokens: options.minMoveTokens, original, sameGap: complete, budget, lastMove });
  if (options.detectMoves) lastMove = search(null);
  if (absorbWords >= 0) {
    const snapshot = al.aMatch.slice();
    if (absorbEqualities(al, table, absorbWords)) {
      before = snapshot;
      shiftBoundaries(al, table);
      if (options.detectMoves) lastMove = search(before);
    }
  }
  consolidateMoves(al, lastMove, before);
}

export const diffWords: DiffWords = (a, b, options) => {
  if (typeof a !== "string" || typeof b !== "string") throw new OfficeError("invalid_argument", "diffWords compares two strings");
  if (a.length > MAX_TEXT_LENGTH || b.length > MAX_TEXT_LENGTH) {
    throw new OfficeError("limit_exceeded", "text is too long to compare", { details: { limit: MAX_TEXT_LENGTH } });
  }
  const resolved = resolve(options, 4);
  const granularity = options?.granularity ?? "word";
  const aOff = tokenOffsets(a, granularity);
  const bOff = tokenOffsets(b, granularity);
  const it = internTokens(a, aOff, b, bOff);
  const { al, complete } = align(it, resolved.maxTokens, { a, aOff, b, bOff });
  shiftBoundaries(al, it.table);
  findMoves(al, it.table, resolved, complete, granularity === "word" ? MAX_ABSORBED_WORDS : Number.MAX_SAFE_INTEGER);
  renumberMoves(al);
  const ops = readOps(al).map((op: TokenOp): DiffOp => {
    const aStart = aOff[op.aStart] as number;
    const aEnd = aOff[op.aEnd] as number;
    const bStart = bOff[op.bStart] as number;
    const bEnd = bOff[op.bEnd] as number;
    const onA = op.type === "equal" || op.type === "delete" || op.type === "moveFrom";
    return {
      type: op.type,
      text: onA ? a.slice(aStart, aEnd) : b.slice(bStart, bEnd),
      aStart,
      aEnd,
      bStart,
      bEnd,
      moveId: op.move > 0 ? `m${op.move}` : null,
    };
  });
  return granularity === "word" ? shareSpace(ops, a) : ops;
};

/**
 * A whitespace run is one token, so `"a b"` against `"a  b"` replaces the
 * run. Here the whitespace that a deletion and the insertion after it share
 * at their start and end becomes equal text, leaving only the real change.
 */
function shareSpace(ops: DiffOp[], a: string): DiffOp[] {
  const out: DiffOp[] = [];
  const equal = (aStart: number, aEnd: number, bStart: number, bEnd: number): void => {
    if (aEnd === aStart) return;
    const last = out[out.length - 1];
    if (last && last.type === "equal") {
      last.aEnd = aEnd;
      last.bEnd = bEnd;
      last.text = a.slice(last.aStart, aEnd);
    } else {
      out.push({ type: "equal", text: a.slice(aStart, aEnd), aStart, aEnd, bStart, bEnd, moveId: null });
    }
  };
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as DiffOp;
    const next = ops[i + 1];
    if (op.type === "equal") {
      equal(op.aStart, op.aEnd, op.bStart, op.bEnd);
      continue;
    }
    if (op.type !== "delete" || !next || next.type !== "insert") {
      out.push(op);
      continue;
    }
    const gone = op.text;
    const come = next.text;
    const shortest = Math.min(gone.length, come.length);
    let head = 0;
    while (head < shortest && gone[head] === come[head] && SPACE.test(gone[head] as string)) head += 1;
    let tail = 0;
    while (tail < shortest - head && gone[gone.length - 1 - tail] === come[come.length - 1 - tail] && SPACE.test(gone[gone.length - 1 - tail] as string)) {
      tail += 1;
    }
    if (head === 0 && tail === 0) {
      out.push(op);
      continue;
    }
    equal(op.aStart, op.aStart + head, next.bStart, next.bStart + head);
    if (gone.length > head + tail) {
      out.push({
        type: "delete",
        text: gone.slice(head, gone.length - tail),
        aStart: op.aStart + head,
        aEnd: op.aEnd - tail,
        bStart: next.bStart + head,
        bEnd: next.bStart + head,
        moveId: null,
      });
    }
    if (come.length > head + tail) {
      out.push({
        type: "insert",
        text: come.slice(head, come.length - tail),
        aStart: op.aEnd - tail,
        aEnd: op.aEnd - tail,
        bStart: next.bStart + head,
        bEnd: next.bEnd - tail,
        moveId: null,
      });
    }
    equal(op.aEnd - tail, op.aEnd, next.bEnd - tail, next.bEnd);
    i += 1;
  }
  return out;
}

const SPACE = /\s/;

export const diffSequences: DiffSequences = (a, b, options) => {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new OfficeError("invalid_argument", "diffSequences compares two arrays");
  if (a.length > MAX_SEQUENCE_LENGTH || b.length > MAX_SEQUENCE_LENGTH) {
    throw new OfficeError("limit_exceeded", "sequence is too long to compare", { details: { limit: MAX_SEQUENCE_LENGTH } });
  }
  const resolved = resolve(options, 1);
  const it = internKeys(a, b);
  const { al, complete } = align(it, resolved.maxTokens, null);
  findMoves(al, it.table, resolved, complete, -1);
  renumberMoves(al);
  return readOps(al).map(
    (op: TokenOp): SequenceDiffOp => ({
      type: op.type,
      aStart: op.aStart,
      aEnd: op.aEnd,
      bStart: op.bStart,
      bEnd: op.bEnd,
      moveId: op.move > 0 ? `m${op.move}` : null,
    }),
  );
};

/** Internal: the matching of two key sequences without moves, as `match[i] = j` or -1. Used by the paragraph diff. */
export function matchKeys(a: readonly string[], b: readonly string[], maxTokens: number): Int32Array {
  return align(internKeys(a, b), maxTokens, null).al.aMatch;
}
