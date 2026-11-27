/**
 * Finding text an agent quoted when it is not quoted exactly: typographic
 * quotes and dashes, spaces for tabs, case, and small typos. Bounded so a
 * long paragraph or quote cannot make the search expensive.
 */

export interface Match {
  /** Offsets in the searched text, `end` exclusive. */
  start: number;
  end: number;
  /** 1 for an exact match after normalising, lower for a fuzzy one. */
  score: number;
}

/** Longest quote searched fuzzily, and longest text searched. */
const MAX_FUZZY_NEEDLE = 400;
const MAX_FUZZY_HAYSTACK = 20_000;
/** Candidates checked by edit distance after the trigram filter. */
const MAX_CANDIDATES = 6;

interface Normalised {
  text: string;
  /** Index in the original text of each character of `text`. */
  map: number[];
}

const SINGLE_QUOTES = /[‘’‚‛′]/;
const DOUBLE_QUOTES = /[“”„‟″«»]/;
const DASHES = /[‐‑‒–—―−]/;
const SPACES = /[\s   ]/;

/** Lower case, plain quotes and hyphens, one space for any run of white space. */
export function normalise(text: string): Normalised {
  let out = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i] as string;
    if (SPACES.test(ch)) {
      if (lastSpace) continue;
      ch = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
      if (SINGLE_QUOTES.test(ch)) ch = "'";
      else if (DOUBLE_QUOTES.test(ch)) ch = '"';
      else if (DASHES.test(ch)) ch = "-";
      else ch = ch.toLowerCase();
    }
    // toLowerCase can change length for a few characters; keep one output character per input.
    out += ch.length === 1 ? ch : (text[i] as string);
    map.push(i);
  }
  return { text: out, map };
}

function toOriginal(norm: Normalised, start: number, end: number): { start: number; end: number } {
  return { start: norm.map[start] as number, end: (norm.map[end - 1] as number) + 1 };
}

/** Matches of `needle` in `haystack` after normalising both, in order. */
export function findNormalised(haystack: string, needle: string): Match[] {
  const h = normalise(haystack);
  const n = normalise(needle).text.trim();
  if (n === "") return [];
  const found: Match[] = [];
  let from = 0;
  for (;;) {
    const at = h.text.indexOf(n, from);
    if (at < 0) return found;
    found.push({ ...toOriginal(h, at, at + n.length), score: 1 });
    from = at + n.length;
  }
}

function trigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= text.length; i++) {
    const gram = text.slice(i, i + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function dice(a: Map<string, number>, b: Map<string, number>, sizeA: number, sizeB: number): number {
  if (sizeA === 0 || sizeB === 0) return 0;
  let shared = 0;
  for (const [gram, count] of a) shared += Math.min(count, b.get(gram) ?? 0);
  return (2 * shared) / (sizeA + sizeB);
}

/** Edit distance with two rows. Inputs are bounded by the callers. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

function isWordStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === " " || /[\p{L}\p{N}]/u.test(text[index] as string) !== /[\p{L}\p{N}]/u.test(text[index - 1] as string);
}

/**
 * The stretch of `haystack` most like `needle`, starting and ending at word
 * boundaries, when its similarity (1 minus edit distance over length) is at
 * least `threshold`. Null when nothing is close enough or the input is too long.
 */
export function fuzzyFind(haystack: string, needle: string, threshold = 0.8): Match | null {
  const h = normalise(haystack);
  const n = normalise(needle).text.trim();
  if (n.length < 4 || n.length > MAX_FUZZY_NEEDLE || h.text.length > MAX_FUZZY_HAYSTACK) return null;
  const needleGrams = trigrams(n);
  const needleSize = Math.max(0, n.length - 2);
  const candidates: Array<{ start: number; end: number; dice: number }> = [];
  for (let start = 0; start < h.text.length; start++) {
    if (h.text[start] === " " || !isWordStart(h.text, start)) continue;
    // Windows a little shorter and longer than the quote, ending at a word boundary.
    for (const length of [n.length, Math.round(n.length * 0.9), Math.round(n.length * 1.1)]) {
      let end = Math.min(h.text.length, start + length);
      while (end < h.text.length && /[\p{L}\p{N}]/u.test(h.text[end] as string) && /[\p{L}\p{N}]/u.test(h.text[end - 1] as string)) end++;
      const window = h.text.slice(start, end).trimEnd();
      const windowEnd = start + window.length;
      const score = dice(needleGrams, trigrams(window), needleSize, Math.max(0, window.length - 2));
      if (score >= 0.5) candidates.push({ start, end: windowEnd, dice: score });
    }
  }
  candidates.sort((a, b) => b.dice - a.dice);
  let best: Match | null = null;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const window = h.text.slice(candidate.start, candidate.end);
    const score = 1 - levenshtein(window, n) / Math.max(window.length, n.length);
    if (score >= threshold && (best === null || score > best.score)) best = { ...toOriginal(h, candidate.start, candidate.end), score };
  }
  return best;
}
