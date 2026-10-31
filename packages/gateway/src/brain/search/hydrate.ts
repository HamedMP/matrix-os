/**
 * Turns one page of ranked hits into views: the hit's live document (and claim), its cite and a snippet. A hit
 * whose document or claim went away since ranking is dropped from the page. Reads at most one page of rows.
 */
import { sql, type Kysely } from "kysely";
import { brainCite } from "../cite.js";
import type { BrainClaimKind } from "../claims/types.js";
import type { BrainSearchHitView, BrainSnippetView } from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { chunkBrainSnippet, pickBrainSnippet } from "./snippet.js";
import { BRAIN_SEARCH_BODY_CHUNKS_MAX, BRAIN_SEARCH_FOOTER_TAIL_CHARS, type BrainRankedHit } from "./types.js";
import { chunkBrainBody } from "./vector.js";

interface DocumentRow {
  document_id: string; provenance: string; source_id: string | null; title: string; permalink: string;
  revision: number; incarnation: string; source_updated_at: Date | string; body: string;
}
interface ClaimRow {
  claim_id: string; extractor: string; kind: BrainClaimKind; label: string | null; statement: string; quote: string;
  incarnation: string; revision: number;
}

async function loadDocuments(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, hits: readonly BrainRankedHit[],
): Promise<Map<string, DocumentRow>> {
  const ids = [...new Set(hits.map((hit) => hit.documentId))];
  const full = [...new Set(hits.filter((hit) => hit.type === "document").map((hit) => hit.documentId))];
  const body = full.length === 0 ? sql`right(d.body, ${BRAIN_SEARCH_FOOTER_TAIL_CHARS}::int)`
    : sql`CASE WHEN d.document_id IN (${sql.join(full)}) THEN d.body
        ELSE right(d.body, ${BRAIN_SEARCH_FOOTER_TAIL_CHARS}::int) END`;
  const rows = await sql<DocumentRow>`SELECT d.document_id, d.provenance, d.source_id, d.title, d.permalink,
      d.revision, d.incarnation, d.source_updated_at, ${body} AS body
    FROM brain_documents d
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
      AND d.document_id IN (${sql.join(ids)})`.execute(db);
  return new Map(rows.rows.map((row) => [row.document_id, row]));
}

async function loadClaims(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, hits: readonly BrainRankedHit[],
): Promise<Map<string, ClaimRow>> {
  const claimIds = [...new Set(hits.flatMap((hit) => (hit.claimId === null ? [] : [hit.claimId])))];
  if (claimIds.length === 0) return new Map();
  const rows = await sql<ClaimRow>`SELECT claim_id, extractor, kind, label, statement, quote, incarnation, revision
    FROM brain_claims WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
      AND claim_id IN (${sql.join(claimIds)})`.execute(db);
  return new Map(rows.rows.map((row) => [`${row.claim_id}:${row.extractor}`, row]));
}

/** The first handle ref and the first spec ref of each document (cite labels). */
async function loadLabelRefs(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, documentIds: readonly string[],
): Promise<Map<string, { handle: string | null; spec: string | null }>> {
  if (documentIds.length === 0) return new Map();
  const rows = await sql<{ document_id: string; handle: string | null; spec: string | null }>`SELECT document_id,
      min(value) FILTER (WHERE kind = 'handle') AS handle, min(value) FILTER (WHERE kind = 'spec') AS spec
    FROM brain_document_refs WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
      AND document_id IN (${sql.join([...documentIds])}) AND kind IN ('handle', 'spec')
    GROUP BY document_id`.execute(db);
  return new Map(rows.rows.map((row) => [row.document_id, row]));
}

function documentSnippet(hit: BrainRankedHit, document: DocumentRow, patterns: readonly RegExp[]): BrainSnippetView {
  const fields = [{ field: "body", text: document.body }, { field: "title", text: document.title }] as const;
  const picked = pickBrainSnippet(fields, patterns);
  if (picked.highlights.length > 0 || hit.chunkIndex === null) return picked;
  // The chunk past the body chunks holds claim statements: no body window to start at.
  const span = hit.chunkIndex < BRAIN_SEARCH_BODY_CHUNKS_MAX
    ? chunkBrainBody(document.body)[hit.chunkIndex] : undefined;
  return span === undefined ? picked : chunkBrainSnippet(document.body, span.spanStart, patterns);
}

/** The statement, else the quote, else the label (a claim matched only by its label), with the matches highlighted. */
function claimSnippet(claim: ClaimRow, patterns: readonly RegExp[]): BrainSnippetView {
  return pickBrainSnippet([
    { field: "statement", text: claim.statement }, { field: "quote", text: claim.quote },
    ...(claim.label === null || claim.label === "" ? [] : [{ field: "label" as const, text: claim.label }]),
  ], patterns);
}

/** Views in hit order; at most one query each for documents, claims and label refs. */
export async function hydrateBrainHits(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, hits: readonly BrainRankedHit[], patterns: readonly RegExp[],
): Promise<BrainSearchHitView[]> {
  if (hits.length === 0) return [];
  const [documents, claims] = [await loadDocuments(db, scope, hits), await loadClaims(db, scope, hits)];
  const refs = await loadLabelRefs(db, scope, [...documents.keys()]);
  const views: BrainSearchHitView[] = [];
  for (const hit of hits) {
    const document = documents.get(hit.documentId);
    const claim = hit.type === "claim" ? claims.get(`${hit.claimId}:${hit.extractor}`) : undefined;
    if (document === undefined || (hit.type === "claim" && claim === undefined)) continue;
    const labels = refs.get(hit.documentId);
    const cite = brainCite({
      documentId: document.document_id, provenance: document.provenance, sourceId: document.source_id,
      title: document.title, permalink: document.permalink, date: document.source_updated_at,
      revision: document.revision, bodyTail: document.body, handle: labels?.handle ?? null, spec: labels?.spec ?? null,
    });
    const snippet = claim === undefined ? documentSnippet(hit, document, patterns) : claimSnippet(claim, patterns);
    views.push({
      hitId: hit.hitId, type: hit.type, score: Number(hit.score), matchedBy: hit.matchedBy, snippet, cite,
      claim: claim === undefined ? null : {
        claimId: claim.claim_id, kind: claim.kind, label: claim.label, statement: claim.statement,
        extractor: claim.extractor,
        stale: claim.incarnation !== document.incarnation || claim.revision !== document.revision,
      },
    });
  }
  return views;
}
