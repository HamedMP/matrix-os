/**
 * Company Brain search: the tables this folder owns, its internal limits, error helpers and the parsed query. The
 * public contract (views, query, seams) is contracts/search.ts; this file only adds what the folder needs on top.
 */
import type { ColumnType, Generated, sql } from "kysely";
import type { BrainClaimKind } from "../claims/types.js";
import {
  BRAIN_SEARCH_CHUNK, type BrainCiteKind, type BrainEmbeddingsProvider, type BrainRefreshEmbeddingView,
  type BrainSearchCapabilityView, type BrainVectorStore,
} from "../contracts.js";
import type { BrainScopeKey } from "../types.js";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
/** tsvector and vector columns are written and read through SQL only. */
type SqlOnly = ColumnType<string, never, never>;

/**
 * One row per indexed live document (tsv: A title, B handle and label refs plus claim statements, D body). claims_key:
 * md5 of the document's claims; embedded_provider: "<store>:<provider id>" whose vectors match this revision and
 * claims set; embed_failed_at: last failure.
 */
export interface BrainSearchDocumentsTable {
  owner_id: string; scope_id: string; document_id: string; incarnation: string; revision: number; claims_key: string;
  embedded_provider: string | null; embed_failed_at: Timestamp | null; tsv: SqlOnly; indexed_at: Timestamp;
}

/** One row per claim; tsv: A label, B statement, D quote. A removed claim's row stays until refresh, never ranked. */
export interface BrainSearchClaimsTable {
  owner_id: string; scope_id: string; claim_id: string; extractor: string; document_id: string;
  kind: BrainClaimKind; incarnation: string; revision: number; tsv: SqlOnly;
}

/** Only created when the pgvector extension is available. text_key: of the chunk's text, null when not given. */
export interface BrainSearchChunksTable {
  owner_id: string; scope_id: string; document_id: string; chunk_index: number; incarnation: string;
  revision: number; provider_id: string; span_start: number; span_end: number; dimensions: number;
  text_key: string | null; embedding: SqlOnly;
}

/** Unit-length float4 vectors for stores without pgvector; always created. Spans are not kept (hydrate recomputes). */
export interface BrainSearchVectorsTable {
  owner_id: string; scope_id: string; document_id: string; chunk_index: number; incarnation: string;
  revision: number; provider_id: string; dimensions: number; text_key: string | null; embedding: SqlOnly;
  created_at: Generated<Date>;
}

export type BrainSearchTables = {
  brain_search_documents: BrainSearchDocumentsTable; brain_search_claims: BrainSearchClaimsTable;
  brain_search_chunks: BrainSearchChunksTable; brain_search_vectors: BrainSearchVectorsTable;
};

// Internal limits.

/** Wall clock for one search request's SQL (SET LOCAL statement_timeout) and one query embedding call. */
export const BRAIN_SEARCH_STATEMENT_TIMEOUT_MS = 10_000;
export const BRAIN_SEARCH_EMBED_TIMEOUT_MS = 10_000;
/** Highlight matches collected per field before choosing a window. */
export const BRAIN_SEARCH_MATCHES_MAX = 256;
/** UTF-16 units of a claim-hit document body tail read for the git footer (BRAIN_CLAIM_FOOTER_TAIL_CHARS). */
export const BRAIN_SEARCH_FOOTER_TAIL_CHARS = 2_048;
/** Texts sent to the embeddings provider in one call, whatever the provider allows. */
export const BRAIN_SEARCH_EMBED_BATCH_MAX = 64;
/**
 * Documents rebuilt per transaction: round trips dominate a rebuild (about 6 ms each to a Docker Postgres), so a
 * batch of 25 indexes the 2,129-document dev project in seconds instead of minutes.
 */
export const BRAIN_SEARCH_REBUILD_BATCH = 25;
/** A chunk's text key: the first 32 hex characters of the SHA-256 of its text. */
export const BRAIN_SEARCH_TEXT_KEY_PATTERN = /^[a-f0-9]{32}$/;
/** Embeddings provider ids: short, lowercase, safe in logs. */
export const BRAIN_SEARCH_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;
/** Body chunks embedded per document; the last chunk index is kept for the claim statements chunk. */
export const BRAIN_SEARCH_BODY_CHUNKS_MAX = BRAIN_SEARCH_CHUNK.perDocumentMax - 1;
/** Rows of brain_search_vectors per scope: about 0.8 s for one nearest scan on Postgres 16. */
export const BRAIN_SEARCH_VECTORS_PER_SCOPE_MAX = 50_000;
/**
 * Embedding spend of one refresh, checked before each provider call (one call can pass it by one batch). At
 * text-embedding-3-small's price the two limits agree; the cost limit also holds for a dearer model.
 */
