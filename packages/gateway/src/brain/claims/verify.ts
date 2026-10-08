/**
 * Claim verification shared by both extractors. finalizeBrainClaims turns drafts into store inputs (span check, ids,
 * store bounds, one claim per quote, order, cap); verifyModelClaims never trusts model output: every candidate is
 * re-validated, its kind must be one the call asked for, its quote must be rendered document text that starts and
 * ends on word boundaries, its statement must come from that quote, and so must its label, assignee and due date (each
 * dropped alone otherwise). kind and severity are classifications the model assigns; the quote is their evidence.
 */
import { BrainClaimInputSchema } from "./schemas.js";
import {
  BRAIN_CLAIMS_PER_DOCUMENT_MAX, BRAIN_MODEL_CANDIDATES_MAX, BrainClaimCandidateSchema, computeBrainClaimId,
  normalizeBrainClaimText, type BrainClaimDraft, type BrainClaimExtraction, type BrainClaimFields,
  type BrainClaimInput, type BrainClaimKind, type BrainModelClaimsInput,
} from "./types.js";

/** UTF-16 offsets into the searched text; exact is false when only whitespace-run normalization found it. */
export interface BrainQuoteLocation { readonly start: number; readonly end: number; readonly exact: boolean }

/**
 * Search budget per document, in text units x quote units per indexOf: the worst case on a 64 KiB body stays near
 * a third of a second. A candidate met after it is spent counts as claimsRejected.
 */
const SEARCH_WORK_MAX = 2 ** 32;
const WORD_FIRST = /^[\p{L}\p{N}\p{M}]/u;
const WORD_LAST = /[\p{L}\p{N}\p{M}]$/u;

/**
 * Which kind a quote keeps when it is given under several, first wins: deferred work that names later work is a
 * commitment rather than an invariant, and a chosen design a decision rather than an invariant.
 */
export const BRAIN_CLAIM_KIND_PRECEDENCE: readonly BrainClaimKind[] = ["commitment", "decision", "risk", "invariant"];

const byId = (a: BrainClaimInput, b: BrainClaimInput): number =>
  (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0);
/** Whether a should be kept over b at the same quote: the earlier kind in the precedence, then the smaller id. */
const outranks = (a: BrainClaimInput, b: BrainClaimInput): boolean =>
  (BRAIN_CLAIM_KIND_PRECEDENCE.indexOf(a.kind) - BRAIN_CLAIM_KIND_PRECEDENCE.indexOf(b.kind) || byId(a, b)) < 0;

/**
 * Drops (as claimsRejected) drafts whose span does not slice to the quote or that break a store bound, adds ids, keeps
 * one claim per quote span by BRAIN_CLAIM_KIND_PRECEDENCE (another claim there counts as claimsRejected, a repeat of
 * the same id does not), orders by span then id, keeps the first of each id and at most maxClaims (never above 50).
 */
export function finalizeBrainClaims(input: {
  readonly documentId: string; readonly text: string; readonly drafts: readonly BrainClaimDraft[];
  readonly maxClaims: number;
}): BrainClaimExtraction {
  const { documentId, text, drafts } = input;
  const verified: BrainClaimInput[] = [];
  for (const draft of drafts) {
    const claim = { ...draft, claimId: computeBrainClaimId(documentId, draft.kind, draft.label, draft.statement) };
    const atSpan = draft.spanEnd <= text.length && text.slice(draft.spanStart, draft.spanEnd) === draft.quote;
    if (atSpan && BrainClaimInputSchema.safeParse(claim).success) verified.push(claim);
  }
  // Bounded by drafts.length; dropped when this call returns.
  const perQuote = new Map<string, BrainClaimInput>();
  let displaced = 0;
  for (const claim of verified) {
    const key = `${claim.spanStart}:${claim.spanEnd}`;
    const held = perQuote.get(key);
    if (held !== undefined && held.claimId !== claim.claimId) displaced += 1;
    if (held === undefined || outranks(claim, held)) perQuote.set(key, claim);
  }
  const kept = [...perQuote.values()].sort((a, b) => a.spanStart - b.spanStart || byId(a, b));
  const seen = new Set<string>();
  const unique = kept.filter((claim) => !seen.has(claim.claimId) && seen.add(claim.claimId));
  const cap = Math.min(Math.max(0, Math.floor(input.maxClaims) || 0), BRAIN_CLAIMS_PER_DOCUMENT_MAX);
  const claimsRejected = drafts.length - verified.length + displaced + Math.max(0, unique.length - cap);
  return { claims: unique.slice(0, cap), claimsRejected, quotesRejected: 0 };
}

/**
 * The text a reader never sees rendered, masked as NUL, whichever opens first: an HTML comment (to `-->`, else the end)
 * or fenced code by why.ts fenceOf's rule (up to 3 spaces, 3 or more backticks or tildes, closed by a run of the same
 * character at least as long, else the end).
 */
