/**
 * Owner-scoped search service and its derived index. A search embeds the query and looks up vectors first (so no
 * connection waits on a provider), then filters, ranks, hydrates and reads freshness in one read-only snapshot.
 */
import type { Kysely } from "kysely";
import { brainCallCap } from "../bounded.js";
import {
  BRAIN_DERIVED_REFRESH_DEFAULTS, BRAIN_SEARCH_CANDIDATES_MAX, BrainFeatureError, type BrainDerivedIndex,
  type BrainSearchFeature, type BrainSearchNotice, type BrainSearchQuery, type BrainSearchService,
  type BrainSearchServiceDeps, type BrainSearchView,
} from "../contracts.js";
import { BRAIN_MAX_REVISION, BRAIN_UUID_PATTERN, type BrainDatabase, type BrainScopeKey } from "../types.js";
import { hydrateBrainHits } from "./hydrate.js";
import { withSearchRead } from "./index-sql.js";
import { createBrainArrayVectorStore } from "./array-store.js";
import { brainCurrentEmbedTarget, type BrainSearchMeaning } from "./embed-pass.js";
import { brainMeaningFor, brainSearchFreshness, createBrainSearchIndex } from "./indexer.js";
import { createBrainPgVectorStore } from "./pgvector.js";
import {
  brainSearchCursorMode, brainSearchFingerprint, decodeBrainSearchCursor, encodeBrainSearchCursor,
  parseBrainSearchQuery,
} from "./query.js";
import { brainSearchPatterns } from "./snippet.js";
import { brainSearchNeedsAnyTerm, filterBrainVectorCandidates, rankBrainTextHits } from "./text.js";
import {
  BRAIN_SEARCH_EMBED_TIMEOUT_MS, type BrainParsedSearchQuery, type BrainRankedHit, type BrainSearchCapability,
} from "./types.js";
import {
  brainEmbeddingsFailure, embedBrainTexts, fuseBrainHits, isUsableBrainEmbeddingsProvider, rankBrainVectorDocuments,
  type BrainVectorCandidate,
} from "./vector.js";

const DOCUMENT_ID = /^[a-f0-9]{64}$/;

type VectorDocuments = { readonly ranked: BrainVectorCandidate[]; readonly capped: boolean };
type VectorHits = { readonly hits: BrainRankedHit[]; readonly capped: boolean };

/**
 * The vector store's nearest chunks (its own deadline), one entry per document at its best chunk and the
 * (incarnation, revision) that chunk was built from.
 */
async function nearestDocuments(
  meaning: BrainSearchMeaning, scope: BrainScopeKey, vector: readonly number[],
): Promise<VectorDocuments> {
  const matches = (await meaning.vectors.nearest(scope, vector, BRAIN_SEARCH_CANDIDATES_MAX,
    meaning.provider.providerId)).slice(0, BRAIN_SEARCH_CANDIDATES_MAX)
    .filter((match) => DOCUMENT_ID.test(match.documentId) && BRAIN_UUID_PATTERN.test(match.incarnation)
      && Number.isInteger(match.revision) && match.revision >= 1 && match.revision <= BRAIN_MAX_REVISION
      && Number.isInteger(match.chunkIndex));
  return { ranked: rankBrainVectorDocuments(matches), capped: matches.length >= BRAIN_SEARCH_CANDIDATES_MAX };
}

/**
 * Vector candidates still live at their matched (incarnation, revision) and passing the filters, as hits; inside the
 * search snapshot, so hydration reads the text the vectors were built from.
 */
async function vectorHits(
  trx: Kysely<BrainDatabase>, scope: BrainScopeKey, query: BrainParsedSearchQuery, found: VectorDocuments | null,
): Promise<VectorHits> {
  if (found === null) return { hits: [], capped: false };
  const allowed = await filterBrainVectorCandidates(trx, scope, query, found.ranked);
  return {
    hits: found.ranked.filter((entry) => allowed.has(entry.documentId)).map((entry) => ({
      type: "document", hitId: entry.documentId, documentId: entry.documentId, claimId: null, extractor: null,
      score: "0.000000", matchedBy: ["vector"], chunkIndex: entry.chunkIndex,
    })),
    capped: found.capped,
  };
}

