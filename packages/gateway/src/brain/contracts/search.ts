/**
 * Company Brain feature contract, part 4: ranked search over documents and claims of one project scope, the
 * embeddings seam and the capability flag. Full text works everywhere; meaning search turns on when an embeddings
 * provider is configured (OpenAI with the owner's key), over pgvector or plain arrays. Types and constants only.
 */
import type { BrainClaimKind } from "../claims/types.js";
import type { BrainRepository } from "../repository.js";
import type { BrainScopeKey } from "../types.js";
import type { BrainCiteKind, BrainCiteView, BrainProjectResolver } from "./common.js";
import type { BrainDerivedIndex, BrainIndexFreshness, BrainRefreshView } from "./hooks.js";

// Limits.

/** Equal to BRAIN_SEARCH_QUERY_MAX_CHARS. */
export const BRAIN_SEARCH_Q_MAX_CHARS = 500;
/** Search terms kept after parsing (quoted phrases count once); the rest are dropped with a notice. */
export const BRAIN_SEARCH_TERMS_MAX = 16;
export const BRAIN_SEARCH_DEFAULT_LIMIT = 20;
/** Equal to BRAIN_SEARCH_MAX_LIMIT. */
export const BRAIN_SEARCH_MAX_LIMIT = 50;
/** Ranked candidates per retriever (text, vector); pages never reach past this many fused results. */
export const BRAIN_SEARCH_CANDIDATES_MAX = 200;
/** Reciprocal-rank fusion constant: score = sum(1 / (k + rank)). */
export const BRAIN_SEARCH_RRF_K = 60;
/** UTF-16 units of a snippet and the most highlight ranges in one. */
export const BRAIN_SEARCH_SNIPPET_MAX_CHARS = 280;
export const BRAIN_SEARCH_HIGHLIGHTS_MAX = 16;
/**
 * Weights of the full-text vectors (Postgres 'simple' config). A document hit: title A; its handle and label refs and
 * the statements of its current claims B; body D. A claim hit: label A, statement B, quote D.
 */
export const BRAIN_SEARCH_FIELD_WEIGHTS = {
  document: { title: "A", refs: "B", claimStatements: "B", body: "D" },
  claim: { label: "A", statement: "B", quote: "D" },
} as const;

// Query.

/**
 * q: a quoted "phrase" is matched in order; a term ending in "*" is a prefix (at least 2 characters before it);
 * other punctuation separates terms; raw text never reaches to_tsquery. types: hit types (default both).
 * kinds: document cite kinds. claimKinds: claim hits only of these kinds. sourceId: one source. from/to: on
 * source_updated_at, [from, to). path: repo-relative file or folder (trailing "/" = folder only, as brain_why), via
 * path refs. mode: auto = hybrid when meaning search is available, else text; hybrid when unavailable is
 * vector_search_unavailable.
 */
export interface BrainSearchQuery {
  readonly q: string;
  readonly types?: readonly ("document" | "claim")[];
  readonly kinds?: readonly BrainCiteKind[];
  readonly claimKinds?: readonly BrainClaimKind[];
  readonly sourceId?: string;
  readonly from?: string; readonly to?: string;
  readonly path?: string;
  readonly mode?: "auto" | "text" | "hybrid";
  readonly limit?: number;
  readonly cursor?: string;
}

// Results.

/** Where a snippet comes from: a document hit's title or body; a claim hit's label, statement or quote. */
export const BRAIN_SNIPPET_FIELDS = ["title", "body", "label", "statement", "quote"] as const;

/**
 * highlights: [start, end) UTF-16 ranges into text, sorted, non-overlapping. Plain text; never markup. A claim matched
 * only by its label shows the label (field "label"), so the highlight lands on the text that matched.
 */
export interface BrainSnippetView {
  readonly field: (typeof BRAIN_SNIPPET_FIELDS)[number];
  readonly text: string;
  readonly highlights: readonly (readonly [number, number])[];
  readonly truncatedStart: boolean; readonly truncatedEnd: boolean;
}

export interface BrainSearchClaimView {
  readonly claimId: string; readonly kind: BrainClaimKind; readonly label: string | null;
  readonly statement: string; readonly extractor: string; readonly stale: boolean;
}

/**
 * hitId: the document id (type document) or `${claimId}:${extractor}` (type claim). score: the rank score in
 * [0, 1] for this page's ordering (text: normalized ts_rank_cd; hybrid: normalized fused score); compare only within
 * one response. matchedBy: retrievers that returned the hit. cite: the document (of the claim, for claims).
 */
export interface BrainSearchHitView {
  readonly hitId: string; readonly type: "document" | "claim"; readonly score: number;
  readonly matchedBy: readonly ("text" | "vector")[];
  readonly snippet: BrainSnippetView; readonly claim: BrainSearchClaimView | null; readonly cite: BrainCiteView;
}

/**
 * vector: why meaning search is or is not used. "available": an embeddings provider is configured; store says where
 * the vectors live (pgvector when the extension exists, else plain real[] arrays). Off: "provider_not_configured"
 * where pgvector exists, "extension_missing" where it does not (a provider alone turns meaning search on there).
 * providerId: the embeddings provider, null when none.
 */