export const BRAIN_SEARCH_EMBED_REFRESH_BUDGET = { tokens: 1_000_000, costMicroUsd: 20_000 } as const;
/** Postgres foreign_key_violation: the document or claim was erased meanwhile; a skipped document, not an error. */
export const FOREIGN_KEY_VIOLATION = "23503";
/** A number pgvector can store (float4: finite, magnitude at most 3.4028234663852886e38; else SQLSTATE 22003). */
export const isBrainVectorValue = (value: unknown): boolean =>
  typeof value === "number" && Math.abs(value) <= 3.4028234663852886e38;

/** A composable piece of SQL. */
export type SqlFragment = ReturnType<typeof sql>;
/** The SQLSTATE of a driver error; undefined for anything without one. */
export const sqlState = (error: unknown): unknown => Object(error).code;
export const errorName = (error: unknown): string => (error instanceof Error ? error.name : "UnknownError");
/** `index` moved back off the middle of a surrogate pair, so a cut there never splits one. */
export const brainSafeCut = (text: string, index: number): number => (index > 0 && index < text.length
  && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff ? index - 1 : index);

// Parsed query.

export type BrainSearchTerm =
  | { readonly type: "plain"; readonly text: string }
  | { readonly type: "phrase"; readonly text: string }
  /** Letters, digits and marks, or a joined token ("package.js", "src/brain") matched whole or by its words. */
  | { readonly type: "prefix"; readonly text: string };

export interface BrainParsedSearchQuery {
  readonly q: string;
  readonly terms: readonly BrainSearchTerm[];
  readonly termsDropped: boolean;
  readonly types: readonly ("document" | "claim")[];
  readonly kinds: readonly BrainCiteKind[] | null;
  readonly claimKinds: readonly BrainClaimKind[] | null;
  readonly sourceId: string | null;
  /** ISO instants; [from, to). */
  readonly from: string | null; readonly to: string | null;
  readonly path: { readonly value: string; readonly mode: "exact_or_under" | "under" } | null;
  readonly mode: "auto" | "text" | "hybrid";
  readonly limit: number;
  readonly cursor: string | null;
}

/** A ranked hit before hydration. score: text rank or fused score, 6 decimals. */
export interface BrainRankedHit {
  readonly type: "document" | "claim"; readonly hitId: string; readonly documentId: string;
  readonly claimId: string | null; readonly extractor: string | null; readonly score: string;
  readonly matchedBy: readonly ("text" | "vector")[];
  /** Best matching chunk, vector hits only. */
  readonly chunkIndex: number | null;
}

// Meaning search internals (the public seam is contracts/search.ts).

/**
 * not_configured: no usable key. auth_failed: the key or model was refused (401, 403, 404). invalid: the input was
 * refused (400, 413, 422). unavailable: rate limits, quota, server errors, timeouts, network, or a bad response.
 * status and detail (the provider's error code, checked to be a short slug) are safe to log; no provider text is kept.
 */
export type BrainEmbeddingsErrorCode = "not_configured" | "auth_failed" | "invalid" | "unavailable";
export class BrainEmbeddingsError extends Error {
  readonly code: BrainEmbeddingsErrorCode; readonly status: number | null; readonly detail: string | null;
  constructor(
    code: BrainEmbeddingsErrorCode, options: { status?: number; detail?: string | null; cause?: unknown } = {},
  ) {
    super(`Embeddings ${code}`, { cause: options.cause });
    this.name = "BrainEmbeddingsError";
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
  }
}

/** Tokens billed and their cost in micro-USD. */
export interface BrainEmbeddingsUsage { readonly tokens: number; readonly costMicroUsd: number }

/**
 * Provenances whose documents meaning search may send to the embeddings provider when the owner names none: the
 * project's own git history and specs. Chats, notes, files, calendar events and connector text never leave unless
 * the owner lists their provenance in brain.embeddings.provenances.
 */
