/**
 * Company Brain model claims: the contract shared by the Claude client (client.ts), its prompt and skip policy
 * (prompt.ts), pricing (pricing.ts), configuration and credentials (config.ts), and the job and project service that
 * run it. Nothing here imports @anthropic-ai/sdk, so the job, the service and their tests do not depend on it.
 */
import { z } from "zod/v4";
import {
  BRAIN_EXTRACTION_LIMIT_CEILINGS, brainModelExtractorId, type BrainClaimFields, type BrainClaimModel,
  type BrainClaimModelInput, type BrainExtractionLimits,
} from "../types.js";

// Identity. The extractor id is model:<model id>/<prompt version>; changing either starts a separate claim set.

/** Models a request may name; both take the same request (adaptive thinking, effort, fallbacks "default"). */
export const BRAIN_MODEL_REQUEST_IDS = ["claude-opus-5-5", "claude-opus-5"] as const;
export type BrainModelRequestId = (typeof BRAIN_MODEL_REQUEST_IDS)[number];
export const BRAIN_MODEL_DEFAULT_ID: BrainModelRequestId = "claude-opus-5-5";
/** Bumped whenever the system prompt, the user content or the output schema changes. */
export const BRAIN_MODEL_PROMPT_VERSION = "claims-v2";
/** `model:claude-opus-5-5/claims-v2`. */
export const BRAIN_MODEL_DEFAULT_EXTRACTOR_ID =
  brainModelExtractorId(BRAIN_MODEL_DEFAULT_ID, BRAIN_MODEL_PROMPT_VERSION);

// Request.

export const BRAIN_MODEL_API_BASE_URL = "https://api.anthropic.com";
/** The beta header of the `fallbacks: "default"` form; the array form has another header and mixing them is a 400. */
export const BRAIN_MODEL_FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Thinking counts toward max_tokens, so this bounds one call's whole output. */
export const BRAIN_MODEL_MAX_TOKENS = 8_192;
/** SDK retries per call (429, 5xx, network); the job's per-call timeout bounds the total time. */
export const BRAIN_MODEL_MAX_RETRIES = 1;
/** Claims the system prompt asks for at most; verify.ts still caps a document at BRAIN_CLAIMS_PER_DOCUMENT_MAX. */
export const BRAIN_MODEL_PROMPT_MAX_CLAIMS = 20;
export const BRAIN_MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type BrainModelEffort = (typeof BRAIN_MODEL_EFFORTS)[number];

/** One text content block; mutable so it is assignable to the SDK's text block param. */
export interface BrainModelTextBlock { type: "text"; text: string }

// Selection: a model run takes the newest pending documents first; these bodies are skipped without a call.

/** A footer-stripped body shorter than this (UTF-16 units, trimmed) is body_too_short. */
export const BRAIN_MODEL_BODY_MIN_CHARS = 200;

// Configuration: environment variables, parsed once when the provider is built.

export const BRAIN_MODEL_ENV = {
  modelId: "MATRIX_BRAIN_MODEL_ID", effort: "MATRIX_BRAIN_MODEL_EFFORT",
  documentsPerRun: "MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN",
  costMicroUsdPerRun: "MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN",
  bodyMaxBytes: "MATRIX_BRAIN_MODEL_BODY_MAX_BYTES",
  spendMicroUsdPer30d: "MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D",
} as const;

/**
 * bodyMaxBytes: utf8 bytes of the footer-stripped body; a larger body is skipped as document_too_large.
 * spendMicroUsdPer30d: the rolling cap per owner, across all projects, over 30 days (claims/spend.ts); default 5 USD.
 */
export interface BrainModelConfig {
  readonly modelId: BrainModelRequestId; readonly effort: BrainModelEffort; readonly documentsPerRun: number;
  readonly costMicroUsdPerRun: number; readonly bodyMaxBytes: number; readonly spendMicroUsdPer30d: number;
}

export const BRAIN_MODEL_CONFIG_DEFAULTS: BrainModelConfig = {
  modelId: BRAIN_MODEL_DEFAULT_ID, effort: "low", documentsPerRun: 20, costMicroUsdPerRun: 500_000,
  bodyMaxBytes: 32_768, spendMicroUsdPer30d: 5_000_000,
};

