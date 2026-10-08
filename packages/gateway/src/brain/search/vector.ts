/**
 * Meaning search helpers: body chunking, the texts embedded per document, embeddings calls with output checks and
 * usage, vector match ranking and reciprocal-rank fusion, all against the BrainEmbeddingsProvider seam.
 */
import { createHash } from "node:crypto";
import {
  BRAIN_EMBEDDINGS_DIMENSIONS_MAX, BRAIN_SEARCH_CHUNK, BRAIN_SEARCH_RRF_K, type BrainEmbeddingsProvider,
  type BrainVectorMatch,
} from "../contracts.js";
import {
  BRAIN_SEARCH_BODY_CHUNKS_MAX, BRAIN_SEARCH_EMBED_BATCH_MAX, BRAIN_SEARCH_EMBED_TIMEOUT_MS,
  BRAIN_SEARCH_PROVIDER_ID_PATTERN, BrainEmbeddingsError, brainSafeCut, errorName, isBrainVectorValue,
  type BrainMeteredEmbeddingsProvider, type BrainRankedHit,
} from "./types.js";

export interface BrainChunkSpan { readonly spanStart: number; readonly spanEnd: number }

/**
 * [start, end) UTF-16 spans of at most maxChars, the next starting overlapChars before the previous end, at most
 * perDocumentMax; a cut prefers the last newline, else space, in the back half of the window.
 */
export function chunkBrainBody(body: string): BrainChunkSpan[] {
  const { maxChars, overlapChars, perDocumentMax } = BRAIN_SEARCH_CHUNK;
  const spans: BrainChunkSpan[] = [];
  let start = 0;
  while (start < body.length && spans.length < perDocumentMax) {
    let end = Math.min(body.length, start + maxChars);
    if (end < body.length) {
      const window = body.slice(start, end);
      let cut = window.lastIndexOf("\n");
      if (cut <= maxChars / 2) cut = window.lastIndexOf(" ");
      end = cut > maxChars / 2 ? start + cut + 1 : brainSafeCut(body, end);
    }
    spans.push({ spanStart: start, spanEnd: end });
    if (end >= body.length) break;
    start = brainSafeCut(body, end - overlapChars);
  }
  return spans;
}

/** A provider is usable only with sane bounds; anything else is treated as not configured. */
export function isUsableBrainEmbeddingsProvider(provider: BrainEmbeddingsProvider): boolean {
  const positive = (value: number, max: number) => Number.isInteger(value) && value >= 1 && value <= max;
  return BRAIN_SEARCH_PROVIDER_ID_PATTERN.test(provider.providerId)
    && positive(provider.dimensions, BRAIN_EMBEDDINGS_DIMENSIONS_MAX)
    && positive(provider.maxBatch, 10_000) && positive(provider.maxInputChars, 1_000_000)
    && typeof provider.embed === "function";
}

/** Thrown when a provider answers with the wrong count or length, or a number pgvector cannot store. */
export class BrainEmbeddingsOutputError extends Error {
  constructor() {
    super("Embeddings output invalid");
    this.name = "BrainEmbeddingsOutputError";
  }
}

/** Vectors in input order plus the usage of every call (zero for a provider that does not report it). */
export interface BrainEmbedded { readonly vectors: number[][]; readonly tokens: number; readonly costMicroUsd: number }

const isUsage = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * Embeds texts in provider-sized batches, each call under its own 10 s deadline (a deadline that fires is
 * unavailable, a caller abort is rethrown); every vector and usage figure is checked before it is used.
 */
export async function embedBrainTexts(
  provider: BrainEmbeddingsProvider, texts: readonly string[], signal: AbortSignal,
): Promise<BrainEmbedded> {
  const batchSize = Math.min(provider.maxBatch, BRAIN_SEARCH_EMBED_BATCH_MAX);
  const metered = "embedMetered" in provider && typeof provider.embedMetered === "function"
    ? provider as BrainMeteredEmbeddingsProvider : null;
  const vectors: number[][] = [];
  let tokens = 0;
  let costMicroUsd = 0;
  for (let at = 0; at < texts.length; at += batchSize) {
    const batch = texts.slice(at, at + batchSize)
      .map((text) => text.slice(0, brainSafeCut(text, provider.maxInputChars)));
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(BRAIN_SEARCH_EMBED_TIMEOUT_MS)]);
    let output: unknown;
    try {
      const result = metered === null ? null : await metered.embedMetered(batch, deadline);
      output = result === null ? await provider.embed(batch, deadline) : result.vectors;
      if (result !== null && !(isUsage(result.usage.tokens) && isUsage(result.usage.costMicroUsd))) {
        throw new BrainEmbeddingsOutputError();
      }
      tokens += result?.usage.tokens ?? 0;
      costMicroUsd += result?.usage.costMicroUsd ?? 0;
    } catch (error: unknown) {
      if (signal.aborted || !deadline.aborted) throw error;
      throw new BrainEmbeddingsError("unavailable", { cause: error });
    }
    if (!Array.isArray(output) || output.length !== batch.length) throw new BrainEmbeddingsOutputError();
    for (const vector of output as unknown[]) {
      if (!Array.isArray(vector) || vector.length !== provider.dimensions || !vector.every(isBrainVectorValue)) {
        throw new BrainEmbeddingsOutputError();
      }
      vectors.push([...(vector as number[])]);
    }
  }
  return { vectors, tokens, costMicroUsd };
}