export const BRAIN_SEARCH_EMBED_DEFAULT_PROVENANCES: readonly string[] = ["git_pr", "git_commit", "git_spec"];
export const BRAIN_SEARCH_EMBED_PROVENANCES_MAX = 32;
const PROVENANCE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A provider may carry the provenances the owner allowed it to receive at start, and a reader of the owner's current
 * list (read again for every refresh and search, so narrowing the list takes effect without a restart; an empty list
 * sends nothing).
 */
export interface BrainSearchEmbeddingsAllowance {
  readonly provenances?: readonly string[];
  currentProvenances?(): Promise<readonly string[]>;
}

/** The provider's allowed provenances; absent, empty, malformed or too many: the git default. */
export function brainEmbedProvenances(provider: BrainEmbeddingsProvider & BrainSearchEmbeddingsAllowance): string[] {
  const listed: unknown = provider.provenances;
  const valid = Array.isArray(listed) && listed.length > 0 && listed.length <= BRAIN_SEARCH_EMBED_PROVENANCES_MAX
    && listed.every((value) => typeof value === "string" && PROVENANCE_PATTERN.test(value));
  return [...new Set(valid ? listed as string[] : BRAIN_SEARCH_EMBED_DEFAULT_PROVENANCES)];
}

/** The owner's current list as read now: kept when well formed (an empty list sends nothing), else nothing. */
export function brainCurrentEmbedProvenances(listed: unknown): string[] {
  const valid = Array.isArray(listed) && listed.length <= BRAIN_SEARCH_EMBED_PROVENANCES_MAX
    && listed.every((value) => typeof value === "string" && PROVENANCE_PATTERN.test(value));
  return valid ? [...new Set(listed as string[])] : [];
}

/** What a refresh embeds: the marker a row carries once embedded, and the provenances whose documents may be sent. */
export interface BrainSearchEmbedTarget { readonly marker: string; readonly provenances: readonly string[] }

/** A provider that also reports usage; embedBrainTexts prefers embedMetered when it exists. */
export interface BrainMeteredEmbeddingsProvider extends BrainEmbeddingsProvider {
  embedMetered(texts: readonly string[], signal: AbortSignal): Promise<{
    readonly vectors: readonly (readonly number[])[]; readonly usage: BrainEmbeddingsUsage;
  }>;
}

type BrainVectorReplace = Parameters<BrainVectorStore["replaceChunks"]>[1];
/** A chunk to store; textKey (32 hex characters, from the chunk's text) lets an unchanged chunk keep its vector. */
export type BrainSearchChunkWrite = BrainVectorReplace["chunks"][number] & { readonly textKey?: string };

/**
 * The search stores: replaceChunks also keeps text keys; a write is skipped (nothing deleted or written) unless the
 * document is live at the input's (incarnation, revision) and, when the input carries a claims key, its search row
 * still holds that claims set (isLiveAt, in the write's transaction), and a removal (no chunks) while the document is
 * live at another one. Optional: remaining() says how many more rows fit when the listed documents' rows are
 * replaced; storedVectors() returns kept vectors by text key.
 */
export interface BrainSearchVectorStore extends BrainVectorStore {
  replaceChunks(scope: BrainScopeKey, input: Omit<BrainVectorReplace, "chunks"> & {
    readonly chunks: readonly BrainSearchChunkWrite[];
    /** brain_search_documents.claims_key the vectors were embedded for (32 hex characters). */
    readonly claimsKey?: string;
  }): Promise<void>;
  remaining?(scope: BrainScopeKey, documentIds?: readonly string[]): Promise<number>;
  /** Vectors of these documents for this provider and size, by text key, for the listed keys only. */
  storedVectors?(scope: BrainScopeKey, input: {
    readonly providerId: string; readonly dimensions: number; readonly documentIds: readonly string[];
    readonly textKeys: readonly string[];
  }): Promise<ReadonlyMap<string, readonly number[]>>;
}

/** Thrown by a capped store when a write would pass the scope's cap; the transaction leaves the old rows. */
export class BrainSearchVectorCapError extends Error {
  constructor() {
    super("Vector store full");
    this.name = "BrainSearchVectorCapError";
  }
}

/** Embedding spend of one refresh and why it stopped early, if it did (the contract's refresh view part). */
export type BrainSearchEmbeddingView = BrainRefreshEmbeddingView;

/** The capability view, store included (present only while vector is "available"). */
export type BrainSearchCapability = BrainSearchCapabilityView;
