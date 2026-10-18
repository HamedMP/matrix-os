/**
 * Search query parsing: the strict input schema, the term grammar (quoted phrases, trailing-* prefixes, at most 16
 * terms, English stop words dropped, words of 4+ letters matched by their stem), the query fingerprint and the opaque
 * cursors. Pure; every failure is BrainApiError("invalid_request").
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { BrainApiError } from "../api/types.js";
import { BRAIN_CLAIM_KINDS } from "../claims/types.js";
import {
  BRAIN_CITE_KINDS, BRAIN_DATE_PATTERN, BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_QUERY_LIST_MAX_ITEMS,
  BRAIN_SEARCH_CANDIDATES_MAX, BRAIN_SEARCH_DEFAULT_LIMIT, BRAIN_SEARCH_MAX_LIMIT, BRAIN_SEARCH_Q_MAX_CHARS,
  BRAIN_SEARCH_TERMS_MAX, type BrainSearchQuery,
} from "../contracts.js";
import { BRAIN_SOURCE_ID_PATTERN } from "../types.js";
import { normalizeBrainWhyPath } from "../why.js";
import type { BrainParsedSearchQuery, BrainSearchTerm } from "./types.js";

const invalid = (cause?: unknown): BrainApiError => new BrainApiError("invalid_request", { cause });

/** Raw path input bound (BRAIN_WHY_PATH_INPUT_MAX_CHARS). */
const PATH_INPUT_MAX_CHARS = 1_024;
const uniqueList = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).min(1).max(max).refine((list) => new Set(list).size === list.length);

/** YYYY-MM-DD (UTC midnight, a real date) or an ISO-8601 instant with an offset; year 1 or later. */
const DateInputSchema = z.string().max(40).transform((value, ctx) => {
  const day = BRAIN_DATE_PATTERN.test(value);
  const parsed = day ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  const valid = day ? !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
    : z.iso.datetime({ offset: true }).safeParse(value).success && !Number.isNaN(parsed.getTime());
  if (!valid || parsed.getUTCFullYear() < 1) {
    ctx.addIssue({ code: "custom", message: "invalid date" });
    return z.NEVER;
  }
  return parsed.toISOString();
});

export const BrainSearchQuerySchema = z.object({
  q: z.string().max(BRAIN_SEARCH_Q_MAX_CHARS).refine((value) => value.trim().length > 0),
  types: uniqueList(z.enum(["document", "claim"]), 2).optional(),
  kinds: uniqueList(z.enum(BRAIN_CITE_KINDS), BRAIN_QUERY_LIST_MAX_ITEMS).optional(),
  claimKinds: uniqueList(z.enum(BRAIN_CLAIM_KINDS), BRAIN_CLAIM_KINDS.length).optional(),
  sourceId: z.string().regex(BRAIN_SOURCE_ID_PATTERN).optional(),
  from: DateInputSchema.optional(), to: DateInputSchema.optional(),
  path: z.string().min(1).max(PATH_INPUT_MAX_CHARS).optional(),
  mode: z.enum(["auto", "text", "hybrid"]).optional(),
  limit: z.number().int().min(1).max(BRAIN_SEARCH_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(BRAIN_FEATURE_CURSOR_MAX_CHARS).optional(),
}).strict();

// Terms.

/** Letters, digits and marks make words; these joiners stay inside a term ("package.json", "ENG-42"). */
const NOT_TERM_CHAR = /[^\p{L}\p{N}\p{M}._\-@/#+:]+/gu;
const EDGE_JOINERS = /^[._\-@/#+:]+|[._\-@/#+:]+$/gu;
const JOINER = /[._\-@/#+:]/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
/** A quoted phrase (an unclosed quote runs to the end) or a run of non-space, non-quote characters. */
const SEGMENTS = /"([^"]*)"?|([^\s"]+)/gu;
const PREFIX_MIN_CODE_POINTS = 2;

function pieces(text: string): string[] {
  return text.replace(NOT_TERM_CHAR, " ").split(" ")
    .map((piece) => piece.replace(EDGE_JOINERS, "")).filter((piece) => HAS_WORD.test(piece));
}

/** A trailing `*` makes the last piece a prefix: a joined token ("src/brain"), or a word of 2+ characters. */
function chunkTerms(chunk: string): BrainSearchTerm[] {
  const terms: BrainSearchTerm[] = pieces(chunk).map((text) => ({ type: "plain", text }));
  const last = terms[terms.length - 1];
  if (chunk.endsWith("*") && last !== undefined
    && (JOINER.test(last.text) || [...last.text].length >= PREFIX_MIN_CODE_POINTS)) {
    terms[terms.length - 1] = { type: "prefix", text: last.text };
  }
  return terms;
}

/** Common English words dropped from plain terms (never from phrases), unless nothing else is left. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it",
  "of", "on", "or", "should", "that", "the", "this", "to", "was", "we", "were", "what", "when", "where", "which",
  "who", "why", "will", "with",
]);
const LETTERS = /^\p{L}+$/u;
const STEM_MIN_CHARS = 4;

/** A light English stem ("grants" -> "grant", "policies" -> "polic"), or the word when the stem gets too short. */
export function brainSearchStem(word: string): string {
  const lower = word.toLowerCase();
  const stem = lower.replace(/(?:ies|ing|ed)$|(?<=ss|ch|sh|x|z)es$|(?<![su])s$/u, "");
  return stem.length >= STEM_MIN_CHARS ? stem : lower;
}