export interface BrainSearchCapabilityView {
  readonly fullText: true;
  readonly vector: "available" | "extension_missing" | "provider_not_configured";
  readonly providerId: string | null;
  /** Present only while vector is "available". */
  readonly store?: "pgvector" | "array";
}

/**
 * terms_dropped: terms past BRAIN_SEARCH_TERMS_MAX were not used. query_empty_after_parse: no term was left to search.
 * candidates_capped: more than BRAIN_SEARCH_CANDIDATES_MAX hits matched. index_behind: the index is not caught up.
 * any_term_fallback: fewer than 5 hits held every term, so hits holding any term were ranked too (fuller first).
 */
export const BRAIN_SEARCH_NOTICES = [
  "terms_dropped", "query_empty_after_parse", "candidates_capped", "index_behind", "any_term_fallback",
] as const;
export type BrainSearchNotice = (typeof BRAIN_SEARCH_NOTICES)[number];

/** Best first; the cursor continues the same query and filters only (another query with it is invalid_request). */
export interface BrainSearchView {
  readonly q: string; readonly mode: "text" | "hybrid";
  readonly items: readonly BrainSearchHitView[]; readonly nextCursor: string | null;
  readonly capability: BrainSearchCapabilityView; readonly freshness: BrainIndexFreshness;
  readonly notices: readonly BrainSearchNotice[];
}

// Embeddings seam. The OpenAI provider is search/openai.ts; tests use fakes.

/**
 * embed returns one vector per input, each of `dimensions` finite numbers within float4 range (magnitude at most
 * 3.4028234663852886e38), in input order; rejects on abort or provider failure (the indexer records the document as
 * pending and retries on the next refresh). Inputs are at most maxBatch texts of at most maxInputChars each.
 */
export interface BrainEmbeddingsProvider {
  readonly providerId: string; readonly dimensions: number; readonly maxBatch: number; readonly maxInputChars: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
}
export const BRAIN_EMBEDDINGS_DIMENSIONS_MAX = 4_096;
/** Chunking for meaning search: UTF-16 units per chunk and overlap; chunks per document cap. */
export const BRAIN_SEARCH_CHUNK = { maxChars: 2_000, overlapChars: 200, perDocumentMax: 40 } as const;

/**
 * pgvector storage, created only when the extension is available. Without it, vectors live in
 * BRAIN_SEARCH_VECTORS_TABLE (real[]), which always exists.
 */
export const BRAIN_SEARCH_CHUNKS_TABLE = "brain_search_chunks";
export const BRAIN_SEARCH_VECTORS_TABLE = "brain_search_vectors";

/** A nearest chunk and the (incarnation, revision) its vector was built from. */
export interface BrainVectorMatch {
  readonly documentId: string; readonly incarnation: string; readonly revision: number; readonly chunkIndex: number;
  readonly distance: number;
}

export interface BrainVectorStore {
  /**
   * Replaces a document's chunks for (incarnation, revision, providerId); an empty list removes them. The search
   * stores skip the write when the document is no longer live at that (incarnation, revision), and keep an optional
   * per-chunk text key so an unchanged chunk is not embedded again.
   */
  replaceChunks(scope: BrainScopeKey, input: {
    readonly documentId: string; readonly incarnation: string; readonly revision: number;
    readonly providerId: string;
    readonly chunks: readonly { readonly spanStart: number; readonly spanEnd: number; readonly vector: readonly number[] }[];
  }): Promise<void>;
  /**
   * Nearest live-document chunks, best first, at most `limit` (<= BRAIN_SEARCH_CANDIDATES_MAX), each with the
   * (incarnation, revision) it was built from, so a search can drop a document that changed after this read.
   */
  nearest(scope: BrainScopeKey, vector: readonly number[], limit: number, providerId: string):
    Promise<readonly BrainVectorMatch[]>;
}

// Service.

export interface BrainSearchServiceDeps {
  readonly repository: BrainRepository; readonly resolver: BrainProjectResolver;
  /** From bootstrapBrainSearchDatabase. */
  readonly capability: BrainSearchCapabilityView;
  /** Null: full text only. search/index.ts createBrainSearchEmbeddings builds it from the owner's settings. */
  readonly embeddings?: BrainEmbeddingsProvider | null;
  readonly vectors?: BrainVectorStore | null;
  readonly now?: () => Date;
  /**
   * Principals whose scopes may use the embeddings provider (the gateway owner, whose key it holds); any other
   * principal searches by text only and its documents are never sent. Absent: every principal.
   */
  readonly embeddingOwnerIds?: readonly string[];
}

/** Owner-scoped; search is read-only and never refreshes the index. */
export interface BrainSearchService {
  search(ownerId: string, projectRef: string, query: BrainSearchQuery): Promise<BrainSearchView>;
  /** One bounded refresh of the scope's search index. */
  refresh(ownerId: string, projectRef: string): Promise<BrainRefreshView>;
  capability(): BrainSearchCapabilityView;
}

/** search/index.ts creates both from one deps object; the index is the hook listener named "search". */
export interface BrainSearchFeature { readonly service: BrainSearchService; readonly index: BrainDerivedIndex }
