/**
 * The embedding pass of one refresh. Candidates are read a provider batch at a time (title, body and the statements
 * of current claims). A chunk whose text the store already holds a vector for (same text key, provider and size)
 * keeps it; only the other chunks are sent, grouped so one provider call carries the chunks of several documents.
 * Before each call: the signal and time budget, the refresh's token and cost budget, and the store's room net of the
 * rows the group's documents already hold. A provider that is not configured, refuses the key or is unavailable ends
 * the pass and records nothing; any other failure of a group of several documents retries them one by one, and one
 * document's failure is recorded on its row and ends the pass. A pass that paid anything logs its tokens, cost and
 * early stop (counts only, never ids or text), even when it then throws: the hook listener, the job step and the
 * index catch-up run it too, and only the refresh route returns the figures.
 */
import type { Kysely } from "kysely";
import type { BrainEmbeddingsProvider, BrainRefreshStopReason } from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import {
  markEmbedding, selectEmbedSources, withSearchRead, withSearchScopeWrite, type BrainSearchOrphan,
} from "./index-sql.js";
import {
  BRAIN_SEARCH_EMBED_BATCH_MAX, BRAIN_SEARCH_EMBED_REFRESH_BUDGET, BrainEmbeddingsError, BrainSearchVectorCapError,
  brainCurrentEmbedProvenances, brainEmbedProvenances, FOREIGN_KEY_VIOLATION, sqlState,
  type BrainSearchEmbeddingsAllowance,
  type BrainSearchEmbeddingView, type BrainSearchEmbedTarget, type BrainSearchVectorStore,
} from "./types.js";
import {
  brainEmbedChunks, brainEmbeddingsFailure, embedBrainTexts, type BrainEmbedChunk, type BrainEmbedded,
} from "./vector.js";

/** store: the kind of vector store, part of the embedded marker so that a store switch embeds again. */
export interface BrainSearchMeaning {
  readonly provider: BrainEmbeddingsProvider & BrainSearchEmbeddingsAllowance; readonly vectors: BrainSearchVectorStore;
  readonly store?: "pgvector" | "array";
}

/** What brain_search_documents.embedded_provider holds once a document's vectors are stored. */
export const brainEmbedMarker = (meaning: BrainSearchMeaning): string => (meaning.store === undefined
  ? meaning.provider.providerId : `${meaning.store}:${meaning.provider.providerId}`);

/** The marker plus the provenances the provider may receive (brainEmbedProvenances: the git default unless listed). */
export const brainEmbedTarget = (meaning: BrainSearchMeaning): BrainSearchEmbedTarget => ({
  marker: brainEmbedMarker(meaning), provenances: brainEmbedProvenances(meaning.provider),
});

/**
 * The target as the owner's settings say now: a provider that can read the owner's current list is asked each time
 * (a list narrowed since start applies at once); otherwise the list it started with.
 */
export async function brainCurrentEmbedTarget(meaning: BrainSearchMeaning): Promise<BrainSearchEmbedTarget> {
  const { provider } = meaning;
  if (provider.currentProvenances === undefined) return brainEmbedTarget(meaning);
  return {
    marker: brainEmbedMarker(meaning), provenances: brainCurrentEmbedProvenances(await provider.currentProvenances()),
  };
}

/** target: what this refresh may send, read once at its start (brainCurrentEmbedTarget). */
export interface BrainEmbedPassContext {
  readonly db: Kysely<BrainDatabase>; readonly scope: BrainScopeKey; readonly meaning: BrainSearchMeaning;
  readonly target: BrainSearchEmbedTarget;
  readonly now: () => Date; readonly signal: AbortSignal; readonly halted: () => boolean;
  /** Documents this refresh dealt with (processed). */
  readonly touched: Set<string>;
}

/**
 * stopped: the pass ended before its candidates for a reason other than a recorded document failure. stopReason: the
 * pass cannot go on until something changes (the provider failed, or the store is full); null otherwise.
 */
export interface BrainEmbedPassResult {
  readonly stopped: boolean; readonly embedding: BrainSearchEmbeddingView;
  readonly stopReason: Extract<BrainRefreshStopReason, "embedding_unavailable" | "vector_cap"> | null;
}

/** kept: per chunk, the stored vector of its text, or null when the chunk is sent. */
interface Job {
  readonly built: BrainSearchOrphan; readonly chunks: readonly BrainEmbedChunk[];
  readonly kept: readonly (readonly number[] | null)[];
}
type Outcome = "embedded" | "split" | "stopped" | "failed" | "aborted" | "vector_cap";
/** Tokens and micro-USD the pass has paid for so far. */
type Usage = { tokens: number; costMicroUsd: number };

const sent = (job: Job): BrainEmbedChunk[] => job.chunks.filter((_, index) => job.kept[index] === null);

/** The batch's documents still live at the candidate's (incarnation, revision), in candidate order. */
async function loadJobs(context: BrainEmbedPassContext, batch: readonly BrainSearchOrphan[]): Promise<Job[]> {
  const rows = await withSearchRead(context.db, (trx) => selectEmbedSources(trx, context.scope,
    context.target, batch.map((built) => built.documentId)));
  const live: Omit<Job, "kept">[] = [];
  for (const built of batch) {
    context.touched.add(built.documentId);
    const row = rows.find((candidate) => candidate.document_id === built.documentId);
    if (row?.incarnation !== built.incarnation || row.revision !== built.revision) continue;
    live.push({ built, chunks: brainEmbedChunks(row.title, row.body, row.statements) });
  }
  const { provider, vectors } = context.meaning;
  const stored = vectors.storedVectors === undefined || live.length === 0 ? new Map<string, readonly number[]>()
    : await vectors.storedVectors(context.scope, { providerId: provider.providerId, dimensions: provider.dimensions,
      documentIds: live.map((job) => job.built.documentId),
      textKeys: [...new Set(live.flatMap((job) => job.chunks.map((chunk) => chunk.textKey)))] });
  return live.map((job) => ({ ...job, kept: job.chunks.map((chunk) => stored.get(chunk.textKey) ?? null) }));
}