/**
 * Stop words leave plain terms (unless every term is one); a plain word of 4+ letters becomes a prefix of its stem,
 * so "grant" and "grants" find the same documents.
 */
function relaxTerms(terms: readonly BrainSearchTerm[]): BrainSearchTerm[] {
  const kept = terms.filter((term) => term.type !== "plain" || !STOP_WORDS.has(term.text.toLowerCase()));
  return (kept.length === 0 ? terms : kept).map((term) => (term.type === "plain" && LETTERS.test(term.text)
    && term.text.length >= STEM_MIN_CHARS ? { type: "prefix", text: brainSearchStem(term.text) } : term));
}

/** Terms in input order; a phrase is one term; past BRAIN_SEARCH_TERMS_MAX the rest are dropped. */
export function parseBrainSearchTerms(q: string): { readonly terms: BrainSearchTerm[]; readonly dropped: boolean } {
  const terms: BrainSearchTerm[] = [];
  for (const match of q.normalize("NFC").matchAll(SEGMENTS)) {
    if (match[1] !== undefined) {
      const words = pieces(match[1]);
      if (words.length > 0) terms.push({ type: "phrase", text: words.join(" ") });
    } else {
      terms.push(...chunkTerms(match[2]!));
    }
    if (terms.length > BRAIN_SEARCH_TERMS_MAX) break;
  }
  return { terms: relaxTerms(terms.slice(0, BRAIN_SEARCH_TERMS_MAX)), dropped: terms.length > BRAIN_SEARCH_TERMS_MAX };
}

/** Validates the query; a bad value of any field is invalid_request. */
export function parseBrainSearchQuery(input: BrainSearchQuery): BrainParsedSearchQuery {
  const parsed = BrainSearchQuerySchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const query = parsed.data;
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) throw invalid();
  const path = query.path === undefined ? null : normalizeBrainWhyPath(query.path);
  if (path === null && query.path !== undefined) throw invalid();
  const { terms, dropped } = parseBrainSearchTerms(query.q);
  return {
    q: query.q, terms, termsDropped: dropped, types: query.types ?? ["document", "claim"],
    kinds: query.kinds ?? null, claimKinds: query.claimKinds ?? null, sourceId: query.sourceId ?? null,
    from: query.from ?? null, to: query.to ?? null,
    path: path === null ? null : { value: path.path, mode: path.match === "folder" ? "under" : "exact_or_under" },
    mode: query.mode ?? "auto", limit: query.limit ?? BRAIN_SEARCH_DEFAULT_LIMIT, cursor: query.cursor ?? null,
  };
}

// Fingerprint and cursors.

/** 16 hex of sha256 over the query text, the filters and the resolved mode; the cursor must carry the same. */
export function brainSearchFingerprint(query: BrainParsedSearchQuery, mode: "text" | "hybrid"): string {
  const sorted = (list: readonly string[] | null) => (list === null ? null : [...list].sort());
  const key = [query.q, sorted(query.types), sorted(query.kinds), sorted(query.claimKinds), query.sourceId,
    query.from, query.to, query.path, mode];
  return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}

const SCORE_PATTERN = /^(?:0\.\d{6}|1\.000000)$/;
const HIT_ID_PATTERN = /^[a-f0-9]{64}(?::[A-Za-z0-9@._:/-]{1,128})?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const CursorSchema = z.discriminatedUnion("m", [
  z.object({ v: z.literal(1), m: z.literal("t"), f: z.string().regex(/^[a-f0-9]{16}$/),
    s: z.string().regex(SCORE_PATTERN), h: z.string().regex(HIT_ID_PATTERN) }).strict(),
  z.object({ v: z.literal(1), m: z.literal("h"), f: z.string().regex(/^[a-f0-9]{16}$/),
    o: z.number().int().min(1).max(BRAIN_SEARCH_CANDIDATES_MAX) }).strict(),
]);
export type BrainSearchCursor = z.output<typeof CursorSchema>;

export function encodeBrainSearchCursor(cursor: BrainSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function readCursor(cursor: string): BrainSearchCursor {
  if (!BASE64URL.test(cursor)) throw invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error: unknown) {
    // JSON.parse fails only on malformed client input here (512 characters cannot nest deeply enough for more).
    throw invalid(error);
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** The mode a well-formed cursor continues ("t" text, "h" hybrid), else invalid_request. */
export function brainSearchCursorMode(cursor: string): "t" | "h" {
  return readCursor(cursor).m;
}

/** The cursor of the same query and mode, else invalid_request. */
export function decodeBrainSearchCursor(cursor: string, fingerprint: string, mode: "t" | "h"): BrainSearchCursor {
  const parsed = readCursor(cursor);
  if (parsed.f !== fingerprint || parsed.m !== mode) throw invalid();
  return parsed;
}