/**
 * Meaning search is on whenever a usable provider and a vector store exist: by default the pgvector store when the
 * bootstrap found the extension, else the array store. A row counts as embedded only under the same store and
 * provider, so a switch of either embeds again. Off, the capability is exactly the text-only one. Only the owners in
 * deps.embeddingOwnerIds (the gateway owner, whose key the provider holds) get it: any other principal searches by
 * text, sees the text-only capability, and its queries and documents are never sent. Every refresh entry point (the
 * route, and the returned index the hook listener, job steps and index catch-up run) shares one cap of
 * BRAIN_HEAVY_CALLS_MAX at once; past it they answer brain_unavailable. A scope erase only deletes rows: never refused.
 */
export function createBrainSearch(deps: BrainSearchServiceDeps): BrainSearchFeature {
  const db = deps.repository.kysely;
  const extension = deps.capability.vector !== "extension_missing";
  const provider = deps.embeddings ?? null;
  const usable = provider !== null && isUsableBrainEmbeddingsProvider(provider);
  if (provider !== null && !usable) console.error("[brain-search] embeddings provider settings are invalid");
  const store = extension ? "pgvector" : "array";
  // Omitted: the store the database supports; an explicit null keeps meaning search off.
  const vectors = deps.vectors !== undefined ? deps.vectors : !usable ? null
    : store === "pgvector" ? createBrainPgVectorStore(db) : createBrainArrayVectorStore(db);
  const meaning: BrainSearchMeaning | null = usable && vectors !== null ? { provider, vectors, store } : null;
  const capability: BrainSearchCapability = meaning === null
    ? { fullText: true, vector: extension ? "provider_not_configured" : "extension_missing",
      providerId: usable ? provider.providerId : null }
    : { fullText: true, vector: "available", providerId: meaning.provider.providerId, store };
  const ownerIds = deps.embeddingOwnerIds;
  const derived = createBrainSearchIndex({
    db, meaning, now: deps.now ?? (() => new Date()), ...(ownerIds === undefined ? {} : { ownerIds }),
  });
  const refreshCap = brainCallCap("search refresh");
  const index: BrainDerivedIndex = {
    name: derived.name, freshness: derived.freshness,
    refresh: (scope, limits, signal) => refreshCap(() => derived.refresh(scope, limits, signal)),
    handle: (event, signal) => (event.type === "scope_erased" ? derived.handle(event, signal)
      : refreshCap(() => derived.handle(event, signal))),
  };
  // What a principal the provider does not serve sees: no provider for them, whatever the store.
  const textOnly: BrainSearchCapability = { fullText: true, vector: "provider_not_configured", providerId: null };

  /** Text mode: keyset page on (score, hitId). Hybrid: offset page within the fused window. */
  async function rank(
    trx: Kysely<BrainDatabase>, scope: BrainScopeKey, query: BrainParsedSearchQuery, mode: "text" | "hybrid",
    vector: VectorHits, fingerprint: string, notices: BrainSearchNotice[],
  ): Promise<{ readonly page: BrainRankedHit[]; readonly nextCursor: string | null }> {
    const cursor = query.cursor === null ? null
      : decodeBrainSearchCursor(query.cursor, fingerprint, mode === "text" ? "t" : "h");
    const any = await brainSearchNeedsAnyTerm(trx, scope, query);
    if (any) notices.push("any_term_fallback");
    if (mode === "text") {
      const after = cursor?.m === "t" ? { score: cursor.s, hitId: cursor.h } : null;
      const rows = await rankBrainTextHits(trx, scope, query, { limit: query.limit + 1, after }, any);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1]!;
      return { page, nextCursor: rows.length > query.limit
        ? encodeBrainSearchCursor({ v: 1, m: "t", f: fingerprint, s: last.score, h: last.hitId }) : null };
    }
    const offset = cursor?.m === "h" ? cursor.o : 0;
    const text = await rankBrainTextHits(trx, scope, query,
      { limit: BRAIN_SEARCH_CANDIDATES_MAX + 1, after: null }, any);
    if (text.length > BRAIN_SEARCH_CANDIDATES_MAX || vector.capped) notices.push("candidates_capped");
    const fused = fuseBrainHits([text.slice(0, BRAIN_SEARCH_CANDIDATES_MAX), vector.hits])
      .slice(0, BRAIN_SEARCH_CANDIDATES_MAX);
    return { page: fused.slice(offset, offset + query.limit), nextCursor: offset + query.limit < fused.length
      ? encodeBrainSearchCursor({ v: 1, m: "h", f: fingerprint, o: offset + query.limit }) : null };
  }

  /**
   * The query's embedding, its spend logged by counts only (never the text). Only the provider call falls back: in
   * auto mode without a cursor a provider failure answers null (text search); otherwise it is
   * vector_search_unavailable.
   */
  async function embedQuery(query: BrainParsedSearchQuery, active: BrainSearchMeaning): Promise<number[] | null> {
    try {
      const { vectors: [vector], tokens, costMicroUsd } = await embedBrainTexts(active.provider, [query.q.trim()],
        AbortSignal.timeout(BRAIN_SEARCH_EMBED_TIMEOUT_MS));
      if (tokens > 0) console.info("[brain-search] query embedding spend", { tokens, costMicroUsd });
      return vector!;
    } catch (error: unknown) {
      console.error("[brain-search] meaning search failed:", brainEmbeddingsFailure(error));
      if (query.mode === "hybrid" || query.cursor !== null) {
        throw new BrainFeatureError("vector_search_unavailable", { cause: error });
      }
      return null;
    }
  }

  async function search(
    ownerId: string, projectRef: string, input: BrainSearchQuery,
  ): Promise<BrainSearchView> {
    const query = parseBrainSearchQuery(input);
    const { scope } = await deps.resolver.resolve(ownerId, projectRef);
    const active = brainMeaningFor(meaning, ownerIds, scope.ownerId);
    // A cursor in auto mode continues the mode its first page resolved to.
    const continued = query.cursor === null || query.mode !== "auto" ? null : brainSearchCursorMode(query.cursor);
    if ((query.mode === "hybrid" || continued === "h") && active === null) {
      throw new BrainFeatureError("vector_search_unavailable");
    }
    let mode: "text" | "hybrid" = query.mode === "text" || active === null || continued === "t" ? "text" : "hybrid";
    const notices: BrainSearchNotice[] = query.termsDropped ? ["terms_dropped"] : [];
    if (query.terms.length === 0) notices.push("query_empty_after_parse");
    let found: VectorDocuments | null = null;
    if (mode === "hybrid" && query.terms.length > 0 && query.types.includes("document")) {
      const vector = await embedQuery(query, active!);
      if (vector === null) mode = "text";
      else found = await nearestDocuments(active!, scope, vector);
    }
    const fingerprint = brainSearchFingerprint(query, mode);
    const embed = active === null ? null : await brainCurrentEmbedTarget(active);
    const view = await withSearchRead(db, async (trx) => {
      const vector = await vectorHits(trx, scope, query, found);
      const { page, nextCursor } = query.terms.length === 0 ? { page: [], nextCursor: null }
        : await rank(trx, scope, query, mode, vector, fingerprint, notices);
      const items = await hydrateBrainHits(trx, scope, page, brainSearchPatterns(query.terms));
      return { items, nextCursor, freshness: await brainSearchFreshness(trx, scope, embed) };
    }, true);
    if (!view.freshness.caughtUp) notices.push("index_behind");
    return { q: query.q, mode, ...view, capability: active === null && meaning !== null ? textOnly : capability, notices };
  }

  const service: BrainSearchService = {
    search,
    async refresh(ownerId, projectRef) {
      const { scope } = await deps.resolver.resolve(ownerId, projectRef);
      return refreshCap(async () => {
        const signal = AbortSignal.timeout(BRAIN_DERIVED_REFRESH_DEFAULTS.budgetMs + BRAIN_SEARCH_EMBED_TIMEOUT_MS);
        const result = await derived.refresh(scope, BRAIN_DERIVED_REFRESH_DEFAULTS, signal);
        return { index: "search" as const, ...result, freshness: await derived.freshness(scope) };
      });
    },
    capability: () => capability,
  };
  return { service, index };
}
