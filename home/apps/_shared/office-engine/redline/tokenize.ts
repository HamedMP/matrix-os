/**
 * Splits text into the units a diff compares.
 *
 * `word`: a run of letters, digits and combining marks (apostrophes allowed
 * between letters), a run of whitespace, or one other character. Scripts
 * written without spaces are split further with `Intl.Segmenter` where the
 * runtime has it, and per character otherwise.
 *
 * `char`: one code point with the combining marks that follow it.
 *
 * Tokens always cover the input exactly, in order, and never split a
 * surrogate pair.
 */

import type { DiffGranularity } from "../api/redline.js";

const WORD_TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|\s+|[\s\S]/gu;
const CHAR_TOKEN = /\P{M}\p{M}*|\p{M}/gu;
/** Scripts whose words are not separated by spaces. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const UNSPACED_SPLIT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]\p{M}*|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;

export interface TokenizeOptions {
  /** Set false to use the built-in fallback even where `Intl.Segmenter` exists. Default true. */
  segmenter?: boolean;
}

interface WordSegmenter {
  segment(input: string): Iterable<{ segment: string; index: number }>;
}

let cachedSegmenter: WordSegmenter | null | undefined;

function wordSegmenter(): WordSegmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  cachedSegmenter = null;
  if (typeof Intl === "object" && typeof Intl.Segmenter === "function") {
    try {
      cachedSegmenter = new Intl.Segmenter("und", { granularity: "word" });
    } catch (error) {
      // A runtime without word segmentation data throws RangeError: the per-character fallback is used instead.
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return cachedSegmenter;
}

/** Appends the end offsets of the pieces of `text[start, end)`, a word in an unspaced script. */
function splitUnspaced(text: string, start: number, end: number, ends: number[], useSegmenter: boolean): void {
  const word = text.slice(start, end);
  const segmenter = useSegmenter ? wordSegmenter() : null;
  if (segmenter) {
    for (const part of segmenter.segment(word)) {
      const partEnd = start + part.index + part.segment.length;
      if (part.segment.length > 0 && partEnd <= end) ends.push(partEnd);
    }
    if (ends.length === 0 || ends[ends.length - 1] !== end) ends.push(end);
    return;
  }
  UNSPACED_SPLIT.lastIndex = 0;
  for (let match = UNSPACED_SPLIT.exec(word); match; match = UNSPACED_SPLIT.exec(word)) {
    ends.push(start + match.index + match[0].length);
  }
}

/**
 * Token boundaries of `text`: `offsets[i]` is where token `i` starts and the
 * last entry is `text.length`, so there are `offsets.length - 1` tokens.
 */
export function tokenOffsets(text: string, granularity: DiffGranularity = "word", options: TokenizeOptions = {}): number[] {
  const ends: number[] = [];
  const pattern = granularity === "char" ? CHAR_TOKEN : WORD_TOKEN;
  const useSegmenter = options.segmenter !== false;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (granularity === "word" && end - start > 1 && UNSPACED.test(match[0])) {
      splitUnspaced(text, start, end, ends, useSegmenter);
    } else {
      ends.push(end);
    }
  }
  const offsets = new Array<number>(ends.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < ends.length; i += 1) offsets[i + 1] = ends[i] as number;
  return offsets;
}

/** The tokens of `text` as strings. `tokenize(text).join("") === text`. */
export function tokenize(text: string, granularity: DiffGranularity = "word", options: TokenizeOptions = {}): string[] {
  const offsets = tokenOffsets(text, granularity, options);
  const tokens = new Array<string>(offsets.length - 1);
  for (let i = 0; i + 1 < offsets.length; i += 1) tokens[i] = text.slice(offsets[i], offsets[i + 1]);
  return tokens;
}
