/**
 * Snippets: plain text cut from stored text with [start, end) UTF-16 highlight ranges, computed here and never by
 * ts_headline. The stored text is read as plain text first (markdown markup dropped, whitespace collapsed; see
 * snippet-plain.ts), and terms are matched on that, so every highlight covers words the snippet shows. Term patterns
 * are built from escaped word parts only, so a query can never inject a pattern.
 */
import {
  BRAIN_SEARCH_HIGHLIGHTS_MAX, BRAIN_SEARCH_SNIPPET_MAX_CHARS, type BrainSnippetView,
} from "../contracts.js";
import { brainPlainIndex, brainPlainText } from "./snippet-plain.js";
import { BRAIN_SEARCH_MATCHES_MAX, brainSafeCut, type BrainSearchTerm } from "./types.js";

type Range = readonly [number, number];

const WORD = "[\\p{L}\\p{N}\\p{M}]";
const WORD_PARTS = /[\p{L}\p{N}\p{M}]+/gu;
/** Up to 8 separator characters between the words of one term or phrase. */
const SEPARATOR = "[^\\p{L}\\p{N}\\p{M}]{1,8}";
/** Context kept before the first highlight of a window. */
const LEAD_CHARS = 40;
const BOUNDARY_SEARCH_CHARS = 24;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * One case-insensitive pattern per term: its word parts in order, whole words, the last one open for a prefix. Parsed
 * terms always hold a letter or digit.
 */
export function brainSearchPatterns(terms: readonly BrainSearchTerm[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const term of terms) {
    const parts = term.text.match(WORD_PARTS)!;
    const body = parts.map(escapeRegExp).join(SEPARATOR);
    const tail = term.type === "prefix" ? `${WORD}*` : `(?!${WORD})`;
    patterns.push(new RegExp(`(?<!${WORD})${body}${tail}`, "giu"));
  }
  return patterns;
}

/** Sorted, merged match ranges of every pattern in text, at most BRAIN_SEARCH_MATCHES_MAX before merging. */
export function findBrainSearchMatches(text: string, patterns: readonly RegExp[]): Range[] {
  const found: [number, number][] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (found.length >= BRAIN_SEARCH_MATCHES_MAX) break;
      found.push([match.index, match.index + match[0].length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** The window start that holds the most matches, starting LEAD_CHARS before one of them. */
function bestStart(text: string, matches: readonly Range[], size: number): number {
  let best = 0;
  let bestCount = -1;
  for (const [start] of matches) {
    const from = Math.max(0, Math.min(start - LEAD_CHARS, text.length - size));
    const count = matches.filter(([a, b]) => a >= from && b <= from + size).length;
    if (count > bestCount) {
      best = from;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A window start moves forward to just after whitespace within BOUNDARY_SEARCH_CHARS; it never reaches the first
 * highlight, which sits at least LEAD_CHARS after it.
 */
function snapStart(text: string, start: number): number {
  const offset = text.slice(start - 1, start - 1 + BOUNDARY_SEARCH_CHARS).search(/\s/);
  return offset === -1 ? start : start + offset;
}

/** A window end moves back onto whitespace within BOUNDARY_SEARCH_CHARS, never before `limit` (a highlight end). */
function snapEnd(text: string, end: number, limit: number): number {
  for (let at = end; at >= Math.max(limit, end - BOUNDARY_SEARCH_CHARS); at -= 1) {
    if (/\s/.test(text[at]!)) return at;
  }
  return end;
}

/**
 * A window of at most BRAIN_SEARCH_SNIPPET_MAX_CHARS units of `text` (already plain) around the densest matches, or
 * starting at `anchor` (a plain index), or at the start of the text.
 */
export function buildBrainSnippet(
  field: BrainSnippetView["field"], text: string, matches: readonly Range[], anchor?: number,
): BrainSnippetView {
  const size = BRAIN_SEARCH_SNIPPET_MAX_CHARS;
  let start = anchor === undefined ? 0 : brainSafeCut(text, Math.min(Math.max(0, anchor), text.length));
  let end = text.length;
  if (anchor === undefined && text.length > size && matches.length > 0) {
    start = brainSafeCut(text, bestStart(text, matches, size));
    if (start > 0) start = snapStart(text, start);
  }
  if (end - start > size) {
    end = brainSafeCut(text, start + size);
    const last = [...matches].reverse().find(([a, b]) => b <= end && a >= start);
    end = snapEnd(text, end, last?.[1] ?? start);
  }
  const highlights: Range[] = [];
  for (const [a, b] of matches) {
    if (highlights.length >= BRAIN_SEARCH_HIGHLIGHTS_MAX) break;
    // Only whole matches: a window edge never leaves half a word highlighted.
    if (a >= start && b <= end) highlights.push([a - start, b - start]);
  }
  return {
    field, text: text.slice(start, end), highlights, truncatedStart: start > 0, truncatedEnd: end < text.length,
  };
}

/** The first field whose plain text has a match, else the first field's plain text without highlights. */
export function pickBrainSnippet(
  fields: readonly { readonly field: BrainSnippetView["field"]; readonly text: string }[], patterns: readonly RegExp[],
): BrainSnippetView {
  let first: string | undefined;
  for (const { field, text } of fields) {
    const plain = brainPlainText(text).text;
    first ??= plain;
    const matches = findBrainSearchMatches(plain, patterns);
    if (matches.length > 0) return buildBrainSnippet(field, plain, matches);
  }
  return buildBrainSnippet(fields[0]!.field, first ?? "", []);
}

/**
 * A body window starting where a chunk's stored span start lands in the plain text (vector hits), with any term
 * matches in it highlighted.
 */
export function chunkBrainSnippet(text: string, spanStart: number, patterns: readonly RegExp[]): BrainSnippetView {
  const plain = brainPlainText(text);
  return buildBrainSnippet("body", plain.text, findBrainSearchMatches(plain.text, patterns),
    brainPlainIndex(plain, spanStart));
}
