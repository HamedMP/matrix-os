/**
 * Token bags for paragraph similarity: each paragraph is reduced to the
 * sorted ids of its non-whitespace tokens, and two paragraphs are compared
 * by how many tokens they share (Dice coefficient).
 */

import { tokenOffsets } from "./tokenize.js";

/** Tokens of one paragraph that take part in similarity. Longer paragraphs are compared on their start. */
const MAX_BAG = 4096;

export class Bags {
  // Token text to id. Bounded by the tokens of the paragraphs asked for; lives for one diff.
  private readonly ids = new Map<string, number>();
  private readonly cache: [Array<Int32Array | undefined>, Array<Int32Array | undefined>];
  /** Bag elements compared so far, for the caller's work bound. */
  work = 0;

  constructor(
    private readonly a: readonly string[],
    private readonly b: readonly string[],
  ) {
    this.cache = [new Array<Int32Array | undefined>(a.length), new Array<Int32Array | undefined>(b.length)];
  }

  /** The sorted token ids of paragraph `index` of side 0 (`a`) or 1 (`b`). */
  bag(side: 0 | 1, index: number): Int32Array {
    const cached = this.cache[side][index];
    if (cached) return cached;
    const text = String((side === 0 ? this.a : this.b)[index] ?? "");
    const offsets = tokenOffsets(text);
    const out: number[] = [];
    for (let i = 0; i + 1 < offsets.length && out.length < MAX_BAG; i += 1) {
      const token = text.slice(offsets[i], offsets[i + 1]);
      if (/^\s/.test(token)) continue;
      let id = this.ids.get(token);
      if (id === undefined) {
        id = this.ids.size;
        this.ids.set(token, id);
      }
      out.push(id);
    }
    const bag = Int32Array.from(out).sort();
    this.cache[side][index] = bag;
    return bag;
  }

  /** Number of tokens two bags share, counting repeats. */
  common(x: Int32Array, y: Int32Array): number {
    let i = 0;
    let j = 0;
    let shared = 0;
    while (i < x.length && j < y.length) {
      const d = (x[i] as number) - (y[j] as number);
      if (d === 0) {
        shared += 1;
        i += 1;
        j += 1;
      } else if (d < 0) {
        i += 1;
      } else {
        j += 1;
      }
    }
    this.work += i + j + 1;
    return shared;
  }

  /** Dice coefficient from a shared count: 1 for the same bag, 0 for nothing in common. */
  static dice(shared: number, xLength: number, yLength: number): number {
    return xLength + yLength === 0 ? 0 : (2 * shared) / (xLength + yLength);
  }

  similarity(x: Int32Array, y: Int32Array): number {
    return Bags.dice(this.common(x, y), x.length, y.length);
  }

  /** The bag of several paragraphs of one side read as one. */
  concat(side: 0 | 1, from: number, to: number): Int32Array {
    let total = 0;
    for (let k = from; k < to; k += 1) total += this.bag(side, k).length;
    const out = new Int32Array(total);
    let at = 0;
    for (let k = from; k < to; k += 1) {
      out.set(this.bag(side, k), at);
      at += this.bag(side, k).length;
    }
    this.work += total;
    return out.sort();
  }
}
