/**
 * Find and replace over the visible text of the body. Matches never cross a
 * paragraph; replacements are engine operations, so they are undoable and
 * follow the Track changes toggle. A match can run over text the view hides
 * (a pending deletion in the final view): only its visible stretches are
 * replaced, so the hidden change stays for review.
 */

import type { DocxOp, TextRange } from "../../../_shared/office-engine/index";
import { type ParagraphText, rangeOf, visiblePieces } from "./text-index";

/** Most matches found; the rest are reported as `truncated`. */
export const MAX_MATCHES = 1_000;
/** Longest query accepted. */
export const MAX_QUERY_LENGTH = 500;

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

export interface FindMatch {
  /** `find:<n>`, also the highlight id. */
  id: string;
  /** From the first matched character to the last, hidden text between them included. */
  range: TextRange;
  /** The visible stretches of the match, in order; one unless hidden text lies inside it. */
  pieces: TextRange[];
  /** The matched text as shown. */
  text: string;
}

export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

/** Matches of `query` in document order. */
export function findMatches(paragraphs: readonly ParagraphText[], query: string, options: FindOptions = {}, limit = MAX_MATCHES): FindResult {
  const matches: FindMatch[] = [];
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) return { matches, truncated: false };
  const pattern = new RegExp(escapeRegExp(query), options.matchCase === true ? "gu" : "giu");
  for (const paragraph of paragraphs) {
    pattern.lastIndex = 0;
    for (let found = pattern.exec(paragraph.text); found !== null; found = pattern.exec(paragraph.text)) {
      const from = found.index;
      const to = from + found[0].length;
      if (found[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      if (options.wholeWord === true && (isWordChar(paragraph.text[from - 1]) || isWordChar(paragraph.text[to]))) continue;
      if (matches.length === limit) return { matches, truncated: true };
      matches.push({ id: `find:${matches.length}`, range: rangeOf(paragraph, from, to), pieces: visiblePieces(paragraph, from, to), text: found[0] });
    }
  }
  return { matches, truncated: false };
}

/**
 * Operations for the matches, last first, so earlier positions stay valid. The
 * replacement takes the first visible stretch of a match; later stretches are
 * deleted, and hidden text between them is left alone.
 */
export function replaceOps(matches: readonly FindMatch[], replacement: string): DocxOp[] {
  return [...matches].reverse().flatMap((match): DocxOp[] => {
    const [first, ...rest] = match.pieces.length > 0 ? match.pieces : [match.range];
    if (first === undefined) return [];
    const deletes: DocxOp[] = rest.reverse().map((range) => ({ type: "deleteRange", range }));
    return [...deletes, { type: "replaceRange", range: first, text: replacement }];
  });
}
