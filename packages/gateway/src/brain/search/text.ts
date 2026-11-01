/**
 * Full-text retrieval: the tsquery built from parsed terms (phraseto_tsquery for words and phrases, so they are
 * tokenized exactly like stored text; to_tsquery only for a quoted prefix lexeme), the filters, and the ranked union
 * of document and claim hits (one per claim id) keyset-paged on (score, hitId). Every term must match, unless that
 * finds fewer than BRAIN_SEARCH_ANY_TERM_BELOW hits; then any term does and the score ranks the fuller matches
 * first (brainSearchNeedsAnyTerm; the search says so with the any_term_fallback notice). Scores are ts_rank_cd
 * normalized to [0, 1) (flag 32) and rounded to 6 decimals so a cursor compares exactly.
 */
import { sql, type Kysely } from "kysely";
import { BRAIN_PROVENANCE_CITE_KINDS, type BrainCiteKind } from "../contracts.js";
import { valueMatches } from "../refs-reads.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import type { BrainParsedSearchQuery, BrainRankedHit, BrainSearchTerm, SqlFragment } from "./types.js";

const KNOWN_PROVENANCES = Object.keys(BRAIN_PROVENANCE_CITE_KINDS);

/** Prefix text: letters, digits, marks and joiners only, never a quote or backslash that could leave the lexeme. */
const PREFIX_TEXT = /^[\p{L}\p{N}\p{M}._\-@/#+:]+$/u;
const WORD_PARTS = /[\p{L}\p{N}\p{M}]+/gu;
const prefixLexeme = (text: string) => sql`to_tsquery('simple', ${`'${text}':*`})`;

/**
 * A joined prefix ("src/brain") matches the parser's whole file, host or path token, or else its word parts (the last
 * one a prefix when it has 2+ characters).
 */
function prefixQuery(text: string): SqlFragment {
  if (!PREFIX_TEXT.test(text)) throw new Error("Unsafe prefix term");
  const words = text.match(WORD_PARTS)!;
  if (words.length === 1 && words[0] === text) return prefixLexeme(text);
  const tail = words.pop()!;
  const parts = [...words.map((word) => sql`phraseto_tsquery('simple', ${word})`),
    [...tail].length >= 2 ? prefixLexeme(tail) : sql`phraseto_tsquery('simple', ${tail})`];
  return sql`(${prefixLexeme(text)} || (${sql.join(parts, sql` && `)}))`;
}

/** AND of every term, or OR when `any`. */
export function brainTsQuery(terms: readonly BrainSearchTerm[], any = false): SqlFragment {
  const parts = terms.map((term) => (term.type === "prefix" ? prefixQuery(term.text)
    : sql`phraseto_tsquery('simple', ${term.text})`));
  return sql`(${sql.join(parts, any ? sql` || ` : sql` && `)})`;
}

/** Below this many hits for every term together, a search of two or more terms ranks documents with any term. */
export const BRAIN_SEARCH_ANY_TERM_BELOW = 5;

/** Provenances whose cite kind is listed; "document" also matches provenances outside the shared table. */
function kindFilter(kinds: readonly BrainCiteKind[]): SqlFragment {
  const provenances = KNOWN_PROVENANCES.filter((provenance) =>
    kinds.includes(BRAIN_PROVENANCE_CITE_KINDS[provenance as keyof typeof BRAIN_PROVENANCE_CITE_KINDS]));
  const listed = provenances.length === 0 ? sql`FALSE` : sql`d.provenance IN (${sql.join(provenances)})`;
  return kinds.includes("document")
    ? sql`(${listed} OR d.provenance NOT IN (${sql.join(KNOWN_PROVENANCES)}))` : listed;
}

/** Filters on the hit's document `d` (kinds, source, [from, to), path refs). */
export function brainDocumentFilters(query: BrainParsedSearchQuery): SqlFragment {
  const parts: SqlFragment[] = [];
  if (query.kinds !== null) parts.push(kindFilter(query.kinds));
  if (query.sourceId !== null) parts.push(sql`d.source_id = ${query.sourceId}`);
  if (query.from !== null) parts.push(sql`d.source_updated_at >= ${query.from}::timestamptz`);
  if (query.to !== null) parts.push(sql`d.source_updated_at < ${query.to}::timestamptz`);
  if (query.path !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM brain_document_refs r WHERE r.owner_id = d.owner_id
      AND r.scope_id = d.scope_id AND r.document_id = d.document_id AND r.kind = 'path'
      AND ${valueMatches("r.value", query.path)})`);
  }
  return parts.length === 0 ? sql`` : sql` AND ${sql.join(parts, sql` AND `)}`;
}

const score = (column: string, tsquery: SqlFragment) =>
  sql`round(ts_rank_cd(${sql.ref(column)}, ${tsquery}, 32)::numeric, 6)`;

/**
 * Hits best first, then by hit id (bytewise), after `after` when given, at most `limit`. Document and claim rows count
 * while their document is live in the same incarnation (a newer revision still matches its indexed text until
 * refresh); claim rows also while their claim still exists. A restored document's claim of the same id never matches
 * the text indexed from its previous life.
 */
export async function rankBrainTextHits(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, query: BrainParsedSearchQuery,
  page: { readonly limit: number; readonly after: { readonly score: string; readonly hitId: string } | null },
  any?: boolean,
): Promise<BrainRankedHit[]> {
  if (any === undefined) {
    return rankBrainTextHits(db, scope, query, page, await brainSearchNeedsAnyTerm(db, scope, query));
  }
  const tsquery = brainTsQuery(query.terms, any);
  const filters = brainDocumentFilters(query);
  const branches: SqlFragment[] = [];
  if (query.types.includes("document")) {
    branches.push(sql`SELECT 'document'::text AS hit_type, s.document_id AS hit_id, s.document_id,
        NULL::text AS claim_id, NULL::text AS extractor, ${score("s.tsv", tsquery)} AS score
      FROM brain_search_documents s
      JOIN brain_documents d ON d.owner_id = s.owner_id AND d.scope_id = s.scope_id
        AND d.document_id = s.document_id AND d.deleted_at IS NULL AND d.incarnation = s.incarnation
      WHERE s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId} AND s.tsv @@ ${tsquery}${filters}`);
  }
  if (query.types.includes("claim")) {
    const kinds = query.claimKinds === null ? sql`` : sql` AND c.kind IN (${sql.join([...query.claimKinds])})`;
    // One hit per claim id: rules and model extractors can both hold a claim; the model's row, then the best, wins.
    branches.push(sql`SELECT * FROM (SELECT DISTINCT ON (c.claim_id) 'claim'::text AS hit_type, c.claim_id AS hit_id,
        c.document_id, c.claim_id, c.extractor, ${score("c.tsv", tsquery)} AS score
      FROM brain_search_claims c
      JOIN brain_claims bc ON bc.owner_id = c.owner_id AND bc.scope_id = c.scope_id AND bc.claim_id = c.claim_id
        AND bc.extractor = c.extractor
      JOIN brain_documents d ON d.owner_id = c.owner_id AND d.scope_id = c.scope_id
        AND d.document_id = c.document_id AND d.deleted_at IS NULL AND d.incarnation = c.incarnation
      WHERE c.owner_id = ${scope.ownerId} AND c.scope_id = ${scope.scopeId} AND c.tsv @@ ${tsquery}${kinds}${filters}
      ORDER BY c.claim_id, (c.extractor LIKE 'model:%') DESC, score DESC, c.extractor) one`);
  }
  const after = page.after === null ? sql`` : sql`WHERE score < ${page.after.score}::numeric
    OR (score = ${page.after.score}::numeric AND hit_id COLLATE "C" > ${page.after.hitId})`;
  const rows = await sql<{
    hit_type: "document" | "claim"; hit_id: string; document_id: string; claim_id: string | null;
    extractor: string | null; score_text: string;
  }>`SELECT hit_type, hit_id, document_id, claim_id, extractor, score::text AS score_text
    FROM (${sql.join(branches, sql` UNION ALL `)}) hits ${after}
    ORDER BY score DESC, hit_id COLLATE "C" ASC LIMIT ${page.limit}`.execute(db);
  return rows.rows.map((row) => ({
    type: row.hit_type, hitId: row.hit_id, documentId: row.document_id, claimId: row.claim_id,
    extractor: row.extractor, score: row.score_text, matchedBy: ["text"], chunkIndex: null,
  }));
}

/**
 * Whether a search of two or more different terms ranks hits with any term: fewer than BRAIN_SEARCH_ANY_TERM_BELOW
 * hold all of them. A repeated term (any case) counts once, since any of them finds nothing more than all.
 */
export async function brainSearchNeedsAnyTerm(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, query: BrainParsedSearchQuery,
): Promise<boolean> {
  if (new Set(query.terms.map((term) => `${term.type}:${term.text.toLowerCase()}`)).size < 2) return false;
  const all = await rankBrainTextHits(db, scope, query, { limit: BRAIN_SEARCH_ANY_TERM_BELOW, after: null }, false);
  return all.length < BRAIN_SEARCH_ANY_TERM_BELOW;
}

/**
 * The ids of the vector candidates whose document is still live at the candidate's (incarnation, revision) and passes
 * the filters: a document changed after its vectors were read is dropped, so a meaning match never shows new text.
 */
export async function filterBrainVectorCandidates(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, query: BrainParsedSearchQuery,
  candidates: readonly { readonly documentId: string; readonly incarnation: string; readonly revision: number }[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const at = candidates.map((entry) => sql`(${entry.documentId}, ${entry.incarnation}::uuid, ${entry.revision}::int)`);
  const rows = await sql<{ document_id: string }>`SELECT d.document_id FROM brain_documents d
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
      AND (d.document_id, d.incarnation, d.revision) IN (${sql.join(at)})${brainDocumentFilters(query)}`.execute(db);
  return new Set(rows.rows.map((row) => row.document_id));
}
