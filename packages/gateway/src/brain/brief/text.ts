/**
 * Pure text rules of the brief: one-line text, clause shapes (content words, values, negation parity), the two
 * contradiction tests, commitment state words and the Draft status line of a spec. Never throws on any string.
 */
import { normalizeBrainClaimText } from "../claims/types.js";
import { BRAIN_BRIEF_LIMITS } from "../contracts.js";

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The first `max` UTF-16 units, never ending inside a surrogate pair. */
export function cutUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max);
}

/** One plain line: control characters and whitespace runs become one space; cut with "..." past the limit. */
export function lineText(value: string, max: number = BRAIN_BRIEF_LIMITS.lineTextMaxChars): string {
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  return flat.length <= max ? flat : `${cutUnits(flat, max - 3).trimEnd()}...`;
}

const STOP_WORDS = [
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in", "on", "at", "by", "for",
  "with", "and", "or", "as", "it", "its", "this", "that", "these", "those", "from", "into", "per", "than", "then",
  "so", "any", "each", "every", "all", "also", "only", "always", "must", "should", "will", "shall", "can", "may",
  "does", "do", "has", "have", "had", "which", "who", "when", "while", "yet", "still", "now",
];
const NEGATIONS = ["not", "no", "never", "none", "nothing", "without", "cannot", "nor", "neither"];
/** The second word reads as the first one negated. */
const ANTONYMS: Readonly<Record<string, string>> = {
  disabled: "enabled", forbidden: "allowed", denied: "allowed", refused: "allowed", optional: "required",
  off: "on", false: "true", rejected: "accepted",
};
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'_.%-]*/gu;

/** words: content words without digits; values: tokens with a digit; all: both. Sorted and unique. */
export interface ClauseShape {
  readonly words: readonly string[]; readonly values: readonly string[]; readonly all: readonly string[];
  readonly negated: boolean;
}

const sortedUnique = (items: readonly string[]): string[] =>
  [...items].sort().filter((item, index, sorted) => index === 0 || sorted[index - 1] !== item);