/** Consecutive jobs while the chunks they send fit one call; a job sending more than that goes alone. */
function groupJobs(jobs: readonly Job[], size: number): Job[][] {
  const groups: Job[][] = [];
  let count = 0;
  for (const job of jobs) {
    const last = groups[groups.length - 1];
    const sends = sent(job).length;
    if (last === undefined || count + sends > size) {
      groups.push([job]);
      count = sends;
    } else {
      last.push(job);
      count += sends;
    }
  }
  return groups;
}

/** Stores one document's vectors (kept and fresh) and marks its row; a document erased meanwhile is skipped. */
async function write(context: BrainEmbedPassContext, job: Job, fresh: readonly number[][]): Promise<Outcome> {
  let at = 0;
  try {
    await context.meaning.vectors.replaceChunks(context.scope, {
      documentId: job.built.documentId, incarnation: job.built.incarnation, revision: job.built.revision,
      providerId: context.meaning.provider.providerId,
      chunks: job.chunks.map((chunk, index) => ({ spanStart: chunk.spanStart, spanEnd: chunk.spanEnd,
        textKey: chunk.textKey, vector: job.kept[index] ?? fresh[at++]! })),
    });
  } catch (error: unknown) {
    if (error instanceof BrainSearchVectorCapError) return "vector_cap";
    if (sqlState(error) === FOREIGN_KEY_VIOLATION) return "embedded";
    throw error;
  }
  await withSearchScopeWrite(context.db, context.scope,
    (trx) => markEmbedding(trx, context.scope, job.built, brainEmbedMarker(context.meaning), context.now()));
  return "embedded";
}

async function embedGroup(context: BrainEmbedPassContext, group: readonly Job[], usage: Usage): Promise<Outcome> {
  let embedded: BrainEmbedded;
  try {
    embedded = await embedBrainTexts(context.meaning.provider,
      group.flatMap((job) => sent(job).map((chunk) => chunk.text)), context.signal);
  } catch (error: unknown) {
    if (context.signal.aborted) return "aborted";
    console.error("[brain-search] embeddings failed:", brainEmbeddingsFailure(error));
    if (error instanceof BrainEmbeddingsError && error.code !== "invalid") return "stopped";
    if (group.length > 1) return "split";
    await withSearchScopeWrite(context.db, context.scope,
      (trx) => markEmbedding(trx, context.scope, group[0]!.built, null, context.now()));
    return "failed";
  }
  usage.tokens += embedded.tokens;
  usage.costMicroUsd += embedded.costMicroUsd;
  let at = 0;
  for (const job of group) {
    const count = sent(job).length;
    const outcome = await write(context, job, embedded.vectors.slice(at, at + count));
    if (outcome === "vector_cap") return outcome;
    at += count;
  }
  return "embedded";
}

/** The pass, its spend logged once it ends (see the header). */
export async function runBrainEmbedPass(
  context: BrainEmbedPassContext, candidates: readonly BrainSearchOrphan[],
): Promise<BrainEmbedPassResult> {
  const usage: Usage = { tokens: 0, costMicroUsd: 0 };
  let result: BrainEmbedPassResult | null = null;
  try {
    result = await embedCandidates(context, candidates, usage);
    return result;
  } finally {
    if (usage.tokens > 0) {
      console.info("[brain-search] embedding spend", { tokens: usage.tokens, costMicroUsd: usage.costMicroUsd,
        stopped: result === null ? "error" : result.embedding.stopped });
    }
  }
}

async function embedCandidates(
  context: BrainEmbedPassContext, candidates: readonly BrainSearchOrphan[], usage: Usage,
): Promise<BrainEmbedPassResult> {
  const { provider, vectors } = context.meaning;
  const size = Math.min(provider.maxBatch, BRAIN_SEARCH_EMBED_BATCH_MAX);
  const end = (stopped: boolean, by: BrainSearchEmbeddingView["stopped"] = null,
    stopReason: BrainEmbedPassResult["stopReason"] = by === "vector_cap" ? "vector_cap" : null): BrainEmbedPassResult =>
    ({ stopped, embedding: { ...usage, stopped: by }, stopReason });
  const budget = BRAIN_SEARCH_EMBED_REFRESH_BUDGET;
  for (let at = 0; at < candidates.length; at += size) {
    const queue = groupJobs(await loadJobs(context, candidates.slice(at, at + size)), size);
    for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
      if (context.halted()) return end(true);
      if (usage.tokens >= budget.tokens || usage.costMicroUsd >= budget.costMicroUsd) return end(true, "budget");
      // The write replaces the group's own rows, so only the rest of the scope counts against the cap.
      const need = group.reduce((sum, job) => sum + job.chunks.length, 0);
      const room = vectors.remaining === undefined ? Number.POSITIVE_INFINITY
        : await vectors.remaining(context.scope, group.map((job) => job.built.documentId));
      if (need > room) return end(true, "vector_cap");
      const outcome = await embedGroup(context, group, usage);
      if (outcome === "split") queue.unshift(...group.map((job) => [job]));
      else if (outcome === "stopped") return end(true, null, "embedding_unavailable");
      else if (outcome !== "embedded") return end(outcome !== "failed", outcome === "vector_cap" ? outcome : null);
    }
  }
  return end(false);
}