/** An embeddings failure for logs: the code, status and provider code of a typed error, else the error name. */
export function brainEmbeddingsFailure(error: unknown): string {
  if (!(error instanceof BrainEmbeddingsError)) return errorName(error);
  return [error.code, error.status, error.detail].filter((part) => part !== null).join(" ");
}

/**
 * A chunk to embed: its body span (the claims chunk: its own text), the text sent (the title first) and its text
 * key, so a chunk whose text is unchanged keeps its stored vector.
 */
export interface BrainEmbedChunk extends BrainChunkSpan { readonly text: string; readonly textKey: string }

const chunkOf = (span: BrainChunkSpan, text: string): BrainEmbedChunk =>
  ({ ...span, text, textKey: createHash("sha256").update(text).digest("hex").slice(0, 32) });

/**
 * Up to BRAIN_SEARCH_BODY_CHUNKS_MAX body chunks, then (when the document has claims) one chunk of its current claim
 * statements cut at BRAIN_SEARCH_CHUNK.maxChars, so a vector match on a claim finds its document.
 */
export function brainEmbedChunks(title: string, body: string, statements: string): BrainEmbedChunk[] {
  const chunks = chunkBrainBody(body).slice(0, BRAIN_SEARCH_BODY_CHUNKS_MAX)
    .map((span) => chunkOf(span, `${title}\n${body.slice(span.spanStart, span.spanEnd)}`));
  const claims = statements.slice(0, brainSafeCut(statements, BRAIN_SEARCH_CHUNK.maxChars));
  if (claims.length > 0) chunks.push(chunkOf({ spanStart: 0, spanEnd: claims.length }, `${title}\n${claims}`));
  return chunks;
}

/** The document order of vector matches: each document once, at its best chunk. */
export function rankBrainVectorDocuments(
  matches: readonly BrainVectorMatch[],
): { readonly documentId: string; readonly chunkIndex: number }[] {
  const seen = new Set<string>();
  const ranked: { documentId: string; chunkIndex: number }[] = [];
  for (const match of matches) {
    if (seen.has(match.documentId)) continue;
    seen.add(match.documentId);
    ranked.push({ documentId: match.documentId, chunkIndex: match.chunkIndex });
  }
  return ranked;
}

/**
 * Reciprocal-rank fusion: sum of 1 / (k + rank) over the lists a hit is in, divided by the best possible sum for
 * the non-empty lists, so a hit ranked first everywhere scores 1. Best first, then hit id.
 */
export function fuseBrainHits(lists: readonly (readonly BrainRankedHit[])[]): BrainRankedHit[] {
  const used = lists.filter((list) => list.length > 0);
  const best = used.length / (BRAIN_SEARCH_RRF_K + 1);
  const fused = new Map<string, { hit: BrainRankedHit; sum: number; matchedBy: Set<"text" | "vector"> }>();
  for (const list of used) {
    list.forEach((hit, index) => {
      const entry = fused.get(hit.hitId) ?? { hit, sum: 0, matchedBy: new Set() };
      entry.sum += 1 / (BRAIN_SEARCH_RRF_K + index + 1);
      for (const by of hit.matchedBy) entry.matchedBy.add(by);
      if (entry.hit.chunkIndex === null && hit.chunkIndex !== null) entry.hit = { ...entry.hit, chunkIndex: hit.chunkIndex };
      fused.set(hit.hitId, entry);
    });
  }
  return [...fused.values()]
    .map(({ hit, sum, matchedBy }) => ({
      ...hit, score: Math.min(1, sum / best).toFixed(6),
      matchedBy: (["text", "vector"] as const).filter((by) => matchedBy.has(by)),
    }))
    .sort((a, b) => (a.score === b.score ? (a.hitId < b.hitId ? -1 : 1) : (a.score < b.score ? 1 : -1)));
}
