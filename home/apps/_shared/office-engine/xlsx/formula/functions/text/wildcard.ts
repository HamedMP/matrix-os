/**
 * Spreadsheet wildcards: `?` is any one character, `*` any run of
 * characters, and `~` makes the next `*`, `?` or `~` literal. Matching
 * ignores case. The matcher is iterative (no regular expressions), so its
 * cost is bounded by the text length times the pattern length.
 */

type Token = { kind: "char"; ch: string } | { kind: "any" } | { kind: "star" };

/** True when the text holds a wildcard or the escape character. */
export function hasWildcard(pattern: string): boolean {
  return /[*?~]/.test(pattern);
}

function tokenize(pattern: string): Token[] {
  const upper = pattern.toUpperCase();
  const tokens: Token[] = [];
  for (let i = 0; i < upper.length; i += 1) {
    const ch = upper.charAt(i);
    if (ch === "~" && i + 1 < upper.length && "*?~".includes(upper.charAt(i + 1))) {
      tokens.push({ kind: "char", ch: upper.charAt(i + 1) });
      i += 1;
    } else if (ch === "*") {
      if (tokens[tokens.length - 1]?.kind !== "star") tokens.push({ kind: "star" });
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else {
      tokens.push({ kind: "char", ch });
    }
  }
  return tokens;
}

function matchTokens(tokens: readonly Token[], text: string, start: number, prefixOnly: boolean): boolean {
  let t = start;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p === tokens.length && prefixOnly) return true;
    const token = tokens[p];
    if (token !== undefined && token.kind === "star") {
      starP = p;
      starT = t;
      p += 1;
      continue;
    }
    if (token !== undefined && (token.kind === "any" || token.ch === text.charAt(t))) {
      p += 1;
      t += 1;
      continue;
    }
    if (starP === -1) return false;
    p = starP + 1;
    starT += 1;
    t = starT;
  }
  while (p < tokens.length && (tokens[p] as Token).kind === "star") p += 1;
  return p === tokens.length;
}

/** A case-insensitive predicate that is true when the whole text matches the pattern. */
export function wildcardMatcher(pattern: string): (text: string) => boolean {
  const tokens = tokenize(pattern);
  return (text) => matchTokens(tokens, text.toUpperCase(), 0, false);
}

/**
 * Zero-based position of the first place at or after `from` where the
 * pattern matches, or -1. Used by SEARCH.
 */
export function wildcardSearch(pattern: string, text: string, from: number): number {
  const tokens = tokenize(pattern);
  const upper = text.toUpperCase();
  if (tokens.length === 0) return from <= upper.length ? from : -1;
  for (let i = from; i < upper.length; i += 1) {
    if (matchTokens(tokens, upper, i, true)) return i;
  }
  return -1;
}
