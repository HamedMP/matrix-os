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

export function createBrainOpenAiEmbeddings(options: BrainOpenAiEmbeddingsOptions): BrainMeteredEmbeddingsProvider {
  const { dimensions } = options;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > LIMITS.dimensionsMax) {
    throw new RangeError("OpenAI embeddings dimensions out of range");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const wait = options.wait ?? (async (ms: number, signal: AbortSignal) => { await sleep(ms, undefined, { signal }); });
  const random = options.random ?? Math.random;

  /** The checked vectors (in input order) and usage of a 200 answer; anything unusable is unavailable. */
  async function read(response: Response, count: number, signal: AbortSignal): Promise<Embedded> {
    const body = await readBoundedJson(response, LIMITS.responseMaxBytes, signal);
    const parsed = ResponseSchema.safeParse(body.ok ? body.value : null);
    const bad = new BrainEmbeddingsError("unavailable", { status: response.status });
    if (!parsed.success || parsed.data.data.length !== count) throw bad;
    const vectors: number[][] = new Array<number[]>(count);
    for (const item of parsed.data.data) {
      if (item.index >= count || vectors[item.index] !== undefined || item.embedding.length !== dimensions) throw bad;
      vectors[item.index] = item.embedding;
    }
    const tokens = parsed.data.usage.total_tokens;
    return { vectors, usage: { tokens, costMicroUsd: brainOpenAiEmbeddingsCost(tokens) } };
  }

  /** One attempt. Network failures and attempt timeouts are retryable; a caller abort is rethrown. */
  async function send(key: string, body: string, count: number, signal: AbortSignal): Promise<Sent> {
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(BRAIN_SEARCH_EMBED_TIMEOUT_MS)]);
    try {
      const response = await fetchImpl(BRAIN_OPENAI_EMBEDDINGS_URL, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body,
        redirect: "error", signal: attempt,
      });
      if (response.ok) return { embedded: await read(response, count, attempt) };
      const waitMs = requestedWaitMs(response.headers);
      const error = await readBoundedJson(response, LIMITS.errorMaxBytes, attempt);
      const code = ErrorSchema.safeParse(error.ok ? error.value : null).data?.error.code;
      const detail = typeof code === "string" && DETAIL.test(code) ? code : null;
      const retry = RETRY_STATUSES.includes(response.status) && response.headers.get("x-should-retry") !== "false"
        && (response.status !== 429 || detail === null || detail === "rate_limit_exceeded");
      return { error: new BrainEmbeddingsError(statusCode(response.status), { status: response.status, detail }),
        retry, waitMs };
    } catch (error: unknown) {
      if (signal.aborted || error instanceof BrainEmbeddingsError) throw error;
      return { error: new BrainEmbeddingsError("unavailable", { cause: error }), retry: true, waitMs: null };
    }
  }

  async function embedMetered(texts: readonly string[], signal: AbortSignal): Promise<Embedded> {
    if (texts.length === 0 || texts.length > LIMITS.maxBatch
      || texts.some((text) => text.length === 0 || text.length > LIMITS.maxInputChars)) {
      throw new BrainEmbeddingsError("invalid");
    }
    const key = await options.apiKey();
    if (key === null) throw new BrainEmbeddingsError("not_configured");
    const body = JSON.stringify({ model: BRAIN_OPENAI_EMBEDDINGS_MODEL, input: texts, dimensions,
      encoding_format: "float" });
    for (let attempt = 0; ; attempt += 1) {
      const sent = await send(key, body, texts.length, signal);
      if ("embedded" in sent) return sent.embedded;
      const delay = sent.waitMs ?? LIMITS.backoffMs * 2 ** attempt * (1 - random() / 4);
      if (!sent.retry || attempt >= LIMITS.retries || delay > LIMITS.retryWaitMaxMs) throw sent.error;
      await wait(delay, signal);
    }
  }

  return {
    providerId: `openai/${BRAIN_OPENAI_EMBEDDINGS_MODEL}/${dimensions}`, dimensions, maxBatch: LIMITS.maxBatch,
    maxInputChars: LIMITS.maxInputChars, embedMetered,
    embed: async (texts, signal) => (await embedMetered(texts, signal)).vectors,
  };
}