const HIDDEN = /<!--[\s\S]*?(?:-->|(?![\s\S]))|^ {0,3}(([`~])\2{2,})[^\n]*(?:\n(?! {0,3}\1)[^\n]*)*(?:\n {0,3}\1[^\n]*)?/gm;
const mask = (hidden: string): string => "\u0000".repeat(hidden.length);
/** Occurrences of a statement or label tried in its stored quote (at most 2,000 units): a few searches per claim. */
const GROUNDING_TRIES = 8;

/** Whether text[start, end) starts or ends inside a word: a letter, number or mark runs on across the edge. */
const touchesWord = (text: string, start: number, end: number, needle: string): boolean =>
  (WORD_FIRST.test(needle) && WORD_LAST.test(text.slice(Math.max(0, start - 2), start)))
  || (WORD_LAST.test(needle) && WORD_FIRST.test(text.slice(end, end + 2)));

/** Whether the normalized needle is whole words of the normalized quote, so `safe` is never read out of `unsafe`. */
function groundedIn(quote: string, needle: string): boolean {
  const [haystack, words] = [normalizeBrainClaimText(quote), normalizeBrainClaimText(needle)];
  for (let at = haystack.indexOf(words), tries = 1; at >= 0 && tries <= GROUNDING_TRIES; tries += 1) {
    if (!touchesWord(haystack, at, at + words.length, words)) return true;
    at = haystack.indexOf(words, at + 1);
  }
  return false;
}

/** The fields a quote states: an assignee as whole words of it, a due date as written in it; severity as given. */
function groundedFields(quote: string, fields: BrainClaimFields | undefined): BrainClaimFields {
  const { assignee, due, severity } = fields ?? {};
  return {
    ...(assignee !== undefined && groundedIn(quote, assignee) ? { assignee } : {}),
    ...(due !== undefined && groundedIn(quote, due) ? { due } : {}),
    ...(severity === undefined ? {} : { severity }),
  };
}

/**
 * Finds quotes in one text, prepared once: the first occurrence, with every whitespace run in either treated as one
 * space, in text a reader sees, that does not start or end inside a word. null: not found; undefined: the text's
 * search budget was already spent.
 */
export function quoteLocator(text: string): (quote: string) => BrainQuoteLocation | null | undefined {
  const masked = text.replace(HIDDEN, mask);
  const norm = masked.replace(/\s+/g, " ");
  // norm unit i stands for text[startOf[i], endOf[i]): a whole whitespace run, else one UTF-16 unit.
  const startOf = new Int32Array(text.length);
  const endOf = new Int32Array(text.length);
  let units = 0;
  for (const { 0: piece, index: at } of masked.matchAll(/\s+|[^]/g)) {
    startOf[units] = at;
    endOf[units++] = at + piece.length;
  }
  let work = SEARCH_WORK_MAX;
  return (quote) => {
    if (work <= 0) return undefined;
    const needle = quote.replace(/\s+/g, " ").trim();
    for (let at = -1; needle !== "" && work > 0;) {
      work -= norm.length * needle.length;
      at = norm.indexOf(needle, at + 1);
      if (at < 0) return null;
      const [start, end] = [startOf[at]!, endOf[at + needle.length - 1]!];
      if (!touchesWord(text, start, end, needle)) return { start, end, exact: text.slice(start, end) === quote };
    }
    return null;
  };
}

/**
 * Null when candidates is not an array of at most BRAIN_MODEL_CANDIDATES_MAX items. A located quote is stored as the
 * exact original substring at its span: confidence medium when found verbatim, low after whitespace normalization.
 */
export function verifyModelClaims(input: BrainModelClaimsInput): BrainClaimExtraction | null {
  const { documentId, text, candidates, kinds, maxClaims } = input;
  if (!Array.isArray(candidates) || candidates.length > BRAIN_MODEL_CANDIDATES_MAX) return null;
  const locate = quoteLocator(text);
  const drafts: BrainClaimDraft[] = [];
  let claimsRejected = 0;
  let quotesRejected = 0;
  for (const candidate of candidates as unknown[]) {
    const parsed = BrainClaimCandidateSchema.safeParse(candidate);
    const valid = parsed.success && kinds.includes(parsed.data.kind) && parsed.data.quote.isWellFormed();
    const found = valid ? locate(parsed.data.quote) : undefined;
    if (found === null) quotesRejected += 1;
    if (!valid || !found) {
      if (found === undefined) claimsRejected += 1;
      continue;
    }
    const { kind, label, statement, fields } = parsed.data;
    const stored = text.slice(found.start, found.end);
    // The statement, label and fields restate their quote: a model cannot pin invented text to a real quote.
    if (!groundedIn(stored, statement)) {
      claimsRejected += 1;
      continue;
    }
    const kept = label ?? null;
    drafts.push({
      kind, label: kept !== null && groundedIn(stored, kept) ? kept : null,
      statement: statement.replace(/\s+/gu, " "), quote: stored, spanStart: found.start, spanEnd: found.end,
      fields: groundedFields(stored, fields), confidence: found.exact ? "medium" : "low",
    });
  }
  const finalized = finalizeBrainClaims({ documentId, text, drafts, maxClaims });
  return { ...finalized, claimsRejected: claimsRejected + finalized.claimsRejected, quotesRejected };
}
