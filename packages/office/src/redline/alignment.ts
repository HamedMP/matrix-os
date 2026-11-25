/**
 * The working form of a diff: two token sequences, a monotone matching
 * between them, and move labels on the unmatched tokens.
 *
 * Every later pass (boundary shifting, absorbing small equalities, move
 * detection) rewrites these arrays in place, and the ops are read off them
 * at the end, so no pass has to keep an op list consistent.
 */

import { OfficeError } from "../errors.js";

/** Bits of {@link TokenTable.cls}. */
export const CLS_SPACE = 1;
export const CLS_NEWLINE = 2;
export const CLS_BLANK_LINE = 4;
export const CLS_SENTENCE_END = 8;
export const CLS_WORD = 16;

/** Facts about each distinct token, indexed by token id. */
export interface TokenTable {
  /** Number of distinct tokens. Ids are `0 … count - 1`. */
  count: number;
  /** 1 when the token is whitespace: it does not count towards a move. */
  space: Uint8Array;
  /** Length of the token in UTF-16 code units (1 for sequence items). */
  length: Int32Array;
  /** `CLS_*` bits used to score edit boundaries. */
  cls: Uint8Array;
}

export interface Alignment {
  aTok: Int32Array;
  bTok: Int32Array;
  /** Index of the equal token in `b`, or -1. Matched pairs never cross. */
  aMatch: Int32Array;
  /** Index of the equal token in `a`, or -1. */
  bMatch: Int32Array;
  /** Move number of an unmatched token, or 0. */
  aMove: Int32Array;
  bMove: Int32Array;
}

export function createAlignment(aTok: Int32Array, bTok: Int32Array, aMatch: Int32Array): Alignment {
  const bMatch = new Int32Array(bTok.length).fill(-1);
  for (let i = 0; i < aMatch.length; i += 1) {
    const j = aMatch[i] as number;
    if (j >= 0) bMatch[j] = i;
  }
  return { aTok, bTok, aMatch, bMatch, aMove: new Int32Array(aTok.length), bMove: new Int32Array(bTok.length) };
}

const SENTENCE_END = /^[.!?。！？]$/;
const WORD_START = /^[\p{L}\p{N}\p{M}]/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const BLANK_LINE = /[\n\u2028\u2029]\r?[\n\u2028\u2029]|\r\r/;

/** Boundary class of one token text. */
export function classify(token: string): number {
  if (/^\s/.test(token)) {
    let cls = CLS_SPACE;
    if (LINE_BREAK.test(token)) cls |= CLS_NEWLINE;
    if (BLANK_LINE.test(token)) cls |= CLS_BLANK_LINE;
    return cls;
  }
  if (WORD_START.test(token)) return CLS_WORD;
  return SENTENCE_END.test(token) ? CLS_SENTENCE_END : 0;
}

/** A table for opaque sequence items: nothing is whitespace, every item weighs 1. */
export function plainTable(count: number): TokenTable {
  return { count, space: new Uint8Array(count), length: new Int32Array(count).fill(1), cls: new Uint8Array(count) };
}

/** One step of the diff over token indexes, read off an {@link Alignment}. */
export interface TokenOp {
  type: "equal" | "delete" | "insert" | "moveFrom" | "moveTo";
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  /** Move number, or 0. */
  move: number;
}

/**
 * Reads the ops off an alignment. In each gap the `a`-side pieces come
 * first, then the `b`-side pieces; a piece ends where the move label changes.
 */
export function readOps(al: Alignment): TokenOp[] {
  const { aMatch, bMatch, aMove, bMove } = al;
  const n = aMatch.length;
  const m = bMatch.length;
  const ops: TokenOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const before = i + j;
    if (i < n && j < m && aMatch[i] === j) {
      const aStart = i;
      const bStart = j;
      while (i < n && j < m && aMatch[i] === j) {
        i += 1;
        j += 1;
      }
      ops.push({ type: "equal", aStart, aEnd: i, bStart, bEnd: j, move: 0 });
      continue;
    }
    while (i < n && (aMatch[i] as number) < 0) {
      const start = i;
      const move = aMove[i] as number;
      while (i < n && (aMatch[i] as number) < 0 && aMove[i] === move) i += 1;
      ops.push({ type: move > 0 ? "moveFrom" : "delete", aStart: start, aEnd: i, bStart: j, bEnd: j, move });
    }
    while (j < m && (bMatch[j] as number) < 0) {
      const start = j;
      const move = bMove[j] as number;
      while (j < m && (bMatch[j] as number) < 0 && bMove[j] === move) j += 1;
      ops.push({ type: move > 0 ? "moveTo" : "insert", aStart: i, aEnd: i, bStart: start, bEnd: j, move });
    }
    if (i + j === before) throw new OfficeError("invalid_operation", "diff alignment is not monotone");
  }
  return ops;
}
