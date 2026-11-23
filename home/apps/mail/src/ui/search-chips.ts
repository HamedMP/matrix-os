/**
 * Filter chips over the Mail query language (see model/query.ts). Chips edit
 * the query text, so the text box stays the single source of truth.
 */

export interface FilterChip {
  id: "unread" | "flagged" | "attachment";
  label: string;
  term: string;
}

export const FILTER_CHIPS: readonly FilterChip[] = Object.freeze([
  { id: "unread", label: "Unread", term: "is:unread" },
  { id: "flagged", label: "Flagged", term: "is:flagged" },
  { id: "attachment", label: "Has attachment", term: "has:attachment" },
]);

/** Splits query text into tokens, keeping quoted values together with their quotes. */
export function queryTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function isChipActive(text: string, chip: FilterChip): boolean {
  return queryTokens(text).some((token) => token.toLowerCase() === chip.term);
}

export function toggleChip(text: string, chip: FilterChip): string {
  const tokens = queryTokens(text);
  if (tokens.some((token) => token.toLowerCase() === chip.term)) {
    return tokens.filter((token) => token.toLowerCase() !== chip.term).join(" ");
  }
  return [...tokens, chip.term].join(" ");
}

const TERM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  from: "From",
  to: "To",
  subject: "Subject",
  before: "Before",
  after: "After",
});

export interface QueryTermChip {
  token: string;
  label: string;
}

/** The structured `from:`, `to:`, `subject:`, `before:` and `after:` terms, as removable chips. */
export function queryTermChips(text: string): QueryTermChip[] {
  const chips: QueryTermChip[] = [];
  for (const token of queryTokens(text)) {
    const colon = token.indexOf(":");
    if (colon <= 0) continue;
    const label = TERM_LABELS[token.slice(0, colon).toLowerCase()];
    const value = token.slice(colon + 1).replace(/"/g, "").trim();
    if (!label || !value) continue;
    chips.push({ token, label: `${label}: ${value}` });
  }
  return chips;
}

export function removeQueryTerm(text: string, token: string): string {
  return queryTokens(text).filter((candidate) => candidate !== token).join(" ");
}