/** The shape of one piece of text: negation parity, antonyms read as their negated pair. */
export function shapeOf(text: string): ClauseShape {
  const words: string[] = [];
  const values: string[] = [];
  let negated = false;
  for (const raw of normalizeBrainClaimText(text).replace(/(\d),(?=\d{3}\b)/g, "$1").match(TOKEN) ?? []) {
    const token = raw.replace(/[.'_%-]+$/u, "");
    if (NEGATIONS.includes(token) || token.endsWith("n't")) negated = !negated;
    else if (/\d/.test(token)) values.push(token);
    else if (ANTONYMS[token] !== undefined) {
      negated = !negated;
      words.push(ANTONYMS[token]!);
    } else if (!STOP_WORDS.includes(token)) words.push(token);
  }
  const uniqueWords = sortedUnique(words);
  const uniqueValues = sortedUnique(values);
  return { words: uniqueWords, values: uniqueValues, all: sortedUnique([...uniqueWords, ...uniqueValues]), negated };
}

const CLAUSE_BREAK = /[;.!?](?:\s+|$)|\s+(?:but|while|whereas)\s+/u;
/** Two statements cost at most 8 x 8 clause comparisons, so 20,000 compared pairs stay near 100 ms. */
const CLAUSES_MAX = 8;

/** A statement's clauses (sentence and `;` breaks, `but` / `while` / `whereas`), at most CLAUSES_MAX. */
export function statementClauses(statement: string): readonly ClauseShape[] {
  return statement.split(CLAUSE_BREAK).slice(0, CLAUSES_MAX).map(shapeOf).filter((clause) => clause.all.length > 0);
}

/** Jaccard overlap of two sorted unique lists, by merge. */
export function overlap(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (a[i]! < b[j]!) i += 1;
    else j += 1;
  }
  const union = a.length + b.length - shared;
  return union === 0 ? 0 : shared / union;
}

const CLAUSE_MATCH = 0.8;

function clauseContradiction(a: ClauseShape, b: ClauseShape): "polarity" | "values" | null {
  if (a.negated !== b.negated) {
    return a.all.length >= 2 && b.all.length >= 2 && overlap(a.all, b.all) >= CLAUSE_MATCH ? "polarity" : null;
  }
  const valuesDiffer = a.values.length > 0 && b.values.length > 0 && a.values.join(" ") !== b.values.join(" ");
  return valuesDiffer && a.words.length >= 2 && overlap(a.words, b.words) >= CLAUSE_MATCH ? "values" : null;
}

/**
 * polarity: a clause of each with the same content and opposite negation ("stored" / "never stored"). values: a
 * clause of each with the same words and other numbers ("at most 8 runs" / "at most 16 runs"). Null otherwise.
 */
export function contradiction(a: readonly ClauseShape[], b: readonly ClauseShape[]): "polarity" | "values" | null {
  for (const left of a) {
    for (const right of b) {
      const found = clauseContradiction(left, right);
      if (found !== null) return found;
    }
  }
  return null;
}

const DONE_WORDS = /\b(?:done|shipped|landed|completed?|implemented|resolved|fixed|merged|delivered|finished|closed)\b/;
const DEFERRED_WORDS = new RegExp(String.raw`\b(?:deferred|defer|postponed?|later|follow[- ]?ups?|backlog|on hold`
  + String.raw`|not now|out of scope|punted|reverted|reopened|undone)\b`);
const STATE_WORD = new RegExp(`^(?:${[DONE_WORDS, DEFERRED_WORDS].map((r) => r.source.slice(5, -3)).join("|")})$`);
const DONE_STATUSES = ["done", "completed", "closed", "merged", "resolved", "shipped"];
const DEFERRED_STATUSES = ["backlog", "deferred", "later", "paused", "on_hold", "postponed"];
/** Status refs that close a commitment (done or canceled). */
export const CLOSED_STATUSES: readonly string[] = [...DONE_STATUSES, "canceled", "cancelled"];

const DONE_WORD = new RegExp(DONE_WORDS.source, "g");
/** Earlier in a done word's clause, these make it planned work: future, need, intent and condition words. */
const PLANNED_BEFORE = new RegExp(String.raw`\b(?:will|shall|should|must|would|could|can|may|might|needs?|ha(?:s|ve) to`
  + String.raw`|going to|plan(?:s|ned)? to|to be|get|ensure|make sure|verify|confirm|until|once|before|after|when`
  + String.raw`|unless|if|todo|pending)\b`);
/** Right after a done word, a deadline makes it planned work ("completed by Friday"). */
const DEADLINE_AFTER = new RegExp(String.raw`^ by (?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|eod`
  + String.raw`|eow|(?:the )?end of|next (?:week|month|sprint|release)|q[1-4]|\d{4}-\d{2}-\d{2})\b`);

/**
 * A clause states finished work: a done word not after a planned-work word of its clause, not before a deadline and
 * not an imperative `complete` at the clause start ("Complete the migration").
 */
function statesFinished(text: string): boolean {
  return text.split(CLAUSE_BREAK).some((raw) => {
    const clause = raw.trimStart();
    for (const match of clause.matchAll(DONE_WORD)) {
      const imperative = match.index === 0 && match[0] === "complete";
      const planned = PLANNED_BEFORE.test(clause.slice(0, match.index))
        || DEADLINE_AFTER.test(clause.slice(match.index + match[0].length));
      if (!imperative && !planned) return true;
    }
    return false;
  });
}

export type CommitmentState = "done" | "deferred";

/**
 * From the statement's words, else from the document's status ref. A negated done word is deferred; done words of
 * planned work ("will be shipped", "ensure it is completed by Friday") say nothing, so the status ref decides.
 */
export function commitmentState(statement: string, status: string | null): CommitmentState | null {
  const text = normalizeBrainClaimText(statement);
  const done = DONE_WORDS.test(text);
  const deferred = DEFERRED_WORDS.test(text);
  if (done !== deferred) {
    if (deferred || shapeOf(text).negated) return "deferred";
    if (statesFinished(text)) return "done";
  } else if (done) return null;
  if (status !== null && DONE_STATUSES.includes(status)) return "done";
  return status !== null && DEFERRED_STATUSES.includes(status) ? "deferred" : null;
}

/** Content words of a commitment without its state words, for matching what two commitments talk about. */
export function commitmentWords(statement: string): readonly string[] {
  return shapeOf(statement).all.filter((word) => !STATE_WORD.test(word));
}

const STATUS_LINE = /^[ \t]*(?:[-*>][ \t]*)?(?:\*\*)?status(?:\*\*)?[ \t]*:[ \t]*(?:\*\*)?[ \t]*(.*)$/i;
const STATUS_SCAN_LINES = 40;
const STATUS_SCAN_CHARS = 4_096;

/** The verbatim status line of a spec body when its first status line reads Draft; null otherwise. */
export function draftStatusLine(body: string, max: number): string | null {
  for (const raw of body.slice(0, STATUS_SCAN_CHARS).split("\n").slice(0, STATUS_SCAN_LINES)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const status = STATUS_LINE.exec(line);
    if (status !== null) return /^(?:\*\*|_)?draft\b/i.test(status[1]!) ? cutUnits(line.trim(), max) : null;
  }
  return null;
}
