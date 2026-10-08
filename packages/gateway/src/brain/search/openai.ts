/**
 * The OpenAI embeddings provider (text-embedding-3-small) over plain fetch. One POST per batch of at most 32 inputs
 * of at most 2,730 UTF-16 units: a unit is at most 3 UTF-8 bytes and a token covers at least one byte, so an input
 * stays under 8,192 tokens and a request under 300,000 (OpenAI's limits) with no tokenizer. The key is read for each
 * call and sent only to api.openai.com (a redirect fails); it is never cached, logged or returned, and no provider
 * error text is kept. Each attempt has its own timeout; 408, 409, 429 (not a quota error), 5xx and network failures
 * are retried twice after the server's wait (retry-after-ms, retry-after) or a short backoff, and a wait over 2 s
 * fails the call at once. A caller abort is rethrown untouched.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod/v4";
import { readBoundedJson } from "../sources/integration/bounded-body.js";
import {
  BRAIN_SEARCH_EMBED_TIMEOUT_MS, BrainEmbeddingsError, type BrainEmbeddingsErrorCode, type BrainEmbeddingsUsage,
  type BrainMeteredEmbeddingsProvider,
} from "./types.js";

export const BRAIN_OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const BRAIN_OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-small";
/**
 * text-embedding-3-small costs $0.02 per 1M tokens, kept here as micro-USD per 1M tokens and nowhere else. Source:
 * https://developers.openai.com/api/docs/pricing (read 2026-10-02).
 */
export const BRAIN_OPENAI_EMBEDDINGS_MICRO_USD_PER_MILLION_TOKENS = 20_000;
/** dimensionsMax: the model's full size. Waits and backoff in ms; body caps in bytes. */
export const BRAIN_OPENAI_EMBEDDINGS_LIMITS = {
  maxBatch: 32, maxInputChars: 2_730, dimensionsMax: 1_536, retries: 2, retryWaitMaxMs: 2_000, backoffMs: 250,
  responseMaxBytes: 2 * 1024 * 1024, errorMaxBytes: 16 * 1024,
} as const;

const LIMITS = BRAIN_OPENAI_EMBEDDINGS_LIMITS;
const RETRY_STATUSES: readonly number[] = [408, 409, 429, 500, 502, 503, 504];
/** A provider error code that is safe to log and compare. */
const DETAIL = /^[a-z0-9_.-]{1,64}$/;

export interface BrainOpenAiEmbeddingsOptions {
  readonly dimensions: number;
  /** The key for one call, or null (not_configured). Called once per call; never cached. */
  readonly apiKey: () => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  /** Sleeps between attempts and rejects when the signal aborts. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Jitter in [0, 1). */
  readonly random?: () => number;
}

/** Micro-USD for the tokens of one response, rounded up. */
export function brainOpenAiEmbeddingsCost(tokens: number): number {
  return Math.ceil((tokens * BRAIN_OPENAI_EMBEDDINGS_MICRO_USD_PER_MILLION_TOKENS) / 1_000_000);
}

const ResponseSchema = z.object({
  data: z.array(z.object({
    index: z.number().int().min(0), embedding: z.array(z.number()).max(LIMITS.dimensionsMax),
  })).max(LIMITS.maxBatch),
  usage: z.object({ total_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
});
const ErrorSchema = z.object({ error: z.object({ code: z.unknown() }) });

/** retry-after-ms, else retry-after in seconds or as an HTTP date; null when absent or unreadable. */
function requestedWaitMs(headers: Headers): number | null {
  const number = (value: string | null) => (value !== null && /^\d+(\.\d+)?$/.test(value) ? Number(value) : null);
  const milliseconds = number(headers.get("retry-after-ms"));
  if (milliseconds !== null) return milliseconds;
  const after = headers.get("retry-after");
  const seconds = number(after);
  if (seconds !== null) return seconds * 1_000;
  const date = after === null ? Number.NaN : Date.parse(after);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function statusCode(status: number): BrainEmbeddingsErrorCode {
  if ([400, 413, 422].includes(status)) return "invalid";
  return [401, 403, 404].includes(status) ? "auth_failed" : "unavailable";
}

type Embedded = { readonly vectors: number[][]; readonly usage: BrainEmbeddingsUsage };
type Sent = { readonly embedded: Embedded } | {
  readonly error: BrainEmbeddingsError; readonly retry: boolean; readonly waitMs: number | null;
};