/** Inclusive bounds; a value outside them, or not a plain decimal integer, disables the model extractor. */
export const BRAIN_MODEL_CONFIG_BOUNDS = {
  documentsPerRun: [1, BRAIN_EXTRACTION_LIMIT_CEILINGS.documentsPerRun],
  costMicroUsdPerRun: [1, BRAIN_EXTRACTION_LIMIT_CEILINGS.costMicroUsdPerRun],
  bodyMaxBytes: [1_024, 65_536],
  spendMicroUsdPer30d: [1, BRAIN_EXTRACTION_LIMIT_CEILINGS.spendMicroUsdPer30d],
} as const satisfies Record<string, readonly [number, number]>;

/** variable: the name of the first invalid variable, never its value. */
export type BrainModelConfigResult =
  | { readonly ok: true; readonly config: BrainModelConfig }
  | { readonly ok: false; readonly variable: string };

/**
 * Fixed limits of a model run, merged with documentsPerRun, costMicroUsdPerRun and spendMicroUsdPer30d from the
 * configuration. A 120 s run
 * plus one 60 s call stays under the 5-minute run lease and Node's 300 s request timeout.
 */
export const BRAIN_MODEL_RUN_LIMITS = {
  runBudgetMs: 120_000, modelCallTimeoutMs: 60_000, tokensPerRun: 1_000_000,
} as const satisfies Partial<BrainExtractionLimits>;

// Credentials: resolved per extract request; never cached, logged, stored or returned.

/** A direct Anthropic API key. OAuth tokens (sk-ant-oat...) and Matrix proxy keys (sk-proxy-...) do not match. */
export const BRAIN_ANTHROPIC_DIRECT_KEY_PATTERN = /^sk-ant-api[A-Za-z0-9_-]+$/;
export const BRAIN_ANTHROPIC_KEY_MAX_CHARS = 4_096;

/** owner_key: kernel.anthropicApiKey in <home>/system/config.json. environment: ANTHROPIC_API_KEY, direct keys only. */
export interface BrainAnthropicCredential { readonly apiKey: string; readonly source: "owner_key" | "environment" }

export type BrainModelEnv = Readonly<Record<string, string | undefined>>;

// Output schema (structured outputs). Deliberately loose: the SDK's JSON Schema transform drops enum, length and
// pattern constraints, so verify.ts re-validates every candidate and client.ts drops unusable optional parts.

export const BrainModelWireClaimSchema = z.object({
  kind: z.string(), label: z.string().nullable(), statement: z.string(), quote: z.string(),
  fields: z.object({ assignee: z.string().nullable(), due: z.string().nullable(), severity: z.string().nullable() }),
});
export const BrainModelWireOutputSchema = z.object({ claims: z.array(BrainModelWireClaimSchema) });
export type BrainModelWireOutput = z.output<typeof BrainModelWireOutputSchema>;

// Additions to the model seam: job.ts reads them; claims/types.ts BrainClaimModelOutput carries `outcome`.

/** Document codes of a revision the model extractor reads no claims from; a skipped revision is not pending again. */
export const BRAIN_MODEL_SKIP_CODES =
  ["model_refused", "body_too_short", "commit_list_only", "document_too_large"] as const;
export type BrainModelSkipCode = (typeof BRAIN_MODEL_SKIP_CODES)[number];

/**
 * Absent: `claims` holds the candidates. skipped: no claims for this revision (a refusal, or a body not worth a call).
 * invalid: a billed response with no usable output (cut off, not JSON, wrong shape), recorded as model_output_invalid.
 */
export const BrainClaimModelOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("skipped"), code: z.enum(BRAIN_MODEL_SKIP_CODES) }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);
export type BrainClaimModelOutcome = z.output<typeof BrainClaimModelOutcomeSchema>;

/** inputTokens counts every prompt token: uncached, cache writes and cache reads. costMicroUsd is rounded up. */
export interface BrainModelUsage {
  readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number; readonly costMicroUsd: number;
}

/** A candidate as verify.ts receives it: label null when unusable, fields only with valid, non-null values. */
export interface BrainModelClaimCandidate {
  readonly kind: string; readonly label: string | null; readonly statement: string; readonly quote: string;
  readonly fields?: BrainClaimFields;
}

/** Assignable to BrainClaimModelOutput. usage covers every response the API billed, whatever the outcome. */
export interface BrainModelOutput {
  readonly claims: readonly BrainModelClaimCandidate[]; readonly usage: BrainModelUsage;
  readonly outcome?: BrainClaimModelOutcome;
}

export interface BrainAnthropicClaimModel extends BrainClaimModel {
  skip(input: BrainClaimModelInput): BrainModelSkipCode | null;
  extract(input: BrainClaimModelInput, signal: AbortSignal): Promise<BrainModelOutput>;
}

// Errors.

/**
 * A failed call; any other throw from a model stays the document's model_failed. runBrainExtraction maps:
 * - model_auth_failed (401, 402, 403, 404): the run stops failed, nextAction configure_model, no document state.
 * - model_unavailable (429, 5xx including 529, network after retries, a 2xx whose body could not be read): the run
 *   stops failed, retry_later, no state.
 * - model_rejected (400, 413, 422, any other status): the document fails model_failed, then the run stops failed with
 *   contact_support, so a request the API refuses cannot fail a whole page of documents.
 * - model_timeout (the SDK's own per-attempt timeout): the document fails model_timeout, the call is charged at its
 *   worst case (it may still be billed), and the run goes on within its budgets.
 * Whatever the code, an unanswered call (BrainModelError.unanswered) is charged at its worst case as well.
 * A caller abort is rethrown as the SDK's abort error: the job checks its own signals before anything else.
 */
export const BRAIN_MODEL_ERROR_CODES =
  ["model_auth_failed", "model_unavailable", "model_rejected", "model_timeout"] as const;
export type BrainModelErrorCode = (typeof BRAIN_MODEL_ERROR_CODES)[number];

/**
 * unanswered: an attempt of the call may have reached the API but its answer was lost (the connection dropped, or a
 * 2xx body could not be read), so the call may be billed with no usage to count. A connection that never opened
 * (DNS, refused, unreachable) sent nothing and does not count; neither does an attempt answered with an error status.
 */
export interface BrainModelErrorOptions extends ErrorOptions { readonly unanswered?: boolean }

/** The message is the code; the SDK error is only the cause and is never logged beyond its name. */
export class BrainModelError extends Error {
  readonly unanswered: boolean;
  constructor(readonly code: BrainModelErrorCode, options?: BrainModelErrorOptions) {
    super(code, options);
    this.name = "BrainModelError";
    this.unanswered = options?.unanswered ?? false;
  }
}

// Pricing (pricing.ts).

/** Tenths of a micro-USD per token ($0.20 per million is 2). cacheWrite is the 5-minute rate, the only TTL sent. */
export interface BrainModelPrice {
  readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number;
}

/** One response's or one attempt's token counts; the SDK's BetaUsage and its iterations are assignable. */
export interface BrainModelTokenCounts {
  readonly input_tokens: number; readonly output_tokens: number;
  readonly cache_read_input_tokens: number | null; readonly cache_creation_input_tokens: number | null;
}

export interface BrainModelIterationCounts extends BrainModelTokenCounts {
  readonly type: string; readonly model?: string | null;
}

/** iterations, when non-empty, is the per-attempt source of truth: a fallback attempt is priced at its own model. */
export interface BrainModelUsageReport extends BrainModelTokenCounts {
  readonly iterations: readonly BrainModelIterationCounts[] | null;
}

// Client and provider (client.ts, config.ts).

export type BrainModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** apiKey: resolved for this request only. timeoutMs: the SDK's per-attempt timeout. fetch: the test seam. */
export interface BrainAnthropicModelOptions {
  readonly apiKey: string; readonly modelId: BrainModelRequestId; readonly effort: BrainModelEffort;
  readonly bodyMaxBytes: number; readonly timeoutMs: number; readonly fetch?: BrainModelFetch;
}

/** One model extract request: the model, its extractor identity and the limits passed to runBrainExtraction. */
export interface BrainClaimModelResolution {
  readonly model: BrainClaimModel; readonly modelId: string; readonly promptVersion: string;
  readonly limits: Partial<BrainExtractionLimits>;
}

/**
 * Called once per model extract request. null: no valid configuration or no usable credential (409
 * extractor_not_configured). Rejects only when the owner's config file cannot be read (503 brain_unavailable).
 */
export type BrainClaimModelProvider = () => Promise<BrainClaimModelResolution | null>;

/** env: the configuration is parsed once at build time, the credential read per call. fetch: the test seam. */
export interface BrainClaimModelProviderOptions {
  readonly homePath: string; readonly env: BrainModelEnv; readonly fetch?: BrainModelFetch;
}
